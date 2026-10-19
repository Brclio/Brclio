package com.brclio.toolbox

import org.json.JSONObject
import org.json.JSONArray
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
    @Test fun settingsAllowOnlyBoundedJsonAndRetainTheCurrentSession() {
        for ((path, method) in listOf("/api/account/profile" to "PUT", "/api/account/password" to "POST")) {
            val body = JSONObject().put("fixture", "value")
            val request = AccountPolicy.validate(JSONObject().put("path", path).put("method", method).put("body", body))
            assertEquals(body.toString(), request.body)
            assertTrue(request.cancelsGoogle)
            assertFalse(request.changesAuth)
            for (invalidMethod in listOf("GET", "DELETE", "PATCH", method.lowercase(), if (method == "PUT") "POST" else "PUT")) {
                assertThrows(IllegalArgumentException::class.java) {
                    AccountPolicy.validate(JSONObject().put("path", path).put("method", invalidMethod).put("body", body))
                }
            }
            for (invalidPath in listOf("$path?x=y", "$path/", AccountPolicy.ORIGIN + path, path.replace("/api/", "//api/"), path.replace("/account/", "/account/%2e%2e/"))) {
                assertThrows(IllegalArgumentException::class.java) {
                    AccountPolicy.validate(JSONObject().put("path", invalidPath).put("method", method).put("body", body))
                }
            }
            for (invalidBody in listOf(JSONObject.NULL, JSONArray(), "fixture", JSONObject().put("nickname", "字".repeat(50000)))) {
                assertThrows(IllegalArgumentException::class.java) {
                    AccountPolicy.validate(JSONObject().put("path", path).put("method", method).put("body", invalidBody))
                }
            }
        }
        val session = AccountPolicy.validate(JSONObject().put("path", "/api/account/session"))
        assertFalse(session.cancelsGoogle)
        assertFalse(session.changesAuth)
        for (path in listOf("/api/account/login", "/api/account/register", "/api/account/logout")) {
            val request = AccountPolicy.validate(JSONObject().put("path", path).put("method", "POST"))
            assertTrue(request.cancelsGoogle)
            assertTrue(request.changesAuth)
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
