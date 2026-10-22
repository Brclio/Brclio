package com.brclio.toolbox

import android.app.Activity
import android.content.ClipData
import android.content.Intent
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.content.FileProvider
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.File
import java.net.HttpURLConnection
import java.net.Proxy
import java.net.URL
import java.security.MessageDigest
import java.security.DigestOutputStream
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import javax.net.ssl.HttpsURLConnection

class AndroidUpdater(private val activity: Activity, private val emit: (JSONObject) -> Unit) {
    private val worker = Executors.newSingleThreadExecutor()
    private val busy = AtomicBoolean(false)
    private val deadlineWorker = Executors.newSingleThreadScheduledExecutor()
    @Volatile private var connectionDeadline: ScheduledFuture<*>? = null
    @Volatile private var retryState = UpdateRetryState()
    private val directory = File(activity.cacheDir, "updates").apply { mkdirs() }
    private val currentVersion = BuildConfig.VERSION_NAME.removeSuffix("-debug")
    @Volatile private var state = JSONObject().put("status", "up-to-date").put("currentVersion", currentVersion)
        .put("retryCount", 0).put("retryLimit", UpdateRetryPolicy.LIMIT).put("retrying", false)
        .put("retryExhausted", false).put("retryStage", JSONObject.NULL).put("message", JSONObject.NULL)
    @Volatile private var connection: HttpsURLConnection? = null
    @Volatile private var bootstrap: UpdateProxyBootstrap? = null
    @Volatile private var nodeSelector: UpdateNodeSelector? = null
    @Volatile private var nativeProxy: NativeUpdateProxy? = null
    @Volatile private var closed = false
    @Volatile private var installationWindowOpen = false
    private var latest: UpdateRelease? = null
    private var downloaded: File? = null
    private var downloadedSha256: String? = null

    init {
        // An interrupted previous process never leaves an installable unverified package.
        directory.listFiles()?.forEach { if (it.isFile) it.delete() }
    }

    fun check(callback: (JSONObject?, String?) -> Unit) = run(callback) {
        retryState = UpdateRetryState(retryStage = "check")
        latest = null
        publish("checking")
        // Each attempt has a fresh 60s budget; the whole loop is still bounded.
        val deadline = System.currentTimeMillis() + 11 * 60_000L + 42_000L
        var bootstrapAddress = UpdateProxyConfig.ADDRESS
        val release = UpdateRetryController().run("check", deadline, { closed }, { retry ->
            retryState = retry
            publish("checking")
        }, ::closeNetwork) {
            val attemptDeadline = minOf(deadline, System.currentTimeMillis() + 60_000L)
            val address = bootstrapAddress
            bootstrapAddress = UpdateProxyConfig.ADDRESS
            val route = try { prepareNetwork(attemptDeadline, address) }
            catch (failure: UpdateBootstrapFailure) { bootstrapAddress = failure.nextAddress; throw failure }
            val metadata = readSmall("https://api.github.com/repos/Brclio/Brclio/releases/latest", 1024 * 1024, route, attemptDeadline)
            UpdatePolicy.parseRelease(JSONObject(metadata))
        }
        latest = release
        publish(if (UpdatePolicy.isNewer(release.version, currentVersion)) "available" else "up-to-date", release)
    }

