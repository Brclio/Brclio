package com.brclio.toolbox

import org.junit.Assert.assertEquals
import org.junit.Test

class XhsOperationPolicyTest {
    @Test fun archiveAndImageProgressReachTheirOwnUiRatherThanTheVideoRequestFilter() {
        assertEquals("archive", XhsOperationPolicy.eventType("exportArchive"))
        assertEquals("transfer", XhsOperationPolicy.eventType("saveImages"))
        assertEquals("transfer", XhsOperationPolicy.eventType("saveNote"))
        assertEquals("clipboard", XhsOperationPolicy.eventType("copyImages"))
        assertEquals("clipboard", XhsOperationPolicy.eventType("shareImages"))
        assertEquals("video", XhsOperationPolicy.eventType("saveVideo"))
    }
}
