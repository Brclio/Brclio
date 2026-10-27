package com.brclio.toolbox

import android.app.Activity
import android.content.ClipData
import android.content.ClipDescription
import android.content.ClipboardManager
import android.content.Intent
import android.net.Uri
import android.provider.DocumentsContract
import android.util.Base64
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import androidx.core.content.FileProvider
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.io.File
import java.io.FileOutputStream
import java.util.Locale
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream

/** Local media module. It never receives Brclio account sessions or updater state. */
class AndroidXhs(private val activity: Activity, private val emit: (JSONObject) -> Unit) {
    private val workers = Executors.newFixedThreadPool(2)
    private val ready = CountDownLatch(1)
    private val previews = ConcurrentHashMap.newKeySet<XhsTransfer.Cancellation>()
    private val preferences = activity.getSharedPreferences("brclio-xhs-transfer", Activity.MODE_PRIVATE)
    @Volatile private var closed = false
    @Volatile private var parsing: XhsTransfer.Cancellation? = null
    @Volatile private var operation: Operation? = null
    private var generated: Generated? = null
    private var pendingGenerated: String? = null
    private val cancelledGenerated = linkedSetOf<String>()
    private data class Generated(val token: String, val file: File, val filename: String, val mime: String, val expected: Long, val requestId: String, var received: Long = 0)
    private class Operation(val entries: List<XhsTransfer.Entry>, val filename: String, val mime: String,
        val requestId: String, val callback: (Any?, String?) -> Unit, val file: File? = null, val eventType: String = "transfer") {
        val cancellation = XhsTransfer.Cancellation(XhsPolicy.unlimitedVideoSave(mime == "application/zip", entries.size, entries.firstOrNull()?.kind ?: ""))
        @Volatile var committed = false
        var document: Uri? = null
        var awaitingPicker = true
        var lastProgress = 0L
        var lastStage = ""
    }
    init {
        workers.execute {
          try {
            preferences.getString("pending", null)?.let { value ->
                val uri = Uri.parse(value)
                if (runCatching { DocumentsContract.deleteDocument(activity.contentResolver, uri) }.getOrDefault(false)) {
                    preferences.edit().remove("pending").commit()
                    releaseDocumentPermission(uri)
                }
            }
            File(activity.cacheDir, "xhs-generated").deleteRecursively()
            File(activity.cacheDir, "xhs-prepared-images").deleteRecursively()
            val cached = File(activity.cacheDir, "xhs-shared-images")
            cached.listFiles()?.filter { System.currentTimeMillis() - it.lastModified() > 24 * 60 * 60 * 1000 }?.forEach { it.deleteRecursively() }
          } finally { ready.countDown() }
        }
    }
    @Synchronized fun request(action: String, input: JSONObject, callback: (Any?, String?) -> Unit) {
        try {
            check(!closed) { "小红书工具已关闭。" }
            when (action) {
                "info" -> callback(JSONObject().put("platform", "android").put("capabilities", JSONObject().put("profile", false).put("python", true)), null)
                "fetchNote", "parsePython" -> {
                    check(parsing == null) { "已有笔记正在解析。" }
                    val cancellation = XhsTransfer.Cancellation(); parsing = cancellation
                    work(callback) { try {
                        if (action == "parsePython") XhsTransfer.parsePython(input.getString("text"), cancellation)
                        else XhsTransfer.fetchNote(input.getString("url"), cancellation)
                    } finally { parsing = null } }
                }
                "readClipboard" -> {
                    val clip = activity.getSystemService(ClipboardManager::class.java).primaryClip
                    callback(JSONObject().put("text", clip?.takeIf { it.itemCount > 0 }?.getItemAt(0)?.coerceToText(activity)?.toString()?.take(3000) ?: ""), null)
                }
                "saveImages", "saveNote", "exportArchive", "saveVideo" -> beginSave(action, input, callback)
                "copyImages", "shareImages" -> copyImages(input, action == "shareImages", callback)
                "openVideo" -> {
                    val uri = Uri.parse(XhsPolicy.playbackVideoUri(input.getString("url")).toString())
                    activity.startActivity(Intent(Intent.ACTION_VIEW, uri))
                    callback(JSONObject().put("ok", true), null)
                }
                "cancelVideo", "cancelArchive", "cancelTransfer" -> {
                    val active = operation
                    val requested = input.optString("requestId")
                    val accepted = active != null && !active.committed && (requested.isEmpty() || requested == active.requestId)
                    if (accepted) active!!.cancellation.cancel()
                    val item = generated
                    val generatedAccepted = item != null && (requested.isEmpty() || requested == item.requestId || requested == item.token)
                    val pendingAccepted = pendingGenerated != null && (requested.isEmpty() || requested == pendingGenerated)
                    if (generatedAccepted) {
                        cancelledGenerated.add(item!!.token); item.file.delete(); generated = null
                    }
                    if (pendingAccepted) cancelledGenerated.add(pendingGenerated!!)
                    while (cancelledGenerated.size > 16) cancelledGenerated.remove(cancelledGenerated.first())
                    callback(JSONObject().put("cancelled", accepted || generatedAccepted || pendingAccepted), null)
                }
                "beginGenerated" -> {
                    check(ready.count == 0L) { "正在恢复上次保存状态，请稍后重试。" }
                    check(operation == null && generated == null && pendingGenerated == null) { "请先完成当前保存。" }
                    val requestId = input.optString("requestId").ifBlank { UUID.randomUUID().toString() }
                    pendingGenerated = requestId
                    work(callback) { synchronized(this) {
                      try {
                    check(!closed) { "小红书工具已关闭。" }
                    if (cancelledGenerated.remove(requestId)) return@synchronized JSONObject().put("cancelled", true)
                    val size = input.getLong("size"); require(size in 1..MAX_GENERATED_BYTES) { "实况导出文件必须小于 64 MB。" }
                    val mime = XhsGeneratedPolicy.mime(input.getString("mime"))
                    val directory = File(activity.cacheDir, "xhs-generated").apply { mkdirs() }
                    val token = UUID.randomUUID().toString()
                    generated = Generated(token, File.createTempFile("generated-", ".part", directory), XhsPolicy.filename(input.getString("filename"), "实况.zip"), mime, size, requestId)
                    publish("transfer", JSONObject().put("requestId", requestId).put("status", "preparing").put("stage", "preparing").put("receivedBytes", 0).put("totalBytes", size).put("message", "正在准备导出文件"))
                    JSONObject().put("token", token).put("requestId", requestId)
                      } finally { if (pendingGenerated == requestId) pendingGenerated = null }
                    } }
                }
                "appendGenerated" -> work(callback) { synchronized(this) {
                    if (cancelledGenerated.contains(input.optString("token"))) return@synchronized JSONObject().put("cancelled", true)
                    val item = requireGenerated(input); val data = Base64.decode(input.getString("data"), Base64.NO_WRAP)
                    require(data.size in 1..65536 && input.getLong("offset") == item.received && item.received + data.size <= item.expected) { "导出分块无效。" }
                    FileOutputStream(item.file, true).use { it.write(data) }; item.received += data.size
                    publish("transfer", JSONObject().put("requestId", item.requestId).put("status", "preparing").put("stage", "preparing").put("receivedBytes", item.received).put("totalBytes", item.expected).put("message", "正在准备导出文件 ${item.received / 1024} KB"))
                    JSONObject().put("received", item.received)
                } }
                "finishGenerated" -> {
                    if (cancelledGenerated.remove(input.optString("token"))) callback(JSONObject().put("cancelled", true), null)
                    else {
                        val item = requireGenerated(input).also { check(it.received == it.expected) { "实况文件尚未完整传输。" }; generated = null }
                        launchSave(Operation(emptyList(), item.filename, item.mime, item.requestId, callback, item.file))
                    }
                }
                "abortGenerated" -> { synchronized(this) { generated?.takeIf { it.token == input.optString("token") }?.let { it.file.delete(); generated = null } }; callback(JSONObject().put("cancelled", true), null) }
                "chooseDirectory" -> callback(null, "Android 在每次保存时通过系统文件选择器选择位置。")
                "openDirectory" -> { activity.startActivity(Intent(Intent.ACTION_OPEN_DOCUMENT).apply { type = "*/*"; addCategory(Intent.CATEGORY_OPENABLE) }); callback(JSONObject().put("ok", true), null) }
                "loginState" -> callback(JSONObject().put("loggedIn", false).put("status", "unsupported"), null)
                "profileState" -> callback(JSONObject().put("status", "unsupported").put("items", JSONArray()), null)
                else -> callback(null, "此功能仅在桌面客户端可用。")
            }
        } catch (error: Exception) { callback(null, error.message ?: "操作未完成。") }
    }
    private fun requireGenerated(input: JSONObject): Generated = generated?.takeIf { it.token == input.optString("token") } ?: error("实况导出已失效，请重新导出。")
    private fun work(callback: (Any?, String?) -> Unit, action: () -> Any?) {
        workers.execute { val result = runCatching { ready.await(); check(!closed) { "小红书工具已关闭。" }; action() }; activity.runOnUiThread { if (!closed) callback(result.getOrNull(), result.exceptionOrNull()?.message) } }
    }
    private fun entries(action: String, input: JSONObject): Pair<List<XhsTransfer.Entry>, String> {
        val records = JSONArray()
        if (action == "saveVideo") {
            val video = input.getJSONObject("video")
            records.put(JSONObject().put("name", XhsPolicy.filename(input.optString("filename"), "视频.mp4")).put("kind", "video").put("url", video.getString("url")).put("backupUrls", video.optJSONArray("backupUrls") ?: JSONArray()).put("requireAudio", input.optBoolean("requireAudio", true)))
        } else {
            val note = input.optJSONObject("note") ?: input
            val images = input.optJSONArray("images") ?: note.optJSONArray("images") ?: JSONArray()
            val format = if (action == "saveImages") "images" else input.optString("format", "all")
            val imageEntries = XhsArchivePolicy.imageEntries(images, format)
            for (index in 0 until imageEntries.length()) records.put(imageEntries.getJSONObject(index))
            if (format == "all") {
                val video = XhsArchivePolicy.video(note.optJSONArray("originalVideos"), note.optJSONArray("videos"))
                if (video != null) records.put(JSONObject().put("name", "视频.mp4").put("kind", "video").put("url", video.getString("url")).put("backupUrls", video.optJSONArray("backupUrls") ?: JSONArray()).put("requireAudio", true))
            }
            if (action != "saveImages") records.put(JSONObject().put("name", "文案.txt").put("text", XhsNoteTextPolicy.render(
                note.optString("title"), note.optString("content"), note.optString("sourceUrl"), note.optString("engine"),
            )))
        }
        val values = XhsTransfer.entries(records, false)
        val name = XhsPolicy.filename(input.optJSONObject("note")?.optString("title") ?: input.optString("title"), "小红书笔记")
        return values to name
    }
    private fun beginSave(action: String, input: JSONObject, callback: (Any?, String?) -> Unit) {
        check(ready.count == 0L) { "正在恢复上次保存状态，请稍后重试。" }
        check(operation == null && generated == null && pendingGenerated == null) { "请先完成当前保存或复制操作。" }
        val (entries, title) = entries(action, input)
        val archive = action == "exportArchive" || (action != "saveVideo" && entries.size > 1)
        val mime = if (archive) "application/zip" else when (entries.first().kind) { "image" -> "image/jpeg"; "text" -> "text/plain"; else -> "video/mp4" }
        val name = if (archive) "$title.zip" else if (action == "saveVideo") input.optString("filename", "视频.mp4") else "$title${if (mime == "text/plain") ".txt" else ".jpg"}"
        val requestId = input.optString("requestId", UUID.randomUUID().toString())
        if (!archive && entries.first().kind == "image") {
            // Determine the real codec before SAF creates a document, so both its
            // display extension and provider MIME preserve PNG/WebP/JPEG bytes.
            val preparation = Operation(entries, name, "image/*", requestId, callback, eventType = XhsOperationPolicy.eventType(action))
            preparation.awaitingPicker = false; operation = preparation
            progress(preparation, 0, 1, message = "正在连接原图下载地址", force = true)
            workers.execute {
                var media: XhsTransfer.Media? = null
                try {
                    val cache = File(activity.cacheDir, "xhs-prepared-images").apply { mkdirs() }
                    media = XhsTransfer.download(entries.first(), cache, 0, preparation.cancellation) { bytes, total -> progress(preparation, bytes, 1, total) }
                    val prepared = media
                    activity.runOnUiThread {
                        synchronized(this) {
                            if (closed || preparation.cancellation.isCancelled || operation !== preparation) {
                                prepared.file.delete(); finish(preparation, JSONObject().put("ok", true).put("cancelled", true), null)
                            } else {
                                operation = null
                                try { launchSave(Operation(emptyList(), XhsPolicy.mediaFilename(name, prepared.mime), prepared.mime, requestId, callback, prepared.file, preparation.eventType)) }
                                catch (error: Exception) { prepared.file.delete(); finish(preparation, null, error.message) }
                            }
                        }
                    }
                } catch (error: Exception) {
                    media?.file?.delete()
                    finish(preparation, if (preparation.cancellation.isCancelled) JSONObject().put("ok", true).put("cancelled", true) else null,
                        if (preparation.cancellation.isCancelled) null else error.message)
                }
            }
        } else launchSave(Operation(entries, XhsPolicy.filename(name, "小红书笔记.zip"), mime, requestId, callback, eventType = XhsOperationPolicy.eventType(action)))
    }
    private fun launchSave(value: Operation) {
        check(operation == null) { "请先完成当前保存。" }
        operation = value
        progress(value, 0, 0, stage = "choosing", message = "请选择保存位置", force = true)
        try { activity.startActivityForResult(Intent(Intent.ACTION_CREATE_DOCUMENT).apply { addCategory(Intent.CATEGORY_OPENABLE); type = value.mime; putExtra(Intent.EXTRA_TITLE, value.filename); addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION or Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION) }, SAVE_DOCUMENT) }
        catch (error: Exception) { operation = null; value.file?.delete(); throw error }
    }
    fun onActivityResult(request: Int, result: Int, data: Intent?): Boolean {
        if (request != SAVE_DOCUMENT) return false
        val value = operation ?: return true
        if (!value.awaitingPicker) return true
        value.awaitingPicker = false
        val uri = data?.data
        if (result != Activity.RESULT_OK || uri == null) { finish(value, JSONObject().put("cancelled", true), null); return true }
        if (uri.scheme != "content") { finish(value, null, "系统返回的保存位置无效。"); return true }
        value.document = uri
        runCatching {
            val read = (data.flags and Intent.FLAG_GRANT_READ_URI_PERMISSION) != 0
            val write = (data.flags and Intent.FLAG_GRANT_WRITE_URI_PERMISSION) != 0
            if (read && write) activity.contentResolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
            else if (write) activity.contentResolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
            else if (read) activity.contentResolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        progress(value, 0, 0, stage = "preparing", message = "正在准备保存", force = true)
        workers.execute { save(value) }
        return true
    }
    private fun save(value: Operation) {
        val directory = File(activity.cacheDir, "xhs-transfer-${UUID.randomUUID()}")
        var bytes = 0L; var complete = false; var cleanupFailed = false; var failure: String? = null
        try {
            check(directory.mkdirs()) { "无法创建临时目录。" }
            check(preferences.edit().putString("pending", value.document.toString()).commit()) { "无法记录保存状态。" }
            value.cancellation.check()
            activity.contentResolver.openOutputStream(value.document!!, "wt")?.use { destination ->
                if (value.file != null) {
                    XhsTransfer.copy(value.file, destination, value.cancellation) { received, total -> progress(value, received, 1, total, "saving", "正在写入文件") }
                    bytes = value.file.length()
                }
                else if (value.mime == "application/zip") ZipOutputStream(destination).use { zip ->
                    val names = hashSetOf<String>()
                    value.entries.forEachIndexed { index, entry ->
                        val media = if (entry.text == null) XhsTransfer.download(entry, directory, bytes, value.cancellation) { received, _ -> progress(value, bytes + received, index + 1) } else null
                        try {
                            val initial = if (media == null) entry.name else XhsPolicy.mediaFilename(entry.name, media.mime)
                            var name = initial; var suffix = 2
                            while (!names.add(name.lowercase(Locale.ROOT))) name = XhsPolicy.numberedFilename(initial, suffix++)
                            progress(value, bytes + (media?.file?.length() ?: 0), index + 1, stage = "archiving", message = "正在写入 ZIP · 第 ${index + 1} / ${value.entries.size} 个文件", force = true)
                            zip.putNextEntry(ZipEntry(name))
                            if (media != null) {
                                val downloadedBytes = bytes + media.file.length()
                                XhsTransfer.copy(media.file, zip, value.cancellation) { written, _ ->
                                    progress(value, downloadedBytes, index + 1, stage = "archiving", message = "正在写入 ZIP · 第 ${index + 1} / ${value.entries.size} 个文件 · 已写入 ${written / 1024} KB")
                                }
                                bytes = downloadedBytes
                            }
                            else { val text = entry.text.toByteArray(Charsets.UTF_8); require(bytes + text.size <= XhsPolicy.MAX_TOTAL_BYTES); zip.write(text); bytes += text.size }
                            zip.closeEntry()
                            progress(value, bytes, index + 1, stage = "archiving", message = "已写入 ${index + 1} / ${value.entries.size} 个文件", completed = index + 1, force = true)
                        } finally { media?.file?.delete() }
                    }
                    progress(value, bytes, value.entries.size, stage = "saving", message = "正在完成 ZIP 文件", completed = value.entries.size, force = true)
                    value.cancellation.check(); zip.finish()
                } else {
                    val entry = value.entries.first()
                    if (entry.text != null) {
                        val text = entry.text.toByteArray(Charsets.UTF_8)
                        progress(value, 0, 1, text.size.toLong(), "saving", "正在写入文案", force = true)
                        value.cancellation.check(); destination.write(text); bytes = text.size.toLong()
                        progress(value, bytes, 1, bytes, "saving", "正在完成文案保存", force = true)
                    }
                    else {
                        val media = XhsTransfer.download(entry, directory, 0, value.cancellation) { received, total -> progress(value, received, 1, total) }
                        try {
                            if (media.mime != value.mime) {
                                if (entry.kind != "image") error("媒体实际格式与所选格式不同，请使用 ZIP 保存。")
                                val renamed = DocumentsContract.renameDocument(activity.contentResolver, value.document!!, XhsPolicy.mediaFilename(value.filename, media.mime)) ?: error("原图格式不同，请使用 ZIP 保存。")
                                value.document = renamed; preferences.edit().putString("pending", renamed.toString()).commit()
                            }
                            XhsTransfer.copy(media.file, destination, value.cancellation) { received, total -> progress(value, received, 1, total, "saving", "正在写入文件") }
                            bytes = media.file.length()
                        } finally { media.file.delete() }
                    }
                    value.cancellation.check(); destination.flush()
                }
            } ?: error("无法打开保存位置。")
            // Serialize the commit with cancelTransfer: an accepted cancellation
            // must never race past the last check and leave a completed file.
            synchronized(this) {
                value.cancellation.check()
                check(preferences.edit().remove("pending").commit()) { "无法确认保存状态。" }
                value.committed = true; complete = true
            }
        } catch (error: Exception) { failure = error.message ?: "保存失败。" }
        finally {
            directory.deleteRecursively(); value.file?.delete()
            if (!complete) {
                val removed = runCatching { DocumentsContract.deleteDocument(activity.contentResolver, value.document!!) }.getOrDefault(false)
                if (removed) { preferences.edit().remove("pending").commit(); releaseDocumentPermission(value.document) }
                else { cleanupFailed = true; failure = "保存未完成，请在所选位置删除“${value.filename}”。" }
            } else releaseDocumentPermission(value.document)
            finish(value, if (complete || (value.cancellation.isCancelled && !cleanupFailed)) JSONObject().put("ok", true).put("cancelled", !complete && value.cancellation.isCancelled).put("bytes", bytes) else null, if (complete || (value.cancellation.isCancelled && !cleanupFailed)) null else failure)
        }
    }
    private fun releaseDocumentPermission(uri: Uri?) {
        if (uri == null) return
        // Only the unfinished document needs a grant across process restarts.
        // Release each granted flag separately; some providers grant write only.
        for (flag in listOf(Intent.FLAG_GRANT_READ_URI_PERMISSION, Intent.FLAG_GRANT_WRITE_URI_PERMISSION)) {
            runCatching { activity.contentResolver.releasePersistableUriPermission(uri, flag) }
        }
    }
    private fun copyImages(input: JSONObject, share: Boolean, callback: (Any?, String?) -> Unit) {
        check(ready.count == 0L) { "正在恢复上次保存状态，请稍后重试。" }
        check(operation == null && generated == null && pendingGenerated == null) { "请先完成当前保存或复制。" }
        val records = JSONArray(); val images = input.getJSONArray("images")
        for (index in 0 until images.length()) records.put(JSONObject(images.getJSONObject(index).toString()).put("name", "图片_${index + 1}.jpg"))
        val entries = XhsTransfer.entries(records, true)
        val value = Operation(entries, "", "image/*", input.optString("requestId").ifBlank { UUID.randomUUID().toString() }, callback, eventType = "clipboard"); value.awaitingPicker = false; operation = value
        progress(value, 0, 1, message = "正在准备原图", force = true)
        workers.execute {
            val directory = File(File(activity.cacheDir, "xhs-shared-images"), UUID.randomUUID().toString())
            try {
                check(directory.mkdirs()) { "无法准备图片缓存。" }
                val uris = arrayListOf<Uri>(); val mimes = linkedSetOf<String>(); var bytes = 0L
                entries.forEachIndexed { index, entry ->
                    val media = XhsTransfer.download(entry, directory, bytes, value.cancellation) { received, total -> progress(value, bytes + received, index + 1, if (entries.size == 1) total else 0) }; bytes += media.file.length()
                    progress(value, bytes, index + 1, stage = "preparing", message = "已准备 ${index + 1} / ${entries.size} 张原图", completed = index + 1, force = true)
                    val file = File(directory, "图片_${index + 1}${XhsPolicy.extension(media.mime)}")
                    check(media.file.renameTo(file)) { "无法准备图片文件。" }
                    uris.add(FileProvider.getUriForFile(activity, "${activity.packageName}.updates", file)); mimes.add(media.mime)
                }
                value.cancellation.check()
                activity.runOnUiThread {
                    try {
                        check(!closed && !value.cancellation.isCancelled) { "复制已取消。" }
                        val clip = ClipData(ClipDescription("小红书原图", mimes.toTypedArray()), ClipData.Item(uris.first()))
                        uris.drop(1).forEach { clip.addItem(ClipData.Item(it)) }
                        if (share) activity.startActivity(Intent.createChooser(Intent(if (uris.size == 1) Intent.ACTION_SEND else Intent.ACTION_SEND_MULTIPLE).apply { type = if (mimes.size == 1) mimes.first() else "image/*"; clipData = clip; addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION); if (uris.size == 1) putExtra(Intent.EXTRA_STREAM, uris.first()) else putParcelableArrayListExtra(Intent.EXTRA_STREAM, uris) }, "分享原图"))
                        else activity.getSystemService(ClipboardManager::class.java).setPrimaryClip(clip)
                        value.committed = true
                        finish(value, JSONObject().put("count", uris.size).put("bytes", bytes), null)
                    } catch (error: Exception) {
                        directory.deleteRecursively()
                        finish(value, if (value.cancellation.isCancelled) JSONObject().put("ok", true).put("cancelled", true) else null,
                            if (value.cancellation.isCancelled) null else error.message)
                    }
                }
            } catch (error: Exception) {
                directory.deleteRecursively()
                finish(value, if (value.cancellation.isCancelled) JSONObject().put("ok", true).put("cancelled", true) else null,
                    if (value.cancellation.isCancelled) null else error.message)
            }
        }
    }
    private fun publish(type: String, state: JSONObject) {
        activity.runOnUiThread { if (!closed) emit(JSONObject().put("type", type).put("state", state)) }
    }
    private fun progress(value: Operation, bytes: Long, item: Int, totalBytes: Long = 0,
        stage: String = "downloading", message: String = "已接收 ${bytes / 1024} KB · 第 $item / ${value.entries.size} 个文件",
        completed: Int = (item - 1).coerceAtLeast(0), force: Boolean = false) {
        val now = android.os.SystemClock.elapsedRealtime()
        if (!force && value.lastStage == stage && bytes != 0L && now - value.lastProgress < 150) return
        value.lastProgress = now; value.lastStage = stage
        publish(value.eventType, JSONObject().put("requestId", value.requestId).put("status", stage).put("stage", stage)
            .put("receivedBytes", bytes).put("totalBytes", totalBytes).put("completed", completed)
            .put("current", item).put("total", value.entries.size).put("message", message))
    }
    private fun finish(value: Operation, result: JSONObject?, error: String?) {
        activity.runOnUiThread {
            if (operation === value) operation = null
            value.file?.delete()
            if (!closed) {
                val status = if (error != null) "failed" else if (result?.optBoolean("cancelled") == true) "cancelled" else "completed"
                val state = JSONObject().put("requestId", value.requestId).put("status", status).put("stage", status)
                    .put("message", error ?: if (status == "cancelled") "操作已取消" else "保存已完成")
                if (status == "completed") state.put("completed", value.entries.size).put("total", value.entries.size).put("receivedBytes", result?.optLong("bytes", 0) ?: 0)
                emit(JSONObject().put("type", value.eventType).put("state", state))
                value.callback(result, error)
            }
        }
    }
    fun intercept(request: WebResourceRequest): WebResourceResponse? {
        val uri = request.url
        if (uri.scheme != "https" || uri.host != "appassets.androidplatform.net" || uri.path != "/xhs-media") return null
        if (request.isForMainFrame || request.method != "GET") return blocked()
        val cancellation = XhsTransfer.Cancellation(); previews.add(cancellation)
        return try {
            val preview = XhsTransfer.preview(XhsPolicy.mediaUri(uri.getQueryParameter("url")), request.requestHeaders["Range"], cancellation) { previews.remove(cancellation) }
            WebResourceResponse(preview.mime, null, preview.status, if (preview.status == 206) "Partial Content" else "OK", preview.headers, preview.stream)
        } catch (_: Exception) { previews.remove(cancellation); blocked() }
    }
    private fun blocked() = WebResourceResponse("text/plain", "UTF-8", 403, "Blocked", emptyMap(), ByteArrayInputStream(ByteArray(0)))
    @Synchronized fun isBusy(): Boolean = parsing != null || operation != null || generated != null || pendingGenerated != null
    @Synchronized fun close() { closed = true; parsing?.cancel(); operation?.cancellation?.cancel(); previews.forEach { it.cancel() }; generated?.file?.delete(); generated = null; pendingGenerated = null; cancelledGenerated.clear(); workers.shutdownNow() }
    companion object {
        const val SAVE_DOCUMENT = 4201
        private const val MAX_GENERATED_BYTES = 64L * 1024 * 1024
    }
}