    fun download(callback: (JSONObject?, String?) -> Unit) = run(callback) {
        retryState = UpdateRetryState(retryStage = "download")
        val release = latest ?: error("请先检查更新。")
        check(!UpdatePolicy.isNewer(currentVersion, release.version)) { "不能下载早于当前版本的安装包。" }
        downloaded?.let { check(!it.exists() || it.delete()) { "无法删除上次的安装包。" } }
        downloaded = null
        downloadedSha256 = null
        val deadline = System.currentTimeMillis() + 10 * 60_000L
        val temporary = File(directory, "${release.apk.name}.part")
        val target = File(directory, release.apk.name)
        var bootstrapAddress = UpdateProxyConfig.ADDRESS
        publish("downloading", release, 0, release.apk.size)
        UpdateRetryController().run("download", deadline, { closed }, { retry ->
            retryState = retry
            publish("downloading", release, 0, release.apk.size)
        }, {
            closeNetwork()
            check(!temporary.exists() || temporary.delete()) { "无法清理未完成的安装包。" }
        }) {
            check(!target.exists() || target.delete()) { "无法清理旧安装包。" }
            val address = bootstrapAddress
            bootstrapAddress = UpdateProxyConfig.ADDRESS
            val route = try { prepareNetwork(deadline, address) }
            catch (failure: UpdateBootstrapFailure) { bootstrapAddress = failure.nextAddress; throw failure }
            val checksum = UpdatePolicy.expectedChecksum(readSmall(release.checksums.url, 256 * 1024, route, deadline), release.apk.name)
            val digest = MessageDigest.getInstance("SHA-256")
            var received = 0L
            var lastProgress = 0L
            fun progress(bytes: Long) {
                received = bytes
                val now = System.currentTimeMillis()
                if (now - lastProgress >= 150) {
                    publish("downloading", release, received, release.apk.size)
                    lastProgress = now
                }
            }
            // Only remote connection/read exceptions are retryable. Disk writes,
            // checksum/signature failures and installation are never replayed.
            DigestOutputStream(temporary.outputStream(), digest).use { output ->
                val response = open(release.apk.url, route, deadline)
                val input = remote { response.inputStream }
                try {
                    val buffer = ByteArray(64 * 1024)
                    while (true) {
                        checkActive(deadline)
                        val count = remote { input.read(buffer) }
                        if (count < 0) break
                        checkActive(deadline)
                        check(received + count <= release.apk.size) { "安装包大小超过发布记录。" }
                        output.write(buffer, 0, count)
                        progress(received + count)
                    }
                } finally { runCatching { input.close() } }
            }
            checkActive(deadline)
            if (received < release.apk.size) throw UpdateNetworkFailure("安装包连接提前结束。")
            check(received == release.apk.size) { "安装包大小与发布记录不符。" }
            check(digest.digest().hex() == checksum) { "安装包 SHA-256 校验失败，已删除下载文件。" }
            verifyPackage(temporary, release)
            check(temporary.renameTo(target)) { "无法保存已验证的安装包。" }
            downloaded = target
            downloadedSha256 = checksum
        }
        publish("downloaded", release, release.apk.size, release.apk.size)
    }

    fun install(callback: (JSONObject?, String?) -> Unit) = run(callback) {
        retryState = UpdateRetryState()
        val release = latest ?: error("请先检查并下载更新。")
        val apk = downloaded?.takeIf { it.isFile } ?: error("请先下载更新。")
        val actual = apk.inputStream().use { input ->
            val digest = MessageDigest.getInstance("SHA-256")
            val buffer = ByteArray(64 * 1024)
            while (true) { val count = input.read(buffer); if (count < 0) break; digest.update(buffer, 0, count) }
            digest.digest().hex()
        }
        check(actual == downloadedSha256) { "安装包已改变，请重新下载。" }
        val targetVersionCode = verifyPackage(apk, release)
        // Keep another check/download/install from replacing the APK while the system reads it.
        installationWindowOpen = true
        onMain {
            try {
                if (!activity.packageManager.canRequestPackageInstalls()) {
                    activity.startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${activity.packageName}")))
                    callback(snapshot().put("requiresPermission", true).put("message", "允许 Brclio 安装更新后，请返回再次点击安装。"), null)
                } else {
                    val uri = FileProvider.getUriForFile(activity, "${activity.packageName}.updates", apk)
                    UpdateRelaunchReceiver.remember(activity, targetVersionCode)
                    activity.startActivity(Intent(Intent.ACTION_VIEW).apply {
                        setDataAndType(uri, "application/vnd.android.package-archive")
                        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                        clipData = ClipData.newRawUri("Brclio 更新", uri)
                    })
                    callback(snapshot().put("installerOpened", true).put("message", "请确认覆盖安装。完成后将尝试自动打开 Brclio；若系统限制，请点击安装器中的“打开”。"), null)
                }
            } catch (exception: Exception) {
                installationWindowOpen = false
                UpdateRelaunchReceiver.clear(activity)
                val message = exception.message ?: "无法打开 Android 安装界面。"
                publish("error", release, error = message)
                callback(null, message)
            }
        }
        null
    }

