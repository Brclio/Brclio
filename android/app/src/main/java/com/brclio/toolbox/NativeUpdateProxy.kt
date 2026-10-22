package com.brclio.toolbox

import java.io.ByteArrayOutputStream
import java.io.DataInputStream
import java.io.EOFException
import java.io.InputStream
import java.io.OutputStream
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.Proxy
import java.net.ServerSocket
import java.net.Socket
import java.nio.ByteBuffer
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Base64
import java.util.Collections
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.Semaphore
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import javax.net.ssl.SNIHostName
import javax.net.ssl.SSLSocket
import javax.net.ssl.SSLSocketFactory

/** Operation-scoped local CONNECT proxy. Neither Android's proxy nor its TLS trust is changed. */
internal class NativeUpdateProxy(
    private val nodes: List<UpdateProxyNode>,
    deadlineMillis: Long,
    private val tlsFactory: SSLSocketFactory = SSLSocketFactory.getDefault() as SSLSocketFactory,
    private val connectAddress: (UpdateProxyNode) -> InetSocketAddress = { InetSocketAddress(it.dialAddress, it.port) },
) : AutoCloseable {
    private val closed = AtomicBoolean(false)
    @Volatile var terminalFailure: Throwable? = null
        private set
    private val sockets = Collections.newSetFromMap(ConcurrentHashMap<Socket, Boolean>())
    private val transports = ConcurrentHashMap<SSLSocket, Socket>()
    private val slots = Semaphore(4)
    private val executor = Executors.newFixedThreadPool(9) { task -> Thread(task, "Brclio-update-tunnel").apply { isDaemon = true } }
    private val timer = Executors.newSingleThreadScheduledExecutor { task -> Thread(task, "Brclio-update-deadline").apply { isDaemon = true } }
    private val server = ServerSocket().apply { bind(InetSocketAddress(InetAddress.getByName("127.0.0.1"), 0), 4) }
    val proxy = Proxy(Proxy.Type.HTTP, InetSocketAddress("127.0.0.1", server.localPort))

    init {
        require(nodes.isNotEmpty())
        timer.schedule({ close() }, maxOf(1L, deadlineMillis - System.currentTimeMillis()), TimeUnit.MILLISECONDS)
        executor.execute {
            while (!closed.get()) {
                val socket = try { server.accept() } catch (_: Exception) { break }
                if (!slots.tryAcquire()) { socket.close(); continue }
                sockets.add(socket)
                try { executor.execute { connect(socket) } } catch (_: Exception) { dispose(socket); slots.release() }
            }
        }
    }

    private fun connect(local: Socket) {
        var upstream: SSLSocket? = null
        var selected: UpdateProxyNode? = null
        try {
            checkOpen()
            local.soTimeout = 30_000
            val host = UpdateTunnelProtocol.connectHost(UpdateTunnelProtocol.readHeaders(local.getInputStream()))
            // Failover is allowed only before any destination TLS bytes have been sent.
            for (node in nodes) {
                checkOpen()
                var tcp: Socket? = null
                var candidate: SSLSocket? = null
                try {
                    tcp = Socket(Proxy.NO_PROXY).also { sockets.add(it) }
                    tcp.connect(connectAddress(node), 15_000)
                    candidate = (tlsFactory.createSocket(tcp, node.host, node.port, true) as SSLSocket).also { sockets.add(it) }
                    transports[candidate] = tcp
                    sockets.remove(tcp) // dispose(TLS) closes raw TCP first, including blocked writes.
                    candidate.enabledProtocols = candidate.supportedProtocols.filter { it == "TLSv1.2" || it == "TLSv1.3" }.toTypedArray()
                    candidate.soTimeout = 30_000
                    candidate.sslParameters = candidate.sslParameters.apply {
                        endpointIdentificationAlgorithm = "HTTPS"
                        serverNames = listOf(SNIHostName(node.host))
                    }
                    candidate.startHandshake()
                    try { UpdateTunnelProtocol.upgrade(candidate.getInputStream(), candidate.getOutputStream(), node) }
                    catch (_: IllegalArgumentException) { throw UpdateTransportRejected() }
                    catch (_: IllegalStateException) { throw UpdateTransportRejected() }
                    upstream = candidate
                    selected = node
                    break
                } catch (failure: Exception) {
                    if (UpdateRetryPolicy.isSecurityFailure(failure) || failure is UpdateTransportRejected) terminalFailure = failure
                    candidate?.let(::dispose)
                    tcp?.let(::dispose)
                }
            }
            val remote = upstream ?: throw EOFException()
            checkOpen()
            val remoteIn = DataInputStream(remote.getInputStream())
            val remoteOut = remote.getOutputStream()
            local.getOutputStream().apply { write("HTTP/1.1 200 Connection Established\r\n\r\n".toByteArray(Charsets.US_ASCII)); flush() }
            // The first TLS record and VLESS header share one binary frame; no early-data URL.
            val first = ByteArray(16 * 1024)
            val count = local.getInputStream().read(first)
            if (count < 0) throw EOFException()
            val prefix = UpdateTunnelProtocol.vlessRequest(selected ?: throw EOFException(), host)
            UpdateTunnelProtocol.writeFrame(remoteOut, 2, prefix + first.copyOf(count))
            executor.execute {
                try {
                    val buffer = ByteArray(16 * 1024)
                    while (!closed.get()) {
                        val size = local.getInputStream().read(buffer)
                        if (size < 0) break
                        UpdateTunnelProtocol.writeFrame(remoteOut, 2, buffer.copyOf(size))
                    }
                } catch (_: Exception) { /* The owner reports a fixed, credential-free error. */ }
                finally { dispose(local); dispose(remote) }
            }
            UpdateTunnelProtocol.copyResponse(remoteIn, remoteOut, local.getOutputStream()) { checkOpen() }
        } catch (_: Exception) {
            // Never expose socket/TLS/URI messages, which may include node credentials or hosts.
        } finally {
            upstream?.let(::dispose)
            dispose(local)
            slots.release()
        }
    }

    private fun checkOpen() { check(!closed.get() && !Thread.currentThread().isInterrupted) }
    private fun dispose(socket: Socket) {
        sockets.remove(socket)
        if (socket is SSLSocket) transports.remove(socket)?.let { raw -> runCatching { raw.close() } }
        runCatching { socket.close() }
    }

    override fun close() {
        if (!closed.compareAndSet(false, true)) return
        runCatching { server.close() }
        sockets.toList().forEach(::dispose)
        executor.shutdownNow()
        timer.shutdownNow()
    }
}

