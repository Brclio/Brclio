package com.brclio.toolbox

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.InputStream
import java.security.DigestOutputStream
import java.security.MessageDigest
import javax.net.ssl.SSLException

class UpdateRangeDownloaderTest {
    private val etag = "\"stable-release-etag\""
    private val chunk = UpdateRangeDownloader.SEGMENT_BYTES

    private class FixtureResponse(
        override val status: Int,
        val headers: MutableMap<String, String>,
        override val body: InputStream,
    ) : UpdateRangeDownloader.Response {
        var closed = false
        override fun header(name: String) = headers[name]
        override fun close() { closed = true; body.close() }
    }

    private fun response(part: UpdateRangeDownloader.Segment, total: Long, bytes: ByteArray = ByteArray(part.length.toInt())) =
        FixtureResponse(206, mutableMapOf("Content-Range" to "bytes ${part.start}-${part.end}/$total",
            "Content-Length" to part.length.toString(), "ETag" to etag), ByteArrayInputStream(bytes))

    private fun rejects(modify: (FixtureResponse) -> Unit, total: Long = 23): FixtureResponse {
        val fixture = response(UpdateRangeDownloader.segment(0, total), total)
        modify(fixture)
        val output = ByteArrayOutputStream()
        assertTrue(runCatching {
            UpdateRangeDownloader.copy(total, output, { _, _ -> fixture }, {}, {})
        }.isFailure)
        assertTrue("rejected response must be disconnected", fixture.closed)
        assertEquals("untrusted headers must be rejected before writing", 0, output.size())
        return fixture
    }

    @Test fun boundedRangesCoverExactBoundariesAndFinalPartialSegment() {
        assertEquals("bytes=0-${chunk - 1}", UpdateRangeDownloader.segment(0, chunk).header)
        assertEquals("bytes=$chunk-$chunk", UpdateRangeDownloader.segment(chunk, chunk + 1).header)
        assertEquals("bytes=0-0", UpdateRangeDownloader.segment(0, 1).header)
        for ((start, total) in listOf(0L to 0L, -1L to 3L, 3L to 3L, 0L to (512L * 1024 * 1024 + 1), Long.MAX_VALUE to Long.MAX_VALUE)) {
            assertTrue(runCatching { UpdateRangeDownloader.segment(start, total) }.isFailure)
        }
    }

    @Test fun copiesSerialSegmentsWithIfRangeAndPreservesWholeFileDigest() {
        val original = ByteArray((2 * chunk + 31).toInt()) { (it % 251).toByte() }
        val total = original.size.toLong()
        val output = ByteArrayOutputStream()
        val digest = MessageDigest.getInstance("SHA-256")
        val opened = mutableListOf<FixtureResponse>()
        val requests = mutableListOf<Pair<String, String?>>()
        val progress = mutableListOf<Long>()
        val received = UpdateRangeDownloader.copy(total, DigestOutputStream(output, digest), { part, ifRange ->
            assertTrue("preceding invocation must be closed", opened.all { it.closed })
            requests += part.header to ifRange
            response(part, total, original.copyOfRange(part.start.toInt(), part.end.toInt() + 1)).also(opened::add)
        }, {}, progress::add)
        assertEquals(total, received)
        assertEquals(listOf("bytes=0-${chunk - 1}" to null, "bytes=$chunk-${2 * chunk - 1}" to etag,
            "bytes=${2 * chunk}-${total - 1}" to etag), requests)
        assertArrayEquals(original, output.toByteArray())
        assertArrayEquals(MessageDigest.getInstance("SHA-256").digest(original), digest.digest())
        assertTrue(opened.all { it.closed })
        assertEquals(total, progress.last())
        assertTrue(progress.zipWithNext().all { (previous, next) -> previous < next })
    }

    @Test fun rejectsFullBodyFallbackBeforeReading() {
        val fixture = FixtureResponse(200, mutableMapOf(), ByteArrayInputStream(byteArrayOf(1)))
        assertTrue(runCatching { UpdateRangeDownloader.copy(1, ByteArrayOutputStream(), { _, _ -> fixture }, {}, {}) }.isFailure)
        assertTrue(fixture.closed)
    }

