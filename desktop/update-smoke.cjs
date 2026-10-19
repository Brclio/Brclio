'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { _electron: electron, expect } = require('@playwright/test');

async function main() {
  const root = path.join(__dirname, '..');
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'brclio-update-smoke-'));
  let application;
  try {
    const packagedExecutable = process.env.BRCLIO_SMOKE_EXECUTABLE;
    application = await electron.launch({ cwd: root, args: packagedExecutable ? [] : [root],
      ...(packagedExecutable ? { executablePath: packagedExecutable } : {}),
      env: { ...process.env, BRCLIO_USER_DATA: temporary } });
    const page = await application.firstWindow();
    await page.waitForURL('file://**/web/index.html');
    await page.waitForFunction(() => document.body.dataset.ready === 'true');
    const currentVersion = await application.evaluate(({ app }) => app.getVersion());
    const versionParts = /^(\d+)\.(\d+)\.(\d+)$/.exec(currentVersion);
    assert.ok(versionParts, `Expected a stable version for update smoke; received ${currentVersion}`);
    const updateVersion = `${versionParts[1]}.${versionParts[2]}.${Number(versionParts[3]) + 1}`;
    const fixtureText = 'fixture data '.repeat(90000);
    await application.evaluate(({ net, shell, session }, fixture) => {
      const payload = new TextEncoder().encode(fixture.text);
      const hash = fixture.hash;
      const assetName = `Brclio-${fixture.version}-mac-${fixture.architecture}.dmg`;
      const prefix = `https://github.com/Brclio/Brclio/releases/download/v${fixture.version}/`;
      const release = { tag_name: `v${fixture.version}`, draft: false, prerelease: false, body: '原生 UI 更新验证。', assets: [
        { name: assetName, size: payload.length, browser_download_url: prefix + assetName, digest: `sha256:${hash}` },
        { name: 'SHA256SUMS.txt', size: 100, browser_download_url: prefix + 'SHA256SUMS.txt' },
      ] };
      globalThis.__updateSmoke = { corrupted: true, calls: [], routes: [], ranges: [], opened: [], gateMetadata: true, systemProxy: false };
      const resolveProxy = async () => globalThis.__updateSmoke.systemProxy ? 'PROXY 127.0.0.1:7890; DIRECT' : 'DIRECT';
      session.defaultSession.resolveProxy = resolveProxy;
      const systemSession = session.fromPartition('brclio-update-system', { cache: false });
      const directSession = session.fromPartition('brclio-update-direct', { cache: false });
      systemSession.resolveProxy = resolveProxy;
      const fetch = async (requested, init = {}) => {
        const url = requested;
        if (new URL(url).pathname === '/api/client/update-proxy') return new Response(JSON.stringify({version:1,ttlSeconds:600,nodes:[{uuid:'12345678-1234-1234-1234-123456789abc',host:'relay.example.com',dialAddress:'1.1.1.1',port:443,path:'/tunnel',servername:'relay.example.com',wsHost:'relay.example.com'}]}));
        if (init.method === 'HEAD') return new Response(null, {status:200});
        globalThis.__updateSmoke.routes.push(globalThis.__updateSmoke.systemProxy ? 'native' : 'builtin');
        globalThis.__updateSmoke.calls.push(url);
        const range = new Headers(init.headers).get('range');
        globalThis.__updateSmoke.ranges.push(range);
        if (url.includes('/releases/latest')) {
          if (globalThis.__updateSmoke.gateMetadata) await new Promise(resolve => {
            globalThis.__updateSmoke.releaseMetadata = () => { globalThis.__updateSmoke.gateMetadata = false; resolve(); };
          });
          return new Response(JSON.stringify(release));
        }
        if (url.endsWith('SHA256SUMS.txt')) return new Response(`${hash}  ${assetName}\n`);
        const body = globalThis.__updateSmoke.corrupted ? new Uint8Array(payload.length).fill(120) : payload;
        const start = 0, end = body.length - 1;
        let offset = start;
        const stream = new ReadableStream({ async pull(controller) {
          await new Promise(resolve => setTimeout(resolve, 30));
          if (offset > end) { controller.close(); return; }
          controller.enqueue(body.subarray(offset, Math.min(end + 1, offset + 64 * 1024))); offset += 64 * 1024;
        } });
        return new Response(stream, {headers:{'content-length':String(body.length)}});
      };
      net.fetch = fetch;
      const load = process.getBuiltinModule('node:module').createRequire(process.cwd() + '/package.json');
      net.request = load('./test/electron-update-request-fixture.cjs').mockElectronRequest(fetch);
      systemSession.fetch = fetch;
      directSession.fetch = fetch;
      const originalPartition = session.fromPartition.bind(session);
      session.fromPartition = (name, options) => { const partition = originalPartition(name, options); if (name.startsWith('brclio-update-builtin-')) partition.fetch = fetch; return partition; };
      shell.openPath = async filename => { globalThis.__updateSmoke.opened.push(filename); return ''; };
    }, { text: fixtureText, hash: crypto.createHash('sha256').update(fixtureText).digest('hex'), architecture: process.arch, version: updateVersion });
    await page.click('#about-button');
    await expect(page.locator('#about-update-proxy')).toBeChecked();
    await expect(page.locator('#about-update-proxy')).toBeEnabled();
    await page.uncheck('#about-update-proxy');
    await expect(page.locator('#about-update-proxy')).not.toBeChecked();
    await expect(page.locator('#update-proxy')).not.toBeChecked();
    assert.equal((await page.evaluate(() => window.brclio.getUpdateProxyState())).route, 'direct');
    await page.check('#about-update-proxy');
    await expect(page.locator('#about-update-proxy')).toBeEnabled();
    assert.equal((await page.evaluate(() => window.brclio.getUpdateProxyState())).route, 'builtin');
    await application.evaluate(() => { globalThis.__updateSmoke.systemProxy = true; });
    assert.equal((await page.evaluate(() => window.brclio.getUpdateProxyState())).route, 'system');
    await application.evaluate(() => { globalThis.__updateSmoke.systemProxy = false; });
    await page.click('#about-update');
    await expect(page.locator('#about-update')).toHaveText('正在检查…');
    await expect(page.locator('#about-update')).toBeDisabled();
    await expect(page.locator('#about-update-proxy')).toBeDisabled();
    await expect(page.locator('#about-dialog')).toBeVisible();
    await expect(page.locator('#view-copy')).toBeVisible();
    await expect.poll(() => application.evaluate(() => Boolean(globalThis.__updateSmoke.releaseMetadata))).toBe(true);
    await application.evaluate(() => globalThis.__updateSmoke.releaseMetadata());
    await expect(page.locator('#about-update-status-title')).toHaveText(`v${updateVersion} 已经准备好。`);
    assert.equal(await application.evaluate(() => globalThis.__updateSmoke.calls.length), 1);
    assert.deepEqual(await application.evaluate(() => globalThis.__updateSmoke.routes), ['builtin']);
    await page.click('#about-update');
    await expect(page.locator('#about-update-progress')).toBeVisible();
    await expect(page.locator('#about-update-status-title')).toHaveText('这次更新未完成，可以重试。');
    await expect(page.locator('#about-update-status-detail')).toContainText('SHA256 校验失败');
    assert.equal(await application.evaluate(() => globalThis.__updateSmoke.opened.length), 0);
    const updates = path.join(temporary, 'updates');
    assert.deepEqual(await fs.readdir(updates), []);

    await application.evaluate(() => { globalThis.__updateSmoke.corrupted = false; });
    await page.click('#about-update');
    await expect(page.locator('#about-update')).toHaveText('下载并安装更新');
    await page.click('#about-update');
    await expect(page.locator('#about-update-progress')).toBeVisible();
    await expect(page.locator('#about-update-status-title')).toHaveText('这次更新未完成，可以重试。');
    await expect(page.locator('#about-update')).toHaveText('重试安装');
    await expect(page.locator('#about-update-status-detail')).toContainText(packagedExecutable ? '磁盘' : '安装版');
    assert.deepEqual(await fs.readFile(path.join(updates, `Brclio-${updateVersion}-mac-${process.arch}.dmg`)), Buffer.from(fixtureText));
    const requests = await application.evaluate(() => globalThis.__updateSmoke.calls.length);
    await page.click('#about-update');
    await expect(page.locator('#about-update-status-title')).toHaveText('这次更新未完成，可以重试。');
    assert.equal(await application.evaluate(() => globalThis.__updateSmoke.calls.length), requests);
    assert.equal(await application.evaluate(() => globalThis.__updateSmoke.opened.length), 0);
    await expect(page.locator('#about-dialog')).toBeVisible();
    await expect(page.locator('#view-copy')).toBeVisible();
    await page.click('#about-dialog [data-close]');
    await page.click('[data-view="settings"]');
    await expect(page.locator('#update-status-title')).toHaveText('这次更新未完成，可以重试。');
    await expect(page.locator('#install-update')).toHaveText('重试安装');
    await expect(page.locator('#update-proxy')).toBeEnabled();
    await page.uncheck('#update-proxy');
    await expect(page.locator('#update-proxy')).not.toBeChecked();
    assert.equal((await page.evaluate(() => window.brclio.getUpdateProxyState())).enabled, false);
    assert.ok((await application.evaluate(() => globalThis.__updateSmoke.routes)).every(route => route === 'builtin'));
    assert.deepEqual(await application.evaluate(() => globalThis.__updateSmoke.ranges.filter(Boolean)), []);
    await application.close();
    application = await electron.launch({ cwd: root, args: packagedExecutable ? [] : [root],
      ...(packagedExecutable ? { executablePath: packagedExecutable } : {}),
      env: { ...process.env, BRCLIO_USER_DATA: temporary } });
    const restarted = await application.firstWindow();
    await restarted.waitForFunction(() => document.body.dataset.ready === 'true');
    assert.equal((await restarted.evaluate(() => window.brclio.getUpdateProxyState())).enabled, true);
    await restarted.click('#about-button');
    await expect(restarted.locator('#about-update-proxy')).toBeChecked();
    console.log('PASS native update IPC/UI: fresh built-in config/probes and continuous official metadata/checksum/installer requests, system proxy precedence, shared session-only switches, busy locking, restart default, failed-hash cleanup, safe preparation failure and cached retry. Real native replacement is tested separately.');
  } finally {
    if (application) await application.close();
    await fs.rm(temporary, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
