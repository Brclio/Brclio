'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { _electron: electron, expect } = require('@playwright/test');
const { program } = require('../desktop/terminal/tmux-launch.cjs');

async function main() {
  const binary = program(process.platform, process.env);
  assert.ok(process.platform === 'darwin' && binary, '该桌面用例需要 macOS 和本机 tmux');
  const root = path.resolve(__dirname, '..');
  const temporary = await fs.mkdtemp('/tmp/brclio-tmux-ui-');
  const env = { ...process.env, BRCLIO_USER_DATA: path.join(temporary, 'appdata'), TMUX_TMPDIR: temporary,
    ZDOTDIR: temporary, HISTFILE: path.join(temporary, 'history'), HOME: temporary };
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
    try { execFileSync(binary, ['kill-server'], { env, stdio: 'ignore' }); } catch {}
    await fs.rm(temporary, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
