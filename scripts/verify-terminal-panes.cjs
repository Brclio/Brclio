'use strict';

const { expect } = require('@playwright/test');

async function verifyPaneTools(page, command, windows) {
  const visible = page.locator('.panel:not([hidden])');
  const active = visible.locator('.pane.active');
  const tab = page.locator('#tabs [role=tab][aria-selected=true]');
  const tabId = await tab.getAttribute('id');
  const first = await active.getAttribute('data-id');
  await page.locator('#split-right').click();
  const second = await active.getAttribute('data-id');
  await page.locator('#split-down').click();
  const third = await active.getAttribute('data-id');
  const pane = id => visible.locator('.pane[data-id="' + id + '"]');
  const output = id => pane(id).locator('.xterm-rows');
  const mod = windows ? 'Control' : 'Meta';
  for (const id of [first, second, third]) {
    await expect(pane(id)).toHaveAttribute('data-state', 'running', { timeout: 15000 });
    if (windows) await expect(output(id)).toContainText(/PS [^>]*>/, { timeout: 20000 });
  }
  await page.keyboard.press(mod + '+Alt+ArrowUp');
  await expect(active).toHaveAttribute('data-id', second);
  await page.keyboard.press(mod + '+Shift+Enter');
  await expect(visible.locator('.pane:visible')).toHaveCount(1);
  await page.keyboard.press(mod + '+Alt+ArrowLeft');
  await expect(active).toHaveAttribute('data-id', first);
  await page.locator('#pane-restore').click();
  await expect(visible.locator('.pane:visible')).toHaveCount(3);
  await page.keyboard.press('Control+Shift+PageUp');
  await expect(page.locator('#tabs [role=tab]').first()).toHaveAttribute('id', tabId);
  await page.keyboard.press('Control+Shift+PageDown');
  await expect(page.locator('#tabs [role=tab]').last()).toHaveAttribute('id', tabId);

  await page.locator('#terminal-actions').click();
  await page.locator('#broadcast-options summary').click();
  await expect(page.locator('#broadcast-toggle')).toBeDisabled();
  for (const id of [first, second]) await page.locator('#broadcast-members input[value="' + id + '"]').check();
  await page.locator('#broadcast-toggle').click();
  await expect(page.locator('#broadcast-status')).toContainText('2 个窗格');
  const print = suffix => windows
    ? "[Console]::WriteLine(('BC-' + '" + suffix + "'))"
    : "printf 'BC-%s\\n' " + suffix;
  await command(print('READY') + (windows ? '; Start-Sleep -Seconds 60' : '; sleep 60'));
  for (const id of [first, second]) await expect(output(id)).toContainText('BC-READY', { timeout: 10000 });
  await page.keyboard.press('Control+c');
  for (const id of [first, second]) {
    await expect.poll(async () => (await output(id).innerText()).split('BC-READY').at(-1).trimEnd(),
      { timeout: 15000 }).toMatch(windows ? /PS [^>]*>$/ : /[%$#]$/);
  }
  await command(print('DONE'));
  for (const id of [first, second]) {
    await expect.poll(async () => (await output(id).innerText()).split('BC-DONE').length - 1).toBe(1);
  }
  await expect(output(third)).not.toContainText('BC-DONE');
  await page.locator('#new-tab').click();
  await expect(page.locator('#broadcast-status')).toBeHidden();
  await page.locator('#close-pane').click();
  await expect(tab).toHaveAttribute('id', tabId);
  await expect(page.locator('#broadcast-status')).toBeHidden();
  await expect(visible.locator('.pane[data-broadcast]')).toHaveCount(0);
}

module.exports = { verifyPaneTools };
