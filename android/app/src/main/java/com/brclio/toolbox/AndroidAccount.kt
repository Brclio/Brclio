package com.brclio.toolbox

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Handler
import android.os.Looper
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.net.URL
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.CountDownLatch
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import javax.net.ssl.HttpsURLConnection

/** Network and bearer tokens stay outside the bundled WebView. */
class AndroidAccount(private val activity: Activity) {
    private val preferences = activity.getSharedPreferences("brclio-account", Activity.MODE_PRIVATE)
    private val worker = ThreadPoolExecutor(2, 2, 30, TimeUnit.SECONDS, ArrayBlockingQueue(16))
    private val handler = Handler(Looper.getMainLooper())
    private val authVersion = AtomicInteger(0)
    private val connections = mutableSetOf<HttpsURLConnection>()
    private val lock = Any()
    @Volatile private var closed = false
    @Volatile private var csrf = ""
    @Volatile private var google: GoogleOperation? = null

    private class GoogleOperation {
        @Volatile var canceled = false
        @Volatile var timedOut = false
        @Volatile var connection: HttpsURLConnection? = null
    }

    fun request(input: JSONObject, callback: (JSONObject?, String?) -> Unit) {
        // Reject malformed requests before consuming a native worker thread.
        val request = AccountPolicy.validate(input)
        if (request.cancelsGoogle) cancelGoogle()
        val version = if (request.changesAuth) authVersion.incrementAndGet() else authVersion.get()
        execute(callback) {
            try { accept(raw(request.path, request.method, request.body), version) }
            finally {
                if (request.path == "/api/account/logout" && version == authVersion.get()) {
                    saveToken(null)
                    csrf = ""
                }
            }
        }
    }

    fun google(callback: (JSONObject?, String?) -> Unit) {
        val operation = synchronized(lock) {
            check(google == null) { "请先完成或取消当前谷歌登录。" }
            GoogleOperation().also { google = it }
        }
        val version = authVersion.incrementAndGet()
        val timeout = Runnable { operation.timedOut = true; operation.canceled = true; operation.connection?.disconnect() }
        handler.postDelayed(timeout, TimeUnit.MINUTES.toMillis(5))
        execute(callback, { handler.removeCallbacks(timeout); synchronized(lock) { if (google === operation) google = null } }) {
          try {
            val verifier = AccountPolicy.verifier()
            val deadline = System.nanoTime() + TimeUnit.MINUTES.toNanos(5)
            val started = raw("/api/account/device/start", "POST", JSONObject()
                .put("challenge", AccountPolicy.challenge(verifier)).toString(), operation)
            val id = started.optString("id")
            val url = started.optString("url")
            check(AccountPolicy.validDevice(id) && AccountPolicy.validGoogleUrl(url, id)) { "谷歌登录链接无效。" }
            checkActive(operation)
            val opened = CountDownLatch(1)
            var launchError: Exception? = null
            activity.runOnUiThread {
                try {
                    checkActive(operation)
                    activity.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
                } catch (error: Exception) { launchError = error }
                finally { opened.countDown() }
            }
            check(opened.await(10, TimeUnit.SECONDS)) { "无法打开系统浏览器，请重试。" }
            launchError?.let { throw it }
            while (System.nanoTime() < deadline) {
                // Short intervals allow cancellation without waiting for a network timeout.
                repeat(20) { checkActive(operation); Thread.sleep(100) }
                val result = raw("/api/account/device/poll?id=$id&verifier=$verifier", "GET", null, operation)
                if (result.optBoolean("pending")) continue
                check(result.opt("token") is String && result.opt("user") is JSONObject) { "谷歌登录尚未完成，请重试。" }
                return@execute accept(result, version, operation)
            }
            error("谷歌登录已超时，请重新登录。")
          } catch (error: Exception) {
              if (operation.timedOut) error("谷歌登录已超时，请重新登录。")
              if (operation.canceled) error("谷歌登录已取消，请重新登录。")
              throw error
          }
        }
    }

    fun cancelGoogle(): JSONObject {
        val connection = synchronized(lock) {
            google?.let { it.canceled = true; it.connection }
        }
        connection?.disconnect()
        return JSONObject().put("canceled", true)
    }

    private fun checkActive(operation: GoogleOperation? = null) {
        check(!closed && !Thread.currentThread().isInterrupted) { "账号操作已停止。" }
        check(operation?.canceled != true) { "谷歌登录已取消，请重新登录。" }
    }