    private fun run(callback: (JSONObject?, String?) -> Unit, action: () -> JSONObject?) {
        if (installationWindowOpen) {
            callback(null, "请先完成系统安装或授权窗口，返回 Brclio 后再重试。")
            return
        }
        if (!busy.compareAndSet(false, true)) { callback(snapshot(), null); return }
        worker.execute {
            try {
                val result = action()
                if (result != null) onMain { callback(result, null) }
            } catch (exception: Exception) {
                if (exception !is UpdateRetryExhausted) retryState = retryState.copy(retrying = false, message = null)
                val message = if (exception is UpdateRetryExhausted) retryState.message ?: exception.message!!
                    else if (UpdateRetryPolicy.isSecurityFailure(exception)) "更新连接的安全验证失败，请检查网络后点击重试。"
                    else if (exception is UpdateNetworkFailure) "更新网络连接中断，请点击重试。"
                    else if (exception is java.io.IOException) "无法读写更新文件，请检查设备存储后重试。"
                    else exception.message?.take(500) ?: "更新操作失败，请重试。"
                publish("error", latest, error = message)
                onMain { callback(null, message) }
            } finally {
                closeNetwork()
                busy.set(false)
            }
        }
    }

    private fun publish(status: String, release: UpdateRelease? = latest, received: Long = 0, total: Long = 0, error: String? = null): JSONObject {
        val next = JSONObject().put("status", status).put("currentVersion", currentVersion)
            .put("version", release?.version ?: currentVersion)
            .put("notes", release?.notes ?: "")
            .put("assetName", release?.apk?.name ?: "")
            .put("downloadedBytes", received).put("totalBytes", total)
            .put("progress", if (total > 0) minOf(100, received * 100 / total) else 0)
            .put("error", error ?: JSONObject.NULL)
            .put("retryCount", retryState.retryCount).put("retryLimit", retryState.retryLimit)
            .put("retrying", retryState.retrying).put("retryExhausted", retryState.retryExhausted)
            .put("retryStage", retryState.retryStage ?: JSONObject.NULL)
            .put("message", retryState.message ?: JSONObject.NULL)
        state = next
        onMain { emit(next) }
        return next
    }

    private fun snapshot() = JSONObject(state.toString())

    fun getUpdateProxyState(): JSONObject {
        val route = currentProxyRoute()
        return JSONObject().put("enabled", ProcessUpdateProxySession.state.enabled)
            .put("supported", true).put("route", route.value)
            .put("message", when (route) {
                UpdateProxyRoute.BUILTIN -> "更新检查与下载使用内置代理；关闭后直接连接。重启软件后默认开启。"
                UpdateProxyRoute.SYSTEM -> "已检测到系统代理或 VPN，更新检查与下载使用系统网络。"
                UpdateProxyRoute.DIRECT -> "内置代理已关闭，更新检查与下载直接连接。重启软件后默认开启。"
            })
    }

    fun setUpdateProxyEnabled(enabled: Boolean): JSONObject {
        check(!installationWindowOpen) { "请先完成系统安装或授权窗口，再修改更新代理。" }
        check(busy.compareAndSet(false, true)) { "更新操作进行中，请完成后再修改更新代理。" }
        try {
            ProcessUpdateProxySession.state.setEnabled(enabled)
            return getUpdateProxyState()
        } finally { busy.set(false) }
    }

    private fun currentProxyRoute() = ProcessUpdateProxySession.state.route(AndroidSystemProxy.isPresent(activity))

