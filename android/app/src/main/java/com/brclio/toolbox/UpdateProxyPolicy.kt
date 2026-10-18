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
