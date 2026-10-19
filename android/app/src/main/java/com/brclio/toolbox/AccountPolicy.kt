package com.brclio.toolbox

import org.json.JSONObject
import java.net.URI
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Base64

/** The renderer may select only these API operations, never an origin or a header. */
object AccountPolicy {
    const val ORIGIN = "https://tools.brclio.com"
    const val MAX_BYTES = 128 * 1024
    private val routes = mapOf(
        "/api/account/session" to setOf("GET"), "/api/account/code" to setOf("POST"),
        "/api/account/register" to setOf("POST"), "/api/account/login" to setOf("POST"),
        "/api/account/logout" to setOf("POST"), "/api/account/data" to setOf("GET", "PUT"),
    )
    fun validate(input: JSONObject): AccountRequest {
        val path = input.optString("path")
        val method = input.optString("method", "GET")
        require(routes[path]?.contains(method) == true) { "账号请求路径或方法无效。" }
        val body = if (input.has("body")) {
            require(method != "GET" && input.opt("body") is JSONObject) { "账号请求数据无效。" }
            input.getJSONObject("body").toString().also {
                require(it.toByteArray(Charsets.UTF_8).size <= MAX_BYTES) { "账号请求数据过大。" }
            }
        } else null
        return AccountRequest(path, method, body)
    }
    fun validToken(token: String): Boolean = token.length in 16..4096 && token.all { it.code in 33..126 }
    fun validDevice(id: String): Boolean = id.matches(Regex("[A-Za-z0-9_-]{16,128}"))
    fun validGoogleUrl(value: String, id: String): Boolean = runCatching {
        val uri = URI(value)
        uri.scheme == "https" && uri.rawAuthority == "tools.brclio.com" &&
            uri.path == "/api/account/google/start" && uri.rawFragment == null &&
            uri.rawQuery?.split('&')?.filter { it.substringBefore('=') == "device" } == listOf("device=$id")
    }.getOrDefault(false)
    fun verifier(): String = base64(ByteArray(32).also { SecureRandom().nextBytes(it) })
    fun challenge(verifier: String): String = base64(MessageDigest.getInstance("SHA-256").digest(verifier.toByteArray(Charsets.US_ASCII)))
    private fun base64(bytes: ByteArray) = Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)
}

data class AccountRequest(val path: String, val method: String, val body: String?)
