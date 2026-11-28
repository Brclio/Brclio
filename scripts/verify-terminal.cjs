'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { _electron: electron, expect } = require('@playwright/test');
const { verifyTerminalOutput, verifyShellImages } = require('./verify-terminal-output.cjs');
const { verifyTerminalDevices } = require('./verify-terminal-devices.cjs');
const { verifyDynamicProfiles } = require('./verify-terminal-dynamic.cjs');
const { verifyTerminalHistory } = require('./verify-terminal-history.cjs');
const { verifyPaneTools } = require('./verify-terminal-panes.cjs');

async function main() {
  const root = path.resolve(__dirname, '..');
  const windows = process.platform === 'win32';
  assert.ok(windows || process.platform === 'darwin', 'Use Windows or macOS for the native terminal test.');
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'brclio-terminal-'));
  const executable = process.env.BRCLIO_SMOKE_EXECUTABLE;
  const env = { ...process.env, BRCLIO_USER_DATA: temporary };
  if (windows) {
    // Model an Explorer launch. A CI PowerShell 7 parent exports its own module
    // search path; Windows PowerShell 5 must discover its inbox modules.
    delete env.PSModulePath;
  } else {
    Object.assign(env, { SHELL: '/bin/zsh', ZDOTDIR: temporary, HISTFILE: path.join(temporary, 'history') });
  }
  let app;
  try {
    app = await electron.launch({
      cwd: root, args: executable ? [] : [root], ...(executable ? { executablePath: path.resolve(executable) } : {}),
      env, timeout: 45000,
    });
    const home = await app.firstWindow();
    await home.waitForURL('file://**/web/index.html', { waitUntil: 'domcontentloaded', timeout: 60000 });
    // Cold Windows runners may still be querying Explorer integration and shortcut state.
    await home.locator('body[data-ready="true"]').waitFor({ state: 'attached', timeout: 90000 });
    assert.equal(await home.locator('body').getAttribute('data-initialized'), 'true',
      'Brclio initialization: ' + await home.locator('#toast span').textContent());
    if (executable) assert.equal((await home.evaluate(() => window.brclio.getPlatform())).packaged, true);
    assert.equal(await home.evaluate(() => typeof window.brclioTerminal), 'undefined');
    const mainWindow = await app.browserWindow(home);
    const originalWindowSize = await mainWindow.evaluate(win => win.getContentSize());
    await mainWindow.evaluate(win => win.setContentSize(800, 765));
    const statusRow = home.locator('.platform-status');
    await expect(statusRow).toBeInViewport({ ratio: 1 });
    await expect.poll(() => statusRow.evaluate(row => {
      const bottomPadding = parseFloat(getComputedStyle(row.closest('.app-sidebar')).paddingBottom);
      return Math.abs(innerHeight - row.getBoundingClientRect().bottom - bottomPadding);
    })).toBeLessThan(0.5);
    const statusBeforeScrolling = await statusRow.boundingBox();
    await home.locator('.nav-main').evaluate(nav => { nav.scrollTop = nav.scrollHeight; });
    assert.deepEqual(await statusRow.boundingBox(), statusBeforeScrolling, 'The version row stays anchored as tools scroll');
    await home.locator('#about-button').click();
    await expect(home.locator('#about-dialog')).toBeVisible();
    await home.locator('#about-dialog [data-close]').first().click();
    await mainWindow.evaluate((win, dimensions) => win.setContentSize(...dimensions), originalWindowSize);
    await home.locator('#manual-paths').fill('Brclio terminal smoke');
    await home.locator('#open-search').click();
    await home.locator('#global-search').fill('分');
    await home.locator('#global-search').press('Enter');
    await expect(home.locator('#view-suggestions')).toBeVisible();
    assert.equal(app.windows().length, 1, 'Existing search results keep their Enter shortcut');
    await home.locator('.nav-item[data-view=copy]').click();
    await home.locator('#open-search').click();
    await home.locator('#global-search').fill('powershell');
    await expect(home.locator('#search-terminal')).toBeVisible();
    const windowPromise = app.waitForEvent('window');
    await home.locator('#global-search').press('Enter');
    const terminal = await windowPromise;
    await terminal.waitForURL('file://**/desktop/terminal/index.html');
    await verifyTerminalOutput(terminal);
    const countWindows = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
    const inlineVisible = () => mainWindow.evaluate(win => win.contentView.children.some(view =>
      view.webContents?.getURL().endsWith('/desktop/terminal/index.html') && view.getVisible()));
    await expect.poll(countWindows).toBe(1);
    await expect.poll(inlineVisible).toBe(true);
    const active = terminal.locator('.pane.active:visible');
    const tabs = terminal.locator('#tabs [role=tab]');
    await expect(tabs).toHaveCount(1);
    assert.equal(await terminal.evaluate(() => typeof window.brclio), 'undefined');
    const rows = pane => pane.locator('.xterm-rows');
    const initialized = new Set();
    const command = async line => {
      await expect.poll(async () => {
        const state = await active.getAttribute('data-state');
        return state === 'error' ? await active.locator('.pane-message').innerText() : state;
      }, { timeout: 15000, message: 'The local shell must start successfully' }).toBe('running');
      const id = await active.getAttribute('data-id');
      if (windows && !initialized.has(id)) {
        await expect(rows(active)).toContainText(/PS [^>]*>/, { timeout: 20000 });
        initialized.add(id);
      }
      await active.locator('textarea.xterm-helper-textarea').focus();
      await terminal.keyboard.type(line);
      await terminal.keyboard.press('Enter');
    };
    await terminal.locator('#new-tab').click();
    await verifyShellImages(terminal, command, windows);
    await verifyTerminalDevices(app, terminal, command, windows);
    await verifyDynamicProfiles(app, terminal);
    await verifyTerminalHistory(app, terminal, command);
    await verifyPaneTools(terminal, command, windows);
    await terminal.locator('#tabs .tab:has([aria-selected=true]) .tab-close').click();
    // The complete marker occurs only in shell output, never in the echoed input.
    await command(windows
      ? "[Console]::WriteLine(('BRCLIO-' + 'TTY-' + $Host.UI.RawUI.WindowSize.Width))"
      : "test -t 0 && test -t 1 && printf 'BRCLIO-%s%s\\n' TTY- \"$(tput cols)\"");
    await expect(rows(active)).toContainText(/BRCLIO-TTY-[1-9]\d*/, { timeout: 20000 });
    const width = async () => await command(windows
      ? "[Console]::WriteLine(('COLUMNS-' + $Host.UI.RawUI.WindowSize.Width))"
      : "printf 'COL%s-%s\\n' UMNS \"$(tput cols)\"");
    const originalSize = Number((await rows(active).innerText()).match(/BRCLIO-TTY-(\d+)/)[1]);

    const sessionId = await active.getAttribute('data-id');
    await home.locator('#about-button').click();
    await expect.poll(inlineVisible).toBe(false);
    await home.locator('#about-dialog [data-close]').first().click();
    await expect.poll(inlineVisible).toBe(true);
    await home.locator('.nav-item[data-view=copy]').click();
    await expect.poll(inlineVisible).toBe(false);
    await expect(home.locator('#manual-paths')).toHaveValue('Brclio terminal smoke');
    await home.locator('[data-open-terminal].nav-item').click();
    await expect.poll(inlineVisible).toBe(true);
    await terminal.locator('#presentation').click();
    await expect.poll(countWindows).toBe(2);
    await expect.poll(inlineVisible).toBe(false);
    await expect(terminal.locator('#presentation')).toHaveText('收回主窗口');
    await terminal.locator('#presentation').click();
    await expect.poll(countWindows).toBe(1);
    await expect.poll(inlineVisible).toBe(true);
    await expect(active).toHaveAttribute('data-id', sessionId);
    await expect(rows(active)).toContainText('BRCLIO-TTY-');
    await terminal.locator('#split-right').click();
    await expect(terminal.locator('.pane:visible')).toHaveCount(2);
    await width();
    await expect(rows(active)).toContainText(/COLUMNS-[1-9]\d*/, { timeout: 20000 });
    const splitSize = Number((await rows(active).innerText()).match(/COLUMNS-(\d+)/)[1]);
    assert.ok(splitSize < originalSize, 'The shell must see the narrower PTY after splitting');
    await terminal.locator('#split-down').click();
    await expect(terminal.locator('.pane:visible')).toHaveCount(3);
    await terminal.locator('#close-pane').click();
    await expect(terminal.locator('.pane:visible')).toHaveCount(2);
    await terminal.locator('#new-tab').click();
    await expect(tabs).toHaveCount(2);
    await expect(terminal.locator('.pane:visible')).toHaveCount(1);
    await tabs.first().click();
    await expect(terminal.locator('.pane:visible')).toHaveCount(2);
    await terminal.locator('.pane:visible').first().locator('.xterm-screen').click();
    await expect(rows(active)).toContainText('BRCLIO-TTY-');
    await terminal.locator('#find').click();
    await terminal.locator('#find-input').fill('BRCLIO-TTY-');
    await terminal.locator('#find-next').click();
    await expect(terminal.locator('#find-result')).toHaveText(/1\s*\/\s*[1-9]/);
    await terminal.locator('#find-input').press('Escape');

    await command(windows
      ? "[Console]::WriteLine(('WAITING-' + 'READY')); Start-Sleep -Seconds 90"
      : "sh -c 'printf \"WAITING-%s\\n\" READY; exec sleep 90'");
    await expect(rows(active)).toContainText('WAITING-READY', { timeout: 10000 });
    await terminal.keyboard.press('Control+c');
    await expect.poll(async () => (await rows(active).innerText()).split('WAITING-READY').at(-1).trimEnd(),
      { timeout: 15000 }).toMatch(windows ? /PS [^>]*>$/ : /[%$#]$/);
    await command(windows ? "[Console]::WriteLine(('INTERRUPT-' + 'OK'))" : "printf 'INTERRUPT-%s\\n' OK");
    await expect(rows(active)).toContainText('INTERRUPT-OK', { timeout: 15000 });
    await require('./verify-terminal-alerts.cjs').verifyTerminalAlerts(app, terminal, command, windows);
    await require('./verify-terminal-vault.cjs').verifyTerminalVault(app, terminal, command, windows);
    await require('./verify-terminal-profile.cjs').verifyProfileAndSearch(terminal);
    await require('./verify-terminal-workspace-tools.cjs').verifyWorkspaceTools(terminal, command, windows);
    await require('./verify-terminal-host-library.cjs').verifyHostLibrary(terminal);
    await require('./verify-terminal-center.cjs').verifyConnectionCenter(terminal);
    await require('./verify-terminal-forwarding.cjs').verifyForwarding(terminal);
    await require('./verify-terminal-forwarding.cjs').verifyIdentity(terminal, app, temporary);
    await require('./verify-terminal-sftp.cjs').verifySftpHelper(app);
    await require('./verify-terminal-sftp.cjs').verifySftpEntry(terminal);
    await terminal.locator('#terminal-actions').click();
    await terminal.locator('#trigger-pattern').fill('^BRCLIO-TRIGGER-OK');
    await terminal.locator('#trigger-add').click();
    await terminal.locator('#actions-close').click();
    await command(windows ? "[Console]::WriteLine(('BRCLIO-TRIGGER-' + 'OK'))" : "printf 'BRCLIO-TRIGGER-%s\\n' OK");
    await expect(active.locator('.xterm-decoration').filter({ visible: true }).first()).toBeVisible();
    await terminal.locator('#presentation').click();
    await expect.poll(countWindows).toBe(2);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.getTitle() === 'Brclio 终端').close());
    await expect.poll(countWindows).toBe(1);
    await home.locator('.nav-item[data-view=copy]').click();
    await expect(home.locator('#manual-paths')).toHaveValue('Brclio terminal smoke');
    const reopened = app.waitForEvent('window');
    await home.locator('[data-view="tools"]').first().click();
    await home.locator('#tool-filter').fill('终端');
    await home.locator('#terminal-card').click();
    const fresh = await reopened;
    await expect(fresh.locator('#tabs [role=tab]')).toHaveCount(1);
    await expect(fresh.locator('.pane')).toHaveCount(1);
    await expect(fresh.locator('#preset-name')).toHaveValue('QA profile');
    if (!windows) {
      await fresh.locator('#presentation').click();
      await expect.poll(countWindows).toBe(2);
      await home.close();
      const copyResult = await app.evaluate(async ({ app, clipboard }, selectedPath) => {
        const writeText = clipboard.writeText;
        let timer;
        try {
          const copiedText = new Promise((resolve, reject) => {
            // Exercise Finder dispatch without changing the user's clipboard.
            clipboard.writeText = resolve;
            timer = setTimeout(() => reject(new Error('Finder did not copy the selection')), 5000);
          });
          const payload = Buffer.from(JSON.stringify([selectedPath])).toString('base64url');
          app.emit('open-url', { preventDefault() {} }, 'brclio://copy-path?payload=' + payload);
          return { text: await copiedText, dockVisible: app.dock.isVisible() };
        } finally {
          clearTimeout(timer);
          clipboard.writeText = writeText;
        }
      }, temporary);
      assert.ok(copyResult.text.includes(path.basename(temporary)), 'Finder still copies the selected directory');
      assert.equal(copyResult.dockVisible, true, 'Keep the terminal accessible from the Dock when it is the only window');
    }
    console.log(`Verified Brclio terminal (${process.platform}/${process.arch}, ${executable ? 'packaged' : 'development'}), PTY columns ${originalSize} → ${splitSize}.`);
  } finally {
    try { if (app) await app.close(); }
    finally { await fs.rm(temporary, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }); }
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
