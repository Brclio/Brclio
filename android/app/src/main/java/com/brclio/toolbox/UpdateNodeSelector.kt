package com.brclio.toolbox

import java.net.URL
import java.util.Collections
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ExecutorCompletionService
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import javax.net.ssl.HttpsURLConnection

/** Fresh, bounded end-to-end tests; a WSS front door alone is never a successful probe. */
internal class UpdateNodeSelector(
    private val bridgeFactory: (UpdateProxyNode, Long) -> NativeUpdateProxy = { node, deadline -> NativeUpdateProxy(listOf(node), deadline) },
    private val requestFactory: (NativeUpdateProxy) -> HttpsURLConnection = { bridge -> URL(PROBE_ADDRESS).openConnection(bridge.proxy) as HttpsURLConnection },
) : AutoCloseable {
    private val closed = AtomicBoolean(false)
    private val bridges = Collections.newSetFromMap(ConcurrentHashMap<NativeUpdateProxy, Boolean>())
    private val requests = Collections.newSetFromMap(ConcurrentHashMap<HttpsURLConnection, Boolean>())
    private val executor = Executors.newFixedThreadPool(16) { task -> Thread(task, "Brclio-update-probe").apply { isDaemon = true } }
    private class Result(val node: UpdateProxyNode, val nanos: Long)

    fun select(nodes: List<UpdateProxyNode>, operationDeadline: Long): UpdateProxyNode {
        val deadline = minOf(operationDeadline, System.currentTimeMillis() + TOTAL_TIMEOUT)
        val completions = ExecutorCompletionService<Result?>(executor)
        val futures = nodes.map { node -> completions.submit(java.util.concurrent.Callable {
            if (closed.get() || System.currentTimeMillis() >= deadline) return@Callable null
            val started = System.nanoTime()
            var bridge: NativeUpdateProxy? = null
            var request: HttpsURLConnection? = null
            try {
                check(!closed.get())
                val created = bridgeFactory(node, minOf(deadline, System.currentTimeMillis() + NODE_TIMEOUT))
                bridge = created
                bridges.add(created)
                check(!closed.get())
                request = requestFactory(created).apply {
                    requests.add(this)
                    connectTimeout = NODE_TIMEOUT.toInt()
                    readTimeout = NODE_TIMEOUT.toInt()
                    instanceFollowRedirects = false
                    useCaches = false
                    requestMethod = "HEAD"
                    setRequestProperty("Connection", "close")
                    setRequestProperty("User-Agent", "Brclio-Android-Update-Probe")
                    setRequestProperty("Accept", "application/vnd.github+json")
                }
                val status = request.responseCode
                if (!closed.get() && System.currentTimeMillis() < deadline && status == 200 &&
                    !UpdateProxyPolicy.isCloudflareChallenge(request.getHeaderField("cf-mitigated"))) Result(node, System.nanoTime() - started)
                else null
            } catch (_: Exception) { null }
            finally {
                request?.let { requests.remove(it); it.disconnect() }
                bridge?.let { bridges.remove(it); it.close() }
            }
        }) }
        var best: Result? = null
        try {
            repeat(nodes.size) {
                check(!closed.get() && !Thread.currentThread().isInterrupted) { "下载已停止。" }
                val remaining = deadline - System.currentTimeMillis()
                if (remaining <= 0) return@repeat
                val result = completions.poll(remaining, TimeUnit.MILLISECONDS)?.get()
                if (result != null && (best == null || result.nanos < best!!.nanos)) best = result
            }
            check(!closed.get() && !Thread.currentThread().isInterrupted) { "下载已停止。" }
            return best?.node ?: error("内置更新代理节点均不可用，可关闭内置代理后重试。")
        } finally {
            futures.forEach { it.cancel(true) }
            close()
        }
    }

    override fun close() {
        if (!closed.compareAndSet(false, true)) return
        // Close the transport first: disconnect can wait for a blocked HttpsURLConnection read.
        bridges.toList().forEach { it.close() }
        requests.toList().forEach { it.disconnect() }
        executor.shutdownNow()
    }

    companion object {
        const val PROBE_ADDRESS = "https://github.com/robots.txt"
        const val NODE_TIMEOUT = 4_000L
        const val TOTAL_TIMEOUT = 8_000L
    }
}
