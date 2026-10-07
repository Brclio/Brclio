package com.brclio.toolbox

/** Only the Android primary external-storage provider has a known filesystem mapping. */
object DocumentPath {
    const val PRIMARY_AUTHORITY = "com.android.externalstorage.documents"

    fun primaryPath(authority: String?, documentId: String, externalRoot: String): String? {
        if (authority != PRIMARY_AUTHORITY || !documentId.startsWith("primary:")) return null
        val relative = documentId.substringAfter(':')
        if (relative.startsWith('/') || relative.contains('\u0000') || relative.contains('\\')) return null
        val segments = relative.split('/')
        if (segments.any { it == "." || it == ".." }) return null
        val root = externalRoot.trimEnd('/')
        return if (relative.isEmpty()) root else "$root/$relative"
    }
}