    @Test fun rejectsWrongOffsetsEndTotalAndMalformedContentRange() {
        for (value in listOf("bytes 1-22/23", "bytes 0-21/23", "bytes 0-22/24", "bytes 0-22/*", "bytes 00-22/23",
            "bytes 0-22/9223372036854775808", "bytes 0-22/23, bytes 0-22/23", "bytes 0-22/23\r\n")) {
            rejects({ it.headers["Content-Range"] = value })
        }
        rejects({ it.headers.remove("Content-Range") })
    }

    @Test fun rejectsMissingOrWrongLengthAndEncodedBodies() {
        rejects({ it.headers.remove("Content-Length") })
        for (value in listOf("22", "24", "-23", "+23", "023", "9223372036854775808", "23, 23")) {
            rejects({ it.headers["Content-Length"] = value })
        }
        rejects({ it.headers["Content-Encoding"] = "gzip" })
    }

    @Test fun rejectsWeakUnquotedMissingOrInvalidStrongEtags() {
        for (value in listOf("W/$etag", "stable-release-etag", "\"\"", "\"bad\"etag\"", "\"bad\r\netag\"", "\"\u0080\"",
            "\"first\", \"second\"", "\"${"x".repeat(257)}\"")) {
            rejects({ it.headers["ETag"] = value })
        }
        rejects({ it.headers.remove("ETag") })
    }

    @Test fun acceptsVisibleAsciiStrongEtagAtTheSharedProtocolBoundary() {
        val fixture = response(UpdateRangeDownloader.segment(0, 23), 23)
        fixture.headers["ETag"] = "\"${"x".repeat(256)}\""
        fixture.headers["Content-Encoding"] = "identity"
        val output = ByteArrayOutputStream()
        assertEquals(23L, UpdateRangeDownloader.copy(23, output, { _, _ -> fixture }, {}, {}))
        assertEquals(23, output.size())
        assertTrue(fixture.closed)
    }

    @Test fun changedEtagOrTotalInLaterSegmentFailsBeforeItsBytesAreWritten() {
        for (changeEtag in listOf(true, false)) {
            val total = chunk + 5
            val responses = mutableListOf<FixtureResponse>()
            val output = ByteArrayOutputStream()
            assertTrue(runCatching {
                UpdateRangeDownloader.copy(total, output, { part, ifRange ->
                    response(part, total).also {
                        if (part.start > 0) {
                            assertEquals(etag, ifRange)
                            if (changeEtag) it.headers["ETag"] = "\"changed\""
                            else it.headers["Content-Range"] = "bytes ${part.start}-${part.end}/${total + 1}"
                        }
                        responses += it
                    }
                }, {}, {})
            }.isFailure)
            assertEquals(chunk.toInt(), output.size())
            assertEquals(2, responses.size)
            assertTrue(responses.all { it.closed })
        }
    }

    @Test fun detectsTruncatedAndOversizedSegmentsAndStopsBeforeNextInvocation() {
        for (bodySize in listOf(22, 24)) {
            val fixture = response(UpdateRangeDownloader.segment(0, 23), 23, ByteArray(bodySize))
            var calls = 0
            val output = ByteArrayOutputStream()
            assertTrue(runCatching {
                UpdateRangeDownloader.copy(23, output, { _, _ -> calls++; fixture }, {}, {})
            }.isFailure)
            assertEquals(1, calls)
            assertEquals("incomplete segments must never reach the whole-file digest/output", 0, output.size())
            assertTrue(fixture.closed)
        }
    }

    @Test fun cancellationBeforeRequestDoesNotOpenConnection() {
        var opened = false
        assertTrue(runCatching {
            UpdateRangeDownloader.copy(23, ByteArrayOutputStream(), { _, _ -> opened = true; error("unexpected") },
                { throw IOException("cancelled") }, {})
        }.isFailure)
        assertFalse(opened)
    }

    @Test fun cancellationDuringSegmentClosesResponseAndStopsLaterRequests() {
        val total = 2 * chunk
        var reads = 0
        val body = object : ByteArrayInputStream(ByteArray(chunk.toInt())) {
            override fun read(bytes: ByteArray, offset: Int, length: Int): Int {
                reads++
                return super.read(bytes, offset, length)
            }
        }
        val headers = response(UpdateRangeDownloader.segment(0, total), total).headers
        val fixture = FixtureResponse(206, headers, body)
        val output = ByteArrayOutputStream()
        var calls = 0
        assertTrue(runCatching {
            UpdateRangeDownloader.copy(total, output, { _, _ -> calls++; fixture },
                { if (reads > 0) throw IOException("cancelled") }, {})
        }.isFailure)
        assertEquals(0, output.size())
        assertEquals(1, calls)
        assertTrue(fixture.closed)
    }

