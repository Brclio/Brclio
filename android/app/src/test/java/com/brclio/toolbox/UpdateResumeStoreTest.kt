package com.brclio.toolbox

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.nio.file.Files
import java.nio.file.attribute.PosixFilePermissions
import java.security.MessageDigest

class UpdateResumeStoreTest {
    private val payload = "complete authenticated fixture installer with enough bytes".toByteArray()
    private val name = "Brclio-0.2.0-android.apk"
    private fun binding(bytes: ByteArray = payload) = UpdateResumeBinding("0.2.0", name,
        "https://github.com/Brclio/Brclio/releases/download/v0.2.0/$name", bytes.size.toLong(), sha(bytes))
    private fun sha(bytes: ByteArray) = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
    private fun fresh(session: UpdateResumeStore.Session, etag: String? = "\"fixture-v1\"") = session.accept(UpdateResumeResponse(200,
        contentLength = payload.size.toString(), etag = etag))
    private fun partial(store: UpdateResumeStore, count: Int): UpdateResumeStore.Session = store.prepare(binding()).also {
        fresh(it); it.append(payload.copyOf(count), count)
    }
    private inline fun fixture(action: (java.io.File, UpdateResumeStore) -> Unit) {
        val directory = Files.createTempDirectory("brclio-resume-test-").toFile()
        try { action(directory, UpdateResumeStore(directory, name)) } finally { directory.deleteRecursively() }
    }
    @Test fun freshDownloadUsesPrivateAtomicMetadataAndPromotesOnlyVerifiedFile() = fixture { directory, store ->
        val session = store.prepare(binding()); assertTrue(session.requestHeaders().isEmpty())
        assertEquals(PosixFilePermissions.fromString("rw-------"), Files.getPosixFilePermissions(store.metadata.toPath()))
        fresh(session); session.append(payload, payload.size); session.endResponse()
        assertArrayEquals(payload, session.finish().readBytes())
        assertEquals(listOf(name), directory.listFiles()!!.map { it.name })
    }
    @Test fun automaticRetryAndNewProcessRehashPrefixAndRequestOnlyTheSuffix() = fixture { directory, store ->
        partial(store, 7)
        val restored = UpdateResumeStore(directory, name).prepare(binding())
        assertEquals(7, restored.offset); assertEquals(7, restored.resumedBytes)
        assertEquals(mapOf("Range" to "bytes=7-", "If-Range" to "\"fixture-v1\""), restored.requestHeaders())
        restored.accept(UpdateResumeResponse(206, "bytes 7-${payload.lastIndex}/${payload.size}", (payload.size - 7).toString(), etag = "\"fixture-v1\""))
        val suffix = payload.copyOfRange(7, payload.size); restored.append(suffix, suffix.size)
        restored.endResponse(); assertArrayEquals(payload, restored.finish().readBytes())
    }
    @Test fun actualRunnerPreservesBytesAcrossElevenFailuresThenManualRetryResumes() = fixture { directory, store ->
        var now = 0L; var attempts = 0; var manifestReads = 0
        val runner = UpdateRetryController({ now }, { now += it })
        val failure = runCatching { runner.run<Unit>("download", 600_000, { false }, {}, {}) {
            manifestReads++; val session = UpdateResumeStore(directory, name).prepare(binding()); attempts++
            if (session.offset == 0L) fresh(session) else session.accept(UpdateResumeResponse(206,
                "bytes ${session.offset}-${payload.lastIndex}/${payload.size}", etag = "\"fixture-v1\""))
            val index = session.offset.toInt(); session.append(byteArrayOf(payload[index]), 1)
            throw UpdateNetworkFailure("fixture connection reset")
        } }.exceptionOrNull()
        assertTrue(failure is UpdateRetryExhausted); assertEquals(11, attempts); assertEquals(11, manifestReads)
        assertEquals(11, store.partial.length())
        val session = UpdateResumeStore(directory, name).prepare(binding())
        assertEquals("bytes=11-", session.requestHeaders()["Range"])
        session.accept(UpdateResumeResponse(206, "bytes 11-${payload.lastIndex}/${payload.size}"))
        val suffix = payload.copyOfRange(11, payload.size); session.append(suffix, suffix.size)
        session.endResponse(); assertArrayEquals(payload, session.finish().readBytes())
    }
    @Test fun changedChecksumOrSizeDiscardsTheOldBindingBeforeAnyAppend() = fixture { _, store ->
        partial(store, 8)
        val changed = "new release content with a changed checksum".toByteArray()
        val session = store.prepare(binding(changed))
        assertEquals(0, session.offset); assertTrue(session.requestHeaders().isEmpty()); assertEquals(0, store.partial.length())
        session.accept(UpdateResumeResponse(200, contentLength = changed.size.toString()))
        session.append(changed, changed.size); session.endResponse(); assertArrayEquals(changed, session.finish().readBytes())
    }
    @Test fun rangeIgnored200TruncatesInsteadOfAppendingAndReportsTheRestart() = fixture { _, store ->
        partial(store, 9)
        val session = store.prepare(binding())
        val plan = session.accept(UpdateResumeResponse(200, contentLength = payload.size.toString(), etag = "\"fixture-v2\""))
        assertTrue(plan.restarted); assertEquals(0, session.offset); assertEquals(0, store.partial.length())
        assertEquals("\"fixture-v2\"", JSONObject(store.metadata.readText()).getString("etag"))
        session.append(payload, payload.size); session.endResponse(); assertArrayEquals(payload, session.finish().readBytes())
    }
    @Test fun strict206RejectsMisalignmentChangedIdentityCompressionAndMultipartWithoutKeepingBytes() {
        val invalid = listOf(
            UpdateResumeResponse(206, "bytes 2-${payload.lastIndex}/${payload.size}"),
            UpdateResumeResponse(206, "bytes 3-${payload.lastIndex}/${payload.size + 1}"),
            UpdateResumeResponse(206, "bytes 3-${payload.size}/${payload.size}"),
            UpdateResumeResponse(206, "bytes 3-${payload.lastIndex}/${payload.size}", "1"),
            UpdateResumeResponse(206, "bytes 3-${payload.lastIndex}/${payload.size}", encoding = "gzip"),
            UpdateResumeResponse(206, "bytes 3-${payload.lastIndex}/${payload.size}", contentType = "multipart/byteranges; boundary=fixture"),
            UpdateResumeResponse(206, "bytes 3-${payload.lastIndex}/${payload.size}", etag = "\"changed\""),
            UpdateResumeResponse(206, "bytes 3-${payload.lastIndex}/${payload.size}", etag = "W/\"fixture-v1\""),
            UpdateResumeResponse(206, "bytes 3-${payload.lastIndex}/${payload.size}, bytes 1-2/${payload.size}"),
        )
        for (response in invalid) fixture { _, store ->
            partial(store, 3); val session = store.prepare(binding())
            assertTrue(runCatching { session.accept(response) }.exceptionOrNull() is UpdateResumeRejected)
            assertFalse(store.partial.exists()); assertFalse(store.metadata.exists())
        }
        fixture { _, store -> assertTrue(runCatching { store.prepare(binding()).accept(UpdateResumeResponse(206, "bytes 0-${payload.lastIndex}/${payload.size}")) }.isFailure) }
    }
    @Test fun serverMayReturnAShortRangeAndNextAttemptContinuesAtActualSavedSize() = fixture { _, store ->
        partial(store, 3); val session = store.prepare(binding())
        session.accept(UpdateResumeResponse(206, "bytes 3-7/${payload.size}", "5"))
        session.append(payload.copyOfRange(3, 8), 5)
        assertTrue(runCatching { session.endResponse() }.exceptionOrNull() is UpdateNetworkFailure)
        assertEquals(8, store.prepare(binding()).offset)
    }
    @Test fun truncatedRangePreservesActualPrefixButOversizedSegmentClearsIt() = fixture { _, store ->
        partial(store, 3); val session = store.prepare(binding())
        session.accept(UpdateResumeResponse(206, "bytes 3-7/${payload.size}", "5")); session.append(payload.copyOfRange(3, 5), 2)
        assertTrue(runCatching { session.endResponse() }.exceptionOrNull() is UpdateNetworkFailure)
        assertEquals(5, store.prepare(binding()).offset)
        val second = store.prepare(binding()); second.accept(UpdateResumeResponse(206, "bytes 5-6/${payload.size}", "2"))
        assertTrue(runCatching { second.append(payload.copyOfRange(5, 8), 3) }.isFailure)
        assertFalse(store.partial.exists())
    }
    @Test fun full416IsAcceptedOnlyAfterLocalShaAndIncompleteOrWrongTotalsAreCleared() {
        fixture { _, store ->
            partial(store, payload.size); val session = store.prepare(binding())
            assertTrue(session.accept(UpdateResumeResponse(416, "bytes */${payload.size}")).complete)
            assertArrayEquals(payload, session.finish().readBytes())
        }
        for (count in listOf(5, payload.size)) fixture { _, store ->
            partial(store, count); val session = store.prepare(binding())
            val failure = runCatching { session.accept(UpdateResumeResponse(416, "bytes */${payload.size + 1}")) }.exceptionOrNull()
            assertTrue(failure is UpdateResumeRejected); assertFalse(store.partial.exists())
        }
    }
    @Test fun weakEtagIsNeverSentAndTheCurrentStrongEtagIsBoundAtomically() = fixture { _, store ->
        val session = store.prepare(binding()); fresh(session, "W/\"weak\""); session.append(payload.copyOf(5), 5)
        assertFalse(store.prepare(binding()).requestHeaders().containsKey("If-Range"))
        assertFalse(UpdateResumeStore.strongETag("\"bad\r\nvalue\""))
        assertTrue(UpdateResumeStore.strongETag("\"strong\""))
    }
    @Test fun finalVerificationReadsTheActualFileAgainAndDetectsConcurrentMutation() = fixture { _, store ->
        val session = store.prepare(binding()); fresh(session); session.append(payload, payload.size)
        store.partial.writeBytes(ByteArray(payload.size) { 1 })
        assertTrue(runCatching { session.endResponse() }.exceptionOrNull() is UpdateResumeRejected)
        assertFalse(store.partial.exists()); assertFalse(store.metadata.exists())
    }
    @Test fun symlinkedPartOrMetadataNeverTouchesTheLinkTarget() {
        for (sidecar in listOf(false, true)) fixture { directory, store ->
            val outside = Files.createTempFile("brclio-resume-outside-", ".txt").toFile()
            try {
                outside.writeText("keep this file")
                Files.createSymbolicLink((if (sidecar) store.metadata else store.partial).toPath(), outside.toPath())
                assertTrue(runCatching { store.prepare(binding()) }.isFailure)
                assertEquals("keep this file", outside.readText()); assertFalse(store.partial.exists()); assertFalse(store.metadata.exists())
            } finally { outside.delete() }
        }
    }
    @Test fun deadlineAndCancellationKeepDurablePrefixForTheNextManualOperation() = fixture { _, store ->
        var now = 0L; val states = mutableListOf<UpdateRetryState>()
        val failure = runCatching { UpdateRetryController({ now }, { now += it }).run<Unit>("download", 50, { false }, states::add, {}) {
            partial(store, 4); now = 50; throw UpdateNetworkFailure("fixture timeout")
        } }.exceptionOrNull()!!
        assertTrue(UpdateResumeStore.preserve(failure)); assertFalse(states.last().retryExhausted)
        assertEquals(4, store.prepare(binding()).offset)
        assertTrue(UpdateResumeStore.preserve(UpdateStopped()))
        assertFalse(UpdateResumeStore.preserve(java.io.IOException("fixture disk")))
        assertFalse(UpdateResumeStore.preserve(javax.net.ssl.SSLHandshakeException("fixture certificate")))
    }
}
