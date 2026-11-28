'use strict';

const { expect } = require('@playwright/test');

async function verifyRestoredProfile(page) {
  await expect(page.locator('#preset-theme')).toHaveValue('paper');
  await expect(page.locator('#preset-cursor')).toHaveValue('bar');
  await expect(page.locator('#preset-font')).toHaveValue('monospace');
  const pane = page.locator('.pane.active:visible');
  await expect(pane).toHaveCSS('background-color', 'rgb(250, 247, 238)');
  await expect(pane.locator('.xterm-rows')).toHaveCSS('font-size', '15px');
}

async function verifyProfileAndSearch(page) {
  await page.locator('#terminal-actions').click();
  await page.locator('#buffer-query').fill('BRCLIO-TTY-');
  await page.locator('#buffer-search').click();
  const result = page.locator('#buffer-results button').first();
  await expect(result).toContainText('BRCLIO-TTY-');
  await result.click();

  const pane = page.locator('.pane.active:visible');
  const session = await pane.getAttribute('data-id');
  await page.locator('#quick-appearance').click();
  await expect(page.locator('#workspace-appearance')).toBeVisible();
  await expect(page.locator('dialog:modal')).toHaveCount(0);
  const theme = page.locator('#preset-theme');
  await expect(theme).toBeFocused();
  await expect(theme).toHaveValue('brclio');
  await expect(theme.locator('option[value=custom]')).toHaveJSProperty('disabled', true);
  const font = page.locator('#preset-font-choice');
  await font.selectOption({ label: process.platform === 'win32' ? 'Consolas' : 'Menlo' });
  await expect(page.locator('#preset-preview')).toHaveCSS('font-family', /Consolas|Menlo/);
  await font.selectOption('custom');
  await page.locator('#preset-font').fill('monospace');
  await expect(page.locator('#preset-preview')).toHaveCSS('font-family', 'monospace');
  await page.locator('#appearance-presets > summary').click();
  await page.locator('#preset-name').fill('Imported QA');
  await page.locator('#preset-tags').fill('测试, local');
  await page.locator('#preset-size').fill('15');
  await page.locator('#appearance-advanced > summary').click();
  await page.locator('#preset-colors').setInputFiles({
    name: 'QA.itermcolors', mimeType: 'application/xml',
    buffer: Buffer.from('<plist><dict><key>Background Color</key><dict><key>Red Component</key><real>0.1</real><key>Green Component</key><real>0.2</real><key>Blue Component</key><real>0.4</real></dict></dict></plist>'),
  });
  await expect(page.locator('#preset-status')).toContainText('已读取配色');
  await expect(theme).toHaveValue('custom');
  await theme.selectOption('ocean');
  await expect(page.locator('#preset-preview')).toHaveCSS('background-color', 'rgb(16, 35, 55)');
  await theme.selectOption('custom');
  await expect(page.locator('#preset-preview')).toHaveCSS('background-color', 'rgb(26, 51, 102)');
  await page.locator('#preset-save').click();
  await expect(page.locator('#preset-status')).toContainText('已保存');
  await page.locator('#preset-name').fill('QA profile');
  await page.locator('#preset-cursor').selectOption('bar');
  await expect(page.locator('#preset-preview .profile-caret')).toHaveAttribute('data-shape', 'bar');
  await theme.selectOption('paper');
  await expect(page.locator('#preset-preview')).toHaveCSS('background-color', 'rgb(250, 247, 238)');
  await expect(page.locator('.pane.active:visible')).toHaveCSS('background-color', 'rgb(26, 51, 102)');
  await page.locator('#preset-save').click();
  await verifyRestoredProfile(page);
  await page.locator('#preset-filter').fill('测试');
  await expect(page.locator('#preset-list')).toHaveValue('QA profile');
  await page.locator('#preset-list').selectOption('Imported QA');
  await page.locator('#preset-load').click();
  await expect(theme).toHaveValue('custom');
  await page.locator('#preset-list').selectOption('QA profile');
  await page.locator('#preset-load').click();
  await expect(theme).toHaveValue('paper');
  await pane.locator('.xterm-screen').click({ position: { x: 8, y: 8 } });
  await expect(pane.locator('.xterm-helper-textarea')).toBeFocused();
  await expect(page.locator('#workspace-appearance')).toBeVisible();
  await expect(pane).toHaveAttribute('data-id', session);
  await page.keyboard.type(process.platform === 'win32' ? "[Console]::WriteLine(('SIDE-' + 'PANE'))" : "printf 'SIDE-%s\\n' PANE");
  await page.keyboard.press('Enter');
  await expect(pane.locator('.xterm-rows')).toContainText('SIDE-PANE');
  await page.locator('#workspace-collapse').click();
  await expect(page.locator('.pane.active:visible .xterm-rows')).toHaveCSS('font-size','15px');
  await page.locator('#find').click();
  await page.locator('#find-regex').check();
  await page.locator('#find-input').fill('BRCLIO-TTY-[0-9]+');
  await expect(page.locator('#find-result')).toHaveText(/1\s*\/\s*\d+/);
  await page.locator('#find-input').fill('[');
  await expect(page.locator('#find-result')).toHaveText('正则表达式无效');
  await page.locator('#find-regex').uncheck();
  await page.locator('#find-input').press('Escape');
}

module.exports = { verifyProfileAndSearch, verifyRestoredProfile };
