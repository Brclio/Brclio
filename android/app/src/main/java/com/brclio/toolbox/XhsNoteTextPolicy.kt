package com.brclio.toolbox

import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

/** Mirrors shared archive.js makeNoteTextFileData, including its UTF-8 BOM. */
object XhsNoteTextPolicy {
    fun render(
        title: String?, content: String?, sourceUrl: String?, engine: String?,
        generatedAt: Instant = Instant.now(), zone: ZoneId = ZoneId.systemDefault(),
    ): String {
        fun trim(value: String) = value.trim { it.isWhitespace() || it == '\uFEFF' }
        val heading = trim(title?.takeIf { it.isNotEmpty() } ?: "小红书笔记")
        val body = trim(content ?: "").ifEmpty { "（当前公开页面未提供可读取的正文文案）" }
        val generatedLabel = DateTimeFormatter.ofPattern("y年M月d日 HH:mm:ss", Locale.SIMPLIFIED_CHINESE)
            .withZone(zone).format(generatedAt)
        return "\uFEFF" + listOf(
            "小红书笔记", "", "标题：$heading", "", "文案：", body, "",
            "来源：${sourceUrl?.takeIf { it.isNotEmpty() } ?: "（未获取到来源链接）"}",
            "生成时间：$generatedLabel", "解析引擎：${engine?.takeIf { it.isNotEmpty() } ?: "未知"}", "",
        ).joinToString("\n")
    }
}
