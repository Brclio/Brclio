package com.brclio.toolbox

import java.io.Closeable
import java.io.InputStream
import java.io.OutputStream

/** A fresh bounded relay invocation for every APK segment; never resume unverified bytes. */
internal object UpdateRangeDownloader {
    const val SEGMENT_BYTES = 1024 * 1024L
    private const val MAX_APK_BYTES = 512 * 1024 * 1024L
    private val contentRange = Regex("^bytes (0|[1-9][0-9]*)-(0|[1-9][0-9]*)/(0|[1-9][0-9]*)$")
    private val strongEtag = Regex("^\"[\\x21\\x23-\\x7E]{1,256}\"$")

    data class Segment(val start: Long, val end: Long) {
        val length: Long get() = end - start + 1
        val header: String get() = "bytes=$start-$end"
    }

    interface Response : Closeable {
        val status: Int
        fun header(name: String): String?
        val body: InputStream
    }

    fun segment(start: Long, total: Long): Segment {
        check(total in 1..MAX_APK_BYTES && start in 0 until total) { "安装包大小或分段位置无效。" }
        return Segment(start, start + minOf(SEGMENT_BYTES, total - start) - 1)
    }

    private fun validate(response: Response, segment: Segment, total: Long, etag: String?): String {
        check(response.status == 206) {
            if (response.status == 503) "内置更新代理暂不可用，可关闭内置代理后重试。"
            else "内置更新代理未返回分段安装包，可关闭内置代理后重试。"
        }
        val range = contentRange.matchEntire(response.header("Content-Range").orEmpty())
        check(range != null && range.groupValues[1].toLongOrNull() == segment.start &&
            range.groupValues[2].toLongOrNull() == segment.end && range.groupValues[3].toLongOrNull() == total) {
            "安装包分段位置或大小与发布记录不匹配。"
        }
        check(response.header("Content-Length") == segment.length.toString()) { "安装包分段长度无效。" }
        val encoding = response.header("Content-Encoding")
        check(encoding == null || encoding.equals("identity", ignoreCase = true)) { "安装包分段编码无效。" }
        val actualEtag = response.header("ETag").orEmpty()
        check(strongEtag.matches(actualEtag)) { "安装包分段缺少有效的强校验标识。" }
        check(etag == null || etag == actualEtag) { "安装包在下载期间已改变，请重新下载。" }
        return actualEtag
    }

    private fun pauseBefore503Recovery(checkActive: () -> Unit) {
        val deadline = System.nanoTime() + 400_000_000L
        while (true) {
            checkActive()
            val remaining = deadline - System.nanoTime()
            if (remaining <= 0) return
            Thread.sleep(minOf(25L, maxOf(1L, remaining / 1_000_000L)))
        }
    }

    private fun openWith503Recovery(
        part: Segment, etag: String?, open: (Segment, String?) -> Response,
        checkActive: () -> Unit, pause: (() -> Unit) -> Unit,
    ): Response {
        val first = open(part, etag)
        val unavailable = try { first.status == 503 } catch (exception: Exception) {
            first.close()
            throw exception
        }
        if (!unavailable) return first
        // A transient platform 503 may happen before the Worker runs. Recover
        // only this status, once, without consuming or retaining its body.
        first.close()
        checkActive()
        pause(checkActive)
        checkActive()
        return open(part, etag)
    }

    fun copy(
        total: Long,
        output: OutputStream,
        open: (Segment, String?) -> Response,
        checkActive: () -> Unit,
        progress: (Long) -> Unit,
        pauseBeforeRecovery: (() -> Unit) -> Unit = ::pauseBefore503Recovery,
    ): Long {
        // Validate even before the first network request.
        segment(0, total)
        val buffer = ByteArray(64 * 1024)
        var received = 0L
        var etag: String? = null
        while (received < total) {
            checkActive()
            val part = segment(received, total)
            openWith503Recovery(part, etag, open, checkActive, pauseBeforeRecovery).use { response ->
                etag = validate(response, part, total, etag)
                var partReceived = 0L
                val verifiedPart = ByteArray(part.length.toInt())
                response.body.use { input ->
                    while (true) {
                        checkActive()
                        val count = input.read(buffer)
                        if (count < 0) break
                        checkActive()
                        partReceived += count
                        check(partReceived <= part.length) { "安装包分段超过预期大小。" }
                        buffer.copyInto(verifiedPart, partReceived.toInt() - count, 0, count)
                    }
                }
                check(partReceived == part.length) { "安装包分段下载不完整，请重试。" }
                checkActive()
                output.write(verifiedPart)
                received += partReceived
                progress(received)
            }
        }
        checkActive()
        return received
    }
}
