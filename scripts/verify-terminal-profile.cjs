'use strict';

const { expect } = require('@playwright/test');

async function verifyProfileAndSearch(page) {
  await page.locator('#terminal-actions').click();
  await page.locator('#buffer-query').fill('BRCLIO-TTY-');
  await page.locator('#buffer-search').click();
  const result = page.locator('#buffer-results button').first();
  await expect(result).toContainText('BRCLIO-TTY-');
  await result.click();

  await page.locator('#terminal-actions').click();
  await page.locator('#preset-name').fill('QA profile');
  await page.locator('#preset-tags').fill('测试, local');
  await page.locator('#preset-size').fill('15');
  await page.locator('#preset-colors').setInputFiles({
    name: 'QA.itermcolors', mimeType: 'application/xml',
    buffer: Buffer.from('<plist><dict><key>Background Color</key><dict><key>Red Component</key><real>0.1</real><key>Green Component</key><real>0.2</real><key>Blue Component</key><real>0.4</real></dict></dict></plist>'),
  });
  await expect(page.locator('#preset-status')).toContainText('已读取配色');
  await page.locator('#preset-save').click();
  await expect(page.locator('#preset-status')).toContainText('已保存');
  await page.locator('#preset-filter').fill('测试');
  await expect(page.locator('#preset-list')).toHaveValue('QA profile');
  await page.locator('#actions-close').click();
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

module.exports = { verifyProfileAndSearch };
