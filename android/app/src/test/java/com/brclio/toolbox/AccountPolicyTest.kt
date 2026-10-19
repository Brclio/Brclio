package com.brclio.toolbox

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class AccountPolicyTest {
    @Test fun confinesNativeRequestsToExactAccountOperations() {
        assertEquals("GET", AccountPolicy.validate(JSONObject().put("path", "/api/account/session")).method)
        assertEquals("PUT", AccountPolicy.validate(JSONObject().put("path", "/api/account/data").put("method", "PUT").put("body", JSONObject())).method)
        for (path in listOf("https://evil.example/api/account/login", "/api/account/device/poll", "/api/account/session?x=y", "/api/account/../login")) {
            assertThrows(IllegalArgumentException::class.java) { AccountPolicy.validate(JSONObject().put("path", path)) }
        }
        assertThrows(IllegalArgumentException::class.java) {
            AccountPolicy.validate(JSONObject().put("path", "/api/account/session").put("body", JSONObject()))
        }
        assertThrows(IllegalArgumentException::class.java) {
            AccountPolicy.validate(JSONObject().put("path", "/api/account/login").put("method", "POST").put("body", JSONObject().put("value", "字".repeat(50000))))
        }
    }
    @Test fun oauthUrlAndProofAreBoundToTrustedDeviceHandoff() {
        val id = "fixture_device_0123456789"
        assertTrue(AccountPolicy.validGoogleUrl("${AccountPolicy.ORIGIN}/api/account/google/start?device=$id", id))
        for (url in listOf("https://evil.example/api/account/google/start?device=$id", "https://user@tools.brclio.com/api/account/google/start?device=$id", "${AccountPolicy.ORIGIN}:443/api/account/google/start?device=$id", "${AccountPolicy.ORIGIN}/api/account/google/start?device=other", "${AccountPolicy.ORIGIN}/api/account/google/start?device=$id&device=$id")) {
            assertFalse(url, AccountPolicy.validGoogleUrl(url, id))
        }
        assertEquals("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM", AccountPolicy.challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"))
        assertTrue(AccountPolicy.verifier().matches(Regex("[A-Za-z0-9_-]{43}")))
        assertFalse(AccountPolicy.validToken("invalid\ntoken"))
    }
}
