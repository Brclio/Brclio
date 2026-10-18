package com.brclio.toolbox

import java.net.URI
import java.net.URLEncoder

enum class UpdateProxyRoute(val value: String) {
    BUILTIN("builtin"), SYSTEM("system"), DIRECT("direct"),
}

/** This setting belongs to a process session, never to SharedPreferences. */
class UpdateProxySession {
    @Volatile var enabled = true
        private set

    fun setEnabled(value: Boolean) { enabled = value }

    fun route(hasSystemProxy: Boolean): UpdateProxyRoute = when {
        hasSystemProxy -> UpdateProxyRoute.SYSTEM
        enabled -> UpdateProxyRoute.BUILTIN
        else -> UpdateProxyRoute.DIRECT
    }
}

internal object ProcessUpdateProxySession {
    // Activity recreation shares this object; a new app process gets the default again.
    val state = UpdateProxySession()
}

object UpdateProxyPolicy {
    const val RELAY_ORIGIN = "https://tools.brclio.com"
    private val releasePath = Regex("^/Brclio/Brclio/releases/download/v?\\d{1,9}\\.\\d{1,9}\\.\\d{1,9}/(?:Brclio-\\d{1,9}\\.\\d{1,9}\\.\\d{1,9}-android\\.apk|SHA256SUMS\\.txt)$")

    fun isCloudflareChallenge(mitigated: String?): Boolean = mitigated?.trim()?.equals("challenge", ignoreCase = true) == true

    /** Fixed messages only: response bodies, URLs and arbitrary headers are never echoed. */
    fun responseError(status: Int, route: UpdateProxyRoute, mitigated: String? = null): String {
        if (isCloudflareChallenge(mitigated)) return "更新请求被 Cloudflare 安全验证拦截，请稍后重试或切换更新网络。"
        return when (status) {
            200 -> "内置更新代理未返回分段安装包，可关闭内置代理后重试。"
            404 -> "GitHub 尚未发布正式更新。"
            403 -> if (route == UpdateProxyRoute.BUILTIN) "内置更新服务拒绝请求（HTTP 403），可关闭内置代理或稍后重试。"
                else "GitHub 请求受到限制，请稍后重试。"
            429 -> if (route == UpdateProxyRoute.BUILTIN) "内置更新服务暂时限制请求（HTTP 429），可关闭内置代理或稍后重试。"
                else "GitHub 请求受到限制，请稍后重试。"
            in 500..599 -> if (route == UpdateProxyRoute.BUILTIN) "内置更新代理暂不可用，可关闭内置代理后重试。"
                else "更新服务器返回 HTTP $status，请重试。"
            else -> "更新服务器返回 HTTP $status，请重试。"
        }
    }

    /** Only official initial URLs are wrapped; upstream redirect destinations stay server-side. */
    fun allowedSource(address: String): Boolean {
        val uri = runCatching { URI(address) }.getOrNull() ?: return false
        if (uri.scheme != "https" || uri.userInfo != null || uri.port != -1 ||
            uri.rawQuery != null || uri.rawFragment != null) return false
        return when (uri.host) {
            "api.github.com" -> uri.rawPath == "/repos/Brclio/Brclio/releases/latest"
            "github.com" -> releasePath.matches(uri.rawPath.orEmpty())
            else -> false
        }
    }

    fun relayAddress(address: String): String {
        check(allowedSource(address)) { "更新下载地址不受信任。" }
        return "$RELAY_ORIGIN/api/update?url=${URLEncoder.encode(address, "UTF-8")}"
    }
}
