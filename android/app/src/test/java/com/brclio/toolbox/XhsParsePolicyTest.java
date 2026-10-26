package com.brclio.toolbox;

import static org.junit.Assert.*;
import org.json.JSONObject;
import org.junit.Test;

public class XhsParsePolicyTest {
    @Test public void anonymousPythonContractKeepsOriginalAvailabilityWithoutInventingUrls() throws Exception {
        JSONObject parsed = XhsParsePolicy.pythonResponse(200, "{\"success\":true,\"engine\":\"python\",\"images\":[],\"videos\":[],\"originalVideoCount\":2,\"hasOriginalVideo\":true}");
        assertEquals("python", parsed.getString("engine"));
        assertEquals(2, parsed.getInt("originalVideoCount"));
        assertTrue(parsed.getBoolean("hasOriginalVideo"));
        assertFalse(parsed.has("originalVideos"));
        assertEquals("https://xhs.download.brclio.com/api/python_parse", XhsParsePolicy.PYTHON_ENDPOINT);
        assertEquals(8 * 1024 * 1024, XhsParsePolicy.MAX_RESPONSE_BYTES);
    }
    @Test public void redirectsServerErrorsAndInvalidJsonNeverBecomeParseSuccess() {
        assertThrows(IllegalArgumentException.class, () -> XhsParsePolicy.pythonResponse(302, "{\"success\":true}"));
        assertThrows(IllegalArgumentException.class, () -> XhsParsePolicy.pythonResponse(503, "{\"success\":true}"));
        assertThrows(IllegalArgumentException.class, () -> XhsParsePolicy.pythonResponse(200, "<html>error</html>"));
        assertThrows(IllegalArgumentException.class, () -> XhsParsePolicy.pythonResponse(200, "{\"success\":false,\"message\":\"请稍后重试\"}"));
    }
}
