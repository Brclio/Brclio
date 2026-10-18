package com.brclio.toolbox

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class UpdateProxyConfigTest {
    private fun fixture() = JSONObject("""{"version":1,"ttlSeconds":600,"nodes":[{"uuid":"11111111-2222-4333-8444-555555555555","host":"node.example.com","port":443,"path":"/vless?ed=2048","servername":"node.example.com","wsHost":"node.example.com","dialAddress":"1.1.1.1"}]}""")
    @Test fun acceptsMinimalStrictSchemaWithoutExposingCredentialsInToString() {
        val node = UpdateProxyConfig.parse(fixture().toString()).single()
        assertEquals("node.example.com", node.host)
        assertEquals(443, node.port)
        assertFalse(node.toString().contains("11111111"))
        assertEquals("https://tools.brclio.com/api/client/update-proxy", UpdateProxyConfig.ADDRESS)
    }
    @Test fun rejectsUnsafeOrAmbiguousNodeSettingsWithOneFixedError() {
        val invalid = listOf("host" to "127.0.0.1", "host" to "localhost", "host" to "a.local", "host" to "node.example.com@evil.example", "port" to 80,
            "port" to "443", "port" to 443.5, "uuid" to "1-1-1-1-1", "path" to "/ok\r\nHost: evil", "path" to "ws://evil", "servername" to "evil.example", "wsHost" to "evil.example", "insecure" to true, "skip-cert-verify" to false)
        for ((key,value) in invalid) {
            val root = fixture(); root.getJSONArray("nodes").getJSONObject(0).put(key,value)
            val error = runCatching { UpdateProxyConfig.parse(root.toString()) }.exceptionOrNull()
            assertNotNull("rejected $key", error); assertEquals(UpdateProxyConfig.INVALID, error!!.message)
        }
    }
    @Test fun retainsDifferentDialIpsForTheSameTlsIdentity() {
        val root=fixture();val second=JSONObject(root.getJSONArray("nodes").getJSONObject(0).toString()).put("dialAddress","8.8.8.8")
        root.getJSONArray("nodes").put(second)
        val nodes=UpdateProxyConfig.parse(root.toString())
        assertEquals(2,nodes.size);assertEquals(setOf("1.1.1.1","8.8.8.8"),nodes.map{it.dialAddress}.toSet())
        assertEquals(1,nodes.map{it.host}.toSet().size)
        val missing=fixture();missing.getJSONArray("nodes").getJSONObject(0).remove("dialAddress")
        assertTrue(runCatching{UpdateProxyConfig.parse(missing.toString())}.isFailure)
    }
    @Test fun rejectsPrivateReservedNonCanonicalAndLocalDialAddresses() {
        val invalid=listOf("0.1.2.3","10.0.0.1","100.64.0.1","100.127.255.255","127.0.0.1","169.254.1.1","172.16.0.1","172.31.255.255","192.0.0.9","192.0.2.1","192.88.99.1","192.168.1.1","198.18.0.1","198.19.255.255","198.51.100.1","203.0.113.1","224.0.0.1","240.0.0.1","255.255.255.255","01.1.1.1","1.1.1","2130706433","0x7f000001","1.1.1.256","[::1]","::1","localhost","node.local","node.lan","node.home","node.home.arpa","node.internal","node.test","node.invalid","node.onion","UPPER.example.com")
        for(address in invalid)assertFalse(address,UpdateProxyConfig.isPublicDialAddress(address))
        for(address in listOf("1.1.1.1","8.8.8.8","100.63.255.255","100.128.0.0","172.15.255.255","172.32.0.0","192.0.1.1","198.17.255.255","198.20.0.0","223.255.255.255","node.public.example.com"))assertTrue(address,UpdateProxyConfig.isPublicDialAddress(address))
    }
    @Test fun rejectsUnknownVersionMissingFieldsOversizeAndEmptyNodes() {
        val values = listOf(fixture().put("version",2), fixture().put("ttlSeconds",601), fixture().put("nodes",org.json.JSONArray()))
        for (root in values) assertTrue(runCatching { UpdateProxyConfig.parse(root.toString()) }.isFailure)
        val missing = fixture(); missing.getJSONArray("nodes").getJSONObject(0).remove("wsHost")
        assertTrue(runCatching { UpdateProxyConfig.parse(missing.toString()) }.isFailure)
        assertTrue(runCatching { UpdateProxyConfig.parse(" ".repeat(UpdateProxyConfig.MAX_BYTES + 1)) }.isFailure)
    }
}
