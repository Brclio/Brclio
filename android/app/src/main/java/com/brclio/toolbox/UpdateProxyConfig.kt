package com.brclio.toolbox

import org.json.JSONObject
import java.util.UUID

/** Deliberately has no generated toString: node credentials never belong in UI or logs. */
internal class UpdateProxyNode(val uuid: UUID, val host: String, val port: Int, val path: String, val dialAddress: String)

internal object UpdateProxyConfig {
    const val ADDRESS = "https://tools.brclio.com/api/client/update-proxy"
    const val FALLBACK_ADDRESS = "https://brclio-client-services.aiyuechuang.workers.dev/api/client/update-proxy"
    const val MAX_BYTES = 32 * 1024
    private val dns = Regex("^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z]{2,63}$")
    private val uuid = Regex("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")
    private val ports = setOf(443, 2053, 2083, 2087, 2096, 8443)
    const val INVALID = "内置更新代理配置无效，可关闭内置代理后重试。"

    private fun isPublicDNS(value: String): Boolean = dns.matches(value) &&
        listOf(".localhost", ".local", ".internal", ".lan", ".home", ".home.arpa", ".test", ".invalid", ".example", ".onion").none { value.endsWith(it) }

    internal fun isPublicDialAddress(value: String): Boolean {
        if (!value.matches(Regex("^[0-9.]+$"))) return isPublicDNS(value)
        val parts = value.split('.')
        if (parts.size != 4 || parts.any { !it.matches(Regex("^(?:0|[1-9][0-9]{0,2})$")) }) return false
        val bytes = parts.map { it.toInt() }
        if (bytes.any { it > 255 }) return false
        val (a,b,c) = bytes
        return !(a == 0 || a == 10 || a == 127 || a >= 224 ||
            a == 100 && b in 64..127 || a == 169 && b == 254 || a == 172 && b in 16..31 ||
            a == 192 && (b == 0 && c in setOf(0,2) || b == 88 && c == 99 || b == 168) ||
            a == 198 && (b in 18..19 || b == 51 && c == 100) || a == 203 && b == 0 && c == 113)
    }

    fun parse(text: String): List<UpdateProxyNode> = try {
        require(text.toByteArray(Charsets.UTF_8).size <= MAX_BYTES)
        val root = JSONObject(text)
        require(root.keys().asSequence().toSet() == setOf("version", "ttlSeconds", "nodes"))
        require(root.get("version") == 1 && root.get("ttlSeconds") == 600)
        val nodes = root.getJSONArray("nodes")
        require(nodes.length() in 1..16)
        (0 until nodes.length()).map {
            val node = nodes.getJSONObject(it)
            require(node.keys().asSequence().toSet() == setOf("uuid", "host", "port", "path", "servername", "wsHost", "dialAddress"))
            val host = node.getString("host")
            val id = node.getString("uuid")
            val port = node.get("port")
            val path = node.getString("path")
            require(isPublicDNS(host) && host == node.getString("servername") && host == node.getString("wsHost"))
            val dialAddress = node.getString("dialAddress")
            require(isPublicDialAddress(dialAddress))
            require(port is Int && port in ports && uuid.matches(id))
            require(path.startsWith('/') && path.toByteArray(Charsets.UTF_8).size <= 2048 && path.none { c -> c.code < 32 || c.code == 127 })
            require(!node.has("insecure") && !node.has("skip-cert-verify"))
            UpdateProxyNode(UUID.fromString(id), host, port, path, dialAddress)
        }
    } catch (_: Exception) { throw IllegalStateException(INVALID) }
}
