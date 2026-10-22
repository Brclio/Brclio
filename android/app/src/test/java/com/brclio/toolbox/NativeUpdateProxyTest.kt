package com.brclio.toolbox

import org.junit.Assert.*
import org.junit.Test
import org.junit.After
import java.io.ByteArrayOutputStream
import java.io.DataInputStream
import java.io.OutputStream
import java.net.InetSocketAddress
import java.net.Socket
import java.net.URL
import java.nio.ByteBuffer
import java.nio.file.Files
import java.security.KeyStore
import java.security.MessageDigest
import java.util.Base64
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import javax.net.ssl.*

class NativeUpdateProxyTest {
    /** All sockets are local. These throwaway fixture keys are unrelated to Android signing. */
    @After fun noOperationThreadsLinger() = UpdateProxyThreadAssertions.awaitIdle()

    private class Certificates(names: String) {
        val context: SSLContext
        init {
            val directory = Files.createTempDirectory("brclio-test-tls").toFile()
            val store = directory.resolve("fixture.p12")
            val keytool = java.io.File(System.getProperty("java.home"),"bin/keytool").path
            val process = ProcessBuilder(keytool,"-genkeypair","-alias","fixture","-keyalg","EC","-groupname","secp256r1","-validity","2","-dname","CN=Offline Fixture","-ext","SAN=$names","-storetype","PKCS12","-keystore",store.path,"-storepass","fixture-password","-keypass","fixture-password","-noprompt").redirectErrorStream(true).start()
            process.inputStream.use { it.copyTo(OutputStream.nullOutputStream()) }
            check(process.waitFor()==0)
            val keys=KeyStore.getInstance("PKCS12").apply { store.inputStream().use { load(it,"fixture-password".toCharArray()) } }
            val km=KeyManagerFactory.getInstance(KeyManagerFactory.getDefaultAlgorithm()).apply { init(keys,"fixture-password".toCharArray()) }
            val tm=TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm()).apply { init(keys) }
            context=SSLContext.getInstance("TLS").apply { init(km.keyManagers,tm.trustManagers,null) }
            directory.deleteRecursively()
        }
    }
    private class Fixture(private val outer: SSLContext, inner: SSLContext, private val hang: Boolean=false, private val wrongAccept: Boolean=false, private val deniedStatus: Int?=null) : AutoCloseable {
        val encryptedClientHello = CountDownLatch(1)
        val innerRequests=AtomicInteger()
        private val pool=Executors.newCachedThreadPool { task -> Thread(task,"offline-tls-fixture").apply { isDaemon=true } }
        private val sockets=java.util.concurrent.ConcurrentHashMap.newKeySet<Socket>()
        private val origin=(inner.serverSocketFactory.createServerSocket(0,8,java.net.InetAddress.getLoopbackAddress()) as SSLServerSocket)
        private val front=(outer.serverSocketFactory.createServerSocket(0,8,java.net.InetAddress.getLoopbackAddress()) as SSLServerSocket)
        val port get()=front.localPort
        init {
            pool.execute {
                while(!origin.isClosed) {
                    val socket=try { origin.accept() } catch(_:Exception){break}; sockets.add(socket)
                    pool.execute {
                        try {
                            socket.soTimeout=4000
                            val headers=UpdateTunnelProtocol.readHeaders(socket.getInputStream());innerRequests.incrementAndGet()
                            if(hang){Thread.sleep(10000);return@execute}
                            val body="verified-through-two-real-TLS-layers".toByteArray()
                            socket.getOutputStream().write("HTTP/1.1 200 OK\r\nContent-Length: ${body.size}\r\nConnection: close\r\n\r\n".toByteArray())
                            if(!headers.startsWith("HEAD "))socket.getOutputStream().write(body)
                            socket.getOutputStream().flush()
                        }catch(_:Exception){}finally{socket.close();sockets.remove(socket)}
                    }
                }
            }
            pool.execute {
                while(!front.isClosed){
                    val socket=try{front.accept()}catch(_:Exception){break};sockets.add(socket)
                    pool.execute { handle(socket) }
                }
            }
        }
        private fun handle(socket:Socket){
            var destination:Socket?=null
            try{
                socket.soTimeout=4000
                val headers=UpdateTunnelProtocol.readHeaders(socket.getInputStream())
                val key=headers.split("\r\n").first{it.startsWith("Sec-WebSocket-Key:")}.substringAfter(':').trim()
                val accept=if(wrongAccept)"invalid" else Base64.getEncoder().encodeToString(MessageDigest.getInstance("SHA-1").digest((key+"258EAFA5-E914-47DA-95CA-C5AB0DC85B11").toByteArray()))
                val out=socket.getOutputStream()
                if(deniedStatus!=null){out.write("HTTP/1.1 $deniedStatus Rejected\r\nContent-Length: 0\r\n\r\n".toByteArray());out.flush();return}
                out.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: keep-alive, Upgrade\r\nSec-WebSocket-Accept: $accept\r\n\r\n".toByteArray());out.flush()
                if(wrongAccept)return
                val input=DataInputStream(socket.getInputStream())
                val first=readClientFrame(input)
                check(first[0].toInt()==0 && first[18].toInt()==1 && first[21].toInt()==2)
                val hostSize=first[22].toInt() and 255
                check(String(first,23,hostSize)=="github.com")
                val tls=first.copyOfRange(23+hostSize,first.size)
                check(tls[0].toInt()==22) // Actual inner TLS ClientHello, never an HTTP request in cleartext.
                encryptedClientHello.countDown()
                destination=Socket("127.0.0.1",origin.localPort);sockets.add(destination)
                val target=destination
                target.getOutputStream().write(tls);target.getOutputStream().flush()
                pool.execute {
                    try{
                        // VLESS response header and addon deliberately split across WS messages.
                        serverFrame(out,byteArrayOf(0));serverFrame(out,byteArrayOf(2,9));serverFrame(out,byteArrayOf(8))
                        val buffer=ByteArray(8192)
                        while(true){val size=target.getInputStream().read(buffer);if(size<0)break;serverFrame(out,buffer.copyOf(size))}
                    }catch(_:Exception){}finally{socket.close();target.close()}
                }
                while(true){val payload=readClientFrame(input);target.getOutputStream().write(payload);target.getOutputStream().flush()}
            }catch(_:Exception){}finally{destination?.close();socket.close();sockets.remove(socket);destination?.let{sockets.remove(it)}}
        }
        private fun readClientFrame(input:DataInputStream):ByteArray{
            check(input.readUnsignedByte()==0x82)
            val b=input.readUnsignedByte();check(b and 128 != 0)
            val length=when(val n=b and 127){126->input.readUnsignedShort();127->input.readLong().toInt();else->n}
            check(length in 0..(1024*1024));val mask=ByteArray(4);input.readFully(mask)
            return ByteArray(length).also{input.readFully(it);for(i in it.indices)it[i]=(it[i].toInt() xor mask[i%4].toInt()).toByte()}
        }
        private fun serverFrame(output:OutputStream,bytes:ByteArray)=synchronized(output){
            output.write(0x82)
            if(bytes.size<126)output.write(bytes.size) else{output.write(126);output.write(bytes.size shr 8);output.write(bytes.size and 255)}
            output.write(bytes);output.flush()
        }
        override fun close(){front.close();origin.close();sockets.forEach{runCatching{it.close()}};pool.shutdownNow()}
    }
    private fun node(host:String="node.fixture.example")=UpdateProxyNode(UUID.fromString("11111111-2222-4333-8444-555555555555"),host,443,"/fixture","1.1.1.1")
    private fun bridge(fixture:Fixture,factory:SSLSocketFactory,host:String="node.fixture.example")=NativeUpdateProxy(listOf(node(host)),System.currentTimeMillis()+8000,factory){InetSocketAddress("127.0.0.1",fixture.port)}
    private fun request(proxy:NativeUpdateProxy,trust:SSLSocketFactory)=(URL(UpdateNodeSelector.PROBE_ADDRESS).openConnection(proxy.proxy) as HttpsURLConnection).apply{
        sslSocketFactory=trust;connectTimeout=2000;readTimeout=2000;setRequestProperty("Connection","close")
    }
    @Test fun actualWssConnectAndInnerHttpsUseTwoRealVerifiedTlsLayers(){
        Fixture(valid.context,valid.context).use{fixture->bridge(fixture,valid.context.socketFactory).use{proxy->
            val connection=request(proxy,valid.context.socketFactory)
            try{assertEquals("verified-through-two-real-TLS-layers",connection.inputStream.bufferedReader().readText());assertTrue(fixture.encryptedClientHello.await(1,TimeUnit.SECONDS));assertEquals(1,fixture.innerRequests.get())}finally{connection.disconnect()}
        }}
    }
    @Test fun websocketDenialsAndRedirectsRemainPermanentAcrossTheLocalConnectBoundary() {
        for(status in listOf(403,429,302)) Fixture(valid.context,valid.context,deniedStatus=status).use { fixture ->
            bridge(fixture,valid.context.socketFactory).use { proxy ->
                val connection=request(proxy,valid.context.socketFactory)
                try {
                    assertTrue(runCatching{connection.inputStream.read()}.isFailure)
                    assertTrue(proxy.terminalFailure is UpdateTransportRejected)
                    assertFalse(UpdateRetryPolicy.canRetry(proxy.terminalFailure!!))
                } finally { connection.disconnect() }
            }
        }
    }
    @Test fun fastestNodeProbePerformsRealEndToEndHttpsHead() {
        Fixture(valid.context,valid.context).use { fixture ->
            val selector=UpdateNodeSelector({node,deadline -> NativeUpdateProxy(listOf(node),deadline,valid.context.socketFactory){InetSocketAddress("127.0.0.1",fixture.port)}},{bridge -> request(bridge,valid.context.socketFactory)})
            val candidate=node()
            assertSame(candidate,selector.select(listOf(candidate),System.currentTimeMillis()+8000))
            assertEquals(1,fixture.innerRequests.get())
            assertTrue(fixture.encryptedClientHello.await(1,TimeUnit.SECONDS))
        }
    }
    @Test fun dialsAnIpButStillVerifiesTheConfiguredDnsTlsIdentity() {
        Fixture(valid.context,valid.context).use { fixture ->
            // Direct construction is fixture-only; the production parser rejects loopback.
            for(host in listOf("node.fixture.example","wrong.other.example")) {
                val candidate=UpdateProxyNode(UUID.randomUUID(),host,fixture.port,"/fixture","127.0.0.1")
                NativeUpdateProxy(listOf(candidate),System.currentTimeMillis()+4000,valid.context.socketFactory).use { proxy ->
                    val connection=request(proxy,valid.context.socketFactory)
                    try { assertEquals(host=="node.fixture.example",runCatching{connection.inputStream.bufferedReader().readText()}.isSuccess) }
                    finally {connection.disconnect()}
                }
            }
            assertEquals(1,fixture.innerRequests.get())
        }
    }
    @Test fun outerTlsRejectsUntrustedCertificateAndWrongHostname(){
        Fixture(valid.context,valid.context).use{fixture->
            for((factory,host) in listOf((SSLSocketFactory.getDefault() as SSLSocketFactory) to "node.fixture.example",valid.context.socketFactory to "wrong.other.example")){
                bridge(fixture,factory,host).use{proxy->val connection=request(proxy,valid.context.socketFactory);try{assertTrue(runCatching{connection.responseCode}.isFailure)}finally{connection.disconnect()}}
            }
            assertEquals(0,fixture.innerRequests.get())
        }
    }
    @Test fun innerTlsIndependentlyRejectsWrongHostnameAndUntrustedCertificate(){
        Fixture(valid.context,wrong.context).use{fixture->bridge(fixture,valid.context.socketFactory).use{proxy->
            val connection=request(proxy,wrong.context.socketFactory);try{assertTrue(runCatching{connection.responseCode}.isFailure)}finally{connection.disconnect()}
        }}
        Fixture(valid.context,valid.context).use{fixture->bridge(fixture,valid.context.socketFactory).use{proxy->
            val connection=request(proxy,SSLSocketFactory.getDefault() as SSLSocketFactory);try{assertTrue(runCatching{connection.responseCode}.isFailure)}finally{connection.disconnect()}
        }}
    }
    @Test fun invalidWebsocketAcceptNeverOpensInnerTls(){
        Fixture(valid.context,valid.context,wrongAccept=true).use{fixture->bridge(fixture,valid.context.socketFactory).use{proxy->
            val connection=request(proxy,valid.context.socketFactory);try{assertTrue(runCatching{connection.responseCode}.isFailure);assertEquals(0,fixture.innerRequests.get())}finally{connection.disconnect()}
        }}
    }
    @Test fun closeCancelsBlockedIoAndRejectsNewConnections(){
        Fixture(valid.context,valid.context,hang=true).use{fixture->
            val proxy=bridge(fixture,valid.context.socketFactory)
            val connection=request(proxy,valid.context.socketFactory);connection.readTimeout=10000
            val pool=Executors.newSingleThreadExecutor()
            val result=pool.submit<Boolean>{runCatching{connection.responseCode}.isFailure}
            assertTrue(fixture.encryptedClientHello.await(2,TimeUnit.SECONDS));proxy.close()
            assertTrue(result.get(2,TimeUnit.SECONDS));assertTrue(runCatching{Socket((proxy.proxy.address() as InetSocketAddress).address,(proxy.proxy.address() as InetSocketAddress).port)}.isFailure)
            connection.disconnect();pool.shutdownNow()
        }
    }
    companion object {
        private val valid by lazy { Certificates("dns:api.github.com,dns:github.com,dns:node.fixture.example,dns:*.fixture.example") }
        private val wrong by lazy { Certificates("dns:wrong.fixture.example") }
    }
}
