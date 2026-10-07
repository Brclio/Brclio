package com.brclio.toolbox

/** A package replacement alone is not consent to open the app. */
internal object UpdateRelaunchPolicy {
    const val MAX_AGE_MILLIS = 30 * 60 * 1000L

    fun accepts(targetVersionCode: Long, installedVersionCode: Long, requestedAt: Long, now: Long): Boolean =
        targetVersionCode > 0 && targetVersionCode == installedVersionCode &&
            requestedAt > 0 && now >= requestedAt && now - requestedAt <= MAX_AGE_MILLIS
}
