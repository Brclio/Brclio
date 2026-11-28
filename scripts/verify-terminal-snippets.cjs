'use strict';

const net = require('node:net');
const { once } = require('node:events');
const { expect } = require('@playwright/test');

async function verifySnippetTemplates(page) {
  const prior = await page.evaluate(() => {
    const storage = window.BrclioTerminalPartitions.storage;
    return ['brclio.terminal.host-library.v2', window.BrclioSnippetModel.key].map(key => [key, storage.getItem(key)]);
  });
  await page.locator('#terminal-actions').click();
  await page.locator('#actions-filter').fill('命名剪藏');
  await page.locator('#snippets-name').fill('QA 变量示例');
  await page.locator('#snippets-package').fill('QA 工具包');
  await page.locator('#snippets-text').fill('echo {{value}}');
  await page.locator('#snippets-template').check();
  await page.locator('#snippets-save').click();
  await expect(page.locator('#snippets-status')).toHaveText('已保存。');
  const id = await page.locator('#snippets-list').inputValue();
  await page.locator('#snippets-package-filter').selectOption('p:QA 工具包');
  await page.locator('#snippets-query').fill('echo 工具包');
  await expect(page.locator('#snippets-list option')).toHaveCount(2);
  await page.locator('#actions-close').click();
  await page.locator('#connection-center').click();
  await page.locator('[data-center=commands]').click();
  await page.locator('#command-library-query').fill('QA 工具包');
  await page.locator('#command-library-insert').click();
  const draft = page.locator('#snippet-draft');
  await expect(draft).toBeVisible();
  await expect(draft.locator('[data-send]')).toBeDisabled();
  await draft.locator('input[name=value]').fill('BRCLIO-LOCAL-TEMPLATE');
  await draft.locator('[data-fill]').click();
  await expect(draft.locator('[data-preview]')).toHaveValue('echo BRCLIO-LOCAL-TEMPLATE');
  await draft.locator('[data-preview]').fill('BRCLIO-EDITED-DRAFT');
  await draft.locator('[data-send]').click();
  const active = page.locator('.pane.active:visible');
  await expect(active.locator('.xterm-rows')).toContainText('BRCLIO-EDITED-DRAFT');
  await active.locator('textarea.xterm-helper-textarea').focus();
  await page.keyboard.press('Control+c');

  const sockets = new Set();
  const server = net.createServer(socket => {
    sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket));
    // Keep native SSH at its banner exchange. No external server or account.
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    await page.evaluate(() => window.BrclioRemoteConnections.open());
    await page.locator('#remote-new').click();
    await page.locator('#remote-name').fill('QA 启动剪藏');
    await page.locator('#remote-host').fill('127.0.0.1');
    await page.locator('#remote-port').fill(String(server.address().port));
    await page.locator('#remote-startup-snippet').selectOption(id);
    await page.locator('#remote-save').click();
    await expect(page.locator('#remote-status')).toContainText('已保存');
    await page.locator('#remote-ssh').click();
    await expect(active.locator('.startup-snippet')).toBeVisible();
    await expect(draft).toBeHidden();
    await active.locator('.startup-snippet').click();
    await expect(draft.locator('[data-target]')).toContainText('127.0.0.1:' + server.address().port);
    await expect(draft.locator('[data-send]')).toBeDisabled();
    await draft.locator('[data-cancel]').click();
    await page.locator('#close-pane').click();
    await page.evaluate(() => window.BrclioRemoteConnections.open());
    await page.locator('#remote-remove').click(); await page.locator('#remote-delete-confirm').click();
    await page.locator('#remote-close').click();
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
    // Subsequent smoke tests must still exercise the first migration from legacy hosts.
    await page.evaluate(items => {
      const storage = window.BrclioTerminalPartitions.storage;
      for (const [key, original] of items) {
        if (original === null) storage.removeItem(key); else storage.setItem(key, original);
      }
      window.dispatchEvent(new Event('brclio-snippets-changed'));
    }, prior);
  }
}

module.exports = { verifySnippetTemplates };
