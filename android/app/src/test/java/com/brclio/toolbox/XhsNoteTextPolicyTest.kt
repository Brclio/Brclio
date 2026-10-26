package com.brclio.toolbox

import java.time.Instant
import java.time.ZoneId
import org.junit.Assert.*
import org.junit.Test

class XhsNoteTextPolicyTest {
    private val instant = Instant.parse("2026-01-02T03:04:05Z")
    private val zone = ZoneId.of("Asia/Shanghai")

    @Test fun matchesSharedArchiveFixtureIncludingMetadataAndUnicodeBody() {
        val result = XhsNoteTextPolicy.render(" 标题 ", " 标题\n正文🌸\n第二行 ",
            "https://www.xiaohongshu.com/explore/fixture", "python", instant, zone)
        // This exact fixture is also produced by archive.js using the same
        // instant and Asia/Shanghai. Body text is never rewritten or deduped.
        assertEquals("\uFEFF小红书笔记\n\n标题：标题\n\n文案：\n标题\n正文🌸\n第二行\n\n来源：https://www.xiaohongshu.com/explore/fixture\n生成时间：2026年1月2日 11:04:05\n解析引擎：python\n", result)
        val bytes = result.toByteArray(Charsets.UTF_8)
        assertArrayEquals(byteArrayOf(0xef.toByte(), 0xbb.toByte(), 0xbf.toByte()), bytes.copyOfRange(0, 3))
        assertEquals(result, String(bytes, Charsets.UTF_8))
    }
    @Test fun usesSharedEmptyFieldPlaceholdersAndDeviceTimezone() {
        val result = XhsNoteTextPolicy.render(null, " \n\uFEFF ", "", "", instant, ZoneId.of("UTC"))
        assertTrue(result.contains("标题：小红书笔记"))
        assertTrue(result.contains("（当前公开页面未提供可读取的正文文案）"))
        assertTrue(result.contains("来源：（未获取到来源链接）"))
        assertTrue(result.contains("解析引擎：未知"))
        assertTrue(result.contains("生成时间：2026年1月2日 03:04:05"))
        assertTrue(result.endsWith("\n"))
    }
}
