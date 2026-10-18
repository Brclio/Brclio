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

    @Test fun cloudflareChallengeTakesPriorityOverHttpStatusAndRoute() {
        val expected = "更新请求被 Cloudflare 安全验证拦截，请稍后重试或切换更新网络。"
        for (route in UpdateProxyRoute.entries) {
            for (status in listOf(200, 206, 302, 403, 429, 503)) {
                assertEquals(expected, UpdateProxyPolicy.responseError(status, route, " \tChAlLeNgE\t "))
            }
        }
    }

    @Test fun builtinServiceDenialAndRateLimitAreNotAttributedToGithub() {
        assertEquals("内置更新服务拒绝请求（HTTP 403），可关闭内置代理或稍后重试。",
            UpdateProxyPolicy.responseError(403, UpdateProxyRoute.BUILTIN))
        assertEquals("内置更新服务暂时限制请求（HTTP 429），可关闭内置代理或稍后重试。",
            UpdateProxyPolicy.responseError(429, UpdateProxyRoute.BUILTIN))
    }

    @Test fun ordinaryGithubLimitsKeepTheirExistingMessageOnSystemAndDirectRoutes() {
        for (route in listOf(UpdateProxyRoute.SYSTEM, UpdateProxyRoute.DIRECT)) {
            for (status in listOf(403, 429)) {
                assertEquals("GitHub 请求受到限制，请稍后重试。", UpdateProxyPolicy.responseError(status, route))
            }
        }
    }

    @Test fun challengeHeaderMustMatchExactlyAndUntrustedHeaderTextNeverAppearsInErrors() {
        val untrusted = "https://private.example/sub?token=fixture-sensitive-value"
        for (header in listOf(null, "", "challenge-other", "other challenge", untrusted)) {
            assertFalse(UpdateProxyPolicy.isCloudflareChallenge(header))
            val message = UpdateProxyPolicy.responseError(403, UpdateProxyRoute.BUILTIN, header)
            assertFalse(message.contains(untrusted))
            assertFalse(message.contains("fixture-sensitive-value"))
            assertEquals(UpdateProxyPolicy.responseError(403, UpdateProxyRoute.BUILTIN), message)
        }
    }

    @Test fun unrelatedHttpErrorsKeepTheirExistingMessages() {
        assertEquals("GitHub 尚未发布正式更新。", UpdateProxyPolicy.responseError(404, UpdateProxyRoute.BUILTIN))
        assertEquals("内置更新代理暂不可用，可关闭内置代理后重试。", UpdateProxyPolicy.responseError(502, UpdateProxyRoute.BUILTIN))
        assertEquals("更新服务器返回 HTTP 502，请重试。", UpdateProxyPolicy.responseError(502, UpdateProxyRoute.SYSTEM))
    }
}
