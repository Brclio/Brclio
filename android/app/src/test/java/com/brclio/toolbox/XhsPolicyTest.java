package com.brclio.toolbox;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.net.URI;
import java.nio.charset.StandardCharsets;

public class XhsPolicyTest {
    @Test public void onlyIndividualVideoSavesBypassMediaAndArchiveCaps() {
        assertTrue(XhsPolicy.unlimitedVideoSave(false, 1, "video"));
        assertFalse(XhsPolicy.unlimitedVideoSave(true, 1, "video"));
        assertFalse(XhsPolicy.unlimitedVideoSave(false, 2, "video"));
        assertFalse(XhsPolicy.unlimitedVideoSave(false, 1, "image"));
        assertFalse(XhsPolicy.unlimitedVideoSave(false, 1, "text"));
        assertFalse(XhsPolicy.unlimitedVideoSave(false, 0, "video"));
    }

    @Test public void individualVideoByteAccountingCrosses512MiB1GiBAnd2GiBWithoutAllocatingMedia() {
        long count = 0, target = 8L * 1024 * 1024 * 1024 + 17;
        while (count < target) {
            count = XhsPolicy.addBytes(count, Math.min(64 * 1024, target - count));
            XhsPolicy.validateMediaBytes("video", true, 0, count);
        }
        assertEquals(target, count);
        XhsPolicy.validateMediaBytes("video", true, 0, XhsPolicy.contentLength(Long.toString(target)));
    }

    @Test public void imageArchiveAndPreviewLimitsRemainBounded() {
        long fileLimit = XhsPolicy.MAX_MEDIA_BYTES;
        XhsPolicy.validateMediaBytes("image", false, fileLimit, fileLimit);
        XhsPolicy.validateMediaBytes("video", false, 0, fileLimit);
        assertThrows(IllegalArgumentException.class, () -> XhsPolicy.validateMediaBytes("video", false, 0, fileLimit + 1));
        assertThrows(IllegalArgumentException.class, () -> XhsPolicy.validateMediaBytes("image", false, 0, fileLimit + 1));
        assertThrows(IllegalArgumentException.class, () -> XhsPolicy.validateMediaBytes("image", true, 0, fileLimit + 1));
        assertThrows(IllegalArgumentException.class, () -> XhsPolicy.validateMediaBytes("image", false, XhsPolicy.MAX_TOTAL_BYTES, 1));
    }

    @Test public void malformedNegativeZeroAndOverflowingDeclaredLengthsAreRejected() {
        assertEquals(-1, XhsPolicy.contentLength(null));
        assertEquals(2L * 1024 * 1024 * 1024 + 1, XhsPolicy.contentLength("2147483649"));
        for (String header : new String[] {"", "0", "-1", "1.5", "1e9", "NaN", " 5", "+5", "9223372036854775808"}) {
            assertThrows(header, IllegalArgumentException.class, () -> XhsPolicy.contentLength(header));
        }
    }

    @Test public void accountingNeverWrapsLongCountersEvenForUnlimitedVideos() {
        assertEquals(Long.MAX_VALUE, XhsPolicy.addBytes(Long.MAX_VALUE - 1, 1));
        assertThrows(IllegalArgumentException.class, () -> XhsPolicy.addBytes(Long.MAX_VALUE, 1));
        assertThrows(IllegalArgumentException.class, () -> XhsPolicy.addBytes(-1, 1));
        assertThrows(IllegalArgumentException.class, () -> XhsPolicy.addBytes(0, -1));
        assertThrows(IllegalArgumentException.class, () -> XhsPolicy.validateMediaBytes("video", true, Long.MAX_VALUE, 1));
        assertThrows(IllegalArgumentException.class, () -> XhsPolicy.validateMediaBytes("metadata", true, 0, 1));
    }

