package com.brclio.toolbox

import java.util.Locale

object XhsGeneratedPolicy {
    fun mime(value: String): String {
        val normalized = value.substringBefore(';').trim().lowercase(Locale.ROOT)
        require(normalized in setOf("image/jpeg", "image/heic", "video/quicktime", "application/zip", "text/plain")) { "不支持的导出格式。" }
        return normalized
    }
}
