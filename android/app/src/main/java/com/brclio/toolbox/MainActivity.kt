package com.brclio.toolbox

import android.app.Activity
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.provider.DocumentsContract
import android.provider.OpenableColumns
import android.view.Gravity
import android.view.WindowInsets
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.widget.TextView
import android.widget.FrameLayout
import android.view.ViewGroup
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewClientCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayInputStream

class MainActivity : Activity() {
    private lateinit var webView: WebView
    private val preferences by lazy { getSharedPreferences("brclio-settings", MODE_PRIVATE) }
    private var pageReady = false
    private var pendingPickerId: String? = null
    private var pendingPickerKind = "file"
    private var incomingPaths = JSONArray()
    private var updater: AndroidUpdater? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        webView = WebView(this)
        webView.setBackgroundColor(Color.rgb(244, 243, 238))
        val container = FrameLayout(this).apply {
            setBackgroundColor(Color.rgb(244, 243, 238))
            addView(webView, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        }
        setContentView(container)

        // Android 15 enforces edge-to-edge. Keep the web app clear of system bars/keyboard.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            container.setOnApplyWindowInsetsListener { view, insets ->
                val bars = insets.getInsets(WindowInsets.Type.systemBars() or WindowInsets.Type.ime())
                view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
                insets
            }
        }

        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            setContentView(TextView(this).apply {
                setText(R.string.webview_update)
                gravity = Gravity.CENTER
                textSize = 18f
                setPadding(32, 32, 32, 32)
            })
            return
        }

        configureWebView()
        acceptIntent(intent)
        webView.isFocusableInTouchMode = true
        webView.requestFocus()
        webView.loadUrl("$LOCAL_ORIGIN/assets/web/index.html")
    }

    @Suppress("SetJavaScriptEnabled")
    private fun configureWebView() {
        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            setSupportMultipleWindows(false)
            javaScriptCanOpenWindowsAutomatically = false
        }
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)

        val loader = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()
        webView.webViewClient = object : WebViewClientCompat() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse {
                if (isLocal(request.url)) {
                    loader.shouldInterceptRequest(request.url)?.let { return it }
                }
                // Never fall back to the network for missing assets or remote subresources.
                return WebResourceResponse(
                    "text/plain", "UTF-8", 403, "Blocked", emptyMap(),
                    ByteArrayInputStream(ByteArray(0)),
                )
            }

            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                if (isLocal(request.url)) return false
                if (request.isForMainFrame && request.hasGesture() &&
                    request.url.scheme in setOf("https", "http")) {
                    runCatching { startActivity(Intent(Intent.ACTION_VIEW, request.url)) }
                }
                return true
            }

            override fun onPageFinished(view: WebView, url: String) {
                if (!isLocal(Uri.parse(url))) return
                pageReady = true
                flushIncomingPaths()
            }
        }

        // Unlike addJavascriptInterface, this bridge is restricted to the local origin
        // and rejects frames. Remote navigation is also blocked above.
        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            WebViewCompat.addWebMessageListener(
                webView, "AndroidBridge", setOf(LOCAL_ORIGIN),
            ) { _, message, sourceOrigin, isMainFrame, _ ->
                if (isMainFrame && sourceOrigin.toString().trimEnd('/') == LOCAL_ORIGIN) {
                    message.data?.let { processMessage(it) }
                }
            }
        }
    }

    private fun processMessage(raw: String) {
        if (raw.length > 1_048_576) return
        val request = runCatching { JSONObject(raw) }.getOrNull() ?: return
        val id = request.optString("id").takeIf { it.isNotEmpty() && it.length <= 128 } ?: return
        val payload = request.optJSONObject("payload") ?: JSONObject()
        try {
            when (request.optString("method")) {
                "getPlatform" -> resolve(id, JSONObject()
                    .put("platform", "android")
                    .put("version", BuildConfig.VERSION_NAME)
                    .put("capabilities", JSONObject()
                        .put("filePicker", true)
                        .put("folderPicker", true)
                        .put("systemIntegration", false)))
                "getSettings" -> resolve(id, readSettings())
                "saveSettings" -> {
                    val settings = Settings.normalize(payload.optJSONObject("settings") ?: payload)
                    if (!preferences.edit().putString("settings", settings.toString()).commit()) {
                        error("无法保存设置，请重试。")
                    }
                    resolve(id, settings)
                }
                "pickPaths" -> launchPicker(id, payload.optString("kind", "file"))
                "copyText" -> {
                    val text = payload.optString("text")
                    require(text.length <= 524_288) { "复制内容过长。" }
                    val clipboard = getSystemService(CLIPBOARD_SERVICE) as ClipboardManager
                    clipboard.setPrimaryClip(ClipData.newPlainText("Brclio 路径", text))
                    resolve(id, JSONObject().put("ok", true))
                }
                "getIntegrationStatus" -> resolve(id, integrationStatus())
                "setIntegration" -> resolve(id, error = "Android 不支持向系统文件管理器统一添加右键菜单。请使用文件选择或分享至 Brclio。")
                "checkForUpdates" -> updater().check { result, error -> resolve(id, result, error) }
                "downloadUpdate" -> updater().download { result, error -> resolve(id, result, error) }
                "installUpdate" -> updater().install { result, error -> resolve(id, result, error) }
                else -> resolve(id, error = "未知操作。")
            }
        } catch (exception: Exception) {
            resolve(id, error = exception.message ?: "操作失败，请重试。")
        }
    }

    private fun readSettings(): JSONObject {
        val saved = runCatching { JSONObject(preferences.getString("settings", "{}") ?: "{}") }
            .getOrDefault(JSONObject())
        return Settings.normalize(saved)
    }

    private fun updater(): AndroidUpdater = updater ?: AndroidUpdater(this) { state ->
        if (pageReady) webView.evaluateJavascript(
            "window.dispatchEvent(new CustomEvent('brclio:update',{detail:$state}));", null,
        )
    }.also { updater = it }

    private fun integrationStatus() = JSONObject()
        .put("supported", false)
        .put("enabled", false)
        .put("message", "选择文件或文件夹，或从文件管理器分享至 Brclio。长按应用内的路径即可复制。")

    @Suppress("DEPRECATION")
    private fun launchPicker(id: String, kind: String) {
        val pickerKind = PickerKind.fromWebKind(kind)
        check(pendingPickerId == null) { "请先完成当前文件选择。" }
        val folder = pickerKind == PickerKind.DIRECTORY
        val picker = Intent(if (folder) Intent.ACTION_OPEN_DOCUMENT_TREE else Intent.ACTION_OPEN_DOCUMENT).apply {
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            if (!folder) {
                addCategory(Intent.CATEGORY_OPENABLE)
                type = "*/*"
                putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
            }
        }
        pendingPickerId = id
        pendingPickerKind = if (folder) "directory" else "file"
        try {
            startActivityForResult(picker, PICK_PATHS)
        } catch (exception: Exception) {
            pendingPickerId = null
            throw exception
        }
    }

    @Deprecated("Activity result compatibility for Android 8+, no AndroidX Activity dependency needed.")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode != PICK_PATHS) return
        val id = pendingPickerId ?: return
        pendingPickerId = null
        if (resultCode != RESULT_OK || data == null) {
            resolve(id, JSONArray())
            return
        }
        val paths = JSONArray()
        selectedUris(data).forEach { uri -> paths.put(pathRecord(uri, pendingPickerKind)) }
        resolve(id, paths)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        acceptIntent(intent)
        flushIncomingPaths()
    }

    private fun acceptIntent(received: Intent?) {
        if (received?.action !in setOf(Intent.ACTION_SEND, Intent.ACTION_SEND_MULTIPLE, Intent.ACTION_VIEW)) return
        selectedUris(received ?: return).forEach { uri ->
            if (uri.scheme == "content" || uri.scheme == "file") {
                incomingPaths.put(pathRecord(uri))
            }
        }
        // Plain text shares may contain a path/URI but must never be opened as web content.
        if (incomingPaths.length() == 0) {
            received.getCharSequenceExtra(Intent.EXTRA_TEXT)?.toString()?.trim()?.let { text ->
                val path = text.takeIf {
                    it.length <= 16_384 && !it.contains('\u0000') &&
                        (it.startsWith('/') || it.startsWith("content://"))
                } ?: return@let
                incomingPaths.put(JSONObject()
                    .put("path", path)
                    .put("name", path.substringAfterLast('/').ifEmpty { "已分享的路径" })
                    .put("kind", "file")
                    .put("isUri", path.startsWith("content://")))
            }
        }
    }

    @Suppress("DEPRECATION")
    private fun selectedUris(data: Intent): List<Uri> {
        val uris = linkedSetOf<Uri>()
        data.data?.let(uris::add)
        data.clipData?.let { clips ->
            for (index in 0 until minOf(clips.itemCount, MAX_PATHS)) {
                clips.getItemAt(index).uri?.let(uris::add)
            }
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            data.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java)?.let(uris::add)
            data.getParcelableArrayListExtra(Intent.EXTRA_STREAM, Uri::class.java)?.let(uris::addAll)
        } else {
            data.getParcelableExtra<Uri>(Intent.EXTRA_STREAM)?.let(uris::add)
            data.getParcelableArrayListExtra<Uri>(Intent.EXTRA_STREAM)?.let(uris::addAll)
        }
        return uris.take(MAX_PATHS)
    }

    @Suppress("DEPRECATION")
    private fun pathRecord(uri: Uri, expectedKind: String? = null): JSONObject {
        var name = uri.lastPathSegment ?: "文件"
        var kind = expectedKind ?: "file"
        if (uri.scheme == "content") {
            runCatching {
                val metadataUri = if (DocumentsContract.isTreeUri(uri) &&
                    !DocumentsContract.isDocumentUri(this, uri)) {
                    DocumentsContract.buildDocumentUriUsingTree(uri, DocumentsContract.getTreeDocumentId(uri))
                } else uri
                contentResolver.query(metadataUri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
                    if (cursor.moveToFirst()) {
                        val column = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                        if (column >= 0 && !cursor.isNull(column)) name = cursor.getString(column)
                    }
                }
                if (contentResolver.getType(metadataUri) == DocumentsContract.Document.MIME_TYPE_DIR) kind = "directory"
            }
        }

        val documentId = runCatching {
            when {
                DocumentsContract.isDocumentUri(this, uri) -> DocumentsContract.getDocumentId(uri)
                DocumentsContract.isTreeUri(uri) -> DocumentsContract.getTreeDocumentId(uri)
                else -> null
            }
        }.getOrNull()
        val absolute = documentId?.let {
            DocumentPath.primaryPath(uri.authority, it, Environment.getExternalStorageDirectory().absolutePath)
        } ?: if (uri.scheme == "file") uri.path?.takeIf { it.startsWith('/') } else null
        val path = absolute ?: uri.toString()
        return JSONObject()
            .put("path", path)
            .put("name", if (name.isBlank() || name == uri.lastPathSegment) path.substringAfterLast('/') else name)
            .put("kind", kind)
            .put("isUri", absolute == null)
    }

    private fun flushIncomingPaths() {
        if (!pageReady || incomingPaths.length() == 0) return
        val paths = incomingPaths
        incomingPaths = JSONArray()
        webView.evaluateJavascript(
            "window.dispatchEvent(new CustomEvent('brclio:paths',{detail:$paths}));", null,
        )
    }

    private fun resolve(id: String, result: Any? = null, error: String? = null) {
        val response = JSONObject()
            .put("result", result ?: JSONObject.NULL)
            .put("error", error ?: JSONObject.NULL)
        webView.evaluateJavascript(
            "window.__brclioResolve?.(${JSONObject.quote(id)},$response);", null,
        )
    }

    @Deprecated("Compatible with Android versions before predictive back.")
    override fun onBackPressed() {
        if (::webView.isInitialized && webView.canGoBack()) webView.goBack() else finish()
    }

    override fun onDestroy() {
        updater?.close()
        if (::webView.isInitialized) {
            webView.stopLoading()
            webView.destroy()
        }
        super.onDestroy()
    }

    private fun isLocal(uri: Uri): Boolean = uri.scheme == "https" &&
        uri.host == "appassets.androidplatform.net" && uri.port == -1 &&
        uri.path?.startsWith("/assets/") == true

    companion object {
        private const val LOCAL_ORIGIN = "https://appassets.androidplatform.net"
        private const val PICK_PATHS = 41
        private const val MAX_PATHS = 128
    }
}
