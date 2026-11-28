'use strict';

const { expect } = require('@playwright/test');

async function verifyWorkspaceTools(page, command, windows) {
  const active = page.locator('.pane.active:visible');
  const open = () => page.locator('#terminal-actions').click();
  const close = () => page.locator('#actions-close').click();
  const id = await active.getAttribute('data-id');
  await open();
  await page.locator('#keymap-action').selectOption('find');
  await page.locator('#keymap-record').click();
  await page.keyboard.press('Control+Shift+F8');
  await expect(page.locator('#keymap-list')).toContainText('搜索当前窗格');
  await close();
  await active.locator('textarea.xterm-helper-textarea').focus();
  await page.keyboard.press('Control+Shift+F8');
  await expect(page.locator('#find-bar')).toBeVisible();
  await page.locator('#find-close').click();

  await open();
  await page.locator('#keymap-list button').click();
  await page.locator('#inspect-note').fill('QA memo');
  await page.locator('#inspect-add').click();
  await expect(page.locator('#inspect-notes')).toContainText('QA memo');
  await page.locator('#inspect-badge').fill('QA {tab}');
  await page.locator('#inspect-badge-set').click();
  await page.locator('#inspect-times').check();
  await page.locator('#trigger-pattern').fill('^QA-CAPTURE$');
  await page.locator('#trigger-action').selectOption('capture');
  await page.locator('#trigger-add').click();
  await page.locator('#trigger-action').selectOption('highlight');
  await close();
  await expect(active.locator('.session-badge')).toContainText('QA ');
  await command(windows ? "[Console]::WriteLine(('QA-' + 'CAPTURE'))" : "printf 'QA-%s\\n' CAPTURE");
  await expect(active.locator('.xterm-rows')).toContainText('QA-CAPTURE');
  await open();
  await expect(async () => {
    await page.locator('#trigger-captures-show').click();
    await expect(page.locator('#trigger-captures button')).toContainText('QA-CAPTURE', { timeout: 400 });
  }).toPass({ timeout: 5000 });
  await page.locator('#trigger-captures button').click();
  await open();
  await page.locator('#group-name').fill('QA group');
  await page.locator('#group-set').click();
  await page.locator('#group-hide').click();
  await expect(page.locator('#hidden-tabs option')).toHaveCount(1);
  await page.locator('#tab-show').click();
  await expect(active).toHaveAttribute('data-id', id);
  await expect(active.locator('.xterm-rows')).toContainText('QA-CAPTURE');
  await open();
  await page.locator('#paste-preview').fill('terminal✓\n');
  await page.locator('#paste-trim').check();
  await page.locator('#paste-convert').selectOption('base64');
  await page.locator('#paste-send').click();
  await expect(page.locator('#paste-progress')).toHaveText('粘贴完成。');
  await close();
  await expect(active.locator('.xterm-rows')).toContainText(Buffer.from('terminal✓').toString('base64'));
  await active.locator('textarea.xterm-helper-textarea').focus();
  await page.keyboard.press('Control+c');
  await require('./verify-terminal-snippets.cjs').verifySnippetTemplates(page);
  await page.locator('#connection-center').click();
  await page.locator('[data-center=sessions]').click();
  const sessions = page.locator('#inspect-panes');
  for (const layout of ['grid', 'compact', 'list']) {
    await page.locator('#inspect-layout').selectOption(layout);
    await expect(sessions).toHaveAttribute('data-layout', layout);
    await expect(sessions.locator('[aria-pressed=true]')).toContainText('运行中');
  }
  await expect(sessions.locator('[aria-pressed=true]')).toContainText('最近输出');
  await sessions.locator('[data-pane-id="' + id + '"]').click();
  await expect(active).toHaveAttribute('data-id', id);
}

module.exports = { verifyWorkspaceTools };
