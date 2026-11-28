'use strict';

const assert = require('node:assert/strict');
const { expect } = require('@playwright/test');

async function verifyHostLibrary(terminal) {
  // The caller uses an isolated Brclio data directory. Only synthetic hosts are registered.
  const count = await terminal.locator('#tabs [role=tab]').count();
  await terminal.evaluate(() => {
    localStorage.setItem('brclio.terminal.connections.v1', JSON.stringify([{ name: '旧版主机', host: 'old-test.invalid', user: 'fixture' }]));
  });
  await terminal.locator('#terminal-actions').click();
  await terminal.locator('#remote-connections summary').click();
  await terminal.locator('#remote-open').click();
  const dialog = terminal.locator('#remote-library');
  await expect(dialog).toBeVisible();
  const rows = dialog.locator('#remote-list button');
  await rows.filter({ hasText: '旧版主机' }).click();
  await expect(dialog.locator('#remote-host')).toHaveValue('old-test.invalid');
  await dialog.locator('#remote-name').fill('开发主机');
  await dialog.locator('#remote-group').fill('工作/开发');
  await dialog.locator('#remote-tags').fill('Build, Test');
  await dialog.locator('#remote-favorite').check();
  await dialog.locator('#remote-group-editor summary').click();
  await dialog.locator('#remote-config-path').fill('工作');
  await dialog.locator('#remote-config-port').fill('2222');
  await dialog.locator('#remote-config-environment').fill('COLOR=parent');
  await dialog.locator('#remote-config-save').click();
  await expect(dialog.locator('#remote-status')).toContainText('已保存分组设置');
  await dialog.locator('#remote-inherit').check();
  await expect(dialog.locator('#remote-inherited')).toContainText('2222');
  await dialog.locator('#remote-advanced summary').click();
  await dialog.locator('#remote-environment').fill('COLOR=host');
  await dialog.locator('#remote-save').click();
  const resolved = await terminal.evaluate(() => {
    const bank = window.BrclioConnection.store(localStorage);
    return bank.resolve(bank.all().find(item => item.name === '开发主机'));
  });
  assert.equal(resolved.port, 2222);
  assert.deepEqual(resolved.environment, [{ name: 'COLOR', value: 'host' }]);
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
  await dialog.locator('#remote-quick').fill('ssh://invalid.fixture:99999');
  await dialog.locator('#remote-quick-connect').click();
  await expect(dialog.locator('#remote-status')).toContainText('65535');
  // The selected loopback discard port refuses the SSH attempt before authentication.
  await dialog.locator('#remote-quick').fill('ssh://127.0.0.1:1');
  await dialog.locator('#remote-quick-connect').click();
  await expect(dialog).toBeHidden();
  await expect(terminal.locator('#tabs [role=tab]')).toHaveCount(count + 1);
  await terminal.locator('#tabs .tab:has([aria-selected=true]) .tab-close').click();
  await terminal.evaluate(() => window.BrclioRemoteConnections.open());
  await dialog.locator('#remote-view').selectOption('recent');
  await dialog.locator('#remote-search').fill('');
  await expect(rows.first()).toContainText('127.0.0.1:1');
  await dialog.locator('#remote-clear-recent').click();
  await expect(rows).toHaveCount(0);
  await dialog.locator('#remote-close').click();
  assert.equal(await terminal.locator('#tabs [role=tab]').count(), count);
}

module.exports = { verifyHostLibrary };