    @Test fun cancellationBetweenSegmentsDoesNotRequestAnotherSegment() {
        val total = 2 * chunk
        val fixture = response(UpdateRangeDownloader.segment(0, total), total)
        var received = 0L
        var calls = 0
        assertTrue(runCatching {
            UpdateRangeDownloader.copy(total, ByteArrayOutputStream(), { _, _ -> calls++; fixture },
                { if (received > 0) throw IOException("cancelled") }, { received = it })
        }.isFailure)
        assertEquals(chunk, received)
        assertEquals(1, calls)
        assertTrue(fixture.closed)
    }

    @Test fun bodyReadFailureAndOutputFailureCloseResponse() {
        for (failWrite in listOf(false, true)) {
            val fixture = response(UpdateRangeDownloader.segment(0, 23), 23)
            val brokenBody = object : InputStream() { override fun read(): Int = throw IOException("read failed") }
            val actual = if (failWrite) fixture else FixtureResponse(206, fixture.headers, brokenBody)
            val output = object : ByteArrayOutputStream() {
                override fun write(bytes: ByteArray, offset: Int, length: Int) {
                    if (failWrite) throw IOException("write failed")
                    super.write(bytes, offset, length)
                }
                override fun write(bytes: ByteArray) = write(bytes, 0, bytes.size)
            }
            assertTrue(runCatching { UpdateRangeDownloader.copy(23, output, { _, _ -> actual }, {}, {}) }.isFailure)
            assertTrue(actual.closed)
        }
    }

    @Test fun recoversFromOne503WithoutConsumingItsBody() {
        val part = UpdateRangeDownloader.segment(0, 23)
        val unavailable = FixtureResponse(503, mutableMapOf(), object : InputStream() {
            override fun read(): Int = error("503 body must never be consumed")
        })
        val valid = response(part, 23)
        var calls = 0
        var pauses = 0
        val output = ByteArrayOutputStream()
        assertEquals(23L, UpdateRangeDownloader.copy(23, output, { segment, ifRange ->
            assertEquals(part, segment)
            assertEquals(null, ifRange)
            calls++
            if (calls == 1) unavailable else { assertTrue(unavailable.closed); valid }
        }, {}, {}, { active -> pauses++; assertTrue(unavailable.closed); active() }))
        assertEquals(2, calls)
        assertEquals(1, pauses)
        assertEquals(23, output.size())
        assertTrue(valid.closed)
    }

    @Test fun recoveryKeepsTheSameLaterSegmentAndIfRangeWithoutDuplicatingBytes() {
        val original = ByteArray((chunk + 23).toInt()) { (it % 251).toByte() }
        val requests = mutableListOf<Pair<String, String?>>()
        val opened = mutableListOf<FixtureResponse>()
        val output = ByteArrayOutputStream()
        val digest = MessageDigest.getInstance("SHA-256")
        UpdateRangeDownloader.copy(original.size.toLong(), DigestOutputStream(output, digest), { part, ifRange ->
            assertTrue(opened.all { it.closed })
            requests += part.header to ifRange
            (if (requests.size == 2) FixtureResponse(503, mutableMapOf(), ByteArrayInputStream(byteArrayOf()))
            else response(part, original.size.toLong(), original.copyOfRange(part.start.toInt(), part.end.toInt() + 1)))
                .also(opened::add)
        }, {}, {}, { active -> active() })
        assertEquals(3, requests.size)
        assertEquals(requests[1], requests[2])
        assertEquals(etag, requests[2].second)
        assertArrayEquals(original, output.toByteArray())
        assertArrayEquals(MessageDigest.getInstance("SHA-256").digest(original), digest.digest())
    }