    fun onResume() {
        if (!installationWindowOpen) return
        installationWindowOpen = false
        // Returning without a package replacement means the installation was cancelled,
        // or the unknown-source permission screen closed. It is not consent to a later update.
        UpdateRelaunchReceiver.clear(activity)
        // The shared UI may be in "installing" with its buttons disabled. The same
        // verified download is available again after cancellation/permission return.
        onMain { emit(snapshot()) }
    }

    private fun onMain(action: () -> Unit) {
        activity.runOnUiThread {
            if (!closed && !activity.isFinishing && !activity.isDestroyed) {
                try { action() } catch (exception: Exception) {
                    emit(JSONObject().put("status", "error").put("currentVersion", currentVersion)
                        .put("error", exception.message ?: "无法打开安装界面。"))
                }
            }
        }
    }

    private fun checkActive(deadline: Long) {
        if (closed || Thread.currentThread().isInterrupted) throw UpdateStopped()
        if (System.currentTimeMillis() >= deadline) throw UpdateNetworkFailure("更新连接超时。")
    }

    private fun closeConnection() {
        connectionDeadline?.cancel(false)
        connectionDeadline = null
        connection?.disconnect()
        connection = null
    }

    private fun closeNetwork() {
        // Tear down transports before disconnecting a possibly blocked TLS read.
        nativeProxy?.close()
        nativeProxy = null
        nodeSelector?.close()
        nodeSelector = null
        bootstrap?.close()
        bootstrap = null
        closeConnection()
    }

    private fun <T> remote(action: () -> T): T = try { action() }
    catch (failure: java.io.IOException) {
        nativeProxy?.terminalFailure?.let { throw it }
        if (closed || Thread.currentThread().isInterrupted) throw UpdateStopped()
        if (UpdateRetryPolicy.isSecurityFailure(failure)) throw failure
        throw UpdateNetworkFailure("更新网络连接中断。", failure)
    }

    /** Every attempt freshly resolves routing, configuration and every candidate. */
    private fun prepareNetwork(deadline: Long, bootstrapAddress: String): UpdateProxyRoute {
        checkActive(deadline)
        val route = currentProxyRoute()
        if (route != UpdateProxyRoute.BUILTIN) return route
        val loader = UpdateProxyBootstrap(deadline, { closed }, address = bootstrapAddress)
        bootstrap = loader
        val nodes = try { loader.fetch() } finally { loader.close(); bootstrap = null }
        val selector = UpdateNodeSelector()
        nodeSelector = selector
        val selected = try { selector.select(nodes, deadline) } finally { selector.close(); nodeSelector = null }
        nativeProxy = NativeUpdateProxy(listOf(selected), deadline)
        checkActive(deadline)
        return route
    }

    private fun open(address: String, route: UpdateProxyRoute, deadline: Long): HttpsURLConnection {
        check(UpdateProxyPolicy.allowedSource(address)) { "更新下载地址不受信任。" }
        var url = address
        repeat(6) {
            checkActive(deadline)
            check(UpdatePolicy.allowedDownloadHost(url)) { "更新下载地址不受信任。" }
            val opened = when (route) {
                UpdateProxyRoute.SYSTEM -> URL(url).openConnection()
                UpdateProxyRoute.DIRECT -> URL(url).openConnection(Proxy.NO_PROXY)
                UpdateProxyRoute.BUILTIN -> URL(url).openConnection(nativeProxy?.proxy ?: error("内置更新代理已停止。"))
            }
            val remaining = maxOf(1, deadline - System.currentTimeMillis())
            val request = (opened as HttpsURLConnection).apply {
                connectTimeout = minOf(15_000L, remaining).toInt()
                readTimeout = minOf(30_000L, remaining).toInt()
                instanceFollowRedirects = false
                useCaches = false
                setRequestProperty("Connection", "close")
                setRequestProperty("Accept-Encoding", "identity")
                setRequestProperty("User-Agent", "Brclio-Android/$currentVersion")
                setRequestProperty("Accept", "application/vnd.github+json")
                setRequestProperty("X-GitHub-Api-Version", "2022-11-28")
            }
            connection = request
            connectionDeadline = deadlineWorker.schedule({ request.disconnect() }, remaining, TimeUnit.MILLISECONDS)
            checkActive(deadline)
            val code = remote { request.responseCode }
            val mitigated = request.getHeaderField("cf-mitigated")
            if (UpdateProxyPolicy.isCloudflareChallenge(mitigated)) {
                closeConnection()
                error(UpdateProxyPolicy.responseError(code, UpdateProxyRoute.DIRECT, mitigated))
            }
            if (code in setOf(301, 302, 303, 307, 308)) {
                val destination = request.getHeaderField("Location")
                closeConnection()
                check(destination != null) { "更新服务器重定向缺少地址。" }
                url = try { URL(URL(url), destination).toString() } catch (_: Exception) { error("更新下载地址不受信任。") }
            } else {
                if (code != HttpURLConnection.HTTP_OK) {
                    closeConnection()
                    val message = UpdateProxyPolicy.responseError(code, UpdateProxyRoute.DIRECT)
                    if (code == 408 || code in 500..599) throw UpdateNetworkFailure(message)
                    error(message)
                }
                return request
            }
        }
        error("更新服务器重定向次数过多。")
    }

