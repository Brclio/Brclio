package com.brclio.toolbox

import java.net.URI
import java.util.Locale

/** Shared text must contain an actual official host, not a domain in a path. */
object XhsSharePolicy {
    fun noteText(raw: String?): String? {
        val text = raw?.trim()?.takeIf { it.length in 1..3000 } ?: return null
        return text.takeIf {
            Regex("https?://[^\\s<>\"']+", RegexOption.IGNORE_CASE).findAll(text).any { match ->
                val value = match.value.trimEnd('.', ',', ';', '!', '?', ')', ']', '}', '，', '。', '；', '！', '？', '）', '】', '》')
                runCatching {
                    val uri = URI(value)
                    val host = uri.host?.lowercase(Locale.ROOT) ?: return@runCatching false
                    uri.rawUserInfo == null && uri.port in setOf(-1, 443) &&
                        listOf("xiaohongshu.com", "xhslink.com", "xhslink.cn").any { host == it || host.endsWith(".$it") }
                }.getOrDefault(false)
            }
        }
    }
}