    @Test fun repeated503StopsAfterTwoAttemptsAndClosesBoth() {
        val opened = mutableListOf<FixtureResponse>()
        var pauses = 0
        val output = ByteArrayOutputStream()
        assertTrue(runCatching {
            UpdateRangeDownloader.copy(23, output, { _, _ ->
                FixtureResponse(503, mutableMapOf(), ByteArrayInputStream(byteArrayOf())).also(opened::add)
            }, {}, {}, { active -> pauses++; active() })
        }.isFailure)
        assertEquals(2, opened.size)
        assertEquals(1, pauses)
        assertTrue(opened.all { it.closed })
        assertEquals(0, output.size())
    }

    @Test fun doesNotRecoverOtherStatusesOrInvalid206Headers() {
        for (status in listOf(200, 429, 500, 502, 504, 206)) {
            val fixture = FixtureResponse(status, mutableMapOf(), ByteArrayInputStream(byteArrayOf()))
            var calls = 0
            var pauses = 0
            assertTrue(runCatching {
                UpdateRangeDownloader.copy(23, ByteArrayOutputStream(), { _, _ -> calls++; fixture }, {}, {}, { pauses++ })
            }.isFailure)
            assertEquals(1, calls)
            assertEquals(0, pauses)
            assertTrue(fixture.closed)
        }
    }

    @Test fun doesNotRecoverTransportOrTlsFailures() {
        for (failure in listOf(IOException("network failure"), SSLException("TLS failure"))) {
            var calls = 0
            var pauses = 0
            assertTrue(runCatching {
                UpdateRangeDownloader.copy(23, ByteArrayOutputStream(), { _, _ -> calls++; throw failure }, {}, {}, { pauses++ })
            }.exceptionOrNull() === failure)
            assertEquals(1, calls)
            assertEquals(0, pauses)
        }
    }

    @Test fun cancellationDuring503PauseDoesNotOpenRecoveryRequest() {
        val fixture = FixtureResponse(503, mutableMapOf(), ByteArrayInputStream(byteArrayOf()))
        var cancelled = false
        var calls = 0
        val output = ByteArrayOutputStream()
        assertTrue(runCatching {
            UpdateRangeDownloader.copy(23, output, { _, _ -> calls++; fixture },
                { if (cancelled) throw IOException("cancelled") }, {}, { active ->
                    assertTrue(fixture.closed)
                    cancelled = true
                    active()
                })
        }.isFailure)
        assertEquals(1, calls)
        assertTrue(fixture.closed)
        assertEquals(0, output.size())
    }

    @Test fun default503PauseChecksCancellationAndDoesNotOpenRecoveryRequest() {
        val fixture = FixtureResponse(503, mutableMapOf(), ByteArrayInputStream(byteArrayOf()))
        var calls = 0
        var closedChecks = 0
        assertTrue(runCatching {
            UpdateRangeDownloader.copy(23, ByteArrayOutputStream(), { _, _ -> calls++; fixture }, {
                if (fixture.closed && ++closedChecks >= 3) throw IOException("cancelled during wait")
            }, {})
        }.isFailure)
        assertEquals(1, calls)
        assertTrue(fixture.closed)
        assertEquals(3, closedChecks)
    }

    @Test fun laterSegmentKeepsSafeChallengeAndServiceMessagesWithoutRetry() {
        val messages = listOf(
            UpdateProxyPolicy.responseError(200, UpdateProxyRoute.BUILTIN, "challenge"),
            UpdateProxyPolicy.responseError(403, UpdateProxyRoute.BUILTIN),
            UpdateProxyPolicy.responseError(429, UpdateProxyRoute.BUILTIN),
        )
        for (message in messages) {
            val total = chunk + 23
            val first = response(UpdateRangeDownloader.segment(0, total), total)
            val output = ByteArrayOutputStream()
            val failure = IllegalStateException(message)
            var calls = 0
            var pauses = 0
            val actual = runCatching {
                UpdateRangeDownloader.copy(total, output, { part, _ ->
                    calls++
                    if (part.start > 0) throw failure
                    first
                }, {}, {}, { pauses++ })
            }.exceptionOrNull()
            assertTrue(actual === failure)
            assertEquals(message, actual?.message)
            assertEquals(2, calls)
            assertEquals(0, pauses)
            assertEquals(chunk.toInt(), output.size())
            assertTrue(first.closed)
        }
    }
}