    private fun readSmall(address: String, limit: Int, route: UpdateProxyRoute, deadline: Long): String {
        val request = open(address, route, deadline)
        val output = ByteArrayOutputStream()
        try {
            val declaredLength = request.contentLengthLong
            check(declaredLength <= limit) { "更新信息超过大小限制。" }
            val input = remote { request.inputStream }
            try {
                val buffer = ByteArray(8192)
                while (true) {
                    checkActive(deadline)
                    val count = remote { input.read(buffer) }
                    if (count < 0) break
                    checkActive(deadline)
                    check(output.size() + count <= limit) { "更新信息超过大小限制。" }
                    output.write(buffer, 0, count)
                }
            } finally { runCatching { input.close() } }
            if (declaredLength >= 0 && output.size().toLong() < declaredLength) throw UpdateNetworkFailure("更新信息连接提前结束。")
            return output.toString("UTF-8")
        } finally { closeConnection() }
    }

    @Suppress("DEPRECATION")
    private fun verifyPackage(apk: File, release: UpdateRelease): Long {
        val manager = activity.packageManager
        val flags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) PackageManager.GET_SIGNING_CERTIFICATES else PackageManager.GET_SIGNATURES
        val archive = manager.getPackageArchiveInfo(apk.absolutePath, flags) ?: error("下载的文件不是有效 Android 安装包。")
        check(archive.packageName == activity.packageName) { "安装包与当前应用不匹配。请安装正式版 Brclio。" }
        check(archive.versionName == release.version) { "安装包版本与发布记录不匹配。" }
        val installed = manager.getPackageInfo(activity.packageName, flags)
        val archiveCode = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) archive.longVersionCode else archive.versionCode.toLong()
        val installedCode = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) installed.longVersionCode else installed.versionCode.toLong()
        check(archiveCode >= installedCode) { "安装包的版本代码早于当前应用。" }
        fun certificateDigests(info: PackageInfo): Set<String> {
            val signatures = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) info.signingInfo?.apkContentsSigners else info.signatures
            return signatures.orEmpty().map { MessageDigest.getInstance("SHA-256").digest(it.toByteArray()).hex() }.toSet()
        }
        val trusted = certificateDigests(installed)
        check(trusted.isNotEmpty() && trusted == certificateDigests(archive)) { "安装包签名不匹配，已阻止安装。" }
        return archiveCode
    }

    fun close() {
        closed = true
        closeNetwork()
        worker.shutdownNow()
        deadlineWorker.shutdownNow()
        directory.listFiles()?.filter { it.name.endsWith(".part") }?.forEach(File::delete)
    }

    private fun ByteArray.hex() = joinToString("") { "%02x".format(it) }
}
