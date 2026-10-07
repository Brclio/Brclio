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
    await application.evaluate(({ net, shell }, fixture) => {
      const payload = new TextEncoder().encode(fixture.text);
      const hash = fixture.hash;
      const assetName = `Brclio-${fixture.version}-mac-${fixture.architecture}.dmg`;
      const prefix = `https://github.com/Brclio/Brclio/releases/download/v${fixture.version}/`;
      const release = { tag_name: `v${fixture.version}`, draft: false, prerelease: false, body: '原生 UI 更新验证。', assets: [
        { name: assetName, size: payload.length, browser_download_url: prefix + assetName, digest: `sha256:${hash}` },
        { name: 'SHA256SUMS.txt', size: 100, browser_download_url: prefix + 'SHA256SUMS.txt' },
      ] };
      globalThis.__updateSmoke = { corrupted: true, calls: [], opened: [] };
      net.fetch = async url => {
        globalThis.__updateSmoke.calls.push(url);
        if (url.includes('/releases/latest')) return new Response(JSON.stringify(release));
        if (url.endsWith('SHA256SUMS.txt')) return new Response(`${hash}  ${assetName}\n`);
        const body = globalThis.__updateSmoke.corrupted ? new Uint8Array(payload.length).fill(120) : payload;
        let offset = 0;
        const stream = new ReadableStream({ async pull(controller) {
          await new Promise(resolve => setTimeout(resolve, 30));
          if (offset >= body.length) { controller.close(); return; }
          controller.enqueue(body.subarray(offset, offset + 64 * 1024)); offset += 64 * 1024;
        } });
        return new Response(stream);
      };
      shell.openPath = async filename => { globalThis.__updateSmoke.opened.push(filename); return ''; };
    }, { text: fixtureText, hash: crypto.createHash('sha256').update(fixtureText).digest('hex'), architecture: process.arch, version: updateVersion });
    await page.click('[data-view="settings"]');
    await page.click('#check-update');
    await expect(page.locator('#update-status-title')).toHaveText(`v${updateVersion} 已经准备好。`);
    assert.equal(await application.evaluate(() => globalThis.__updateSmoke.calls.length), 1);
    await page.click('#download-update');
    await expect(page.locator('#update-progress')).toBeVisible();
    await expect(page.locator('#update-status-title')).toHaveText('这次更新未完成，可以重试。');
    await expect(page.locator('#update-status-detail')).toContainText('SHA256 校验失败');
    assert.equal(await application.evaluate(() => globalThis.__updateSmoke.opened.length), 0);
    const updates = path.join(temporary, 'updates');
    assert.deepEqual(await fs.readdir(updates), []);

    await application.evaluate(() => { globalThis.__updateSmoke.corrupted = false; });
    await page.click('#check-update');
    await expect(page.locator('#download-update')).toBeVisible();
    await page.click('#download-update');
    await expect(page.locator('#update-progress')).toBeVisible();
    await expect(page.locator('#update-status-title')).toHaveText('安装包已下载，校验通过。');
    await expect(page.locator('#install-update')).toHaveText('打开 DMG 安装');
    await expect(page.locator('#update-status-detail')).toContainText('拖入 Applications');
    await page.click('#install-update');
    await expect(page.locator('#update-status-title')).toHaveText('请在系统安装界面中继续。');
    assert.equal(await application.evaluate(() => globalThis.__updateSmoke.opened.length), 1);
    console.log('PASS native update IPC/UI: metadata-only check, streamed progress, failed-hash cleanup, retry, verified download and explicit manual DMG install (installer launch mocked).');
  } finally {
    if (application) await application.close();
    await fs.rm(temporary, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
