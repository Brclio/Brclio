'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { expect } = require('@playwright/test');

async function verifyDynamicProfiles(app, page) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'brclio-dynamic-smoke-'));
  const file = path.join(dir, 'theme.json');
  const json = (name, size) => JSON.stringify({ Profiles: [{ Guid: 'test-guid', Name: name,
    Tags: ['Testing'], 'Normal Font': 'Consolas ' + size, Command: 'UNSUPPORTED' }] });
  const openDialog = await app.evaluateHandle(({ dialog }) => dialog.showOpenDialog);
  try {
    await fs.writeFile(file, json('Theme One', 17));
    await app.evaluate(({ dialog }, target) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [target] }); }, file);
    await page.locator('#new-tab').click();
    await page.locator('#terminal-actions').click();
    await page.locator('#dynamic-details summary').click();
    await page.locator('#dynamic-watch').check();
    await page.locator('#dynamic-import').click();
    await expect(page.locator('#dynamic-list option')).toContainText('Theme One');
    await page.locator('#dynamic-apply').click();
    const screen = page.locator('.pane.active:visible .xterm-rows');
    await expect.poll(() => screen.evaluate(node => getComputedStyle(node).fontSize)).toBe('17px');
    await fs.writeFile(file, 'incomplete');
    await expect(page.locator('#dynamic-status')).toContainText('保留上次配置');
    await expect(page.locator('#dynamic-list option')).toContainText('Theme One');
    const fresh = path.join(dir, 'replacement.json');
    await fs.writeFile(fresh, json('Theme Two', 21));
    await fs.rename(fresh, file);
    await expect(page.locator('#dynamic-list option')).toContainText('Theme Two');
    await expect.poll(() => screen.evaluate(node => getComputedStyle(node).fontSize)).toBe('21px');
    await page.locator('#dynamic-watch').uncheck();
    await page.locator('#actions-close').click();
    await page.locator('#tabs .tab:has([aria-selected=true]) .tab-close').click();
  } finally {
    await app.evaluate(({ dialog }, original) => { dialog.showOpenDialog = original; }, openDialog);
    await openDialog.dispose();
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

module.exports = { verifyDynamicProfiles };
