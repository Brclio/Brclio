package com.brclio.toolbox

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import java.net.URI
import java.net.URLDecoder

class UpdateProxyPolicyTest {
    private val metadata = "https://api.github.com/repos/Brclio/Brclio/releases/latest"
    private val apk = "https://github.com/Brclio/Brclio/releases/download/v0.1.8/Brclio-0.1.8-android.apk"
    private val checksum = "https://github.com/Brclio/Brclio/releases/download/v0.1.8/SHA256SUMS.txt"

    @Test fun enablesBuiltInProxyForEveryNewProcessSession() {
        val firstProcess = UpdateProxySession()
        assertTrue(firstProcess.enabled)
        assertEquals(UpdateProxyRoute.BUILTIN, firstProcess.route(false))
        firstProcess.setEnabled(false)
        assertEquals(UpdateProxyRoute.DIRECT, firstProcess.route(false))
        val restartedProcess = UpdateProxySession()
        assertTrue(restartedProcess.enabled)
        assertEquals(UpdateProxyRoute.BUILTIN, restartedProcess.route(false))
    }

    @Test fun activityRecreationSharesTheProcessSetting() {
        val activitySession = ProcessUpdateProxySession.state
        try {
            activitySession.setEnabled(false)
            val recreatedActivitySession = ProcessUpdateProxySession.state
            assertSame(activitySession, recreatedActivitySession)
            assertFalse(recreatedActivitySession.enabled)
        } finally { activitySession.setEnabled(true) }
    }

    @Test fun systemProxyOrVpnTakesPriorityInBothSwitchPositions() {
        val session = UpdateProxySession()
        assertEquals(UpdateProxyRoute.SYSTEM, session.route(true))
        session.setEnabled(false)
        assertEquals(UpdateProxyRoute.SYSTEM, session.route(true))
        assertEquals(UpdateProxyRoute.DIRECT, session.route(false))
        session.setEnabled(true)
        assertEquals(UpdateProxyRoute.BUILTIN, session.route(false))
    }

    @Test fun relaysTheUnmodifiedOfficialMetadataChecksumAndApkUrls() {
        for (source in listOf(metadata, apk, checksum,
            apk.replace("/v0.1.8/", "/0.1.8/"), checksum.replace("/v0.1.8/", "/0.1.8/"))) {
            assertTrue(source, UpdateProxyPolicy.allowedSource(source))
            val wrapped = URI(UpdateProxyPolicy.relayAddress(source))
            assertEquals("https", wrapped.scheme)
            assertEquals("tools.brclio.com", wrapped.host)
            assertEquals("/api/update", wrapped.path)
            assertEquals(source, URLDecoder.decode(wrapped.rawQuery.removePrefix("url="), "UTF-8"))
        }
    }

    @Test fun rejectsProxyRecursionOtherRepositoriesAndUntrustedInitialTargets() {
        for (source in listOf(
            "http://api.github.com/repos/Brclio/Brclio/releases/latest",
            "https://user@api.github.com/repos/Brclio/Brclio/releases/latest",
            "https://api.github.com:443/repos/Brclio/Brclio/releases/latest",
            "https://api.github.com/repos/Other/Brclio/releases/latest",
            "$metadata?target=https://evil.example",
            "$metadata#fragment",
            apk.replace("github.com", "github.com.evil.example"),
            apk.replace("/Brclio/Brclio/", "/Other/Brclio/"),
            apk.replace("/v0.1.8/", "/v0.1.8/../"),
            apk.replace("/v0.1.8/", "/v0.1.8/%2e%2e/"),
            "https://release-assets.githubusercontent.com/redirect-destination",
            UpdateProxyPolicy.relayAddress(metadata),
            "file:///tmp/update.apk",
        )) {
            assertFalse(source, UpdateProxyPolicy.allowedSource(source))
            assertTrue(source, runCatching { UpdateProxyPolicy.relayAddress(source) }.isFailure)
        }
    }
}
