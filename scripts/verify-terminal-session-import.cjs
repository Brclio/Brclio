'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {expect} = require('@playwright/test');

async function verifySessionImports(page, app) {
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
  await format.selectOption('ansible');
  const ansible = {all:{children:['lab']},lab:{children:['routers']},routers:{hosts:['R1','R2']},
    _meta:{hostvars:{R1:{ansible_host:'r1.ansible.test',ansible_user:'operator',ansible_port:2222,ansible_password:'fixture-private'},
      R2:{ansible_host:'r2.ansible.test'}}}};
  await file.setInputFiles({name:'inventory.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(ansible))});
  await expect(preview.getByRole('checkbox')).toHaveCount(2);
  await expect(apply).toBeDisabled();
  await preview.getByRole('checkbox',{name:/R1 · operator@r1.ansible.test:2222 · lab\/routers/}).check();
  await apply.click();
  const imported = await page.evaluate(() => window.BrclioConnection.store(localStorage).all().filter(h => h.host.endsWith('.ansible.test')));
  assert.deepEqual(imported,[{name:'R1',host:'r1.ansible.test',user:'operator',port:2222,group:'lab/routers'}]);
  await file.setInputFiles({name:'cycle.json',mimeType:'application/json',buffer:Buffer.from('{"a":{"children":["a"]}}')});
  await expect(page.locator('#import-status')).toContainText('循环');
  await expect(apply).toBeDisabled();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(),'brclio-putty-picker-'));
  const original = await app.evaluateHandle(({dialog}) => dialog.showOpenDialog);
  try {
    const target = path.join(dir,'Chosen%20PuTTY');
    await fs.writeFile(target,'HostName=chosen.putty.test\nProtocol=ssh\nPortNumber=2222\nUserName=fixture\nProxyPassword=discard\n');
    await app.evaluate(({dialog},file) => {dialog.showOpenDialog=async () => ({canceled:false,filePaths:[file]});},target);
    await format.selectOption('putty-files');
    await expect(apply).toBeDisabled();
    await page.getByRole('button',{name:'选择 PuTTY 会话文件'}).click();
    const selected = preview.getByRole('checkbox',{name:/Chosen PuTTY/});
    await expect(selected).toBeVisible();
    await expect(selected).not.toBeChecked();
    await expect(apply).toBeDisabled();
    await selected.check();
    await apply.click();
    const entry = await page.evaluate(() => window.BrclioConnection.store(localStorage).all().find(h => h.host === 'chosen.putty.test'));
    assert.deepEqual(entry,{name:'Chosen PuTTY',host:'chosen.putty.test',port:2222,user:'fixture'});
    assert.equal(await format.locator('option[value=putty-registry]').count(),process.platform === 'win32' ? 1 : 0);
    if (process.platform === 'win32') {
      const prompt = await app.evaluateHandle(({dialog}) => dialog.showMessageBox);
      try {
        await app.evaluate(({dialog}) => {
          global.__puttyConfirmation = null;
          dialog.showMessageBox = async (...args) => {
            global.__puttyConfirmation = args.at(-1).message;
            return {response:0};
          };
        });
        await format.selectOption('putty-registry');
        assert.equal(await app.evaluate(() => global.__puttyConfirmation),null);
        await page.getByRole('button',{name:'从本机读取 PuTTY 会话'}).click();
        await expect.poll(() => app.evaluate(() => global.__puttyConfirmation)).toContain('当前 Windows 用户');
        await expect(preview.getByRole('checkbox')).toHaveCount(0);
        await expect(apply).toBeDisabled();
      } finally {
        await app.evaluate(({dialog},method) => {dialog.showMessageBox=method;delete global.__puttyConfirmation;},prompt);
        await prompt.dispose();
      }
    }
  } finally {
    await app.evaluate(({dialog},method) => {dialog.showOpenDialog=method;},original);
    await original.dispose();
    await fs.rm(dir,{recursive:true,force:true});
  }
}
module.exports = { verifySessionImports };
