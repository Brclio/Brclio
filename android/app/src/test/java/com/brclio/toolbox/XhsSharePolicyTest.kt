package com.brclio.toolbox

import org.junit.Assert.*
import org.junit.Test

class XhsSharePolicyTest {
    @Test fun acceptsActualHostsAndCompleteSharedText() {
        for (url in listOf("https://www.xiaohongshu.com/explore/abc", "http://xhslink.com/a/short", "https://xhslink.cn/o/short", "https://WWW.XIAOHONGSHU.COM/discovery/item/abc")) {
            val text = "分享一篇笔记 $url，快来看看"
            assertEquals(text, XhsSharePolicy.noteText(text))
        }
    }
    @Test fun doesNotStealPathSharesWhenNamesOnlyOccurInAnotherHostOrPath() {
        for (text in listOf("https://xiaohongshu.com.evil.example/note", "https://example.org/?x=xiaohongshu.com", "https://xiaohongshu.com@evil.example/note", "https://example.org/path/xhslink.cn", "https://xhslink.com:8443/a/test", "/storage/emulated/0/xiaohongshu.com/notes.txt", "not a link")) {
            assertNull(text, XhsSharePolicy.noteText(text))
        }
        assertNull(XhsSharePolicy.noteText("https://xhslink.com/a/test " + "x".repeat(3000)))
    }
}
