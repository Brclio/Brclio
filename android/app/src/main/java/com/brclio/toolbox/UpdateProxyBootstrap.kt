package com.brclio.toolbox

import java.io.ByteArrayOutputStream
import java.io.IOException
import java.net.Proxy
import java.net.URL
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import org.json.JSONObject
import javax.net.ssl.HttpsURLConnection

/** Only fixed control-plane URLs are requested; node URLs or subscription queries are never sent. */
internal class UpdateProxyBootstrap(
    private val deadline: Long,
    private val isCancelled: () -> Boolean,
    private val address: String = UpdateProxyConfig.ADDRESS,
    private val requestFactory: (String) -> HttpsURLConnection = { URL(it).openConnection(Proxy.NO_PROXY) as HttpsURLConnection },
) : AutoCloseable {
    private val closed = AtomicBoolean(false)
    @Volatile private var request: HttpsURLConnection? = null
    private val timer = Executors.newSingleThreadScheduledExecutor { action ->
        Thread(action, "Brclio-update-bootstrap-deadline").apply { isDaemon = true }
    }
    init { timer.schedule({ request?.disconnect() }, maxOf(1, deadline-System.currentTimeMillis()), TimeUnit.MILLISECONDS) }

    fun fetch(): List<UpdateProxyNode> {
        require(address == UpdateProxyConfig.ADDRESS || address == UpdateProxyConfig.FALLBACK_ADDRESS)
        checkActive()
        try { return attempt(address, address == UpdateProxyConfig.ADDRESS) }
        catch (failure: IOException) {
            if (failure is UpdateNetworkFailure) throw failure
            checkActive()
            if (UpdateRetryPolicy.isSecurityFailure(failure)) throw failure
            val next = if (address == UpdateProxyConfig.ADDRESS) UpdateProxyConfig.FALLBACK_ADDRESS else UpdateProxyConfig.ADDRESS
            throw UpdateBootstrapFailure(next, "无法获取内置更新代理配置。", failure)
        }
    }

    private fun attempt(address: String, primary: Boolean): List<UpdateProxyNode> {
        val connection=requestFactory(address)
        request=connection
        try {
            checkActive()
            val remaining=maxOf(1,deadline-System.currentTimeMillis())
            connection.connectTimeout=minOf(15_000L,remaining).toInt()
            connection.readTimeout=minOf(30_000L,remaining).toInt()
            connection.instanceFollowRedirects=false
            connection.useCaches=false
            connection.setRequestProperty("Cache-Control","no-store, no-cache")
            connection.setRequestProperty("User-Agent","Brclio-Android-Update-Config")
            val status=connection.responseCode
            val mitigated=connection.getHeaderField("cf-mitigated")
            checkActive()
            if(primary && status==403 && UpdateProxyPolicy.isCloudflareChallenge(mitigated))
                throw UpdateBootstrapFailure(UpdateProxyConfig.FALLBACK_ADDRESS, "配置入口需要安全验证，下一次尝试使用合法备用入口。")
            if(status!=200 || UpdateProxyPolicy.isCloudflareChallenge(mitigated)) {
                val message = UpdateProxyPolicy.responseError(status,UpdateProxyRoute.BUILTIN,mitigated)
                if (status == 502 && !UpdateProxyPolicy.isCloudflareChallenge(mitigated)) {
                    val document = readBody(connection,status)
                    if (runCatching { JSONObject(document).optString("code") }.getOrNull() == "proxy_configuration_unsupported")
                        error(UpdateProxyConfig.INVALID)
                }
                if (!UpdateProxyPolicy.isCloudflareChallenge(mitigated) && (status == 408 || status in 500..599)) throw UpdateNetworkFailure(message)
                error(message)
            }
            return UpdateProxyConfig.parse(readBody(connection,status))
        } finally { connection.disconnect();request=null }
    }
    private fun readBody(connection: HttpsURLConnection, status: Int): String {
        val bytes=ByteArrayOutputStream()
        val input = if (status == 200) connection.inputStream else connection.errorStream
        input?.use {
            val buffer=ByteArray(4096)
            while(true){
                checkActive()
                connection.readTimeout=minOf(30_000L,maxOf(1,deadline-System.currentTimeMillis())).toInt()
                val count=it.read(buffer)
                if(count<0)break
                check(bytes.size()+count<=UpdateProxyConfig.MAX_BYTES){UpdateProxyConfig.INVALID}
                bytes.write(buffer,0,count)
            }
        }
        checkActive()
        return bytes.toString("UTF-8")
    }
    private fun checkActive(){
        if (closed.get() || isCancelled() || Thread.currentThread().isInterrupted) throw UpdateStopped()
        if (System.currentTimeMillis()>=deadline) throw UpdateNetworkFailure("更新引导超时。")
    }
    override fun close(){closed.set(true);timer.shutdownNow();request?.disconnect()}
}
