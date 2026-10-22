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
import java.util.concurrent.atomic.AtomicReference
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
    private class Fixture(private val outer: SSLContext, inner: SSLContext, private val hang: Boolean=false, private val wrongAccept: Boolean=false, private val deniedStatus: Int?=null, private val oneWayChunks: Int=0) : AutoCloseable {
        val encryptedClientHello = CountDownLatch(1)
        val blockedRequest = CountDownLatch(1)
        val innerRequests=AtomicInteger()
        val responseBody=if(oneWayChunks>0)ByteArray(oneWayChunks*1024){(it%251).toByte()}else "verified-through-two-real-TLS-layers".toByteArray()
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
                            if(hang){blockedRequest.countDown();CountDownLatch(1).await();return@execute}
                            val body=responseBody
                            socket.getOutputStream().write("HTTP/1.1 200 OK\r\nContent-Length: ${body.size}\r\nConnection: close\r\n\r\n".toByteArray())
                            if(!headers.startsWith("HEAD ")) {
                                if(oneWayChunks>0) repeat(oneWayChunks) { chunk ->
                                    if(chunk>0)Thread.sleep(250)
                                    socket.getOutputStream().write(body,chunk*1024,1024)
                                    socket.getOutputStream().flush()
                                } else socket.getOutputStream().write(body)
                            }
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
                // This test server must also allow a one-way response after its
                // client finishes sending; production upstream idle limits remain unchanged.
                if(oneWayChunks>0)socket.soTimeout=0
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
    private fun assertListenerClosed(proxy:NativeUpdateProxy) {
        val listener=NativeUpdateProxy::class.java.getDeclaredField("server").apply{isAccessible=true}.get(proxy) as java.net.ServerSocket
        // A released ephemeral port can already belong to another fixture/process.
        // Assert ownership of the actual listener rather than redialing its former address.
        assertTrue("This proxy's own listener must be closed",listener.isClosed)
    }
    @Test fun actualWssConnectAndInnerHttpsUseTwoRealVerifiedTlsLayers(){
        Fixture(valid.context,valid.context).use{fixture->bridge(fixture,valid.context.socketFactory).use{proxy->
            val connection=request(proxy,valid.context.socketFactory)
            try{assertEquals("verified-through-two-real-TLS-layers",connection.inputStream.bufferedReader().readText());assertTrue(fixture.encryptedClientHello.await(1,TimeUnit.SECONDS));assertEquals(1,fixture.innerRequests.get())}finally{connection.disconnect()}
        }}
    }
    @Test fun downloadTunnelUsesRealTlsWithoutSchedulingAnOperationLifetimeTimer() {
        Fixture(valid.context,valid.context).use { fixture ->
            val previousTimers=Thread.getAllStackTraces().keys.filter { it.isAlive&&it.name=="Brclio-update-deadline" }.toSet()
            NativeUpdateProxy(listOf(node()),null,valid.context.socketFactory){InetSocketAddress("127.0.0.1",fixture.port)}.use { proxy ->
                val connection=request(proxy,valid.context.socketFactory)
                try {
                    assertEquals("verified-through-two-real-TLS-layers",connection.inputStream.bufferedReader().readText())
                    assertTrue("A download tunnel must not schedule a total-lifetime shutdown",Thread.getAllStackTraces().keys.none {
                        it.isAlive&&it.name=="Brclio-update-deadline"&&it !in previousTimers
                    })
                } finally { connection.disconnect() }
            }
        }
    }
    @Test fun continuousOneWayDownloadOutlivesThirtySecondsWithoutClientWrites() {
        Fixture(valid.context,valid.context,oneWayChunks=132).use { fixture ->
            NativeUpdateProxy(listOf(node()),null,valid.context.socketFactory){InetSocketAddress("127.0.0.1",fixture.port)}.use { proxy ->
                val connection=request(proxy,valid.context.socketFactory)
                val started=System.nanoTime()
                try {
                    val actual=connection.inputStream.use { it.readBytes() }
                    assertArrayEquals("Continuous download bytes must survive an idle upload direction",fixture.responseBody,actual)
                    assertTrue("The real response must exceed the former 30-second directional timeout",TimeUnit.NANOSECONDS.toMillis(System.nanoTime()-started)>=32_000)
                    assertEquals(1,fixture.innerRequests.get())
                } finally { connection.disconnect() }
            }
        }
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
            // responseCode may return -1 on EOF; reading requires a real HTTP response.
            val result=pool.submit<Boolean>{runCatching{connection.inputStream.read()}.isFailure}
            try {
                assertTrue("The request must reach blocked HTTP I/O",fixture.blockedRequest.await(2,TimeUnit.SECONDS))
                assertFalse("The request must remain blocked before close",result.isDone)
                proxy.close()
                assertTrue("Closing the proxy must cancel blocked I/O",result.get(2,TimeUnit.SECONDS))
                assertListenerClosed(proxy)
            } finally {
                proxy.close();connection.disconnect();result.cancel(true);pool.shutdownNow()
            }
        }
    }
    @Test fun closeToleratesAConcurrentSocketSetShrinkingBeforeIteration() {
        val proxy=NativeUpdateProxy(listOf(node()),System.currentTimeMillis()+8000)
        // A concurrent set's size can be observed as one just before its last entry is removed.
        val shrinking=object:AbstractMutableSet<Socket>() {
            override val size get()=1
            override fun add(element:Socket)=false
            override fun iterator()=mutableSetOf<Socket>().iterator()
        }
        NativeUpdateProxy::class.java.getDeclaredField("sockets").apply{isAccessible=true}.set(proxy,shrinking)
        val workers=listOf("executor","timer").map { name ->
            NativeUpdateProxy::class.java.getDeclaredField(name).apply{isAccessible=true}.get(proxy) as java.util.concurrent.ExecutorService
        }
        try {
            proxy.close()
            assertTrue("Closing must shut down both worker pools",workers.all{it.isShutdown})
            assertListenerClosed(proxy)
        } finally {
            proxy.close();workers.forEach{it.shutdownNow()}
        }
    }
    @Test fun socketsRegisteredAfterCloseAreDisposedBeforeDialOrTlsHandshake() {
        for(stage in listOf("tcp","tls")) java.net.ServerSocket(0,8,java.net.InetAddress.getLoopbackAddress()).use { destination ->
            val dials=AtomicInteger()
            val proxy=NativeUpdateProxy(listOf(node()),System.currentTimeMillis()+8000,valid.context.socketFactory){
                dials.incrementAndGet();InetSocketAddress("127.0.0.1",destination.localPort)
            }
            val raw=AtomicReference<Socket>()
            val late=AtomicReference<Socket>()
            val registered=CountDownLatch(1)
            val entries=java.util.concurrent.ConcurrentHashMap.newKeySet<Socket>()
            val tracker=object:MutableSet<Socket> by entries {
                override fun add(element:Socket):Boolean {
                    if(element !is SSLSocket&&!element.isConnected)raw.compareAndSet(null,element)
                    val selected=if(stage=="tcp")!element.isConnected else element is SSLSocket
                    if(selected&&late.compareAndSet(null,element)) {
                        if(element is SSLSocket)element.sslParameters=element.sslParameters.apply{endpointIdentificationAlgorithm=null}
                        proxy.close() // Close before this new socket becomes visible to the tracker.
                    }
                    val added=entries.add(element)
                    if(late.get()===element)registered.countDown()
                    return added
                }
            }
            NativeUpdateProxy::class.java.getDeclaredField("sockets").apply{isAccessible=true}.set(proxy,tracker)
            try {
                val address=proxy.proxy.address() as InetSocketAddress
                Socket(address.address,address.port).use { client ->
                    client.soTimeout=2000
                    client.getOutputStream().apply{write("CONNECT github.com:443 HTTP/1.1\r\nHost: github.com:443\r\n\r\n".toByteArray());flush()}
                    assertTrue("The $stage registration race must be reached",registered.await(2,TimeUnit.SECONDS))
                    val ended=runCatching{client.getInputStream().read()}
                    assertTrue("Closing must terminate the local connection",ended.isFailure||ended.getOrNull()==-1)
                }
                UpdateProxyThreadAssertions.awaitIdle()
                assertTrue("The late $stage socket must be closed",late.get().isClosed)
                assertTrue("The raw transport must be closed",raw.get().isClosed)
                assertEquals("No dial may start after close",if(stage=="tcp")0 else 1,dials.get())
                if(stage=="tls")assertNull("TLS must not be configured or started after close",(late.get() as SSLSocket).sslParameters.endpointIdentificationAlgorithm)
                assertListenerClosed(proxy)
            } finally {proxy.close()}
        }
    }
    companion object {
        private val valid by lazy { Certificates("dns:api.github.com,dns:github.com,dns:node.fixture.example,dns:*.fixture.example") }
        private val wrong by lazy { Certificates("dns:wrong.fixture.example") }
    }
}
