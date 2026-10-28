'use strict';
// Exercise the production main/preload/renderer and native filesystem with
// deterministic HTTPS fixtures. Never reads or writes the user's account data.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { _electron, expect } = require('@playwright/test');
const root = path.resolve(__dirname, '..');
const artifacts = path.join(root, 'artifacts');
const noteId = 'abcdef1234567890abcdef12';
const imageURL = 'https://ci.xiaohongshu.com/fixture-image?imageView2/format/png';
const videoURL = 'https://sns-video-bd.xhscdn.com/spectrum/fixture-original.mp4';
const noteURL = `https://www.xiaohongshu.com/explore/${noteId}`;

async function main() {
  await fs.mkdir(artifacts, { recursive: true });
  const platformName = { darwin: 'mac', win32: 'win', linux: 'linux' }[process.platform];
  const bundledPython = path.join(root, 'runtime', `${platformName}-${process.arch}`, 'python', process.platform === 'win32' ? 'xhs-python.exe' : 'xhs-python');
  assert.equal((await fs.stat(bundledPython)).isFile(), true, 'Run npm run prepare:xhs before verifying the frozen native parser.');
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'brclio-xhs-native-'));
  const output = path.join(temporary, 'downloads'); await fs.mkdir(output);
  const videoPath = path.join(temporary, 'fixture.mp4');
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=160x96:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '0.8', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', videoPath], { timeout: 30000, stdio: 'pipe' });
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
  const note = { noteId, title: '本地验证笔记', desc: '完整中文文案 #Brclio', imageList: [
    { urlDefault: imageURL, livePhoto: true, stream: { h264: [{ masterUrl: videoURL, width: 160, height: 96, audioCodec: 'aac' }] } },
    { urlDefault: imageURL },
  ], video: { consumer: { originVideoKey: videoURL }, media: { stream: { h264: [{ masterUrl: videoURL, width: 160, height: 96, audioCodec: 'aac' }] } } } };
  const html = `<!doctype html><title>Fixture</title><script>window.__INITIAL_STATE__=${JSON.stringify({ note: { noteDetailMap: { [noteId]: { note } } } })}</script><p>Offline fixture</p>`;
  const bootstrap = path.join(temporary, 'bootstrap.cjs');
  const metadata = require('../package.json');
  await fs.writeFile(path.join(temporary, 'package.json'), JSON.stringify({ name: metadata.name, version: metadata.version, main: 'bootstrap.cjs' }));
  await fs.writeFile(bootstrap, `
const {app,session,dialog,net}=require('electron');
// UI fixture transports are explicit; verify-xhs-redirects.cjs covers real TLS/network.
const {mockElectronRequest}=require(${JSON.stringify(path.join(root, 'test/electron-update-request-fixture.cjs'))});
globalThis.fetch=(url,options)=>fixtureResponse({url:String(url),headers:new Headers(options?.headers)});
net.request=mockElectronRequest(globalThis.fetch);
const fs=require('node:fs');
app.getAppPath=()=>${JSON.stringify(root)};
global.__xhsNetwork=[];
global.__xhsSavePath=${JSON.stringify(path.join(output, '原视频.mp4'))};
dialog.showOpenDialog=async()=>({canceled:false,filePaths:[${JSON.stringify(output)}]});
dialog.showSaveDialog=async()=>({canceled:false,filePath:global.__xhsSavePath});
dialog.showMessageBox=async()=>({response:0});
const observed=new WeakSet();
function mock(value){
 if(observed.has(value))return;observed.add(value);
 for(const scheme of ['https','http'])value.protocol.handle(scheme,fixtureResponse);
}
function fixtureResponse(request){
  global.__xhsNetwork.push(request.url);
  const url=new URL(request.url);
  if(url.hostname==='tools.brclio.com'&&url.pathname.startsWith('/api/account/'))return Response.json({user:null,csrf:'fixture-csrf',googleEnabled:false});
  if(url.hostname==='www.xiaohongshu.com')return new Response(${JSON.stringify(html)},{headers:{'content-type':'text/html;charset=utf-8'}});
  let data,type;
  if(url.hostname==='ci.xiaohongshu.com'){data=Buffer.from(${JSON.stringify(png.toString('base64'))},'base64');type='image/png';}
  else if(url.hostname==='sns-video-bd.xhscdn.com'){if(global.__xhsFailVideo)return new Response('<html>not a video</html>',{headers:{'content-type':'text/html'}});data=fs.readFileSync(${JSON.stringify(videoPath)});type='video/mp4';}
  else return new Response('Offline fixture refuses unknown destination',{status:403});
  const range=request.headers.get('range');let status=200;const headers={'content-type':type,'accept-ranges':'bytes'};
  if(range){const [,start,end]=/^bytes=(\\d+)-(\\d*)$/.exec(range)||[];const from=Number(start),to=end?Math.min(Number(end),data.length-1):data.length-1;headers['content-range']='bytes '+from+'-'+to+'/'+data.length;data=data.subarray(from,to+1);status=206;}
  headers['content-length']=String(data.length);return new Response(data,{status,headers});
}
app.on('session-created',mock);app.whenReady().then(()=>mock(session.defaultSession));
require(${JSON.stringify(path.join(root, 'desktop/main.cjs'))});
`);
  let app;
  const report = { passed: false, testedAt: new Date().toISOString(), platform: process.platform, checks: [], consoleErrors: [] };
  try {
    app = await _electron.launch({ executablePath: require('electron'), args: [...(process.platform === 'linux' ? ['--no-sandbox'] : []), temporary], cwd: root,
      env: { ...process.env, BRCLIO_USER_DATA: path.join(temporary, 'user-data'), ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' }, timeout: 30000 });
    const page = await app.firstWindow(); page.setDefaultTimeout(20000);
    page.on('pageerror', error => report.consoleErrors.push(error.message));
    await page.waitForFunction(() => document.body.dataset.ready === 'true');
    assert.equal(await page.locator('#view-copy').isVisible(), true);
    const settingsBefore = await page.evaluate(() => window.brclio.getSettings());
    const originalClipboard = await app.evaluate(({ clipboard }) => clipboard.readText());
    assert.ok(!(await app.evaluate(() => global.__xhsNetwork)).some(url => new URL(url).hostname.includes('xiaohongshu')),
      'the copy-path launch must not initiate XHS browsing');
    await page.locator('[data-view="xhs"]').first().click();
    const info = await page.evaluate(() => window.brclio.xhsRequest('info'));
    assert.equal(info.pythonAvailable, true, 'the actual bundled Python worker must start');
    report.checks.push('main/preload IPC and native Python runtime health');
    await page.locator('#xhs-share').fill(noteURL);
    await page.locator('#xhs-parse').click();
    await expect(page.locator('#xhs-note-title')).toHaveText('本地验证笔记');
    await expect(page.locator('#xhs-image-grid article')).toHaveCount(2);
    await page.waitForFunction(() => [...document.querySelectorAll('#xhs-image-grid img')].every(image => image.complete && image.naturalWidth > 0));
    assert.match(await page.locator('#xhs-video-select option').first().textContent(), /原视频/);
    await page.locator('#xhs-image-grid input').last().uncheck();
    await page.locator('#xhs-save-images').click();
    await expect(page.locator('#xhs-message')).toContainText('已保存');
    const noteFolders = await fs.readdir(output);
    assert.equal(noteFolders.length, 1);
    const selectedFiles = await fs.readdir(path.join(output, noteFolders[0]));
    assert.equal(selectedFiles.filter(name => /^image-/.test(name)).length, 1);
    report.checks.push('production Node parse + original candidates + custom-protocol image decoding + selected native image save');
    await page.locator('#xhs-save-note').click();
    await expect(page.locator('#xhs-message')).toContainText('笔记素材已保存');
    const folderNames = await fs.readdir(output);
    let textFile;
    for (const name of folderNames) {
      const candidate = path.join(output, name, '笔记.txt');
      if (await fs.stat(candidate).catch(() => null)) textFile = candidate;
    }
    assert.ok(textFile); assert.match(await fs.readFile(textFile, 'utf8'), /完整中文文案/);
    await page.locator('#xhs-save-video').click();
    await expect(page.locator('#xhs-video-status')).toContainText('视频已下载并保存');
    const savedVideo = path.join(output, '原视频.mp4');
    const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', savedVideo], { encoding: 'utf8', timeout: 10000 }));
    assert.ok(probe.streams.some(stream => stream.codec_type === 'video'));
    assert.ok(probe.streams.some(stream => stream.codec_type === 'audio'));
    report.checks.push('native whole-note media/text save and original-video save with actual H.264/AAC track validation');
    for (const [button, format] of [['xhs-export-images', 'images'], ['xhs-export-live', 'live'], ['xhs-export-selected', 'selected']]) {
      if (format === 'selected') await page.locator('#xhs-image-grid input').last().check();
      const zipPath = path.join(output, `${format}.zip`);
      await app.evaluate((_electron, filename) => { global.__xhsSavePath = filename; }, zipPath);
      await page.locator(`#${button}`).click();
      await expect.poll(async () => Boolean(await fs.stat(zipPath).catch(() => null))).toBe(true);
      const python = process.platform === 'win32' ? 'python' : 'python3';
      const entries = JSON.parse(execFileSync(python, ['-c', 'import sys,zipfile,json\nwith zipfile.ZipFile(sys.argv[1]) as z:\n assert z.testzip() is None\n print(json.dumps({"files":z.namelist(),"text":z.read("笔记.txt").decode("utf-8-sig")},ensure_ascii=False))', zipPath], { encoding: 'utf8', timeout: 10000 }));
      assert.match(entries.text, /完整中文文案/);
      assert.equal(entries.files.filter(name => /\.(?:png|jpe?g|webp)$/i.test(name)).length, format === 'selected' ? 2 : 1);
      assert.equal(entries.files.some(name => /\.mp4$/i.test(name)), format !== 'images');
    }
    report.checks.push('native selected-image and paired-live ZIP exports independently unpack with valid CRC and note text');
    const goodVideo = await fs.readFile(savedVideo);
    await app.evaluate((_electron, filename) => { global.__xhsFailVideo = true; global.__xhsSavePath = filename; }, savedVideo);
    await page.locator('#xhs-save-video').click();
    await expect(page.locator('#xhs-message.error')).toBeVisible();
    assert.deepEqual(await fs.readFile(savedVideo), goodVideo);
    assert.ok(!/视频已下载并保存/.test(await page.locator('#xhs-video-status').textContent()));
    report.checks.push('invalid media cannot report success or replace the previously saved video');
    const denied = await page.evaluate(async () => {
      const response = await fetch('brclio-xhs://local/api/image?url=https%3A%2F%2F127.0.0.1%2Fprivate');
      return { status: response.status, result: await response.json() };
    });
    assert.equal(denied.result.success, false);
    assert.ok(denied.status >= 400);
    await page.locator('#xhs-tab-profile').click();
    await page.locator('#xhs-choose-directory').click();
    await expect(page.locator('#xhs-directory')).toHaveText(await fs.realpath(output));
    const before = await page.evaluate(() => window.brclio.xhsRequest('profileState'));
    assert.equal(before.status, 'idle');
    assert.equal(await page.evaluate(() => window.brclio.xhsRequest('openDirectory', { directory: '/tmp' }).then(() => false, () => true)), true);
    report.checks.push('native folder approval + persisted queue IPC + private-host and unapproved-directory rejection');
    await page.locator('[data-view="copy"]').first().click();
    assert.deepEqual(await page.evaluate(() => window.brclio.getSettings()), settingsBefore);
    assert.equal(await app.evaluate(({ clipboard }) => clipboard.readText()), originalClipboard);
    await page.locator('#account-button').click();
    await expect(page.locator('#account-login-form')).toBeVisible();
    report.checks.push('existing copy preferences, clipboard and Brclio login remain intact');
    assert.deepEqual(report.consoleErrors, []);
    report.network = await app.evaluate(() => global.__xhsNetwork);
    report.passed = true;
  } finally {
    if (app && !report.passed) report.failureContext = await app.firstWindow().then(async page => ({
      message: await page.locator('#xhs-message').textContent(),
      network: await app.evaluate(() => global.__xhsNetwork),
    })).catch(() => null);
    if (app) await app.close();
    await fs.writeFile(path.join(artifacts, 'xhs-desktop-verification.json'), JSON.stringify(report, null, 2) + '\n');
    await fs.rm(temporary, { recursive: true, force: true });
  }
  console.log(JSON.stringify(report, null, 2));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