    @Test public void longHealthyVideoSavesHaveNoTotalTransferOrJobDeadline() {
        long twoHours = 2 * 60 * 60 * 1000L;
        assertFalse(XhsPolicy.downloadTimedOut(twoHours, true));
        assertFalse(XhsPolicy.jobTimedOut(twoHours, true));
        assertTrue(XhsPolicy.downloadTimedOut(twoHours, false));
        assertTrue(XhsPolicy.jobTimedOut(twoHours, false));
        assertFalse(XhsPolicy.downloadTimedOut(XhsPolicy.DOWNLOAD_TIMEOUT_MS, false));
        assertTrue(XhsPolicy.downloadTimedOut(XhsPolicy.DOWNLOAD_TIMEOUT_MS + 1, false));
    }

    @Test public void diskSpaceCheckReservesHeadroomWithoutOverflowingLargeDeclaredSizes() {
        long reserve = XhsPolicy.SPACE_RESERVE_BYTES;
        assertTrue(XhsPolicy.hasDownloadSpace(2147483649L, 2147483649L + reserve));
        assertFalse(XhsPolicy.hasDownloadSpace(2147483649L, 2147483649L + reserve - 1));
        assertFalse(XhsPolicy.hasDownloadSpace(Long.MAX_VALUE, Long.MAX_VALUE));
        assertTrue(XhsPolicy.hasDownloadSpace(Long.MAX_VALUE - reserve, Long.MAX_VALUE));
        assertFalse(XhsPolicy.hasDownloadSpace(0, reserve - 1));
    }

    @Test public void officialMediaHostsKeepSignedQueriesAndDefaultHttpsPorts() {
        String signed = "https://sns-webpic-qc.xhscdn.com/image.jpg?sign=a%2Bb%3D&expires=123";
        assertEquals(signed, XhsPolicy.mediaUri(signed).toString());
        for (String url : new String[] {
                "https://xhscdn.com/image.jpg", "https://a.b.xhscdn.com/image.jpg",
                "https://ci.xiaohongshu.com/image.jpg", "HTTPS://SNS-VIDEO-V28.XHSCDN.COM/video.mp4",
                "https://sns-video-v28.xhscdn.com:443/video.mp4"
        }) assertNotNull(XhsPolicy.mediaUri(url));
    }

    @Test public void mediaHostsCannotBeSpoofedWithSuffixesUserInfoOrIpAddresses() {
        for (String url : new String[] {
                "https://evilxhscdn.com/image.jpg", "https://xhscdn.com.attacker.test/image.jpg",
                "https://ci.xiaohongshu.com.attacker.test/image.jpg", "https://www.xiaohongshu.com/image.jpg",
                "https://localhost/image.jpg", "https://127.0.0.1/image.jpg", "https://[::1]/image.jpg",
                "https://user:password@sns-webpic-qc.xhscdn.com/image.jpg",
                "https://xhscdn.com@attacker.test/image.jpg", "https://attacker.test@xhscdn.com/image.jpg",
                "https://sns-webpic-qc.xhscdn.com./image.jpg",
                "https://sns-webpic-qc.xhscdn.com%2eattacker.test/image.jpg",
                "https://sns-webpic-qc.xhscdn.com\\@attacker.test/image.jpg"
        }) assertThrows(url, IllegalArgumentException.class, () -> XhsPolicy.mediaUri(url));
    }

    @Test public void nativeNetworkBoundaryRequiresHttpsAndRejectsPortsFragmentsAndMalformedInput() {
        for (String url : new String[] {
                null, "", "not a URL", "//xhscdn.com/image.jpg", "http://xhscdn.com/image.jpg",
                "file:///private/image.jpg", "content://com.brclio.xhs/private", "javascript:alert(1)",
                "https://xhscdn.com:80/image.jpg", "https://xhscdn.com:8443/image.jpg",
                "https://xhscdn.com/image.jpg#fragment", "https://xhscdn.com/image.jpg\r\nX-Injected: yes",
                "https://xhscdn.com/" + "a".repeat(8192)
        }) assertThrows(String.valueOf(url), IllegalArgumentException.class, () -> XhsPolicy.mediaUri(url));
    }

