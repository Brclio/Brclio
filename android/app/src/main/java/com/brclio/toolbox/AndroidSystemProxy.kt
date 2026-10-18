package com.brclio.toolbox

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.Uri
import java.net.Proxy
import java.net.ProxySelector
import java.net.URI

/** Detect configured OS routing without changing the app's or device's proxy settings. */
internal object AndroidSystemProxy {
    fun isPresent(context: Context): Boolean {
        val connectivity = context.getSystemService(ConnectivityManager::class.java)
        if (runCatching {
            connectivity?.defaultProxy?.let { proxy ->
                (!proxy.host.isNullOrBlank() && proxy.port > 0) ||
                    (proxy.pacFileUrl != Uri.EMPTY && proxy.pacFileUrl.toString().isNotBlank())
            } == true
        }.getOrDefault(false)) return true
        if (runCatching {
            // Include VPNs that are not the default network for every app.
            connectivity?.allNetworks?.any { network ->
                connectivity?.getNetworkCapabilities(network)?.hasTransport(NetworkCapabilities.TRANSPORT_VPN) == true
            } == true
        }.getOrDefault(false)) return true
        if (listOf("https.proxyHost", "http.proxyHost", "socksProxyHost").any { key ->
            !System.getProperty(key).isNullOrBlank()
        }) return true
        return runCatching {
            ProxySelector.getDefault()?.select(URI("https://api.github.com"))
                ?.any { it.type() != Proxy.Type.DIRECT } == true
        }.getOrDefault(false)
    }
}
