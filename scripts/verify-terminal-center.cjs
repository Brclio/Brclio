'use strict';
const { expect } = require('@playwright/test');
async function verifyConnectionCenter(page) {
  const pane = page.locator('.pane.active:visible');
  const id = await pane.getAttribute('data-id');
  const center = page.locator('#connection-dialog');
  await page.locator('#connection-center').click();
  await expect(center).toBeVisible();
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