    @Test public void relativeRedirectsRemainSubjectToTheSameMediaPolicy() {
        URI base = XhsPolicy.mediaUri("https://sns-video-v28.xhscdn.com/stream/old.mp4?sign=old");
        URI next = base.resolve("../new.mp4?sign=a%2Bb%3D");
        assertEquals("https://sns-video-v28.xhscdn.com/new.mp4?sign=a%2Bb%3D", XhsPolicy.mediaUri(next.toString()).toString());
        for (String target : new String[] { "//attacker.test/media", "http://xhscdn.com/media", "https://xhscdn.com:8443/media" }) {
            assertThrows(IllegalArgumentException.class, () -> XhsPolicy.mediaUri(base.resolve(target).toString()));
        }
    }

    @Test public void originalsAndPlaybackShareOnlyTheOfficialVideoBoundary() {
        for (String value : new String[] {"https://sns-video-v28.xhscdn.com/stream/play.mp4", "https://sns-video-v28.xhscdn.com/spectrum/original", "https://sns-video-v28.xhscdn.com/original.mp4"}) {
            assertNotNull(XhsPolicy.playbackVideoUri(value));
        }
        assertThrows(IllegalArgumentException.class, () -> XhsPolicy.playbackVideoUri("https://ci.xiaohongshu.com/original.mp4"));
        assertThrows(IllegalArgumentException.class, () -> XhsPolicy.playbackVideoUri("https://evil.test/original.mp4"));
    }

    @Test public void noteRedirectsRemainInsideXhsWithoutCookiesOrAccountServices() {
        for (String value : new String[] {"https://xhslink.com/a/signed", "https://xhslink.cn/a/test", "https://www.xiaohongshu.com/explore/0123456789abcdef01234567?xsec_token=a%2Bb"}) assertNotNull(XhsPolicy.noteUri(value));
        for (String value : new String[] {"https://xiaohongshu.com.evil.test/a", "https://tools.brclio.com/api/account/session", "http://xhslink.com/a", "https://xhslink.com:8443/a", "https://user@xhslink.com/a"}) assertThrows(IllegalArgumentException.class, () -> XhsPolicy.noteUri(value));
    }

    @Test public void filenamesCannotEscapeDirectoriesOrHideAnExtension() {
        String clean = XhsPolicy.filename(" ../夏天\\回忆:照片\u0000\n\u007f\u202egpj.mp4 ", "default.jpg");
        assertFalse(clean.matches(".*[\\\\/:*?\"<>|\\p{Cntrl}].*"));
        assertFalse(clean.contains("\u202e"));
        assertFalse(clean.startsWith("."));
        assertFalse(clean.endsWith(" "));
        assertEquals("default.jpg", XhsPolicy.filename(" ... ", "default.jpg"));
        assertEquals("default.jpg", XhsPolicy.filename(null, "default.jpg"));
        assertEquals("旅行照片.jpg", XhsPolicy.filename("旅行照片.jpg", "default.jpg"));
        String longName = XhsPolicy.filename("夏".repeat(180) + ".mp4", "video.mp4");
        assertEquals(140, longName.length());
        assertTrue(longName.endsWith(".mp4"));
    }

    @Test public void duplicateEntryNamesCanBeDisambiguatedWithoutLosingExtensions() {
        assertEquals("照片 (2).jpg", XhsPolicy.numberedFilename("照片.jpg", 2));
        assertEquals("note.backup (3).txt", XhsPolicy.numberedFilename("note.backup.txt", 3));
        assertEquals("README (4)", XhsPolicy.numberedFilename("README", 4));
    }

