package com.brclio.toolbox

import org.json.JSONArray
import org.json.JSONObject

/** An unavailable audio track must not silently turn a video archive into text. */
object XhsArchivePolicy {
    fun imageEntries(images: JSONArray, format: String): JSONArray {
        require(format in setOf("all", "images", "live", "selected", "text")) { "保存格式无效。" }
        if (format in setOf("images", "live", "selected")) require(images.length() > 0) { "请先选择图片。" }
        val records = JSONArray()
        if (format == "text") return records
        for (index in 0 until images.length()) {
            val image = images.getJSONObject(index)
            val number = image.optInt("index", index + 1).toString().padStart(2, '0')
            val live = image.optJSONObject("liveVideo")
            if (format == "live" && live == null) continue
            records.put(JSONObject().put("name", "$number.jpg").put("kind", "image").put("url", image.getString("url")))
            if (format in setOf("all", "live", "selected") && live != null) {
                records.put(JSONObject().put("name", "$number-live.mp4").put("kind", "video").put("url", live.getString("url"))
                    .put("backupUrls", live.optJSONArray("backupUrls") ?: JSONArray()).put("requireAudio", false))
            } else if (format in setOf("all", "selected") && image.optBoolean("livePhoto")) {
                error("实况动态片段不完整，请重新解析或单独保存原图。")
            }
        }
        if (format == "live") require(records.length() > 0) { "所选图片没有可保存的实况片段。" }
        return records
    }
    fun video(candidates: JSONArray): JSONObject? = video(null, candidates)
    fun video(originals: JSONArray?, ordinary: JSONArray?): JSONObject? {
        fun available(items: JSONArray?): List<JSONObject> = if (items == null) emptyList() else
            (0 until items.length()).map { items.getJSONObject(it) }.filter { it.opt("hasAudio") != false }
        val candidates = available(originals).ifEmpty { available(ordinary) }
        require((originals?.length() ?: 0) + (ordinary?.length() ?: 0) == 0 || candidates.isNotEmpty()) {
            "视频候选均缺少声音，请切换清晰度或单独保存视频。"
        }
        return candidates.firstOrNull { it.optBoolean("isDefault") } ?: candidates.firstOrNull()
    }
}
