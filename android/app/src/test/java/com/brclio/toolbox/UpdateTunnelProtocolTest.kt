package com.brclio.toolbox

import org.junit.Assert.*
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.DataInputStream
import java.nio.ByteBuffer
import java.util.UUID

class UpdateTunnelProtocolTest {
    private val node = UpdateProxyNode(UUID.fromString("11111111-2222-4333-8444-555555555555"), "node.example.com",443,"/","1.1.1.1")
    private fun frame(op: Int, bytes: ByteArray, fin: Boolean = true) = byteArrayOf(((if(fin)128 else 0) or op).toByte(),bytes.size.toByte()) + bytes
    private fun decode(bytes: ByteArray): Pair<ByteArray, ByteArray> {
        val output = ByteArrayOutputStream(); val control = ByteArrayOutputStream()
        UpdateTunnelProtocol.copyResponse(DataInputStream(ByteArrayInputStream(bytes)),control,output) {}
        return output.toByteArray() to control.toByteArray()
    }
    @Test fun connectOnlyAllowsExplicitOfficialHttpsHosts() {
        assertEquals("api.github.com",UpdateTunnelProtocol.connectHost("CONNECT api.github.com:443 HTTP/1.1\r\nHost: api.github.com:443\r\n\r\n"))
        for(target in listOf("evil.example:443","api.github.com:80","127.0.0.1:443","user@api.github.com:443","api.github.com.evil.example:443","api.github.com:443/path"))
            assertTrue(runCatching { UpdateTunnelProtocol.connectHost("CONNECT $target HTTP/1.1\r\n\r\n") }.isFailure)
        assertTrue(runCatching { UpdateTunnelProtocol.connectHost("GET https://api.github.com/ HTTP/1.1\r\n\r\n") }.isFailure)
    }
    @Test fun connectParserDoesNotConsumeFollowingTlsRecordAndCapsHeaders() {
        val input = ByteArrayInputStream("CONNECT github.com:443 HTTP/1.1\r\n\r\nTLS".toByteArray())
        UpdateTunnelProtocol.readHeaders(input)
        assertEquals('T'.code,input.read())
        assertTrue(runCatching { UpdateTunnelProtocol.readHeaders(ByteArrayInputStream(ByteArray(17*1024){65})) }.isFailure)
    }
    @Test fun vlessHeaderUsesOriginalDestinationUuidAndTcp443() {
        val header = UpdateTunnelProtocol.vlessRequest(node,"api.github.com")
        assertEquals(0,header[0].toInt());assertEquals(1,header[18].toInt())
        assertEquals(443,ByteBuffer.wrap(header,19,2).short.toInt())
        assertEquals(2,header[21].toInt()); assertEquals("api.github.com",String(header.copyOfRange(23,header.size)))
        assertEquals(node.uuid.mostSignificantBits,ByteBuffer.wrap(header,1,8).long)
    }
    @Test fun stripsVlessPrefixAndAddonsAcrossFramesAndHandlesInterleavedPing() {
        val stream = frame(2,byteArrayOf(0),false)+frame(9,"ping".toByteArray())+frame(0,byteArrayOf(3,9),false)+frame(0,byteArrayOf(8,7)+"TLS".toByteArray())+frame(8,byteArrayOf(3,-24))
        val (out,control)=decode(stream)
        assertEquals("TLS",String(out));assertEquals(0x8a,control[0].toInt() and 255);assertTrue(control[1].toInt() and 128 != 0)
    }
    @Test fun rejectsMaskedRsvTextBadFragmentAndOversizedFramesBeforePayloadRead() {
        val invalid = listOf(byteArrayOf(0x82.toByte(),0x80.toByte()),byteArrayOf(0xc2.toByte(),0),frame(1,byteArrayOf()),frame(0,byteArrayOf()),
            frame(2,byteArrayOf(),false)+frame(2,byteArrayOf()),byteArrayOf(0x09,0),byteArrayOf(0x8b.toByte(),0),
            byteArrayOf(0x82.toByte(),127)+ByteBuffer.allocate(8).putLong(UpdateTunnelProtocol.MAX_FRAME_BYTES+1).array(),
            byteArrayOf(0x82.toByte(),126,0,1),frame(2,byteArrayOf(1,0)))
        invalid.forEach { assertTrue(runCatching { decode(it) }.isFailure) }
    }
    @Test fun validatesCloseCodesAndUtf8Reason() {
        for(bytes in listOf(byteArrayOf(1),byteArrayOf(3,-19),byteArrayOf(3,-24,0xc3.toByte(),0x28)))
            assertTrue(runCatching { decode(frame(8,bytes)) }.isFailure)
    }
    @Test fun websocketUpgradeRequiresStatusAcceptTokensAndNoUnrequestedExtensions() {
        fun attempt(changes: (String) -> String): Boolean {
            val sent=ByteArrayOutputStream()
            val input=object:java.io.InputStream(){
                var source:ByteArrayInputStream?=null
                override fun read():Int {
                    if(source==null){
                        val key=sent.toString("US-ASCII").split("\r\n").first{it.startsWith("Sec-WebSocket-Key:")}.substringAfter(':').trim()
                        val accept=java.util.Base64.getEncoder().encodeToString(java.security.MessageDigest.getInstance("SHA-1").digest((key+"258EAFA5-E914-47DA-95CA-C5AB0DC85B11").toByteArray()))
                        source=ByteArrayInputStream(changes("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: $accept\r\n\r\n").toByteArray())
                    }
                    return source!!.read()
                }
            }
            return runCatching{UpdateTunnelProtocol.upgrade(input,sent,node)}.isSuccess
        }
        assertTrue(attempt{it})
        val mutations:List<(String)->String> = listOf(
            {it.replace("101 Switching Protocols","200 OK")},
            {it.replace("Upgrade: websocket","Upgrade: h2c")},
            {it.replace("Connection: Upgrade","Connection: keep-alive")},
            {it.replace("Sec-WebSocket-Accept:","Sec-WebSocket-Accept: invalid\r\nSec-WebSocket-Accept:")},
            {it.replace("Connection: Upgrade", "Connection: Upgrade\r\nSec-WebSocket-Extensions: permessage-deflate")},
            {it.replace("Connection: Upgrade", "Connection: Upgrade\r\nSec-WebSocket-Protocol: unexpected")},
            {it.replace("Upgrade: websocket", " Upgrade: websocket")}
        )
        mutations.forEach{assertFalse(attempt(it))}
    }
    @Test fun clientFramesAreMaskedAndCancellationInterruptsReceive() {
        val out=ByteArrayOutputStream();UpdateTunnelProtocol.writeFrame(out,2,"secret".toByteArray())
        val bytes=out.toByteArray();assertEquals(0x82,bytes[0].toInt() and 255);assertEquals(0x86,bytes[1].toInt() and 255)
        assertEquals("secret",String(ByteArray(6){(bytes[6+it].toInt() xor bytes[2+it%4].toInt()).toByte()}))
        assertTrue(runCatching { UpdateTunnelProtocol.copyResponse(DataInputStream(ByteArrayInputStream(byteArrayOf())),out,out){error("cancelled")} }.exceptionOrNull()!!.message=="cancelled")
    }
}
