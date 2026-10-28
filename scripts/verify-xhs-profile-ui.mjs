import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from '@playwright/test';

// Use the production page and renderer, with a deterministic native host so a
// delayed queue snapshot can race a real directory-picker button interaction.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const web = path.join(root, 'web');
const output = path.join(root, 'artifacts');
const report = { passed: false, checks: [], screenshots: [], errors: [] };
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.wasm': 'application/wasm' };
const profileUrl = 'https://www.xiaohongshu.com/user/profile/' + 'b'.repeat(24);
const directoryA = '/tmp/Brclio-XHS-A';
const directoryB = '/tmp/Brclio-XHS-B';
const server = http.createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    if (pathname === '/api/account/session') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ user: null, googleEnabled: false })); return;
    }
    const target = path.resolve(web, '.' + (pathname === '/' ? '/index.html' : pathname));
    if (!target.startsWith(web + path.sep)) { response.writeHead(403); response.end(); return; }
    const content = await readFile(target);
    response.writeHead(200, { 'Content-Type': types[path.extname(target)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    response.end(content);
  } catch { response.writeHead(404); response.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;

async function choose(page, directory) {
  await page.evaluate(directory => { window.__chosenDirectory = directory; }, directory);
  await page.locator('#xhs-choose-directory').click();
  await expect(page.locator('#xhs-choose-directory')).toBeEnabled();
  if (directory) await expect(page.locator('#xhs-directory')).toHaveText(directory);
}
async function emit(page, fields) {
  await page.evaluate(fields => {
    window.__profile = { ...window.__profile, ...fields };
    window.__profileEmit({ type: 'profile', state: structuredClone(window.__profile) });
  }, fields);
}
async function oldError(page) {
  await page.evaluate(() => { window.__failOpenDirectory = true; });
  await page.locator('#xhs-open-directory').click();
  await expect(page.locator('#xhs-message.error')).toHaveText('测试旧目录错误');
}
async function holdProfileRead(page) {
  await page.evaluate(() => {
    window.__holdProfileRead = true;
    window.dispatchEvent(new CustomEvent('brclio:view', { detail: { name: 'xhs' } }));
  });
  await page.waitForFunction(() => typeof window.__pendingProfileRead === 'function');
}
async function releaseProfileRead(page) {
  await page.evaluate(async () => {
    window.__pendingProfileRead();
    // Drain the resolved native request and the refresh's Promise.allSettled.
    await new Promise(resolve => setTimeout(resolve, 0));
  });
}

try {
  await mkdir(output, { recursive: true });
  browser = await chromium.launch({ executablePath: process.env.BRCLIO_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1060 } });
  page.setDefaultTimeout(15000);
  page.on('pageerror', error => report.errors.push(error.message));
  await page.route('**/bridge.js', async route => {
    const response = await route.fetch();
    await route.fulfill({ response, body: await response.text() + `
      window.__profileCalls = [];
      window.__profile = { status: 'idle', directory: '', profileUrl: '', intervalSeconds: 10, jitterSeconds: 3, items: [] };
      window.__chosenDirectory = null;
      window.__profileEmit = null;
      window.__holdProfileRead = false;
      window.__pendingProfileRead = null;
      window.__failOpenDirectory = false;
      window.brclio = {
        ...window.BrclioHost,
        getPlatform: async () => ({ platform: 'darwin', version: '0.2.3' }),
        onXhsEvent(callback) { window.__profileEmit = callback; },
        async xhsRequest(action, input = {}) {
          window.__profileCalls.push({ action, input: structuredClone(input) });
          if (action === 'loginState') return { status: 'unknown' };
          if (action === 'profileState') {
            const snapshot = structuredClone(window.__profile);
            if (window.__holdProfileRead) {
              window.__holdProfileRead = false;
              return new Promise(resolve => { window.__pendingProfileRead = () => { window.__pendingProfileRead = null; resolve(snapshot); }; });
            }
            return snapshot;
          }
          if (action === 'chooseDirectory') return window.__chosenDirectory;
          if (action === 'openDirectory') {
            if (window.__failOpenDirectory) { window.__failOpenDirectory = false; throw new Error('测试旧目录错误'); }
            return true;
          }
          if (action === 'startProfile') {
            window.__profile = { ...input, status: 'downloading', items: [{ id: 'a'.repeat(24), title: '等待下载的笔记', status: 'pending' }] };
            return structuredClone(window.__profile);
          }
          if (action === 'pauseProfile') window.__profile.status = 'paused';
          if (['resumeProfile', 'retryFailed', 'retryItem'].includes(action)) window.__profile.status = 'downloading';
          if (['pauseProfile', 'resumeProfile', 'retryFailed', 'retryItem'].includes(action)) return structuredClone(window.__profile);
          return { ok: true };
        }
      };
      window.BrclioHost = window.brclio;
    ` });
  });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.waitForFunction(() => document.body.dataset.ready === 'true');
  assert.equal(await page.evaluate(() => window.__profileCalls.length), 0);
  await page.locator('[data-view="xhs"]').first().click();
  await page.waitForFunction(() => window.__profileCalls.some(call => call.action === 'profileState'));
  await page.locator('#xhs-tab-profile').click();
  await page.locator('#xhs-profile-url').fill(profileUrl);

  await page.locator('#xhs-profile-start').click();
  await expect(page.locator('#xhs-message.error')).toHaveText('请先选择保存目录。');
  assert.equal(await page.evaluate(() => window.__profileCalls.some(call => call.action === 'startProfile')), false);
  await choose(page, directoryA);
  await expect(page.locator('#xhs-message')).not.toHaveClass(/error/);
  await expect(page.locator('#xhs-message')).not.toContainText('请先选择保存目录');
  await oldError(page);
  await page.locator('#xhs-profile-start').click();
  await expect(page.locator('#xhs-profile-status')).toHaveText('正在下载');
  await expect(page.locator('#xhs-choose-directory')).toBeDisabled();
  await expect(page.locator('#xhs-message')).toBeHidden();
  assert.equal(await page.evaluate(() => window.__profileCalls.filter(call => call.action === 'startProfile').at(-1).input.directory), directoryA);
  report.checks.push('A missing-directory submission makes no start request; choosing an OS-returned directory removes the stale error, and a successful start clears old errors and sends the displayed path.');

  await emit(page, { status: 'paused', directory: directoryA });
  await expect(page.locator('#xhs-choose-directory')).toBeEnabled();
  await holdProfileRead(page);
  await choose(page, directoryB);
  await releaseProfileRead(page);
  await expect(page.locator('#xhs-profile-status')).toHaveText('已暂停');
  await expect(page.locator('#xhs-directory')).toHaveText(directoryB);
  await emit(page, { status: 'idle', directory: directoryA });
  await expect(page.locator('#xhs-directory')).toHaveText(directoryB);
  await emit(page, { status: 'paused', directory: directoryA });
  await expect(page.locator('#xhs-directory')).toHaveText(directoryB);
  await choose(page, null);
  await expect(page.locator('#xhs-directory')).toHaveText(directoryB);
  await page.locator('#xhs-profile-start').click();
  await expect(page.locator('#xhs-profile-status')).toHaveText('正在下载');
  assert.equal(await page.evaluate(() => window.__profileCalls.filter(call => call.action === 'startProfile').at(-1).input.directory), directoryB);
  report.checks.push('A late native state read and idle/paused queue events cannot overwrite a newly chosen directory; cancelling the picker preserves it and the next start uses it.');

  await emit(page, { status: 'paused', directory: directoryA });
  await holdProfileRead(page);
  await choose(page, directoryB);
  await page.locator('#xhs-profile-start').click();
  await expect(page.locator('#xhs-profile-status')).toHaveText('正在下载');
  await releaseProfileRead(page);
  await expect(page.locator('#xhs-directory')).toHaveText(directoryB);
  await expect(page.locator('#xhs-profile-status')).toHaveText('正在下载');
  await expect(page.locator('#xhs-profile-start')).toBeDisabled();

  await emit(page, { status: 'paused', directory: directoryA });
  await holdProfileRead(page);
  await page.locator('#xhs-profile-resume').click();
  await expect(page.locator('#xhs-profile-status')).toHaveText('正在下载');
  await releaseProfileRead(page);
  await expect(page.locator('#xhs-directory')).toHaveText(directoryA);
  await expect(page.locator('#xhs-profile-status')).toHaveText('正在下载');
  await expect(page.locator('#xhs-profile-resume')).toBeDisabled();

  await emit(page, { status: 'paused', directory: directoryA });
  await holdProfileRead(page);
  await emit(page, { status: 'downloading', directory: directoryB });
  await releaseProfileRead(page);
  await expect(page.locator('#xhs-directory')).toHaveText(directoryB);
  await expect(page.locator('#xhs-profile-status')).toHaveText('正在下载');
  await expect(page.locator('#xhs-choose-directory')).toBeDisabled();
  report.checks.push('A state read begun before starting a new job, resuming a paused job, or receiving a newer native event cannot revert the active queue or its actual directory.');

  for (const [button, action] of [['xhs-profile-resume', 'resumeProfile'], ['xhs-profile-retry', 'retryFailed']]) {
    await emit(page, { status: 'paused', directory: directoryA, items: [{ id: 'a'.repeat(24), title: '可重试笔记', status: 'failed', error: '测试失败项' }] });
    await choose(page, directoryB);
    await oldError(page);
    await page.locator('#' + button).click();
    await expect(page.locator('#xhs-profile-status')).toHaveText('正在下载');
    await expect(page.locator('#xhs-directory')).toHaveText(directoryA);
    await expect(page.locator('#xhs-message')).toBeHidden();
    const call = await page.evaluate(action => window.__profileCalls.filter(call => call.action === action).at(-1), action);
    assert.ok(call, action + ' must reach the native queue');
    assert.equal(call.input.directory, undefined, 'continuation must retain the existing native job root');
  }
  report.checks.push('Resume and retry continue the authoritative native job directory, restore that directory in the form, and clear obsolete errors.');

  await emit(page, { status: 'paused', directory: directoryA });
  await choose(page, directoryB);
  await oldError(page);
  await page.locator('#xhs-profile-items').getByRole('button', { name: '重试', exact: true }).click();
  await expect(page.locator('#xhs-profile-status')).toHaveText('正在下载');
  await expect(page.locator('#xhs-directory')).toHaveText(directoryA);
  await expect(page.locator('#xhs-message')).toBeHidden();
  assert.equal(await page.evaluate(() => window.__profileCalls.filter(call => call.action === 'retryItem').at(-1).input.noteId), 'a'.repeat(24));
  report.checks.push('An individual failed-item retry also restores the existing queue directory and clears the old error.');

  await page.reload();
  await page.waitForFunction(() => document.body.dataset.ready === 'true');
  await page.evaluate(({ directory, profileUrl }) => {
    window.__profile = { ...window.__profile, status: 'paused', directory, profileUrl,
      items: [{ id: 'a'.repeat(24), title: '已恢复的笔记队列', status: 'pending' }] };
    window.__holdProfileRead = true;
  }, { directory: directoryA, profileUrl });
  await page.locator('[data-view="xhs"]').first().click();
  await page.waitForFunction(() => typeof window.__pendingProfileRead === 'function');
  await page.locator('#xhs-tab-profile').click();
  await choose(page, directoryB);
  await releaseProfileRead(page);
  await expect(page.locator('#xhs-directory')).toHaveText(directoryB);
  await expect(page.locator('#xhs-profile-status')).toHaveText('已暂停');
  await expect(page.locator('#xhs-profile-url')).toHaveValue(profileUrl);
  await expect(page.locator('#xhs-profile-items li')).toHaveCount(1);
  await expect(page.locator('#xhs-profile-items')).toContainText('已恢复的笔记队列');
  report.checks.push('Choosing a new directory before the initial native read finishes preserves that selection while still restoring the saved queue, profile URL, and paused status.');

  await page.reload();
  await page.waitForFunction(() => document.body.dataset.ready === 'true');
  await page.evaluate(({ directory, profileUrl }) => {
    window.__profile = { ...window.__profile, status: 'paused', directory, profileUrl };
    window.__holdProfileRead = true;
  }, { directory: directoryA, profileUrl });
  await page.locator('[data-view="xhs"]').first().click();
  await page.waitForFunction(() => typeof window.__pendingProfileRead === 'function');
  await page.locator('#xhs-tab-profile').click();
  await page.locator('#xhs-profile-url').fill(profileUrl);
  await page.locator('#xhs-profile-start').click();
  await expect(page.locator('#xhs-message.error')).toHaveText('请先选择保存目录。');
  await releaseProfileRead(page);
  await expect(page.locator('#xhs-directory')).toHaveText(directoryA);
  await expect(page.locator('#xhs-profile-status')).toHaveText('已暂停');
  await expect(page.locator('#xhs-message')).toBeHidden();
  report.checks.push('A held initial native state read remains valid after an early missing-directory submission, restores the saved directory, and clears the obsolete validation error.');

  await page.evaluate(() => scrollTo(0, 0));
  const screenshot = 'xhs-profile-ui.png';
  await page.screenshot({ path: path.join(output, screenshot), fullPage: true });
  report.screenshots.push('artifacts/' + screenshot);
  assert.deepEqual(report.errors, []);
  report.passed = true;
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  report.failure = error.stack;
  throw error;
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
  await writeFile(path.join(output, 'xhs-profile-ui-verification.json'), JSON.stringify(report, null, 2) + '\n');
}
