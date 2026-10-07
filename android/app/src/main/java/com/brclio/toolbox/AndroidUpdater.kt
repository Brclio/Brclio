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
import java.net.URL
import java.security.MessageDigest
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import javax.net.ssl.HttpsURLConnection

class AndroidUpdater(private val activity: Activity, private val emit: (JSONObject) -> Unit) {
    private val worker = Executors.newSingleThreadExecutor()
    private val busy = AtomicBoolean(false)
    private val directory = File(activity.cacheDir, "updates").apply { mkdirs() }
    private val currentVersion = BuildConfig.VERSION_NAME.removeSuffix("-debug")
    @Volatile private var state = JSONObject().put("status", "up-to-date").put("currentVersion", currentVersion)
    @Volatile private var connection: HttpsURLConnection? = null
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
        publish("checking")
        val metadata = readSmall("https://api.github.com/repos/Brclio/Brclio/releases/latest", 1024 * 1024)
        val release = UpdatePolicy.parseRelease(JSONObject(metadata))
        latest = release
        publish(if (UpdatePolicy.isNewer(release.version, currentVersion)) "available" else "up-to-date", release)
    }

    fun download(callback: (JSONObject?, String?) -> Unit) = run(callback) {
        val release = latest ?: error("请先检查更新。")
        check(!UpdatePolicy.isNewer(currentVersion, release.version)) { "不能下载早于当前版本的安装包。" }
        downloaded?.delete()
        downloaded = null
        downloadedSha256 = null
        val checksum = UpdatePolicy.expectedChecksum(readSmall(release.checksums.url, 256 * 1024), release.apk.name)
        val temporary = File(directory, "${release.apk.name}.part")
        val target = File(directory, release.apk.name)
        temporary.delete()
        target.delete()
        publish("downloading", release, 0, release.apk.size)
        try {
            val deadline = System.currentTimeMillis() + 10 * 60 * 1000
            val response = open(release.apk.url)
            val digest = MessageDigest.getInstance("SHA-256")
            var received = 0L
            var lastProgress = 0L
            response.inputStream.use { input ->
                temporary.outputStream().use { output ->
                    val buffer = ByteArray(64 * 1024)
                    while (true) {
                        check(!closed && !Thread.currentThread().isInterrupted) { "下载已停止。" }
                        check(System.currentTimeMillis() < deadline) { "下载超时，请重试。" }
                        val count = input.read(buffer)
                        if (count < 0) break
                        received += count
                        check(received <= release.apk.size) { "安装包大小超过发布记录。" }
                        output.write(buffer, 0, count)
                        digest.update(buffer, 0, count)
                        val now = System.currentTimeMillis()
                        if (now - lastProgress >= 150) {
                            publish("downloading", release, received, release.apk.size)
                            lastProgress = now
                        }
                    }
                }
            }
            check(received == release.apk.size) { "安装包下载不完整，请重试。" }
            check(digest.digest().hex() == checksum) { "安装包 SHA-256 校验失败，已删除下载文件。" }
            verifyPackage(temporary, release)
            check(temporary.renameTo(target)) { "无法保存已验证的安装包。" }
            downloaded = target
            downloadedSha256 = checksum
            publish("downloaded", release, received, release.apk.size)
        } catch (exception: Exception) {
            temporary.delete()
            target.delete()
            throw exception
        } finally {
            connection?.disconnect()
            connection = null
        }
    }

    fun install(callback: (JSONObject?, String?) -> Unit) = run(callback) {
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
                val message = exception.message?.take(500) ?: "更新操作失败，请重试。"
                publish("error", latest, error = message)
                onMain { callback(null, message) }
            } finally {
                connection?.disconnect()
                connection = null
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
        state = next
        onMain { emit(next) }
        return next
    }

    private fun snapshot() = JSONObject(state.toString())

    fun onResume() {
        if (!installationWindowOpen) return
        installationWindowOpen = false
        // Returning without a package replacement means the installation was cancelled,
        // or the unknown-source permission screen closed. It is not consent to a later update.
        UpdateRelaunchReceiver.clear(activity)
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

    private fun open(address: String): HttpsURLConnection {
        var url = address
        repeat(6) {
            check(UpdatePolicy.allowedDownloadHost(url)) { "更新下载地址不受信任。" }
            val request = (URL(url).openConnection() as HttpsURLConnection).apply {
                connectTimeout = 15_000
                readTimeout = 30_000
                instanceFollowRedirects = false
                setRequestProperty("User-Agent", "Brclio-Android/$currentVersion")
                setRequestProperty("Accept", "application/vnd.github+json")
                setRequestProperty("X-GitHub-Api-Version", "2022-11-28")
            }
            connection = request
            val code = request.responseCode
            if (code in setOf(301, 302, 303, 307, 308)) {
                val destination = request.getHeaderField("Location") ?: error("更新服务器重定向缺少地址。")
                url = URL(URL(url), destination).toString()
                request.disconnect()
            } else {
                if (code != HttpURLConnection.HTTP_OK) {
                    request.disconnect()
                    error(when (code) {
                        404 -> "GitHub 尚未发布正式更新。"
                        403, 429 -> "GitHub 请求受到限制，请稍后重试。"
                        else -> "更新服务器返回 HTTP $code，请重试。"
                    })
                }
                return request
            }
        }
        error("更新服务器重定向次数过多。")
    }

    private fun readSmall(address: String, limit: Int): String {
        val request = open(address)
        val output = ByteArrayOutputStream()
        val deadline = System.currentTimeMillis() + 60_000
        try {
            request.inputStream.use { input ->
                val buffer = ByteArray(8192)
                while (true) {
                    check(!closed && System.currentTimeMillis() < deadline) { "更新检查超时，请重试。" }
                    val count = input.read(buffer)
                    if (count < 0) break
                    check(output.size() + count <= limit) { "更新信息超过大小限制。" }
                    output.write(buffer, 0, count)
                }
            }
            return output.toString("UTF-8")
        } finally { request.disconnect(); connection = null }
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
        connection?.disconnect()
        worker.shutdownNow()
        directory.listFiles()?.filter { it.name.endsWith(".part") }?.forEach(File::delete)
    }

    private fun ByteArray.hex() = joinToString("") { "%02x".format(it) }
}
