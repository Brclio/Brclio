package com.brclio.toolbox

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SettingsTest {
    @Test fun preservesSupportedSettingsAndDisablesUnsupportedLoginStartup() {
        val settings = Settings.normalize(JSONObject()
            .put("pathMode", "relative").put("basePath", " /storage/emulated/0/Documents ")
            .put("quoteMode", "auto").put("separator", "forward")
            .put("joinWith", "space").put("trailingSlash", true).put("launchAtLogin", true))
        assertEquals("relative", settings.getString("pathMode"))
        assertEquals(" /storage/emulated/0/Documents ", settings.getString("basePath"))
        assertEquals("auto", settings.getString("quoteMode"))
        assertEquals("forward", settings.getString("separator"))
        assertEquals("space", settings.getString("joinWith"))
        assertTrue(settings.getBoolean("trailingSlash"))
        assertFalse(settings.getBoolean("launchAtLogin"))
    }

    @Test fun rejectsInvalidTypesUnknownSettingsAndNullCharacters() {
        val settings = Settings.normalize(JSONObject()
            .put("pathMode", "invalid").put("quoteMode", JSONObject.NULL)
            .put("separator", 3).put("joinWith", "pipe")
            .put("basePath", "path\u0000escape").put("trailingSlash", "true")
            .put("unknown", "value"))
        assertEquals(Settings.defaults().toString(), settings.toString())
        assertFalse(settings.has("unknown"))
    }

    @Test fun settingsSurviveJsonRoundTrip() {
        val original = Settings.normalize(JSONObject().put("quoteMode", "single").put("basePath", "/资料/工作 2026"))
        assertEquals(original.toString(), Settings.normalize(JSONObject(original.toString())).toString())
    }
}
