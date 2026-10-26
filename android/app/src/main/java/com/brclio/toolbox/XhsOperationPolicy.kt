package com.brclio.toolbox

/** Event names are part of the shared UI contract, independent of output MIME. */
object XhsOperationPolicy {
    fun eventType(action: String): String = when (action) {
        "saveVideo" -> "video"
        "exportArchive" -> "archive"
        "copyImages", "shareImages" -> "clipboard"
        else -> "transfer"
    }
}
