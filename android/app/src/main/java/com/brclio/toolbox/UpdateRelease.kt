package com.brclio.toolbox

import org.json.JSONObject
import java.net.URI

data class UpdateAsset(val name: String, val url: String, val size: Long)
data class UpdateRelease(val version: String, val notes: String, val apk: UpdateAsset, val checksums: UpdateAsset)

/** The public release contract is deliberately strict: stable tags and one named APK/checksum pair. */
object UpdatePolicy {
    private val versionPattern = Regex("^v?(\\d{1,9})\\.(\\d{1,9})\\.(\\d{1,9})$")

    fun normalizedVersion(value: String): String {
        val match = versionPattern.matchEntire(value) ?: error("发布版本号格式无效。")
        return match.groupValues.drop(1).joinToString(".") { it.toLong().toString() }
    }

    fun isNewer(candidate: String, current: String): Boolean {
        val left = normalizedVersion(candidate).split('.').map(String::toLong)
        val right = normalizedVersion(current).split('.').map(String::toLong)
        for (index in left.indices) {
            if (left[index] != right[index]) return left[index] > right[index]
        }
        return false
    }

    fun parseRelease(json: JSONObject): UpdateRelease {
        check(!json.optBoolean("draft") && !json.optBoolean("prerelease")) { "此版本不是正式发布版本。" }
        val version = normalizedVersion(json.getString("tag_name"))
        val apkName = "Brclio-$version-android.apk"
        val assets = json.getJSONArray("assets")
        fun find(name: String): UpdateAsset {
            val matches = (0 until assets.length()).map(assets::getJSONObject).filter { it.optString("name") == name }
            check(matches.size == 1) { "发布附件缺失或重复：$name" }
            val asset = matches.first()
            val url = asset.getString("browser_download_url")
            val uri = URI(url)
            check(uri.scheme == "https" && uri.host == "github.com" && uri.userInfo == null && uri.port == -1 &&
                uri.path.startsWith("/Brclio/Brclio/releases/download/")) { "更新附件来源不受信任。" }
            val size = asset.getLong("size")
            check(size > 0 && size <= 512L * 1024 * 1024) { "更新附件大小无效。" }
            return UpdateAsset(name, url, size)
        }
        return UpdateRelease(version, json.optString("body").take(100_000), find(apkName), find("SHA256SUMS.txt"))
    }

    fun expectedChecksum(contents: String, assetName: String): String {
        val lines = contents.lineSequence().mapNotNull { line ->
            Regex("^([a-fA-F0-9]{64})[ \\t]+\\*?(.+)$").matchEntire(line.trimEnd('\r'))?.let {
                if (it.groupValues[2] == assetName) it.groupValues[1].lowercase() else null
            }
        }.toList()
        check(lines.size == 1) { "SHA256SUMS.txt 缺少唯一有效的 APK 校验值。" }
        return lines.single()
    }

    fun allowedDownloadHost(url: String): Boolean {
        val uri = runCatching { URI(url) }.getOrNull() ?: return false
        return uri.scheme == "https" && uri.userInfo == null && uri.port == -1 && uri.host in setOf(
            "api.github.com", "github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com",
        )
    }
}
