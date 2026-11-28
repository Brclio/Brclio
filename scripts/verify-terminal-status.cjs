'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { _electron: electron, expect } = require('@playwright/test');

async function verify(temporary, restarting) {
  const root = path.resolve(__dirname, '..');
  const executable = process.env.BRCLIO_SMOKE_EXECUTABLE;
  const windows = process.platform === 'win32';
  const env = { ...process.env, BRCLIO_USER_DATA: temporary };
  if (windows) delete env.PSModulePath;
  else Object.assign(env, { SHELL: '/bin/zsh', ZDOTDIR: temporary, HISTFILE: path.join(temporary, 'history') });
  const app = await electron.launch({ cwd: root, env, args: executable ? [] : [root],
    ...(executable ? { executablePath: path.resolve(executable) } : {}) });
  try {
    const home = await app.firstWindow();
    await home.locator('body[data-ready=true]').waitFor({ state: 'attached', timeout: 90000 });
    const opened = app.waitForEvent('window');
    await home.locator('.nav-item[data-open-terminal]').click();
    const term = await opened;
    const pane = term.locator('.pane.active:visible'), status = term.locator('#status-components');
    const field = name => term.locator('[data-status-field="' + name + '"]');
    async function settings() {
      await term.locator('#terminal-actions').click();
      await term.locator('#actions-filter').fill('状态栏组件');
    }
    async function type(line) {
      await expect(pane).toHaveAttribute('data-state', 'running', { timeout: 20000 });
      if (windows) await expect(pane.locator('.xterm-rows')).toContainText(/PS [^>]*>/, { timeout: 20000 });
      await pane.locator('textarea').focus();
      await term.keyboard.type(line);
      await term.keyboard.press('Enter');
    }
    async function announce(directory, code) {
      await type(windows
        ? "[Console]::Write(([char]27).ToString()+']1337;CurrentDir=" + directory + "'+[char]7+[char]27+']133;D;" + code + "'+[char]7)"
        : "printf '\\033]1337;CurrentDir=" + directory + "\\007\\033]133;D;" + code + "\\007'");
      await expect(status).toContainText(directory);
      await expect(status).toContainText('命令退出码 ' + code);
    }
    await expect(pane).toHaveAttribute('data-state', 'running', { timeout: 20000 });
    if (restarting) {
      await expect(status).toContainText(/会话 1.*\d+ × \d+.*\d{1,2}:\d{2}/);
      await settings();
      await expect(field('session')).toBeChecked();
      await expect(field('pid')).not.toBeChecked();
      await term.locator('#actions-close').click();
      await type('exit 23');
      await expect(status).toContainText('会话退出码 23', { timeout: 20000 });
      await settings();
      await term.locator('#status-default').click();
      await term.locator('#actions-close').click();
      await expect(status).toBeHidden();
      await expect(term.locator('#status')).toHaveText('已退出 · 退出码 23');
    } else {
      await expect(status).toBeHidden();
      await expect(term.locator('#status')).toBeVisible();
      await settings();
      for (const id of ['session', 'size', 'clock']) await field(id).check();
      await field('pid').uncheck();
      await term.locator('#actions-close').click();
      await expect(status).toContainText(/会话 1.*\d+ × \d+.*\d{1,2}:\d{2}/);
      const first = await pane.getAttribute('data-id');
      await announce('/brclio-status-one', 17);
      await term.locator('#split-right').click();
      await announce('/brclio-status-two', 8);
      await term.locator('.pane[data-id="' + first + '"] textarea').focus();
      await expect(status).toContainText('/brclio-status-one');
      await expect(status).toContainText('命令退出码 17');
      await expect(status).not.toContainText('PID');
    }
  } finally { await app.close(); }
}

(async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'brclio-terminal-status-'));
  try {
    await verify(directory, false);
    await verify(directory, true);
    console.log('Verified status components, pane switches, PTY exit and persistence across two desktop launches.');
  } finally { await fs.rm(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