/** Small RFC6455 binary transport with a length bound before allocation and streaming backpressure. */
internal object UpdateTunnelProtocol {
    const val MAX_FRAME_BYTES = 1024 * 1024L
    private val random = SecureRandom()
    private val allowedHosts = setOf("api.github.com", "github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com")

    fun readHeaders(input: InputStream): String {
        val bytes = ByteArrayOutputStream()
        var end = 0
        while (bytes.size() < 16 * 1024) {
            val b = input.read()
            if (b < 0) throw EOFException()
            require(b == 9 || b == 10 || b == 13 || b in 32..126)
            bytes.write(b)
            end = when { end == 0 && b == 13 -> 1; end == 1 && b == 10 -> 2; end == 2 && b == 13 -> 3; end == 3 && b == 10 -> 4; b == 13 -> 1; else -> 0 }
            if (end == 4) return bytes.toString("US-ASCII")
        }
        error("Header limit")
    }

    fun connectHost(headers: String): String {
        val lines = headers.split("\r\n")
        val match = Regex("^CONNECT ([a-z.-]+):443 HTTP/1\\.[01]$").matchEntire(lines.first()) ?: error("CONNECT required")
        val host = match.groupValues[1]
        require(host in allowedHosts)
        require(lines.drop(1).filter { it.isNotEmpty() }.all { it.contains(':') && !it.startsWith(' ') && !it.startsWith('\t') })
        return host
    }

    fun vlessRequest(node: UpdateProxyNode, host: String): ByteArray {
        require(host in allowedHosts)
        val name = host.toByteArray(Charsets.US_ASCII)
        return ByteBuffer.allocate(23 + name.size).put(0).putLong(node.uuid.mostSignificantBits).putLong(node.uuid.leastSignificantBits)
            .put(0).put(1).putShort(443.toShort()).put(2).put(name.size.toByte()).put(name).array()
    }

