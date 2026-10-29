'use strict';
// Offline integration: production profile discovery/queue, Chromium scroll events,
// CDP response bodies, real TLS sockets and atomic media files. No real accounts.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { _electron } = require('@playwright/test');

const root = path.resolve(__dirname, '..');
const reportPath = path.join(root, 'artifacts/xhs-profile-discovery-verification.json');
const hosts = ['www.xiaohongshu.com', 'ci.xiaohongshu.com'];
const profileId = '5e413a430000000001000f4c';
const profileURL = `https://www.xiaohongshu.com/user/profile/${profileId}`;
const ids = ['111111111111111111111111', '222222222222222222222222', '333333333333333333333333'];
const titles = ['首批第一篇', '主页上的完整标题不会被通用占位符覆盖', '小红书图片'];
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const report = { passed: false, testedAt: new Date().toISOString(), actualElectron: true, publicNetwork: false, isolatedUserData: true, checks: [] };

function profileHTML() {
  return `<!doctype html><meta charset="utf-8"><style>
    html,body{margin:0;height:100%;overflow:hidden}#feed-scroll{height:300px;overflow:auto}.feeds-tab-container{min-height:1200px}.note-item{height:400px}
    </style><div id="feed-scroll"><div class="feeds-tab-container"></div></div><script>
    window.__INITIAL_STATE__={user:{activeTab:{query:'note'},notes:[[]],noteQueries:[{userId:${JSON.stringify(profileId)},hasMore:true}],isFetchingNotes:[false],userPageData:{basicInfo:{nickname:'离线测试作者'}}}};
    window.fixtureState={scrollEvents:0,pageRequests:0,loaded:[],error:''};
    const fixture=window.fixtureState,user=window.__INITIAL_STATE__.user,scroller=document.getElementById('feed-scroll');
    let cursor='',busy=false,hasMore=true;
    async function nextPage(){
      if(busy||!hasMore)return;
      busy=true;user.isFetchingNotes[0]=true;fixture.pageRequests++;
      try{
        const response=await fetch('/api/sns/web/v1/user_posted?user_id=${profileId}&cursor='+encodeURIComponent(cursor));
        const payload=await response.json();
        for(const note of payload.data.notes){
          if(fixture.loaded.includes(note.note_id))continue;
          fixture.loaded.push(note.note_id);
          const card=document.createElement('article');card.className='note-item';
          const anchor=document.createElement('a');anchor.href='/explore/'+note.note_id;
          const title=document.createElement('span');title.className='title';title.textContent=note.display_title;
          anchor.append(title);card.append(anchor);document.querySelector('.feeds-tab-container').append(card);
        }
        cursor=payload.data.cursor;hasMore=payload.data.has_more;
        // Intentionally retain an empty SSR note array and stale hasMore=true.
        // Discovery must obtain these authored notes and the end flag from CDP.
      }catch(error){fixture.error=error.message;}finally{busy=false;user.isFetchingNotes[0]=false;}
    }
    scroller.addEventListener('scroll',()=>{fixture.scrollEvents++;if(scroller.scrollTop+scroller.clientHeight>=scroller.scrollHeight-2)void nextPage();});
    void nextPage();
    </script>`;
}

function noteHTML(id) {
  const index = ids.indexOf(id);
  // The second detail omits its title, reproducing the parser's generic label.
  const note = { noteId: id, title: index === 1 ? '' : titles[index], desc: `完整文案 ${index + 1}`,
    imageList: [{ urlDefault: `https://ci.xiaohongshu.com/fixture/${id}.png` }] };
  return `<!doctype html><meta charset="utf-8"><script>window.__INITIAL_STATE__=${JSON.stringify({ note: { noteDetailMap: { [id]: { note } } } })}</script><p>离线笔记详情</p>`;
}

