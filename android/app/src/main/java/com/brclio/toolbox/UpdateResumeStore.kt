package com.brclio.toolbox

import org.json.JSONObject
import java.io.File
import java.net.URI
import java.nio.file.Files
import java.nio.file.LinkOption.NOFOLLOW_LINKS
import java.nio.file.StandardCopyOption.ATOMIC_MOVE
import java.nio.file.StandardCopyOption.REPLACE_EXISTING
import java.nio.file.StandardOpenOption.APPEND
import java.nio.file.StandardOpenOption.CREATE_NEW
import java.nio.file.StandardOpenOption.WRITE
import java.nio.file.attribute.PosixFilePermissions
import java.security.MessageDigest

internal class UpdateResumeRejected(message: String) : IllegalStateException(message)
internal data class UpdateResumeBinding(val releaseVersion: String, val assetName: String, val downloadURL: String, val size: Long, val expectedSHA256: String) {
    init {
        require(releaseVersion.matches(Regex("\\d{1,9}\\.\\d{1,9}\\.\\d{1,9}")))
        require(assetName == "Brclio-$releaseVersion-android.apk")
        require(size in 1..512L * 1024 * 1024 && expectedSHA256.matches(Regex("[a-f0-9]{64}")))
        val uri = URI(downloadURL)
        require(UpdateProxyPolicy.allowedSource(downloadURL) && uri.path.substringAfterLast('/') == assetName &&
            uri.path.substringBeforeLast('/').substringAfterLast('/').removePrefix("v") == releaseVersion)
    }
}
internal data class UpdateResumeResponse(val status: Int, val contentRange: String? = null, val contentLength: String? = null,
    val encoding: String? = null, val contentType: String? = null, val etag: String? = null)
internal data class UpdateResumePlan(val responseBytes: Long, val complete: Boolean = false, val restarted: Boolean = false)

/** Real file operations, shared by Android and JVM tests. Unverified bytes are never installable. */
internal class UpdateResumeStore(private val directory: File, private val assetName: String) {
    init { require(assetName.matches(Regex("Brclio-\\d{1,9}\\.\\d{1,9}\\.\\d{1,9}-android\\.apk"))) }
    val partial = File(directory, "$assetName.part")
    val metadata = File(directory, "$assetName.part.json")
    private val target = File(directory, assetName)

