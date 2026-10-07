package com.brclio.toolbox

import org.json.JSONObject

/** Strict normalization keeps malformed or old settings from breaking the shared UI. */
object Settings {
    private val allowed = mapOf(
        "pathMode" to setOf("absolute", "relative"),
        "quoteMode" to setOf("none", "double", "single", "auto"),
        "separator" to setOf("native", "forward", "backward"),
        "joinWith" to setOf("newline", "space", "comma"),
    )

    fun defaults(): JSONObject = JSONObject()
        .put("pathMode", "absolute")
        .put("basePath", "")
        .put("quoteMode", "none")
        .put("separator", "native")
        .put("trailingSlash", false)
        .put("joinWith", "newline")
        .put("launchAtLogin", false)

    fun normalize(input: JSONObject): JSONObject {
        val result = defaults()
        allowed.forEach { (key, values) ->
            val candidate = input.optString(key)
            if (candidate in values) result.put(key, candidate)
        }
        val base = input.opt("basePath")
        if (base is String && base.length <= 16_384 && !base.contains('\u0000')) {
            result.put("basePath", base)
        }
        val trailingSlash = input.opt("trailingSlash")
        if (trailingSlash is Boolean) result.put("trailingSlash", trailingSlash)
        // Android has no launch-at-login option. Never persist a misleading enabled state.
        return result
    }
}
