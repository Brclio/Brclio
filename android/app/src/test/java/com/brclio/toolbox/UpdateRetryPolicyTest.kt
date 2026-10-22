package com.brclio.toolbox

import org.junit.Assert.*
import org.junit.Test
import java.io.IOException
import java.io.InterruptedIOException
import java.net.SocketTimeoutException
import java.security.cert.CertificateException
import javax.net.ssl.SSLHandshakeException

class UpdateRetryPolicyTest {
    private class Clock {
        var now = 0L
        val sleeps = mutableListOf<Long>()
        val runner = UpdateRetryController({ now }, { sleeps.add(it); now += it })
    }
    @Test fun firstAttemptSuccessDoesNotRetryAndCleansUp() {
        val clock = Clock(); val states = mutableListOf<UpdateRetryState>(); var attempts = 0; var cleanups = 0
        assertEquals("ok", clock.runner.run("check", 100_000, { false }, states::add, { cleanups++ }) { attempts++; "ok" })
        assertEquals(1, attempts); assertEquals(1, cleanups); assertTrue(clock.sleeps.isEmpty())
        assertTrue(states.all { it.retryCount == 0 && !it.retrying && !it.retryExhausted })
    }
    @Test fun tenRetriesMeanExactlyElevenAttemptsWithBoundedBackoffAndCleanupBeforeWaiting() {
        val clock = Clock(); val states = mutableListOf<UpdateRetryState>(); var attempts = 0; var cleanups = 0
        val failure = runCatching { clock.runner.run<Unit>("download", 600_000, { false }, {
            states.add(it)
            if (it.retrying) assertEquals(attempts, cleanups)
        }, { cleanups++ }) { attempts++; throw UpdateNetworkFailure("fixture network") } }.exceptionOrNull()
        assertTrue(failure is UpdateRetryExhausted)
        assertEquals(11, attempts); assertEquals(11, cleanups)
        assertEquals((1..10).toList(), states.filter { it.retrying }.map { it.retryCount })
        assertEquals(42_000L, clock.now)
        assertEquals(10, states.last().retryCount); assertTrue(states.last().retryExhausted)
        assertTrue(states.last().message!!.contains("点击重试"))
        assertTrue(clock.sleeps.all { it in 1..100 })
    }
    @Test fun successfulRetryStopsAndAnotherManualRunResetsCount() {
        val clock = Clock(); var attempts = 0; var cleanups = 0; val states = mutableListOf<UpdateRetryState>()
        assertEquals("ok", clock.runner.run("check", 100_000, { false }, states::add, { cleanups++ }) {
            attempts++; if (attempts < 4) throw UpdateNetworkFailure("fixture"); "ok"
        })
        assertEquals(4, attempts); assertEquals(4, cleanups); assertEquals(7_000L, clock.now)
        assertEquals(3, states.last().retryCount); assertFalse(states.last().retryExhausted)
        states.clear()
        clock.runner.run("check", 100_000, { false }, states::add, {}) { "ok" }
        assertTrue(states.all { it.retryCount == 0 })
    }
    @Test fun cancellationDuringBackoffStopsBeforeAnotherAttempt() {
        var now = 0L; var cancelled = false; var attempts = 0; var cleanups = 0
        val runner = UpdateRetryController({ now }, { now += it; cancelled = true })
        assertTrue(runCatching { runner.run<Unit>("check", 100_000, { cancelled }, {}, { cleanups++ }) {
            attempts++; throw UpdateNetworkFailure("fixture")
        } }.exceptionOrNull() is UpdateStopped)
        assertEquals(1, attempts); assertEquals(1, cleanups)
    }
    @Test fun deadlineCanEndDownloadBeforeTheRetryLimitWithoutStartingAnotherAttempt() {
        val clock = Clock(); var attempts = 0; var cleanups = 0; val states = mutableListOf<UpdateRetryState>()
        val failure = runCatching { clock.runner.run<Unit>("download", 50, { false }, states::add, { cleanups++ }) {
            attempts++; throw UpdateNetworkFailure("fixture")
        } }.exceptionOrNull()
        assertTrue(failure is UpdateRetryExhausted); assertEquals(50L, clock.now)
        assertEquals(1, attempts); assertEquals(1, cleanups); assertFalse(states.last().retryExhausted)
    }
    @Test fun securityCancellationValidationAndLocalIoNeverReplay() {
        for (failure in listOf(
            SSLHandshakeException("fixture"), CertificateException("fixture"), SecurityException("fixture"),
            UpdateNetworkFailure("fixture", SSLHandshakeException("fixture")),
            UpdateNetworkFailure("fixture", InterruptedIOException("fixture")), UpdateStopped(),
            IOException("fixture local disk"), IllegalStateException("checksum/signature/http denial"),
        )) {
            val clock = Clock(); var attempts = 0; var cleanups = 0
            assertNotNull(runCatching { clock.runner.run<Unit>("download", 100_000, { false }, {}, { cleanups++ }) {
                attempts++; throw failure
            } }.exceptionOrNull())
            assertEquals(1, attempts); assertEquals(1, cleanups); assertTrue(clock.sleeps.isEmpty())
        }
        assertTrue(UpdateRetryPolicy.canRetry(UpdateNetworkFailure("fixture", SocketTimeoutException("fixture"))))
    }
    @Test fun tlsTransportWrappersRetryButCertificateAndHostnameFailuresDoNot() {
        val reset=javax.net.ssl.SSLException("fixture TLS transport",java.net.SocketException("fixture reset"))
        assertTrue(UpdateRetryPolicy.canRetry(UpdateNetworkFailure("fixture",reset)))
        val certificate=SSLHandshakeException("fixture certificate").apply { initCause(CertificateException("fixture chain")) }
        assertFalse(UpdateRetryPolicy.canRetry(UpdateNetworkFailure("fixture",certificate)))
        assertFalse(UpdateRetryPolicy.canRetry(UpdateNetworkFailure("fixture",javax.net.ssl.SSLPeerUnverifiedException("fixture hostname"))))
        assertFalse(UpdateRetryPolicy.canRetry(UpdateNetworkFailure("fixture",javax.net.ssl.SSLProtocolException("fixture TLS protocol"))))
    }
    @Test fun cleanupFailureIsLocalAndStopsTheLoop() {
        val clock = Clock(); var attempts = 0
        val failure = runCatching { clock.runner.run<Unit>("download", 100_000, { false }, {}, { throw IOException("fixture disk") }) {
            attempts++; throw UpdateNetworkFailure("fixture network")
        } }.exceptionOrNull()
        assertTrue(failure is IOException); assertFalse(failure is UpdateNetworkFailure)
        assertEquals(1, attempts); assertTrue(clock.sleeps.isEmpty())
    }
}
