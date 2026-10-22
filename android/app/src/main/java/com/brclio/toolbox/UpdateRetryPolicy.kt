package com.brclio.toolbox

import java.io.IOException
import java.io.EOFException
import java.io.InterruptedIOException
import java.net.SocketTimeoutException
import java.net.SocketException
import java.security.cert.CertificateException
import javax.net.ssl.SSLException
import javax.net.ssl.SSLPeerUnverifiedException
import javax.net.ssl.SSLProtocolException

/** Only failures tagged at a network boundary may replay an update, never local file I/O. */
internal open class UpdateNetworkFailure(message: String, cause: Throwable? = null) : IOException(message, cause)
internal class UpdateBootstrapFailure(val nextAddress: String, message: String, cause: Throwable? = null) : UpdateNetworkFailure(message, cause)
internal class UpdateTransportRejected : IllegalStateException("更新节点拒绝请求或返回未经允许的响应。")
internal class UpdateStopped : IllegalStateException("更新操作已取消。")
internal class UpdateRetryExhausted(cause: Throwable?) : IllegalStateException("自动重试已停止，请点击重试重新开始。", cause)

internal object UpdateRetryPolicy {
    const val LIMIT = 10
    fun delayMillis(retryCount: Int): Long = when (retryCount) { 1 -> 1_000; 2 -> 2_000; 3 -> 4_000; else -> 5_000 }
    fun isSecurityFailure(error: Throwable): Boolean {
        val causes = generateSequence<Throwable>(error) { it.cause }.take(16).toList()
        if (causes.any { it is CertificateException || it is SecurityException || it is SSLPeerUnverifiedException || it is SSLProtocolException }) return true
        // Android can wrap a reset/EOF inside SSLException. Preserve those
        // recoverable transports without reclassifying certificate failures.
        return causes.any { it is SSLException } && causes.none {
            it is SocketException || it is SocketTimeoutException || it is EOFException
        }
    }
    fun canRetry(error: Throwable): Boolean = error is UpdateNetworkFailure &&
        !isSecurityFailure(error) && generateSequence<Throwable>(error) { it.cause }.take(16).none {
            it is InterruptedException || it is UpdateStopped || it is InterruptedIOException && it !is SocketTimeoutException
        }
}

internal data class UpdateRetryState(
    val retryCount: Int = 0,
    val retryLimit: Int = UpdateRetryPolicy.LIMIT,
    val retrying: Boolean = false,
    val retryExhausted: Boolean = false,
    val retryStage: String? = null,
    val message: String? = null,
)

/** One retry loop owns attempts, cleanup and backoff for either check or download. */
internal class UpdateRetryController(
    private val now: () -> Long = System::currentTimeMillis,
    private val sleep: (Long) -> Unit = Thread::sleep,
) {
    fun <T> run(
        stage: String,
        deadline: Long,
        isCancelled: () -> Boolean,
        onState: (UpdateRetryState) -> Unit,
        cleanup: () -> Unit,
        attempt: (Int) -> T,
    ): T {
        var retries = 0
        var lastFailure: Throwable? = null
        fun active() {
            if (isCancelled() || Thread.currentThread().isInterrupted) throw UpdateStopped()
            if (now() >= deadline) {
                onState(UpdateRetryState(retries, retryExhausted = false, retryStage = stage,
                    message = "更新已达到操作时限，请点击重试重新开始。"))
                throw UpdateRetryExhausted(lastFailure)
            }
        }
        while (true) {
            active()
            onState(UpdateRetryState(retries, retryStage = stage,
                message = if (retries > 0) "正在进行第 $retries/${UpdateRetryPolicy.LIMIT} 次自动重试…" else null))
            try {
                val value = try { attempt(retries) } finally { cleanup() }
                active()
                onState(UpdateRetryState(retries, retryStage = stage))
                return value
            } catch (failure: Exception) {
                if (isCancelled() || Thread.currentThread().isInterrupted || failure is InterruptedException) throw UpdateStopped()
                if (!UpdateRetryPolicy.canRetry(failure)) throw failure
                lastFailure = failure
                if (retries >= UpdateRetryPolicy.LIMIT || now() >= deadline) {
                    onState(UpdateRetryState(retries, retryExhausted = retries >= UpdateRetryPolicy.LIMIT, retryStage = stage,
                        message = if (now() >= deadline) "更新已达到操作时限，请点击重试重新开始。"
                        else "自动重试 ${UpdateRetryPolicy.LIMIT} 次后仍未完成，请点击重试重新开始。"))
                    throw UpdateRetryExhausted(failure)
                }
                retries++
                val waitUntil = minOf(deadline, now() + UpdateRetryPolicy.delayMillis(retries))
                onState(UpdateRetryState(retries, retrying = true, retryStage = stage,
                    message = "连接暂未成功，稍后进行第 $retries/${UpdateRetryPolicy.LIMIT} 次自动重试…"))
                while (now() < waitUntil) {
                    active()
                    try { sleep(minOf(100, waitUntil - now())) } catch (_: InterruptedException) { throw UpdateStopped() }
                }
            }
        }
    }
}
