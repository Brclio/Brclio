package com.brclio.toolbox

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class UpdateRelaunchPolicyTest {
    private val now = 1_800_000_000_000L

    @Test fun returnsOnlyForTheVersionTheUserChoseToInstall() {
        assertTrue(UpdateRelaunchPolicy.accepts(4, 4, now - 10_000, now))
        assertFalse(UpdateRelaunchPolicy.accepts(4, 3, now - 10_000, now))
        assertFalse(UpdateRelaunchPolicy.accepts(4, 5, now - 10_000, now))
        assertFalse(UpdateRelaunchPolicy.accepts(0, 0, now - 10_000, now))
    }

    @Test fun absentExpiredOrFutureConsentNeverOpensTheApp() {
        assertFalse(UpdateRelaunchPolicy.accepts(4, 4, 0, now))
        assertFalse(UpdateRelaunchPolicy.accepts(4, 4, now - 31 * 60_000, now))
        assertFalse(UpdateRelaunchPolicy.accepts(4, 4, now + 1, now))
    }

    @Test fun theInstallationMayTakeThirtyMinutes() {
        assertTrue(UpdateRelaunchPolicy.accepts(4, 4, now - 30 * 60_000, now))
        assertFalse(UpdateRelaunchPolicy.accepts(4, 4, now - 30 * 60_000 - 1, now))
    }
}
