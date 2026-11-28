'use strict';
const { expect } = require('@playwright/test');
async function verifyConnectionCenter(page) {
  const pane = page.locator('.pane.active:visible');
  const id = await pane.getAttribute('data-id');
  const center = page.locator('#connection-dialog');
  await page.locator('#connection-center').click();
  await expect(center).toBeVisible();
  await center.locator('[data-center=importHosts]').click();
  await page.locator('#import-format').selectOption('csv');
  await page.locator('#import-file').setInputFiles({name:'hosts.csv',mimeType:'text/csv',
    buffer:Buffer.from('label,hostname,username,port,group\nImport UI Fixture,import.example.test,tester,2200,QA')});
  await expect(page.locator('#import-preview label')).toContainText('tester@import.example.test:2200');
  await page.locator('#import-apply').click();
  await expect(page.locator('#import-status')).toContainText('已导入 1 台');
  await page.locator('#import-close').click();
  await page.locator('#connection-center').click();
  await center.locator('[data-center=hosts]').click();
  await page.locator('#remote-view').selectOption('all');
  await page.locator('#remote-search').fill('Import UI Fixture');
  await expect(page.locator('#remote-list button')).toContainText('import.example.test');
  await page.locator('#remote-search').fill('');
  await page.locator('#remote-close').click();
  await page.locator('#connection-center').click();
  await center.locator('[data-center=commands]').click();
  await expect(page.locator('#command-library-enable')).not.toBeChecked();
  await page.locator('#command-library-query').fill('git status');
  await expect(page.locator('#command-library-list option').first()).toHaveText('命令 · git status');
  await page.locator('#command-library-close').click();
  await page.locator('#connection-center').click();
  await center.locator('[data-center=devices]').click();
  await page.locator('#device-kind').selectOption('serial');
  await expect(page.locator('#serial-fields')).toBeVisible();
  // Verify the native library can be loaded from the packaged ASAR on each architecture.
  expect(Array.isArray(await page.evaluate(() => window.brclioTerminal.serialPorts()))).toBe(true);
  await page.locator('#device-kind').selectOption('mosh');
  await expect(page.locator('#device-user')).toBeVisible();
  await page.locator('#device-close').click();
  await page.locator('#connection-center').click();
  await center.locator('[data-center=sync]').click();
  await expect(page.locator('#terminal-sync')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(pane).toHaveAttribute('data-id',id);
}
module.exports = { verifyConnectionCenter };
