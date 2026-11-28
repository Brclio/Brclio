'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {_electron:electron,expect} = require('@playwright/test');

async function verify(executablePath) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(),'brclio-preview-smoke-'));
  const releasePath = path.join(temp,'release-profile');
  let app;
  try {
    app = await electron.launch({executablePath,args:[],env:{...process.env,BRCLIO_PREVIEW_DATA_ROOT:temp,
      BRCLIO_USER_DATA:releasePath,ZDOTDIR:temp,HISTFILE:path.join(temp,'shell-history')}});
    const home = await app.firstWindow();
    await home.waitForURL('file://**/web/index.html',{timeout:60000});
    await expect(home.locator('#view-terminal')).toBeVisible({timeout:60000});
    const homeWindow = await app.browserWindow(home);
    await homeWindow.evaluate(win => win.setContentSize(1220,850));
    const footer = home.locator('.platform-status');
    await expect(footer).toBeInViewport({ratio:1});
    await expect.poll(() => footer.evaluate(row =>
      Math.abs(innerHeight-row.getBoundingClientRect().bottom-parseFloat(getComputedStyle(row.closest('.app-sidebar')).paddingBottom))
    )).toBeLessThan(0.5);
    const terminalPage = () => app.windows().find(page => page.url().endsWith('/desktop/terminal/index.html'));
    await expect.poll(() => Boolean(terminalPage()),{timeout:30000}).toBe(true);
    const terminal = terminalPage(), pane = terminal.locator('.pane.active:visible');
    const windowCount = () => app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows().length);
    await expect.poll(windowCount).toBe(1);
    await expect(pane).toHaveAttribute('data-state','running',{timeout:20000});
    const session = await pane.getAttribute('data-id');
    for (const width of [800, 1220]) {
      await homeWindow.evaluate((win, width) => win.setContentSize(width, 850), width);
      await terminal.locator('#quick-ssh').click();
      await expect.poll(() => terminal.evaluate(() => {
        const rect = id => document.getElementById(id).getBoundingClientRect();
        const panel = rect('workspace-drawer'), screen = rect('workspace');
        const separate = innerWidth > 620 ? panel.right <= screen.left + 1 : panel.bottom <= screen.top + 1;
        return separate && screen.width >= 200 && screen.height >= 150 && panel.width > 100 &&
          screen.right <= innerWidth && screen.bottom <= innerHeight;
      })).toBe(true);
      await expect(footer).toBeInViewport({ratio:1});
      await expect(terminal.locator('dialog[open]')).toHaveCount(0);
    }
    await expect(terminal.locator('#workspace-hosts')).toBeVisible();
    await terminal.getByRole('button', {name:'常用命令', exact:true}).click();
    await expect(terminal.locator('#workspace-commands')).toBeVisible();
    await expect(terminal.locator('#command-library-query')).toBeFocused();
    await terminal.getByRole('button', {name:'外观', exact:true}).click();
    await expect(terminal.locator('#workspace-appearance')).toBeVisible();
    await expect(terminal.locator('#preset-theme')).toBeFocused();
    await expect(terminal.locator('#preset-preview')).toBeVisible();
    await expect(terminal.locator('dialog[open]')).toHaveCount(0);
    const windows = process.platform === 'win32';
    await expect(pane.locator('.xterm-rows')).toContainText(windows ? /PS [^>]*>/ : /[%#$]/,{timeout:20000});
    await pane.locator('textarea').focus();
    await terminal.keyboard.type(windows ? "[Console]::WriteLine(('PREVIEW-' + 'READY'))" : "printf 'PREVIEW-%s\\n' READY");
    await terminal.keyboard.press('Enter');
    await expect(pane.locator('.xterm-rows')).toContainText('PREVIEW-READY');
    await expect(terminal.locator('#workspace-appearance')).toBeVisible();
    await terminal.locator('#presentation').click();
    await expect.poll(windowCount).toBe(2);
    await terminal.locator('#presentation').click();
    await expect.poll(windowCount).toBe(1);
    await expect(pane).toHaveAttribute('data-id',session);
    await expect(pane.locator('.xterm-rows')).toContainText('PREVIEW-READY');
    await terminal.locator('#workspace-collapse').click();
    await expect(terminal.locator('#workspace-drawer')).toBeHidden();
    const result = await app.evaluate(({app,globalShortcut}) => ({
      title:app.getName(),data:app.getPath('userData'),hotkey:globalShortcut.isRegistered('Alt+P'),
    }));
    assert.equal(result.title,'Brclio Terminal Preview');
    assert.equal(result.data,path.join(temp,'com.brclio.toolbox.terminal-preview'));
    assert.equal(result.hotkey,false);
    assert.equal((await home.evaluate(() => window.brclio.getPlatform())).capabilities.systemIntegration,false);
    assert.equal((await home.evaluate(() => window.brclio.getIntegrationStatus())).supported,false);
    assert.equal((await home.evaluate(() => window.brclio.getShortcutStatus())).supported,false);
    // The staged application must explicitly reject all five paths before they reach an OS service.
    for (const command of ['setIntegration','checkForUpdates','downloadUpdate','installUpdate']) {
      await assert.rejects(home.evaluate(name => window.brclio[name](true),command),/终端预览版/);
    }
    await assert.rejects(home.evaluate(async () => {
      const settings = await window.brclio.getSettings();
      return window.brclio.saveSettings({...settings,launchAtLogin:!settings.launchAtLogin});
    }),/终端预览版/);
    assert.equal(await fs.stat(releasePath).then(() => true,() => false),false);
  } finally {
    await app?.close();
    await fs.rm(temp,{recursive:true,force:true});
  }
}
module.exports = {verify};
