'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { _electron: electron, expect } = require('@playwright/test');
const { program } = require('../desktop/terminal/tmux-launch.cjs');

async function main() {
  const binary = program(process.platform, process.env);
  const windows = process.platform === 'win32';
  assert.ok(binary && (process.platform === 'darwin' || windows), '需要 macOS tmux 或 Windows WSL + tmux');
  const root = path.resolve(__dirname, '..');
  const temporary = await fs.mkdtemp(path.join(windows ? os.tmpdir() : '/tmp', 'brclio-tmux-ui-'));
  const socketDirectory = windows ? execFileSync(binary, ['--exec', 'mktemp', '-d', '/tmp/brclio-tmux-ui-XXXXXXXX'],
    { encoding: 'utf8', timeout: 30000 }).trim() : temporary;
  if (windows) assert.match(socketDirectory, /^\/tmp\/brclio-tmux-ui-[A-Za-z0-9]+$/);
  const env = { ...process.env, BRCLIO_USER_DATA: path.join(temporary, 'appdata'), TMUX_TMPDIR: socketDirectory,
    ZDOTDIR: temporary, HISTFILE: path.join(temporary, 'history'), HOME: temporary };
  if (windows) env.WSLENV = [...(env.WSLENV || '').split(':').filter(item => item && !/^TMUX_TMPDIR(?:\/|$)/i.test(item)), 'TMUX_TMPDIR'].join(':');
  const executable = process.env.BRCLIO_SMOKE_EXECUTABLE;
  let app;
  try {
    app = await electron.launch({ cwd: root, args: executable ? [] : [root], env,
      ...(executable ? { executablePath: path.resolve(executable) } : {}) });
    const main = await app.firstWindow();
    await main.waitForURL('file://**/web/index.html');
    const [page] = await Promise.all([app.waitForEvent('window'), main.evaluate(() => window.brclio.openTerminal('window'))]);
    await page.waitForURL('file://**/desktop/terminal/index.html');
    const connect = async () => {
      await page.locator('#terminal-actions').click();
      await page.locator('#tmux-name').fill('StandaloneUI');
      await page.locator('#tmux-connect').click();
    };
    await connect();
    const panes = page.locator('#tmux-panes .tmux-pane');
    await expect(panes).toHaveCount(1);
    await page.locator('#tmux-right').click();
    await expect(panes).toHaveCount(2);
    const target = panes.last();
    const targetID = await target.getAttribute('data-pane');
    await target.locator('textarea.xterm-helper-textarea').focus();
    await page.keyboard.type("printf 'UI-%s\\n' VERIFIED");
    await page.keyboard.press('Enter');
    await expect(target.locator('.xterm-rows')).toContainText('UI-VERIFIED');
    await expect(panes.first().locator('.xterm-rows')).not.toContainText('UI-VERIFIED');
    await page.locator('#tmux-new').click();
    await expect(page.locator('#tmux-tabs button')).toHaveCount(2);
    await expect(panes).toHaveCount(3);
    await page.locator('#tmux-tabs button').last().click();
    await expect(page.locator('#tmux-panes .tmux-pane:visible')).toHaveCount(1);
    await page.locator('#tmux-detach').click();
    await expect(page.locator('#tmux-dialog')).not.toBeVisible();
    await connect();
    await expect(panes).toHaveCount(3);
    await page.locator('#tmux-tabs button').first().click();
    await expect(page.locator('.tmux-pane[data-pane="' + targetID + '"] .xterm-rows')).toContainText('UI-VERIFIED');
    await page.locator('#tmux-detach').click();
    console.log('Verified native tmux panes, independent terminal input, windows, detach and restore in Electron.');
  } finally {
    if (app) await app.close();
    try { execFileSync(binary, [...(windows ? ['--exec', 'tmux'] : []), 'kill-server'], { env, stdio: 'ignore' }); } catch {}
    if (windows) execFileSync(binary, ['--exec', 'rm', '-rf', '--', socketDirectory], { env, timeout: 15000 });
    await fs.rm(temporary, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