    fun upgrade(input: InputStream, output: OutputStream, node: UpdateProxyNode) {
        val key = Base64.getEncoder().encodeToString(ByteArray(16).also(random::nextBytes))
        val target = buildString {
            node.path.toByteArray(Charsets.UTF_8).forEach { byte ->
                val b = byte.toInt() and 255
                if (b in 33..126 && b != 35) append(b.toChar()) else append("%%%02X".format(b))
            }
        }
        val authority = node.host + if (node.port == 443) "" else ":${node.port}"
        output.write("GET $target HTTP/1.1\r\nHost: $authority\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: $key\r\nSec-WebSocket-Version: 13\r\n\r\n".toByteArray(Charsets.US_ASCII))
        output.flush()
        val lines = readHeaders(input).split("\r\n")
        val status = Regex("^HTTP/1\\.[01] ([0-9]{3})(?: .*)?$").matchEntire(lines.first())?.groupValues?.get(1)?.toInt()
        if (status != 101) {
            if (status != null && (status == 408 || status in 500..599)) throw UpdateNetworkFailure("更新节点连接暂不可用。")
            throw UpdateTransportRejected()
        }
        val fields = mutableMapOf<String, String>()
        lines.drop(1).filter { it.isNotEmpty() }.forEach {
            val colon = it.indexOf(':'); require(colon > 0 && !it.startsWith(' ') && !it.startsWith('\t'))
            val name = it.substring(0, colon).lowercase()
            require(name.matches(Regex("^[!#$%&'*+.^_`|~0-9a-z-]+$")))
            val value = it.substring(colon + 1).trim()
            require(value.none { c -> c.code < 32 && c != '\t' })
            if (name == "sec-websocket-accept") require(!fields.containsKey(name))
            fields[name] = if (fields.containsKey(name)) fields[name] + "," + value else value
        }
        require(fields["upgrade"]?.equals("websocket", true) == true)
        require(fields["connection"]?.split(',')?.any { it.trim().equals("upgrade", true) } == true)
        val accept = Base64.getEncoder().encodeToString(MessageDigest.getInstance("SHA-1").digest((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").toByteArray(Charsets.US_ASCII)))
        require(fields["sec-websocket-accept"] == accept && !fields.containsKey("sec-websocket-extensions") && !fields.containsKey("sec-websocket-protocol"))
    }

    fun writeFrame(output: OutputStream, opcode: Int, payload: ByteArray) = synchronized(output) {
        require(payload.size <= MAX_FRAME_BYTES)
        output.write(0x80 or opcode)
        when {
            payload.size < 126 -> output.write(0x80 or payload.size)
            payload.size <= 65535 -> { output.write(0x80 or 126); output.write(payload.size shr 8); output.write(payload.size and 255) }
            else -> { output.write(0x80 or 127); output.write(ByteBuffer.allocate(8).putLong(payload.size.toLong()).array()) }
        }
        val mask = ByteArray(4).also(random::nextBytes)
        output.write(mask)
        val masked = ByteArray(payload.size) { (payload[it].toInt() xor mask[it % 4].toInt()).toByte() }
        output.write(masked)
        output.flush()
    }

    fun copyResponse(input: DataInputStream, control: OutputStream, output: OutputStream, checkActive: () -> Unit) {
        var fragmented = false
        var prefix = 0
        var addons = 0
        val buffer = ByteArray(16 * 1024)
        while (true) {
            checkActive()
            val first = input.readUnsignedByte()
            val second = input.readUnsignedByte()
            val fin = first and 128 != 0
            val opcode = first and 15
            require(first and 0x70 == 0 && second and 128 == 0)
            var length = (second and 127).toLong()
            if (length == 126L) { length = input.readUnsignedShort().toLong(); require(length >= 126) }
            else if (length == 127L) { length = input.readLong(); require(length >= 65536) }
            require(length in 0..MAX_FRAME_BYTES)
            if (opcode >= 8) {
                require(fin && length <= 125 && opcode in setOf(8, 9, 10))
                val bytes = ByteArray(length.toInt()); input.readFully(bytes)
                when (opcode) {
                    8 -> {
                        require(bytes.size != 1)
                        if (bytes.size >= 2) {
                            val code = ((bytes[0].toInt() and 255) shl 8) or (bytes[1].toInt() and 255)
                            require(code in 1000..1014 && code !in setOf(1004, 1005, 1006) || code in 3000..4999)
                            Charsets.UTF_8.newDecoder().decode(ByteBuffer.wrap(bytes, 2, bytes.size - 2))
                        }
                        writeFrame(control, 8, bytes)
                        return
                    }
                    9 -> writeFrame(control, 10, bytes)
                }
                continue
            }
            require(opcode == 2 && !fragmented || opcode == 0 && fragmented)
            fragmented = !fin
            while (length > 0) {
                checkActive()
                val size = minOf(buffer.size.toLong(), length).toInt()
                input.readFully(buffer, 0, size)
                var start = 0
                while (start < size && prefix < 2) {
                    val b = buffer[start++].toInt() and 255
                    if (prefix == 0) require(b == 0) else addons = b
                    prefix++
                }
                val skip = minOf(addons, size - start); start += skip; addons -= skip
                if (start < size) output.write(buffer, start, size - start)
                length -= size
            }
            output.flush()
        }
    }
}