async function main() {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'brclio-profile-discovery-'));
  const output = path.join(temporary, 'downloads');
  await fs.mkdir(output);
  let application, server;
  const sockets = new Set(), requests = [], secondPageProof = [];
  try {
    const keyPath = path.join(temporary, 'fixture.key'), certPath = path.join(temporary, 'fixture.pem');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
      '-keyout', keyPath, '-out', certPath, '-subj', '/CN=www.xiaohongshu.com',
      '-addext', `subjectAltName=${hosts.map(host => `DNS:${host}`).join(',')}`], { stdio: 'pipe', timeout: 30000 });
    const respond = async (request, response) => {
      const url = new URL(request.url, `https://${request.headers.host}`);
      requests.push({ host: url.hostname, path: url.pathname, cursor: url.searchParams.get('cursor') });
      response.setHeader('cache-control', 'no-store');
      if (url.hostname === 'www.xiaohongshu.com' && url.pathname === `/user/profile/${profileId}`) {
        response.writeHead(200, { 'content-type': 'text/html;charset=utf-8' }); response.end(profileHTML()); return;
      }
      if (url.hostname === 'www.xiaohongshu.com' && url.pathname === '/api/sns/web/v1/user_posted') {
        const second = url.searchParams.get('cursor') === 'page-two';
        if (second) {
          for (const name of await fs.readdir(output)) {
            const manifest = await fs.readFile(path.join(output, name, '.xhs-download.json'), 'utf8').then(JSON.parse).catch(() => null);
            if (manifest?.complete) secondPageProof.push({ id: manifest.id, imagePresent: (await fs.readFile(path.join(output, name, 'image-001.png')).catch(() => null))?.equals(png) === true });
          }
        }
        const selected = second ? [1, 2] : [0, 1];
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ success: true, code: 0, data: { notes: selected.map(index => ({ note_id: ids[index], display_title: titles[index], user: { user_id: profileId } })), has_more: !second, cursor: second ? 'final-page' : 'page-two' } })); return;
      }
      const noteId = url.pathname.match(/^\/explore\/([a-f0-9]{24})$/)?.[1];
      if (url.hostname === 'www.xiaohongshu.com' && ids.includes(noteId)) {
        response.writeHead(200, { 'content-type': 'text/html;charset=utf-8' }); response.end(noteHTML(noteId)); return;
      }
      if (url.hostname === 'ci.xiaohongshu.com' && /^\/fixture\/[a-f0-9]{24}\.png$/.test(url.pathname)) {
        response.writeHead(200, { 'content-type': 'image/png', 'content-length': png.length }); response.end(png); return;
      }
      response.writeHead(403); response.end('Unexpected fixture destination');
    };
    server = https.createServer({ key: await fs.readFile(keyPath), cert: await fs.readFile(certPath) }, (request, response) => {
      void respond(request, response).catch(error => { response.writeHead(500); response.end(error.message); });
    });
    server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const port = server.address().port;
    const driver = path.join(temporary, 'driver.cjs');
    await fs.writeFile(driver, `const {app,BrowserWindow}=require('electron');
app.setPath('userData',${JSON.stringify(path.join(temporary, 'user-data'))});
app.whenReady().then(()=>{const window=new BrowserWindow({show:false});window.loadURL('about:blank');});
app.on('window-all-closed',()=>{});`);
    application = await _electron.launch({ executablePath: require('electron'), cwd: root, timeout: 30000,
      args: [...(process.platform === 'linux' ? ['--no-sandbox'] : []), `--host-resolver-rules=${hosts.map(host => `MAP ${host} 127.0.0.1:${port}`).join(',')},MAP * ~NOTFOUND`, driver] });
    await application.firstWindow();
    const actual = await application.evaluate(async ({ BrowserWindow, session, net }, fixture) => {
      const load = process.getBuiltinModule('node:module').createRequire(fixture.root + '/package.json');
      const { XhsBrowser } = load('./desktop/xhs/desktop/profile-browser.js');
      const { ProfileManager } = load('./desktop/xhs/desktop/profile-manager.js');
      const { createElectronUpdateFetch } = load('./desktop/xhs/desktop/electron-fetch.js');
      const { createFixtureCertificateVerifier } = load('./test/native-proxy-tls-fixture.cjs');
      const { X509Certificate } = load('node:crypto');
      const fs = load('node:fs');
      const nativeSession = session.fromPartition('persist:brclio-xhs');
      const trust = createFixtureCertificateVerifier(new X509Certificate(fs.readFileSync(fixture.certPath)));
      nativeSession.setCertificateVerifyProc(trust.verify);
      await nativeSession.setProxy({ mode: 'direct' });
      const forbidden = [];
      nativeSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (request, callback) => {
        const permitted = fixture.hosts.includes(new URL(request.url).hostname);
        if (!permitted) forbidden.push(request.url);
        callback({ cancel: !permitted });
      });
      let clock = Date.now();
      const diagnostics = [], updates = [];
      // Only pacing is accelerated; DOM, navigation, TLS, CDP and disk I/O are real.
      const wait = async (ms, _value, options) => {
        options?.signal?.throwIfAborted(); clock += ms;
        await new Promise(resolve => setTimeout(resolve, Math.min(ms, 200)));
        options?.signal?.throwIfAborted();
      };
      const browser = new XhsBrowser({ BrowserWindow, session, wait, now: () => clock,
        onDiagnostic: (event, fields) => diagnostics.push({ event, ...fields }),
        fetchPage: async () => { throw Error('The complete fixture must not use a public-page fallback'); } });
      const manager = new ProfileManager({ browser, stateDirectory: fixture.stateDirectory,
        fetchImpl: createElectronUpdateFetch(net, { session: nativeSession }), now: () => clock, random: () => 0,
        sleep: async (ms, signal) => { signal?.throwIfAborted(); clock += ms; },
        onDiagnostic: (event, fields) => diagnostics.push({ event, ...fields }),
        onUpdate: state => updates.push({ discovered: state.discovered, completed: state.completed, discoveryComplete: state.discoveryComplete, status: state.status }) });
      let timer;
      try {
        await manager.initialize();
        await manager.start({ profileUrl: fixture.profileURL, directory: fixture.output, intervalSeconds: 3, jitterSeconds: 0 });
        await Promise.race([manager._runTask, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Profile integration timed out')), 45000); })]);
        const page = await browser.profileWindow.webContents.executeJavaScript('JSON.parse(JSON.stringify(window.fixtureState))');
        return { snapshot: manager.snapshot(), diagnostics, updates, page, forbidden, tls: trust.snapshot() };
      } finally { clearTimeout(timer); await manager.shutdown(); browser.close(); }
    }, { root, certPath, hosts, profileURL, output, stateDirectory: path.join(temporary, 'state') });
    report.actual = actual;
    assert.equal(actual.snapshot.status, 'completed', actual.snapshot.message);
    assert.equal(actual.snapshot.discoveryComplete, true);
    assert.equal(actual.snapshot.discovered, 3);
    assert.equal(actual.snapshot.completed, 3);
    assert.equal(actual.snapshot.failed, 0);
    assert.equal(actual.page.pageRequests, 2);
    assert.ok(actual.page.scrollEvents > 0, 'the second page must be triggered by a real DOM scroll event');
    assert.deepEqual(actual.page.loaded, ids);
    assert.equal(actual.page.error, '');
    const pages = actual.diagnostics.filter(event => event.event === 'discovery.page');
    assert.equal(pages.length, 2, 'real CDP must capture both JSON responses');
    assert.deepEqual(pages.map(page => ({ count: page.count, hasMore: page.hasMore })), [{ count: 2, hasMore: true }, { count: 2, hasMore: false }]);
    report.checks.push('actual CDP captures both API pages and an explicit final has_more=false despite stale SSR state');
    assert.deepEqual(secondPageProof.map(proof => proof.id).sort(), ids.slice(0, 2));
    assert.ok(secondPageProof.every(proof => proof.imagePresent));
    assert.ok(actual.updates.some(state => state.discovered === 2 && state.completed === 2 && state.discoveryComplete === false));
    report.checks.push('both first-page notes and image files are committed before the DOM scroll requests page two');
    assert.deepEqual(actual.snapshot.items.map(item => item.title), titles);
    assert.deepEqual(actual.snapshot.items.map(item => item.sequence), [1, 2, 3]);
    assert.equal(actual.diagnostics.filter(event => event.event === 'note.start').length, 3);
    assert.equal(requests.filter(request => request.host === 'ci.xiaohongshu.com').length, 3);
    report.checks.push('duplicate note is saved once with stable ordering; missing detail title preserves the feed title');
    report.savedImages = [];
    for (const item of actual.snapshot.items) {
      const directory = path.join(output, item.directoryName);
      const bytes = await fs.readFile(path.join(directory, 'image-001.png'));
      assert.deepEqual(bytes, png);
      const manifest = JSON.parse(await fs.readFile(path.join(directory, '.xhs-download.json'), 'utf8'));
      const metadata = JSON.parse(await fs.readFile(path.join(directory, '笔记.json'), 'utf8'));
      assert.equal(manifest.complete, true); assert.equal(metadata.title, item.title);
      assert.ok((await fs.readFile(path.join(directory, '笔记.txt'), 'utf8')).includes(item.title));
      report.savedImages.push({ id: item.id, title: item.title, bytes: bytes.length, sha256: sha256(bytes) });
    }
    report.checks.push('all three original PNGs match byte-for-byte; manifests and text retain the correct titles');
    assert.deepEqual(actual.forbidden, []);
    assert.equal(actual.tls.result, 'accepted');
    report.checks.push('isolated session uses hostname-and-certificate-pinned local TLS only');
    report.requests = requests;
    report.secondPageProof = secondPageProof;
    report.passed = true;
  } catch (error) {
    report.error = { name: error.name, message: error.message };
    throw error;
  } finally {
    await application?.close().catch(() => {});
    for (const socket of sockets) socket.destroy();
    if (server) await new Promise(resolve => server.close(resolve));
    await fs.rm(temporary, { recursive: true, force: true });
    await fs.mkdir(path.dirname(reportPath), { recursive: true });
    await fs.writeFile(reportPath, JSON.stringify(report, null, 2));
  }
  console.log(JSON.stringify({ passed: report.passed, checks: report.checks.length, report: reportPath }));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
