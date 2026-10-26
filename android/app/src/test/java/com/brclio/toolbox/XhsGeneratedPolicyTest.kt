package com.brclio.toolbox

import org.junit.Assert.*
import org.junit.Test

class XhsGeneratedPolicyTest {
    @Test fun allowsTextCaptionCharsetWithoutAcceptingExecutableDocuments() {
        assertEquals("text/plain", XhsGeneratedPolicy.mime("text/plain;charset=utf-8"))
        assertEquals("image/heic", XhsGeneratedPolicy.mime("IMAGE/HEIC"))
        assertEquals("application/zip", XhsGeneratedPolicy.mime("application/zip"))
        for (mime in listOf("text/html", "image/svg+xml", "application/javascript", "application/vnd.android.package-archive", "")) assertThrows(IllegalArgumentException::class.java) { XhsGeneratedPolicy.mime(mime) }
    }
}