    private fun ensureDirectory() {
        Files.createDirectories(directory.toPath())
        check(Files.isDirectory(directory.toPath(), NOFOLLOW_LINKS)) { "更新目录不可用。" }
    }
    private fun exists(file: File) = Files.exists(file.toPath(), NOFOLLOW_LINKS)
    private fun regular(file: File) = Files.isRegularFile(file.toPath(), NOFOLLOW_LINKS)
    private fun reject(message: String): Nothing { throw UpdateResumeRejected(message) }
    private fun requireRegular(file: File) {
        if (!regular(file)) reject("更新缓存不是普通文件，已停止。")
    }
    private inline fun <T> trusted(action: () -> T): T = try { action() } catch (failure: Exception) {
        if (!Thread.currentThread().isInterrupted && !preserve(failure)) clear()
        throw failure
    }
    fun clear() {
        if (Files.exists(directory.toPath(), NOFOLLOW_LINKS) && !Files.isDirectory(directory.toPath(), NOFOLLOW_LINKS))
            reject("更新目录不是普通目录，已停止。")
        // deleteIfExists removes a link itself and never follows it or recursively deletes a directory.
        Files.deleteIfExists(partial.toPath())
        Files.deleteIfExists(metadata.toPath())
    }
    private fun privateFile(file: File) {
        Files.newOutputStream(file.toPath(), CREATE_NEW, WRITE, NOFOLLOW_LINKS).use { }
        Files.setPosixFilePermissions(file.toPath(), PosixFilePermissions.fromString("rw-------"))
    }
    private fun writeMetadata(binding: UpdateResumeBinding, etag: String?) {
        val json = JSONObject().put("version", 1).put("releaseVersion", binding.releaseVersion)
            .put("assetName", binding.assetName).put("downloadURL", binding.downloadURL)
            .put("size", binding.size).put("expectedSHA256", binding.expectedSHA256)
        etag?.let { json.put("etag", it) }
        val temporary = Files.createTempFile(directory.toPath(), ".resume-", ".tmp", PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rw-------")))
        try {
            Files.newOutputStream(temporary, WRITE, NOFOLLOW_LINKS).use { it.write(json.toString().toByteArray(Charsets.UTF_8)) }
            Files.move(temporary, metadata.toPath(), ATOMIC_MOVE, REPLACE_EXISTING)
        } finally { Files.deleteIfExists(temporary) }
    }
    private fun metadataMatches(json: JSONObject, binding: UpdateResumeBinding): Boolean =
        json.opt("version") == 1 && json.optString("releaseVersion") == binding.releaseVersion &&
            json.optString("assetName") == binding.assetName && json.optString("downloadURL") == binding.downloadURL &&
            (json.opt("size") is Int || json.opt("size") is Long) && json.optLong("size", -1) == binding.size && json.optString("expectedSHA256") == binding.expectedSHA256

    fun prepare(binding: UpdateResumeBinding, checkActive: () -> Unit = {}): Session = trusted {
        require(binding.assetName == assetName)
        ensureDirectory()
        if (listOf(partial, metadata).any { exists(it) && !regular(it) }) {
            clear(); reject("更新缓存包含非普通文件，已清理并停止。")
        }
        var etag: String? = null
        var matches = false
        if (exists(partial) && exists(metadata)) {
            val bytes = if (Files.size(metadata.toPath()) <= 4096) Files.newInputStream(metadata.toPath(), NOFOLLOW_LINKS).use { input ->
                val output = java.io.ByteArrayOutputStream()
                val buffer = ByteArray(1024)
                while (true) {
                    checkActive()
                    val count = input.read(buffer)
                    if (count < 0) break
                    if (output.size() + count > 4096) reject("更新续传记录过大。")
                    output.write(buffer, 0, count)
                }
                output.toByteArray()
            } else null
            val json = bytes?.let { runCatching { JSONObject(String(it, Charsets.UTF_8)) }.getOrNull() }
            val savedTag = json?.optString("etag")?.takeIf { it.isNotEmpty() }
            matches = json != null && metadataMatches(json, binding) && (savedTag == null || strongETag(savedTag)) &&
                Files.size(partial.toPath()) <= binding.size
            if (matches) etag = savedTag
        }
        if (!matches) {
            clear()
            privateFile(partial)
            writeMetadata(binding, null)
        }
        val digest = MessageDigest.getInstance("SHA-256")
        var offset = 0L
        Files.newInputStream(partial.toPath(), NOFOLLOW_LINKS).use { input ->
            val bytes = ByteArray(64 * 1024)
            while (true) {
                checkActive()
                val count = input.read(bytes)
                if (count < 0) break
                offset += count
                check(offset <= binding.size) { "更新缓存大小无效。" }
                digest.update(bytes, 0, count)
            }
        }
        checkActive()
        return Session(binding, offset, etag, digest, checkActive)
    }

    inner class Session internal constructor(val binding: UpdateResumeBinding, var offset: Long,
        private var etag: String?, private var digest: MessageDigest, private val checkActive: () -> Unit) {
        val resumedBytes = offset
        private var expectedResponseBytes = 0L
        private var responseBytes = 0L
        private var verified = false
        fun requestHeaders(): Map<String, String> = if (offset == 0L) emptyMap() else buildMap {
            put("Range", "bytes=$offset-"); etag?.let { put("If-Range", it) }
        }
        fun accept(response: UpdateResumeResponse): UpdateResumePlan = trusted {
            if (response.status == 416) {
                if (offset != binding.size || response.contentRange != null && response.contentRange != "bytes */${binding.size}")
                    reject("服务器拒绝续传且缓存未完整，已停止。")
                verifyComplete()
                return UpdateResumePlan(0, complete = true)
            }
            if (response.encoding != null && !response.encoding.trim().equals("identity", true) ||
                response.contentType?.trim()?.startsWith("multipart/", true) == true) reject("服务器返回压缩或分段拼接内容，已停止。")
            val length = response.contentLength?.let {
                if (!it.matches(Regex("[0-9]+"))) reject("服务器返回无效的内容长度。")
                it.toLongOrNull() ?: reject("服务器返回无效的内容长度。")
            }
            var restarted = false
            when (response.status) {
                206 -> {
                    if (offset == 0L) reject("服务器返回未请求的部分内容。")
                    val range = Regex("bytes ([0-9]+)-([0-9]+)/([0-9]+)").matchEntire(response.contentRange.orEmpty())
                        ?: reject("服务器续传范围无效，已停止。")
                    val (start, end, total) = range.groupValues.drop(1).map { it.toLongOrNull() ?: reject("服务器续传范围无效。") }
                    if (start != offset || total != binding.size || end < start || end >= total) reject("服务器续传位置与缓存不一致。")
                    expectedResponseBytes = end - start + 1
                    if (length != null && length != expectedResponseBytes) reject("服务器续传长度与范围不一致。")
                    if (etag != null && response.etag != null && response.etag != etag) reject("服务器续传标识已改变，已停止。")
                }
                200 -> {
                    if (response.contentRange != null || length != null && length != binding.size) reject("服务器完整响应大小无效。")
                    restarted = offset > 0
                    requireRegular(partial)
                    Files.newOutputStream(partial.toPath(), WRITE, java.nio.file.StandardOpenOption.TRUNCATE_EXISTING, NOFOLLOW_LINKS).use { }
                    offset = 0; digest = MessageDigest.getInstance("SHA-256")
                    expectedResponseBytes = binding.size
                }
                else -> reject("服务器返回不支持的续传响应。")
            }
            val nextTag = response.etag?.takeIf(::strongETag)
            if (response.status == 200) etag = nextTag else if (etag == null) etag = nextTag
            writeMetadata(binding, etag)
            responseBytes = 0
            return UpdateResumePlan(expectedResponseBytes, restarted = restarted)
        }
        fun append(bytes: ByteArray, count: Int): Unit = trusted {
            require(count in 0..bytes.size)
            requireRegular(partial)
            if (Files.size(partial.toPath()) != offset || offset + count > binding.size || responseBytes + count > expectedResponseBytes)
                reject("安装包大小或缓存位置发生变化，已停止。")
            Files.newOutputStream(partial.toPath(), WRITE, APPEND, NOFOLLOW_LINKS).use { it.write(bytes, 0, count) }
            digest.update(bytes, 0, count)
            offset += count; responseBytes += count
        }
        fun endResponse() {
            if (responseBytes != expectedResponseBytes || offset < binding.size) throw UpdateNetworkFailure("安装包连接提前结束，可从已保存的位置续传。")
            verifyComplete()
        }
        fun verifyComplete(): Unit = trusted {
            requireRegular(partial)
            if (offset != binding.size || Files.size(partial.toPath()) != binding.size) reject("安装包尚未完整。")
            if (!verified) {
                if (digest.digest().joinToString("") { "%02x".format(it) } != binding.expectedSHA256) reject("安装包 SHA-256 校验失败，已停止。")
                verified = true
            }
            // The file itself is authoritative: do not trust only a prior prefix
            // digest and received chunks when another writer changed the disk.
            val diskDigest = MessageDigest.getInstance("SHA-256")
            var bytesRead = 0L
            Files.newInputStream(partial.toPath(), NOFOLLOW_LINKS).use { input ->
                val bytes = ByteArray(64 * 1024)
                while (true) {
                    checkActive()
                    val count = input.read(bytes)
                    if (count < 0) break
                    bytesRead += count
                    if (bytesRead > binding.size) reject("更新缓存大小发生变化。")
                    diskDigest.update(bytes, 0, count)
                }
            }
            checkActive()
            if (bytesRead != binding.size || diskDigest.digest().joinToString("") { "%02x".format(it) } != binding.expectedSHA256)
                reject("磁盘安装包 SHA-256 校验失败，已停止。")
        }
        fun finish(): File = trusted {
            verifyComplete()
            if (exists(target) && !regular(target)) reject("安装目标不是普通文件，已停止。")
            Files.move(partial.toPath(), target.toPath(), ATOMIC_MOVE, REPLACE_EXISTING)
            Files.deleteIfExists(metadata.toPath())
            return target
        }
    }
    companion object {
        fun strongETag(value: String) = value.length <= 1024 && value.matches(Regex("\"[\\x21\\x23-\\x7e]*\""))
        fun preserve(error: Throwable): Boolean = !UpdateRetryPolicy.isSecurityFailure(error) &&
            (error is UpdateNetworkFailure || error is UpdateRetryExhausted || error is UpdateStopped || error is InterruptedException)
    }
}
