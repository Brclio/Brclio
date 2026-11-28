'use strict';

const assert = require('node:assert/strict');
const { expect } = require('@playwright/test');

async function verifyHostLibrary(terminal) {
  // The caller uses an isolated Brclio data directory. Only synthetic hosts are registered.
  const count = await terminal.locator('#tabs [role=tab]').count();
  await terminal.evaluate(() => {
    // Build a real pre-v2 fixture even if an earlier test already used the new host editor.
    window.BrclioTerminalPartitions.storage.removeItem('brclio.terminal.host-library.v2');
    window.BrclioTerminalPartitions.storage.setItem('brclio.terminal.connections.v1', JSON.stringify([{ name: '旧版主机', host: 'old-test.invalid', user: 'fixture' }]));
  });
  await terminal.locator('#terminal-actions').click();
  await terminal.locator('#remote-connections summary').click();
  await terminal.locator('#remote-open').click();
  const dialog = terminal.locator('#remote-library');
  await expect(dialog).toBeVisible();
  await dialog.locator('#remote-view').selectOption('all');
  await dialog.locator('#remote-group-filter').selectOption('');
  await dialog.locator('#remote-search').fill('');
  const rows = dialog.locator('#remote-list button[aria-pressed]');
  await rows.filter({ hasText: '旧版主机' }).click();
  await expect(dialog.locator('#remote-host')).toHaveValue('old-test.invalid');
  await dialog.locator('#remote-name').fill('开发主机');
  await dialog.locator('#remote-group').fill('工作/开发');
  await dialog.locator('#remote-tags').fill('Build, Test');
  await dialog.locator('#remote-favorite').check();
  await terminal.evaluate(() => {
    window.BrclioIdentities.store(localStorage).save({ name:'QA 分组身份', user:'ci-user', path:'/fixture/group-key' });
  });
  await dialog.locator('#remote-group-editor summary').click();
  await dialog.locator('#remote-config-path').fill('工作');
  await dialog.locator('#remote-config-port').fill('2222');
  await dialog.locator('#remote-config-environment').fill('COLOR=parent');
  await dialog.locator('#remote-config-identity').selectOption('QA 分组身份');
  await dialog.locator('#remote-config-save').click();
  await expect(dialog.locator('#remote-status')).toContainText('已保存分组设置');
  await dialog.locator('#remote-inherit').check();
  await expect(dialog.locator('#remote-inherited')).toContainText('2222');
  await dialog.locator('#remote-advanced summary').click();
  await expect(dialog.locator('#remote-kex')).toHaveValue('system');
  await dialog.locator('#remote-kex-check').click();
  await expect(dialog.locator('#remote-kex-status')).toContainText(/本机|OpenSSH/);
  await dialog.locator('#remote-kex').selectOption('required');
  await dialog.locator('#remote-proxy').fill('socks5://127.0.0.1:1080');
  await dialog.locator('#remote-environment').fill('COLOR=host');
  await dialog.locator('#remote-save').click();
  const resolved = await terminal.evaluate(() => {
    const bank = window.BrclioConnection.store(localStorage);
    return bank.resolve(bank.all().find(item => item.name === '开发主机'));
  });
  assert.equal(resolved.port, 2222);
  assert.equal(resolved.requirePostQuantum, true);
  assert.equal(resolved.proxy, 'socks5://127.0.0.1:1080');
  assert.deepEqual(resolved.environment, [{ name: 'COLOR', value: 'host' }]);
  await expect(dialog.locator('#remote-group-key-info')).toContainText('/fixture/group-key');
  await dialog.locator('#remote-group-key').click();
  await expect(dialog.locator('#remote-group-key')).toHaveText('撤销此主机的分组身份授权');
  assert.equal(await terminal.evaluate(() => {
    const bank = window.BrclioConnection.store(localStorage);
    return bank.resolve(bank.all().find(item => item.name === '开发主机')).identityFile;
  }), '/fixture/group-key');
  await dialog.locator('#remote-group-key').click();
  await dialog.locator('#remote-group-editor summary').click();
  await dialog.locator('#remote-view').selectOption('favorite');
  await dialog.locator('#remote-group-filter').selectOption('工作');
  await dialog.locator('#remote-search').fill('test build');
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('开发主机');
  await dialog.locator('#remote-duplicate').click();
  await dialog.locator('#remote-name').fill('副本');
  await dialog.locator('#remote-save').click();
  await expect(rows).toHaveCount(2);
  await dialog.locator('#remote-remove').click();
  await dialog.locator('#remote-delete-cancel').click();
  await expect(rows).toHaveCount(2);
  await dialog.locator('#remote-remove').click();
  await dialog.locator('#remote-delete-confirm').click();
  await expect(rows).toHaveCount(1);
  await dialog.locator('#remote-new').click();
  await expect(dialog.locator('#remote-kex')).toHaveValue('system');
  await rows.filter({hasText:'开发主机'}).click();
  await expect(dialog.locator('#remote-kex')).toHaveValue('required');
  await dialog.locator('#remote-quick').fill('ssh://invalid.fixture:99999');
  await dialog.locator('#remote-quick-connect').click();
  await expect(dialog.locator('#remote-status')).toContainText('65535');
  // The selected loopback discard port refuses the SSH attempt before authentication.
  await dialog.locator('#remote-quick').fill('ssh://127.0.0.1:1');
  await dialog.locator('#remote-quick-connect').click();
  await expect(dialog).toBeHidden();
  await expect(terminal.locator('#tabs [role=tab]')).toHaveCount(count + 1);
  await terminal.locator('#tabs .tab:has([aria-selected=true]) .tab-close').click();
  await terminal.evaluate(() => window.BrclioRemoteConnections.open('ssh'));
  await expect(dialog.locator('#remote-view')).toHaveValue('recent');
  await expect(dialog.locator('#remote-search')).toHaveValue('');
  await expect(rows.first()).toContainText('127.0.0.1:1');
  await expect(rows.first().locator('time')).toContainText('上次发起');
  const firstOpen = await rows.first().locator('time').getAttribute('datetime');
  await dialog.getByRole('button', { name: '重连 SSH 127.0.0.1:1', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(terminal.locator('#tabs [role=tab]')).toHaveCount(count + 1);
  await expect(terminal.locator('#tabs [aria-selected=true]')).toContainText('SSH');
  await expect(terminal.locator('.pane.active:visible .xterm-helper-textarea')).toBeFocused();
  await terminal.locator('#tabs .tab:has([aria-selected=true]) .tab-close').click();
  await terminal.evaluate(() => window.BrclioRemoteConnections.open('ssh'));
  await expect(rows.filter({ hasText: '127.0.0.1:1' })).toHaveCount(1);
  assert.ok(Date.parse(await rows.first().locator('time').getAttribute('datetime')) > Date.parse(firstOpen));
  await dialog.locator('#remote-clear-recent').click();
  await expect(rows).toHaveCount(0);
  await dialog.locator('#remote-close').click();
  await terminal.evaluate(() => window.BrclioRemoteConnections.open('ssh'));
  await expect(dialog.locator('#remote-view')).toHaveValue('all');
  await expect(rows.filter({ hasText: '开发主机' })).toHaveCount(1);
  await dialog.locator('#remote-close').click();
  assert.equal(await terminal.locator('#tabs [role=tab]').count(), count);
  await verifyWorkspaceHosts(terminal);
}

async function verifyWorkspaceHosts(terminal) {
  const net = require('node:net');
  const { once } = require('node:events');
  const fixture = net.createServer(socket => { attempts++; socket.destroy(); });
  let attempts = 0;
  fixture.listen(0, '127.0.0.1');
  await once(fixture, 'listening');
  try {
    const tabs = terminal.locator('#tabs [role=tab]');
    const count = await tabs.count();
    await terminal.locator('#quick-ssh').click();
    const panel = terminal.locator('#workspace-hosts');
    const library = terminal.locator('#remote-library');
    const editor = panel.locator('[data-host=editor]');
    const search = panel.locator('[data-host=search]');
    const list = panel.locator('[data-host=list]');
    const closeTab = () => terminal.locator('#tabs .tab:has([aria-selected=true]) .tab-close').click();
    await expect(panel).toBeVisible();
    await panel.locator('[data-host=new]').click();
    await editor.getByLabel('名称').fill('侧栏 CI');
    await editor.getByLabel('主机地址').fill('127.0.0.1');
    await editor.getByLabel('用户名').fill('fixture');
    await editor.getByLabel('端口').fill(String(fixture.address().port));
    await editor.getByLabel('收藏主机').check();
    await editor.getByRole('button', {name:'保存主机'}).click();
    await expect(panel.getByRole('status')).toHaveText('已保存 侧栏 CI');
    await panel.getByRole('button', {name:'收藏',exact:true}).click();
    await search.fill('侧栏 CI');
    await expect(list.getByRole('listitem')).toHaveCount(1);
    await list.getByRole('button',{name:'连接 SSH 侧栏 CI'}).click();
    await expect.poll(() => attempts).toBe(1);
    await expect(tabs).toHaveCount(count + 1);
    await expect(panel).toBeVisible();
    await expect(terminal.locator('dialog[open]')).toHaveCount(0);
    await closeTab();
    await panel.getByRole('button',{name:'最近',exact:true}).click();
    await expect(list.locator('time')).toContainText('上次发起');
    await list.getByRole('button',{name:'重新打开 SSH 侧栏 CI'}).click();
    await expect.poll(() => attempts).toBe(2);
    await closeTab();
    await list.getByRole('button',{name:'编辑主机 侧栏 CI'}).click();
    await editor.getByLabel('名称').fill('侧栏改名');
    await editor.getByRole('button',{name:'更多选项…'}).click();
    await expect(library.locator('#remote-name')).toHaveValue('侧栏改名');
    await expect(library.locator('#remote-advanced')).toHaveAttribute('open', '');
    await library.locator('#remote-environment').fill('BRCLIO_FIXTURE=test');
    await library.locator('#remote-save').click();
    await expect(library.locator('#remote-status')).toHaveText('已保存 侧栏改名');
    // A user can focus the sidebar after dismissal, before Chromium delivers the close event.
    await library.evaluate(dialog => new Promise(resolve => {
      dialog.addEventListener('close', () => resolve(), { once: true });
      dialog.querySelector('#remote-close').click();
      document.querySelector('#workspace-hosts [data-host=search]').focus();
    }));
    await expect(search).toBeFocused();
    await search.fill('侧栏改名');
    await expect(search).toHaveValue('侧栏改名');
    await list.getByRole('button',{name:'编辑主机 侧栏改名'}).click();
    await editor.getByLabel('用户名').fill('other-fixture');
    await editor.getByRole('button',{name:'保存主机'}).click();
    assert.equal(await terminal.evaluate(() => window.BrclioConnection.store(localStorage).all()
      .find(item => item.name === '侧栏改名').environment), undefined);
    const quick = panel.locator('[data-host=quick]');
    await quick.fill('ssh://127.0.0.1:99999');
    await quick.press('Enter');
    await expect(panel.getByRole('status')).toContainText('65535');
    await quick.fill('fixture@127.0.0.1:' + fixture.address().port);
    await quick.press('Enter');
    await expect.poll(() => attempts).toBe(3);
    await expect(panel.locator('[data-view=recent]')).toHaveAttribute('aria-pressed','true');
    await expect(quick).toHaveValue('');
    await closeTab();
    await list.getByRole('button',{name:/保存主机 fixture@127\.0\.0\.1/}).click();
    await expect(editor.getByLabel('用户名')).toHaveValue('fixture');
    await editor.getByRole('button',{name:'取消'}).click();
    await terminal.locator('#workspace-collapse').click();
    await expect(tabs).toHaveCount(count);
  } finally {
    await new Promise(resolve => fixture.close(resolve));
  }
}

module.exports = { verifyHostLibrary };
