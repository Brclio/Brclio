'use strict';
const assert = require('node:assert/strict');
const {expect} = require('@playwright/test');

async function verifySessionImports(page) {
  const format = page.locator('#import-format'), file = page.locator('#import-file');
  const preview = page.locator('#import-preview'), apply = page.locator('#import-apply');
  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>','<VanDyke version="3.0"><key name="Sessions"><key name="Lab &amp; QA">',
    '<key name="Router"><string name="Protocol Name">SSH2</string><string name="Hostname">router.import.test</string>',
    '<string name="Username">fixture</string><dword name="[SSH2] Port">2222</dword>',
    '<string name="Password V2">discarded-fixture</string></key>',
    '<key name="Other"><string name="Hostname">other.import.test</string></key>',
    '</key></key><key name="Global"><key name="Outside"><string name="Hostname">ignored.import.test</string></key></key></VanDyke>',
  ].join('\n');
  await format.selectOption('securecrt');
  await file.setInputFiles({ name:'SCRTConfig.xml', mimeType:'application/xml', buffer:Buffer.from(xml) });
  await expect(preview.locator('label')).toHaveCount(2);
  await expect(preview.locator('label').first()).toContainText('fixture@router.import.test:2222 · Lab & QA');
  await preview.getByRole('checkbox').nth(1).uncheck();
  await apply.click();
  const hosts = await page.evaluate(() => window.BrclioConnection.store(localStorage).all());
  const actual = hosts.find(item => item.host === 'router.import.test');
  assert.deepEqual(actual, { name:'Router', host:'router.import.test', user:'fixture', port:2222, group:'Lab & QA' });
  assert.ok(!hosts.some(item => item.host === 'other.import.test' || item.host === 'ignored.import.test'));
  await file.setInputFiles({name:'invalid.xml',mimeType:'application/xml',buffer:Buffer.from('<VanDyke><key></VanDyke>')});
  await expect(apply).toBeDisabled();
  await expect(page.locator('#import-status')).toContainText('不是有效的');
  await format.selectOption('mobaxterm');
  const moba = '[Bookmarks_1]\r\nSubRep=Lab\\Local\r\nCaf\xe9=#109#0%moba.import.test%2200%tester%%-1#MobaFont%10\r\n';
  await file.setInputFiles({ name:'User.mxtsessions', mimeType:'application/octet-stream', buffer:Buffer.from(moba, 'latin1') });
  await expect(preview.locator('label')).toHaveText(/Café · tester@moba.import.test:2200 · Lab\/Local/);
  await apply.click();
  await expect(page.locator('#import-status')).toContainText('已导入 1 台');
}
module.exports = { verifySessionImports };
