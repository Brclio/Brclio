package com.brclio.toolbox

import org.junit.Assert.assertEquals

internal object UpdateProxyThreadAssertions {
    fun awaitIdle() {
        val deadline = System.nanoTime() + 3_000_000_000L
        fun count() = Thread.getAllStackTraces().keys.count { it.isAlive && it.name.startsWith("Brclio-update-") }
        while (count() != 0 && System.nanoTime() < deadline) Thread.sleep(10)
        assertEquals("All operation tunnel, probe and deadline threads must stop", 0, count())
    }
}