    private fun accept(result: JSONObject, version: Int, operation: GoogleOperation? = null): JSONObject = synchronized(lock) {
        checkActive(operation)
        check(version == authVersion.get()) { "账号状态已变化，请重新登录。" }
        if (result.has("token")) {
            val token = result.optString("token")
            check(AccountPolicy.validToken(token)) { "账号会话数据无效。" }
            saveToken(token)
            result.remove("token")
        }
        if (result.opt("csrf") is String) csrf = result.getString("csrf")
        result
    }

    private fun saveToken(token: String?) {
        val editor = preferences.edit()
        if (token == null) editor.remove("token") else editor.putString("token", token)
        check(editor.commit()) { "无法保存账号会话，请重试。" }
    }

    private fun raw(path: String, method: String, body: String?, operation: GoogleOperation? = null): JSONObject {
        checkActive(operation)
        val connection = URL(AccountPolicy.ORIGIN + path).openConnection() as HttpsURLConnection
        synchronized(lock) { connections.add(connection) }
        operation?.connection = connection
        try {
            connection.requestMethod = method
            connection.instanceFollowRedirects = false
            connection.connectTimeout = 15_000
            connection.readTimeout = 30_000
            connection.useCaches = false
            connection.setRequestProperty("Accept", "application/json")
            connection.setRequestProperty("User-Agent", "Brclio/${BuildConfig.VERSION_NAME}")
            connection.setRequestProperty("X-Brclio-Client", "native")
            preferences.getString("token", null)?.takeIf(AccountPolicy::validToken)?.let {
                connection.setRequestProperty("Authorization", "Bearer $it")
            }
            if (csrf.isNotEmpty()) connection.setRequestProperty("X-CSRF-Token", csrf)
            if (body != null) {
                connection.doOutput = true
                connection.setRequestProperty("Content-Type", "application/json")
                val bytes = body.toByteArray(Charsets.UTF_8)
                connection.setFixedLengthStreamingMode(bytes.size)
                connection.outputStream.use { it.write(bytes) }
            }
            val status = connection.responseCode
            check(status !in 300..399) { "账号服务跳转无效，请稍后重试。" }
            check(!connection.getHeaderField("cf-mitigated").equals("challenge", true)) { "账号请求需要完成网站安全验证，请稍后重试。" }
            check(connection.contentType?.substringBefore(';')?.trim() == "application/json") { "账号服务暂时不可用，请稍后重试。" }
            val stream = if (status in 200..299) connection.inputStream else connection.errorStream
            check(stream != null) { "账号服务响应无效。" }
            val output = ByteArrayOutputStream()
            stream.use { input ->
                val buffer = ByteArray(8192)
                while (true) {
                    checkActive(operation)
                    val count = input.read(buffer)
                    if (count == -1) break
                    check(output.size() + count <= AccountPolicy.MAX_BYTES) { "账号服务响应过大。" }
                    output.write(buffer, 0, count)
                }
            }
            val result = runCatching { JSONObject(output.toString("UTF-8")) }.getOrElse { error("账号服务响应无效。") }
            if (status !in 200..299) {
                val message = when (val error = result.opt("error")) {
                    is String -> error
                    is JSONObject -> error.optString("message", "账号操作失败。")
                    else -> result.optString("message", "账号操作失败，请稍后重试。")
                }
                error(message.take(500))
            }
            checkActive(operation)
            return result
        } finally {
            synchronized(lock) { connections.remove(connection) }
            if (operation?.connection === connection) operation.connection = null
            connection.disconnect()
        }
    }

    private fun execute(callback: (JSONObject?, String?) -> Unit, cleanup: () -> Unit = {}, action: () -> JSONObject) {
        try {
            check(!closed) { "账号操作已停止。" }
            worker.execute {
                var result: JSONObject? = null
                var failure: String? = null
                try { result = action() } catch (error: Exception) {
                    failure = error.message?.take(500) ?: "账号操作失败，请稍后重试。"
                } finally { cleanup() }
                activity.runOnUiThread { if (!closed) callback(result, failure) }
            }
        } catch (error: Exception) { cleanup(); callback(null, "账号操作繁忙，请稍后重试。") }
    }

    fun close() {
        closed = true
        cancelGoogle()
        synchronized(lock) { connections.toList() }.forEach { it.disconnect() }
        worker.shutdownNow()
    }
}
