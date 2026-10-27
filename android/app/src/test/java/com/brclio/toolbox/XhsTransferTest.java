package com.brclio.toolbox;

import org.junit.Test;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.IOException;
import java.lang.reflect.Method;
import java.net.HttpURLConnection;
import java.net.InetSocketAddress;
import java.net.Proxy;
import java.net.ProxySelector;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.SocketAddress;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.Assert.*;

public class XhsTransferTest {
    @Test public void savingCachedMediaReportsBytesWithoutChangingTheFile() throws Exception {
        byte[] source = new byte[192 * 1024 + 3];
        for (int i = 0; i < source.length; i++) source[i] = (byte) (i % 251);
        File file = File.createTempFile("xhs-copy-progress", ".bin");
        try {
            Files.write(file.toPath(), source);
            ByteArrayOutputStream output = new ByteArrayOutputStream();
            List<Long> received = new ArrayList<>();
            XhsTransfer.copy(file, output, new XhsTransfer.Cancellation(), (bytes, total) -> {
                assertEquals(source.length, total);
                received.add(bytes);
            });
            assertArrayEquals(source, output.toByteArray());
            assertEquals(Long.valueOf(0), received.get(0));
            assertEquals(Long.valueOf(source.length), received.get(received.size() - 1));
            assertTrue(received.size() > 3);
            for (int i = 1; i < received.size(); i++) assertTrue(received.get(i) > received.get(i - 1));
        } finally { file.delete(); }
    }

    @Test public void cancellationDuringCachedSaveStopsBeforeReportingAllBytes() throws Exception {
        byte[] source = new byte[192 * 1024];
        File file = File.createTempFile("xhs-cancel-progress", ".bin");
        try {
            Files.write(file.toPath(), source);
            ByteArrayOutputStream output = new ByteArrayOutputStream();
            XhsTransfer.Cancellation cancellation = new XhsTransfer.Cancellation();
            try {
                XhsTransfer.copy(file, output, cancellation, (bytes, total) -> {
                    if (bytes > 0) cancellation.cancel();
                });
                fail("Cancelled save must not finish");
            } catch (IOException expected) {
                assertTrue(cancellation.isCancelled());
                assertTrue(output.size() > 0 && output.size() < source.length);
            }
        } finally { file.delete(); }
    }

    @Test public void cancellationAtTheLastByteStillRejectsTheSave() throws Exception {
        File file = File.createTempFile("xhs-last-byte-cancel", ".bin");
        try {
            Files.write(file.toPath(), new byte[100]);
            ByteArrayOutputStream output = new ByteArrayOutputStream();
            XhsTransfer.Cancellation cancellation = new XhsTransfer.Cancellation();
            try {
                XhsTransfer.copy(file, output, cancellation, (bytes, total) -> {
                    if (bytes == total) cancellation.cancel();
                });
                fail("A final-byte cancellation must not be reported as a successful save");
            } catch (IOException expected) {
                assertTrue(cancellation.isCancelled());
                assertEquals(100, output.size());
            }
        } finally { file.delete(); }
    }

    @Test public void xhsConnectionsBypassTheProcessProxySelector() throws Exception {
        ProxySelector original = ProxySelector.getDefault();
        AtomicInteger selected = new AtomicInteger();
        try (ServerSocket server = new ServerSocket(0, 1, java.net.InetAddress.getByName("127.0.0.1"))) {
            Thread fixture = new Thread(() -> {
                try (Socket socket = server.accept()) {
                    socket.setSoTimeout(3000);
                    byte[] tail = new byte[4];
                    int index = 0, value;
                    while ((value = socket.getInputStream().read()) != -1) {
                        tail[index++ % 4] = (byte) value;
                        if (index >= 4 && tail[(index - 4) % 4] == '\r' && tail[(index - 3) % 4] == '\n'
                                && tail[(index - 2) % 4] == '\r' && tail[(index - 1) % 4] == '\n') break;
                    }
                    socket.getOutputStream().write("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok".getBytes(StandardCharsets.US_ASCII));
                } catch (IOException ignored) { }
            }, "xhs-direct-fixture");
            fixture.start();
            ProxySelector.setDefault(new ProxySelector() {
                @Override public List<Proxy> select(URI uri) {
                    selected.incrementAndGet();
                    return Collections.singletonList(new Proxy(Proxy.Type.HTTP, new InetSocketAddress("127.0.0.1", 1)));
                }
                @Override public void connectFailed(URI uri, SocketAddress address, IOException error) { }
            });
            Method factory = XhsTransfer.class.getDeclaredMethod("connection", URI.class, XhsTransfer.Cancellation.class);
            factory.setAccessible(true);
            XhsTransfer.Cancellation cancellation = new XhsTransfer.Cancellation();
            HttpURLConnection connection = (HttpURLConnection) factory.invoke(null,
                    URI.create("http://127.0.0.1:" + server.getLocalPort() + "/fixture"), cancellation);
            try {
                assertEquals(200, connection.getResponseCode());
                assertEquals("ok", new String(connection.getInputStream().readAllBytes(), StandardCharsets.US_ASCII));
                assertEquals(0, selected.get());
                assertFalse(connection.usingProxy());
            } finally { cancellation.detach(connection); }
            fixture.join(3000);
            assertFalse(fixture.isAlive());
        } finally { ProxySelector.setDefault(original); }
    }
}
