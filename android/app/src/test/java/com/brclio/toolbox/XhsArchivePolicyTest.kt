package com.brclio.toolbox

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class XhsArchivePolicyTest {
    @Test fun originalCandidatesWinAndSilentOriginalsFallBackToOrdinaryAudio() {
        val silent = JSONObject().put("hasAudio", false)
        val ordinary = JSONObject().put("url", "https://sns-video.xhscdn.com/ordinary").put("hasAudio", true).put("isDefault", true)
        val original = JSONObject().put("url", "https://sns-video.xhscdn.com/original")
        assertSame(ordinary, XhsArchivePolicy.video(JSONArray().put(silent), JSONArray().put(ordinary)))
        assertSame(original, XhsArchivePolicy.video(JSONArray().put(original), JSONArray().put(ordinary)))
        val preferred = JSONObject().put("url", "https://sns-video.xhscdn.com/preferred").put("isDefault", true)
        assertSame(preferred, XhsArchivePolicy.video(JSONArray().put(original).put(preferred), JSONArray().put(ordinary)))
        assertThrows(IllegalArgumentException::class.java) { XhsArchivePolicy.video(JSONArray().put(silent), JSONArray().put(silent)) }
    }
    @Test fun selectedArchiveKeepsOrdinaryPhotosAndPairedLiveClipsTogether() {
        val images = JSONArray().put(JSONObject().put("index", 1).put("url", "https://ci.xiaohongshu.com/still"))
            .put(JSONObject().put("index", 4).put("url", "https://ci.xiaohongshu.com/live").put("livePhoto", true)
                .put("liveVideo", JSONObject().put("url", "https://sns-video.xhscdn.com/paired").put("backupUrls", JSONArray().put("https://sns-video.xhscdn.com/backup"))))
        val mixed = XhsArchivePolicy.imageEntries(images, "selected")
        assertEquals(3, mixed.length())
        assertEquals("01.jpg", mixed.getJSONObject(0).getString("name"))
        assertEquals("04.jpg", mixed.getJSONObject(1).getString("name"))
        assertEquals("04-live.mp4", mixed.getJSONObject(2).getString("name"))
        assertFalse(mixed.getJSONObject(2).getBoolean("requireAudio"))
        assertEquals("https://sns-video.xhscdn.com/backup", mixed.getJSONObject(2).getJSONArray("backupUrls").getString(0))
        assertEquals(2, XhsArchivePolicy.imageEntries(images, "images").length())
        assertEquals(2, XhsArchivePolicy.imageEntries(images, "live").length())
    }
    @Test fun missingLivePairCannotBeSilentlyArchivedAsAStill() {
        val incomplete = JSONArray().put(JSONObject().put("url", "https://ci.xiaohongshu.com/live").put("livePhoto", true))
        assertThrows(IllegalStateException::class.java) { XhsArchivePolicy.imageEntries(incomplete, "selected") }
        assertEquals(1, XhsArchivePolicy.imageEntries(incomplete, "images").length())
        assertThrows(IllegalArgumentException::class.java) { XhsArchivePolicy.imageEntries(JSONArray(), "selected") }
    }
    @Test fun neverTreatsAnUnavailableVideoAsSuccessfulTextOnlyArchive() {
        assertThrows(IllegalArgumentException::class.java) { XhsArchivePolicy.video(JSONArray().put(JSONObject().put("url", "https://sns-video.xhscdn.com/v").put("hasAudio", false))) }
        assertNull(XhsArchivePolicy.video(JSONArray()))
        val unknown = JSONObject().put("url", "https://sns-video.xhscdn.com/unknown")
        assertSame(unknown, XhsArchivePolicy.video(JSONArray().put(JSONObject().put("hasAudio", false)).put(unknown)))
        val yes = JSONObject().put("hasAudio", true)
        assertSame(yes, XhsArchivePolicy.video(JSONArray().put(yes)))
    }
}
