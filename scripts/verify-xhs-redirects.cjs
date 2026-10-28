'use strict';
// Real Chromium requests and real TLS sockets. No request/protocol interception,
// public network, real account, global certificate override, or installed app.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { _electron } = require('@playwright/test');

const root = path.resolve(__dirname, '..');
const reportPath = path.join(root, 'artifacts/xhs-redirect-verification.json');
const hosts = ['xhslink.com', 'www.xiaohongshu.com', 'ci.xiaohongshu.com', 'sns-video-bd.xhscdn.com'];
const noteId = 'abcdef1234567890abcdef12';
const shortURL = 'https://xhslink.com/fixture/short';
const noteURL = `https://www.xiaohongshu.com/explore/${noteId}`;
const videoBase = 'https://sns-video-bd.xhscdn.com/spectrum/';
const imageURL = 'https://ci.xiaohongshu.com/fixture/original.png';
const report = { passed: false, testedAt: new Date().toISOString(), actualElectron: true, publicNetwork: false, checks: [] };
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

async function main() {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'brclio-xhs-redirects-'));
  const output = path.join(temporary, 'downloads');
  await fs.mkdir(output);
  let application, server;
  const sockets = new Set(), requests = [];
  try {
    // A fresh, test-only leaf with the actual fixture hostnames. Its key and
    // certificate remain inside the temporary directory and are then deleted.
    const keyPath = path.join(temporary, 'fixture.key'), certPath = path.join(temporary, 'fixture.pem');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
      '-keyout', keyPath, '-out', certPath, '-subj', '/CN=xhslink.com',
      '-addext', `subjectAltName=${hosts.map(host => `DNS:${host}`).join(',')}`], { stdio: 'pipe', timeout: 30000 });
    const { mp4Fixture } = await import(pathToFileURL(path.join(root, 'desktop/xhs/test/fixtures/mp4.js')).href);
    const video = mp4Fixture({ payloadBytes: 256 * 1024 });
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
    const note = { noteId, title: '真实重定向验证', desc: '保留原版解析逻辑', imageList: [{ urlDefault: imageURL }],
      video: { consumer: { originVideoKey: videoBase + 'redirect.mp4' }, media: { stream: { h264: [{ masterUrl: videoBase + 'redirect.mp4', audioCodec: 'aac' }] } } } };
    const html = `<script>window.__INITIAL_STATE__=${JSON.stringify({ note: { noteDetailMap: { [noteId]: { note } } } })}</script>`;
    server = https.createServer({ key: await fs.readFile(keyPath), cert: await fs.readFile(certPath) }, (request, response) => {
      const url = new URL(request.url, `https://${request.headers.host}`);
      requests.push({ host: url.hostname, path: url.pathname, referer: request.headers.referer || '', cookie: request.headers.cookie || '' });
      const redirect = location => { response.writeHead(302, { location, 'cache-control': 'no-store' }); response.end(); };
      if (url.hostname === 'xhslink.com' && url.pathname === '/fixture/short') return redirect(noteURL);
      if (url.hostname === 'www.xiaohongshu.com' && url.pathname === `/explore/${noteId}`) {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); response.end(html); return;
      }
      if (url.pathname === '/spectrum/redirect.mp4') return redirect(videoBase + 'final.mp4');
      if (url.pathname === '/fixture/redirect.png') return redirect(imageURL);
      if (url.pathname === '/spectrum/unsafe.mp4') return redirect('https://127.0.0.1/forbidden');
      if (url.pathname === '/spectrum/unavailable.mp4') { response.writeHead(503); response.end('fixture unavailable'); return; }
      if (url.pathname === '/spectrum/stalled.mp4') {
        response.writeHead(200, { 'content-type': 'video/mp4', 'content-length': video.length });
        response.write(video.subarray(0, 128)); return;
      }
      const bytes = url.pathname === '/spectrum/final.mp4' ? video : url.pathname === '/fixture/original.png' ? png : null;
      if (!bytes) { response.writeHead(403); response.end('Unexpected fixture destination'); return; }
      response.writeHead(200, { 'content-type': bytes === video ? 'video/mp4' : 'image/png', 'content-length': bytes.length }); response.end(bytes);
    });
    server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const port = server.address().port;
    const driver = path.join(temporary, 'driver.cjs');
    await fs.writeFile(driver, `const { app, BrowserWindow } = require('electron');
app.setPath('userData', ${JSON.stringify(path.join(temporary, 'user-data'))});
app.whenReady().then(() => { const window = new BrowserWindow({ show: false }); window.loadURL('about:blank'); });
app.on('window-all-closed', () => {});
`);
    application = await _electron.launch({ executablePath: require('electron'), cwd: root, timeout: 30000,
      args: [...(process.platform === 'linux' ? ['--no-sandbox'] : []), `--host-resolver-rules=${hosts.map(host => `MAP ${host} 127.0.0.1:${port}`).join(',')}`, driver] });
    await application.firstWindow();
    const baseline = await application.evaluate(async ({ session }, fixture) => {
      const load = process.getBuiltinModule('node:module').createRequire(fixture.root + '/package.json');
      const { X509Certificate } = load('node:crypto');
      const fs = load('node:fs');
      const expected = new X509Certificate(fs.readFileSync(fixture.certPath));
      const { createFixtureCertificateVerifier } = load('./test/native-proxy-tls-fixture.cjs');
      const nativeSession = session.fromPartition('persist:brclio-xhs', { cache: false });
      const trust = createFixtureCertificateVerifier(expected);
      nativeSession.setCertificateVerifyProc(trust.verify);
      await nativeSession.setProxy({ mode: 'direct' });
      await nativeSession.cookies.set({ url: fixture.videoBase, name: 'xhs_fixture_cookie', value: 'must-not-enter-native-media', secure: true, httpOnly: true });
      await nativeSession.closeAllConnections();
      const forbidden = [];
      nativeSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (request, callback) => {
        const permitted = fixture.hosts.includes(new URL(request.url).hostname);
        if (!permitted) forbidden.push(request.url);
        callback({ cancel: !permitted });
      });
      global.__xhsRedirectFixture = { session: nativeSession, trust, forbidden, events: [], savePath: fixture.output + '/redirect.mp4' };
      try {
        const response = await nativeSession.fetch(fixture.shortURL, { redirect: 'manual' });
        await response.body?.cancel();
        return { unexpectedlyResolved: response.status };
      } catch (error) { return { message: error.message }; }
    }, { root, hosts, certPath, shortURL, output, videoBase });
    assert.match(baseline.message || '', /Redirect was cancelled/i, 'reproduce the exact production transport regression');
    report.checks.push('original session.fetch(manual) failure reproduced over actual HTTPS');
    report.previousTransportError = baseline.message;

    const parsed = await application.evaluate(async ({ net }, fixture) => {
      const load = process.getBuiltinModule('node:module').createRequire(fixture.root + '/package.json');
      const { createElectronUpdateFetch } = load('./desktop/xhs/desktop/electron-fetch.js');
      const { fetchNotePage, parseNoteHtml } = load('./desktop/xhs/lib/xhs.js');
      const state = global.__xhsRedirectFixture;
      const nativeFetch = createElectronUpdateFetch(net, { session: state.session });
      const network = (url, options) => nativeFetch(String(url), options);
      const redirect = await network(fixture.shortURL, { redirect: 'manual' });
      if (redirect.status !== 302 || redirect.headers.get('location') !== fixture.noteURL) throw Error('Manual redirect response was not exposed');
      const { finalUrl, html } = await fetchNotePage(fixture.shortURL, { fetchImpl: network });
      const note = parseNoteHtml(html, { noteId: fixture.noteId });
      return { status: redirect.status, finalUrl, title: note.title, images: note.images.length, originalVideos: note.originalVideos.length, tls: state.trust.snapshot() };
    }, { root, shortURL, noteURL, noteId });
    assert.equal(parsed.finalUrl, noteURL); assert.equal(parsed.title, '真实重定向验证'); assert.equal(parsed.images, 1); assert.equal(parsed.originalVideos, 1);
    assert.equal(parsed.tls.result, 'accepted'); assert.equal(parsed.tls.hostnameMatched, true); assert.equal(parsed.tls.fingerprintMatched, true);
    report.checks.push('source net.request adapter exposes 302 and original parser follows the validated short-link chain');
    report.tls = parsed.tls;

    const downloaded = await application.evaluate(async ({ app, BrowserWindow, session, net }, fixture) => {
      const load = process.getBuiltinModule('node:module').createRequire(fixture.root + '/package.json');
      const { createXhsService } = load('./desktop/xhs/index.mjs');
      const state = global.__xhsRedirectFixture;
      state.service = await createXhsService({
        app: { getPath: name => name === 'downloads' ? fixture.output : app.getPath(name), getAppPath: () => fixture.root, isPackaged: false },
        BrowserWindow, session, net,
        dialog: { showSaveDialog: async () => ({ canceled: false, filePath: state.savePath }), showOpenDialog: async () => ({ canceled: false, filePaths: [fixture.output] }) },
        clipboard: { readText: () => '' }, shell: { openPath: async () => '' }, onEvent: event => state.events.push(event),
        // Keep the user's real OS clipboard intact; the download/cache path is
        // production code and still uses the unmodified native network.
        clipboardWriters: { writeSingleImage: async filename => { state.clipboardImage = filename; return { kind: 'image' }; }, writeImageFiles: async () => { throw Error('Unexpected multi-image clipboard'); } },
      });
      return state.service.request('saveVideo', { requestId: 'real-redirect', filename: 'redirect', video: { url: fixture.videoBase + 'redirect.mp4' } });
    }, { root, output, videoBase });
    assert.equal(downloaded.ok, true, JSON.stringify(downloaded)); assert.equal(downloaded.cancelled, false);
    assert.equal(sha256(await fs.readFile(downloaded.path)), sha256(video));
    assert.ok(requests.some(request => request.path === '/spectrum/redirect.mp4'));
    assert.ok(requests.some(request => request.path === '/spectrum/final.mp4'));
    report.checks.push('production service saves redirected video through its default native network and preserves all bytes');
    report.savedVideo = { bytes: video.length, sha256: sha256(video) };

    if (['darwin', 'win32'].includes(process.platform)) {
      const copied = await application.evaluate(async () => {
        const state = global.__xhsRedirectFixture;
        const result = await state.service.request('copyImages', { requestId: 'real-image-redirect', title: '原图', images: [{ index: 1, url: 'https://ci.xiaohongshu.com/fixture/redirect.png' }] });
        return { result, filename: state.clipboardImage };
      });
      assert.equal(copied.result.ok, true); assert.equal(copied.result.count, 1);
      assert.equal(sha256(await fs.readFile(copied.filename)), sha256(png));
      report.checks.push('production image-copy pipeline follows a real redirect and caches exact original image bytes');
    }

    const backup = await application.evaluate(async (_electron, fixture) => {
      const state = global.__xhsRedirectFixture; state.savePath = fixture.output + '/backup.mp4';
      return state.service.request('saveVideo', { requestId: 'real-backup', video: { url: fixture.videoBase + 'unavailable.mp4', backupUrls: [fixture.videoBase + 'redirect.mp4'] } });
    }, { output, videoBase });
    assert.equal(backup.ok, true, JSON.stringify(backup)); assert.equal(sha256(await fs.readFile(backup.path)), sha256(video));
    report.checks.push('production video download retries the declared backup URL after HTTP 503');

    const refused = await application.evaluate(async (_electron, fixture) => {
      const state = global.__xhsRedirectFixture; state.savePath = fixture.output + '/unsafe.mp4';
      const result = await state.service.request('saveVideo', { requestId: 'real-unsafe', video: { url: fixture.videoBase + 'unsafe.mp4' } });
      return { result, forbidden: state.forbidden };
    }, { output, videoBase });
    assert.equal(refused.result.ok, false); assert.match(refused.result.error.message, /重定向.*小红书媒体域名/);
    assert.deepEqual(refused.forbidden, [], 'unsafe redirect must be refused before it reaches Chromium');
    await assert.rejects(fs.stat(path.join(output, 'unsafe.mp4')), { code: 'ENOENT' });
    report.checks.push('production downloader rejects a non-XHS redirect before connecting and never publishes an invalid file');

    await application.evaluate((_electron, fixture) => {
      const state = global.__xhsRedirectFixture; state.savePath = fixture.output + '/cancelled.mp4';
      state.cancelling = state.service.request('saveVideo', { requestId: 'real-cancel', video: { url: fixture.videoBase + 'stalled.mp4' } });
    }, { output, videoBase });
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline && !requests.some(request => request.path === '/spectrum/stalled.mp4')) await new Promise(resolve => setTimeout(resolve, 25));
    assert.ok(requests.some(request => request.path === '/spectrum/stalled.mp4'), 'stalled real request started');
    const cancellation = await application.evaluate(async () => {
      const state = global.__xhsRedirectFixture;
      await state.service.request('cancelVideo', { requestId: 'real-cancel' });
      return state.cancelling;
    });
    assert.equal(cancellation.cancelled, true);
    assert.deepEqual((await fs.readdir(output)).sort(), ['backup.mp4', 'redirect.mp4']);
    report.checks.push('cancelling a real stalled response removes staged data and leaves completed downloads intact');
    assert.ok(requests.every(request => hosts.includes(request.host)), 'all TLS requests remained in the local XHS fixture');
    assert.ok(requests.filter(request => request.host.includes('xhscdn')).every(request => request.referer === 'https://www.xiaohongshu.com/'));
    assert.ok(requests.every(request => request.cookie === ''), 'native media requests omit session cookies as in the source client');
    report.requestCount = requests.length;
    report.passed = true;
  } finally {
    await application?.evaluate(async () => {
      const state = global.__xhsRedirectFixture;
      await state?.service?.close();
      await state?.session?.closeAllConnections();
      state?.session?.setCertificateVerifyProc(null);
    }).catch(() => {});
    await application?.close().catch(() => {});
    for (const socket of sockets) socket.destroy();
    if (server) await new Promise(resolve => server.close(resolve));
    await fs.rm(temporary, { recursive: true, force: true });
    await fs.mkdir(path.dirname(reportPath), { recursive: true });
    await fs.writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
  }
  console.log(JSON.stringify(report, null, 2));
}

main().catch(error => { console.error(error); process.exitCode = 1; });