    @Test public void sniffingDistinguishesImageVideoAndHtmlRegardlessOfTheClaimedExtension() {
        assertEquals("image/jpeg", sniff(new byte[] {(byte) 0xff, (byte) 0xd8, (byte) 0xff}));
        assertEquals("image/png", sniff(new byte[] {(byte) 0x89, 'P', 'N', 'G', 13, 10, 26, 10}));
        assertEquals("image/gif", sniff("GIF89a"));
        assertEquals("image/gif", sniff("GIF87a"));
        assertEquals("image/webp", sniff("RIFF0000WEBP"));
        assertEquals("image/avif", sniff("0000ftypavif"));
        assertEquals("image/avif", sniff("0000ftypavis"));
        assertEquals("image/heif", sniff("0000ftypheic"));
        assertEquals("video/mp4", sniff("0000ftypisom"));
        assertEquals("video/webm", sniff(new byte[] {0x1a, 0x45, (byte) 0xdf, (byte) 0xa3}));
        assertNull(sniff("<!DOCTYPE html><html>verification required</html>"));
        assertNull(sniff("{\"success\":false}"));
        assertNull(sniff(new byte[] {(byte) 0xff, (byte) 0xd8}));
        assertNull(sniff(new byte[0]));
    }

    @Test public void mimeValidationRejectsHtmlAndWrongKindEvenWhenHttpSaysSuccess() {
        XhsPolicy.validateMime("image/jpeg; charset=binary", "image/jpeg", "image");
        XhsPolicy.validateMime("application/octet-stream", "image/png", "image");
        XhsPolicy.validateMime(null, "video/mp4", "video");
        assertThrows(IllegalArgumentException.class, () -> XhsPolicy.validateMime("image/jpeg", null, "image"));
        assertThrows(IllegalArgumentException.class, () -> XhsPolicy.validateMime("text/html", "image/jpeg", "image"));
        assertThrows(IllegalArgumentException.class, () -> XhsPolicy.validateMime("image/png", "video/mp4", "image"));
        assertThrows(IllegalArgumentException.class, () -> XhsPolicy.validateMime("video/mp4", "image/avif", "video"));
        assertThrows(IllegalArgumentException.class, () -> XhsPolicy.validateMime("application/json", "video/mp4", "video"));
        assertThrows(IllegalArgumentException.class, () -> XhsPolicy.validateMime("image/jpeg", "image/jpeg", "text"));
    }

    @Test public void cacheFilesUseTheDetectedMediaFormatForClipboardAndShareUris() {
        assertEquals(".jpg", XhsPolicy.extension("image/jpeg"));
        assertEquals(".png", XhsPolicy.extension("image/png"));
        assertEquals(".webp", XhsPolicy.extension("image/webp"));
        assertEquals(".gif", XhsPolicy.extension("image/gif"));
        assertEquals(".avif", XhsPolicy.extension("image/avif"));
        assertEquals(".heif", XhsPolicy.extension("image/heif"));
        assertEquals(".webm", XhsPolicy.extension("video/webm"));
        assertEquals(".mp4", XhsPolicy.extension("video/mp4"));
    }

    @Test public void archiveMediaNamesUseActualBytesInsteadOfMislabelingPngOrWebpAsJpeg() {
        assertEquals("01.png", XhsPolicy.mediaFilename("01.jpg", "image/png"));
        assertEquals("实况原图.webp", XhsPolicy.mediaFilename("实况原图.jpg", "image/webp"));
        assertEquals("01-live.mp4", XhsPolicy.mediaFilename("01-live.mp4", "video/mp4"));
        assertEquals("video.webm", XhsPolicy.mediaFilename("video.mp4", "video/webm"));
        assertEquals("原图.jpg", XhsPolicy.mediaFilename("原图", "image/jpeg"));
    }

    private static String sniff(String value) { return sniff(value.getBytes(StandardCharsets.US_ASCII)); }
    private static String sniff(byte[] value) { return XhsPolicy.sniffMime(value, value.length); }
}
