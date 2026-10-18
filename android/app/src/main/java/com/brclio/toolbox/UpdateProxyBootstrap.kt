package com.brclio.toolbox

import java.io.ByteArrayOutputStream
import java.io.IOException
import java.net.Proxy
import java.net.URL
import java.util.concurrent.atomic.AtomicBoolean
import javax.net.ssl.HttpsURLConnection

/** Only fixed control-plane URLs are requested; node URLs or subscription queries are never sent. */
internal class UpdateProxyBootstrap(
    private val deadline: Long,
    private val isCancelled: () -> Boolean,
    private val requestFactory: (String) -> HttpsURLConnection = { URL(it).openConnection(Proxy.NO_PROXY) as HttpsURLConnection },
) : AutoCloseable {
    private val closed = AtomicBoolean(false)
    @Volatile private var request: HttpsURLConnection? = null
    private class ChallengeFallback : Exception()

    fun fetch(): List<UpdateProxyNode> {
        for ((index,address) in listOf(UpdateProxyConfig.ADDRESS, UpdateProxyConfig.FALLBACK_ADDRESS).withIndex()) {
            checkActive()
            try { return attempt(address,index==0) }
            catch (_: ChallengeFallback) { /* Only a primary 403 + explicit challenge may try the alias. */ }
            catch (_: IOException) {
                checkActive()
                if(index != 0) error("无法获取内置更新代理配置，可关闭内置代理后重试。")
            }
        }
        error("无法获取内置更新代理配置，可关闭内置代理后重试。")
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
            if(primary && status==403 && UpdateProxyPolicy.isCloudflareChallenge(mitigated)) throw ChallengeFallback()
            if(status!=200 || UpdateProxyPolicy.isCloudflareChallenge(mitigated)) error(UpdateProxyPolicy.responseError(status,UpdateProxyRoute.BUILTIN,mitigated))
            val bytes=ByteArrayOutputStream()
            connection.inputStream.use { input ->
                val buffer=ByteArray(4096)
                while(true){
                    checkActive()
                    val count=input.read(buffer)
                    if(count<0)break
                    check(bytes.size()+count<=UpdateProxyConfig.MAX_BYTES){UpdateProxyConfig.INVALID}
                    bytes.write(buffer,0,count)
                }
            }
            checkActive()
            return UpdateProxyConfig.parse(bytes.toString("UTF-8"))
        } finally { connection.disconnect();request=null }
    }
    private fun checkActive(){check(!closed.get() && !isCancelled() && !Thread.currentThread().isInterrupted && System.currentTimeMillis()<deadline){"更新操作已停止或超时。"}}
    override fun close(){closed.set(true);request?.disconnect()}
}
