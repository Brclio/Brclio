package com.brclio.toolbox

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class UpdatePolicyTest {
    private fun release(version: String = "0.1.0") = JSONObject()
        .put("tag_name", "v$version").put("body", "修复路径复制")
        .put("draft", false).put("prerelease", false)
        .put("assets", JSONArray().put(asset("Brclio-$version-android.apk", 4000000)).put(asset("SHA256SUMS.txt", 400)))

    private fun asset(name: String, size: Long) = JSONObject().put("name", name).put("size", size)
        .put("browser_download_url", "https://github.com/Brclio/Brclio/releases/download/v0.1.0/$name")

    @Test fun comparesVersionPartsNumerically() {
        assertTrue(UpdatePolicy.isNewer("v0.10.0", "0.9.9"))
        assertFalse(UpdatePolicy.isNewer("0.1.0", "0.1.0"))
        assertFalse(UpdatePolicy.isNewer("0.9.0", "1.0.0"))
    }

    @Test fun resolvesRequiredStableReleaseAssets() {
        val result = UpdatePolicy.parseRelease(release())
        assertEquals("0.1.0", result.version)
        assertEquals("Brclio-0.1.0-android.apk", result.apk.name)
        assertEquals("SHA256SUMS.txt", result.checksums.name)
    }

    @Test(expected = IllegalStateException::class)
    fun refusesPreReleaseInstallers() { UpdatePolicy.parseRelease(release().put("prerelease", true)) }

    @Test(expected = IllegalStateException::class)
    fun refusesAssetsFromAnotherRepository() {
        val json = release()
        json.getJSONArray("assets").getJSONObject(0).put("browser_download_url", "https://github.com/attacker/app/releases/download/v0.1.0/app.apk")
        UpdatePolicy.parseRelease(json)
    }

    @Test fun selectsExactChecksumFilenameWithStandardSha256sumSyntax() {
        val hash = "a".repeat(64)
        assertEquals(hash, UpdatePolicy.expectedChecksum("${"b".repeat(64)}  another.apk\r\n$hash *Brclio-0.1.0-android.apk\r\n", "Brclio-0.1.0-android.apk"))
    }

    @Test(expected = IllegalStateException::class)
    fun refusesAmbiguousChecksumEntries() {
        UpdatePolicy.expectedChecksum("${"a".repeat(64)}  app.apk\n${"b".repeat(64)}  app.apk\n", "app.apk")
    }

    @Test fun allowsOnlyHttpsGithubDownloadInfrastructure() {
        assertTrue(UpdatePolicy.allowedDownloadHost("https://release-assets.githubusercontent.com/example?token=public-link"))
        for (url in listOf("http://github.com/file", "https://github.com.evil.test/file", "https://user@github.com/file", "https://github.com:1234/file", "file:///tmp/app.apk")) {
            assertFalse(url, UpdatePolicy.allowedDownloadHost(url))
        }
    }
}
