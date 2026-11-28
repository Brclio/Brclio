'use strict';

const { expect } = require('@playwright/test');

async function verifyTerminalHistory(app, page, command) {
  const openHistory = async () => {
    await page.locator('#terminal-actions').click();
    await page.locator('#history-details summary').click();
  };
  // Replace the clipboard reader only inside this disposable Electron main
  // process. The smoke test does not read or modify the OS clipboard.
  const originalRead = await app.evaluateHandle(({ clipboard }) => clipboard.readText);
  try {
    await app.evaluate(({ clipboard }) => { clipboard.readText = () => 'paste-history-probe'; });
    await page.locator('#paste').click();
    await page.keyboard.press('Control+c');
    await openHistory();
    await expect(page.locator('#replay-record')).not.toBeChecked();
    await expect(page.locator('#paste-record')).not.toBeChecked();
    await expect(page.locator('#paste-list option')).toHaveCount(0);
    await page.locator('#replay-record').check();
    await page.locator('#paste-record').check();
    await page.locator('#actions-close').click();
    await command('echo BRCLIO-HISTORY-RECORDED');
    await page.locator('#paste').click();
    await page.keyboard.press('Control+c');
    await openHistory();
    await expect(page.locator('#replay-screen')).toContainText('BRCLIO-HISTORY-RECORDED');
    await expect(page.locator('#replay-position')).toBeEnabled();
    await expect(page.locator('#paste-list option')).toHaveText('paste-history-probe');
    await page.locator('#replay-record').uncheck();
    await page.locator('#paste-record').uncheck();
    await expect(page.locator('#replay-screen')).toHaveText('');
    await expect(page.locator('#paste-list option')).toHaveCount(0);
    await page.locator('#actions-close').click();
  } finally {
    await app.evaluate(({ clipboard }, read) => { clipboard.readText = read; }, originalRead);
    await originalRead.dispose();
  }
}

module.exports = { verifyTerminalHistory };
