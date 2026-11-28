'use strict';

const path = require('node:path');
const { expect } = require('@playwright/test');

async function verifyTerminalDevices(app, page, command, windows) {
  const active = page.locator('.pane.active:visible');
  const rows = active.locator('.xterm-rows');
  const script = path.join(__dirname, 'terminal-tty-probe.py');
  const quoted = "'" + script.replaceAll("'", windows ? "''" : "'\\''") + "'";
  await command((windows ? '& python ' : 'python3 ') + quoted);
  await expect(rows).toContainText('BRCLIOMOUSEREADY', { timeout: 10000 });
  const rgb = rows.locator('span').filter({ hasText: /^BRCLIORGBPROBE$/ });
  await expect(rgb).toHaveCSS('color', 'rgb(51, 182, 147)');
  await expect(rgb).toHaveCSS('background-color', 'rgb(19, 21, 38)');
  // xterm must report a genuine pointer click to the foreground PTY process.
  await active.locator('.xterm-screen').click({ position: { x: 40, y: 20 } });
  await expect(rows).toContainText(/BRCLIOMOUSEOK +[1-9]\d* +[1-9]\d*/, { timeout: 14000 });
  await expect(rows).toContainText('BRCLIOSELECTPROBE');
  // Releasing mouse mode must restore ordinary word selection and copy.
  const priorWrite = await app.evaluateHandle(({ clipboard }) => clipboard.writeText);
  try {
    await app.evaluate(({ clipboard }) => { clipboard.writeText = text => { globalThis.__brclioDeviceCopy = text; }; });
    const word = rows.getByText('BRCLIOSELECTPROBE', { exact: true }).last();
    await word.scrollIntoViewIfNeeded();
    const bounds = await word.boundingBox();
    if (!bounds) throw new Error('测试文本未显示。');
    // Click the screen at the word, through any transparent image overlay.
    await page.mouse.dblclick(bounds.x + Math.min(6, bounds.width / 2), bounds.y + bounds.height / 2);
    await expect(page.locator('#copy')).toBeEnabled();
    await page.locator('#copy').click();
    await expect.poll(() => app.evaluate(() => globalThis.__brclioDeviceCopy)).toBe('BRCLIOSELECTPROBE');
  } finally {
    await app.evaluate(({ clipboard }, write) => { clipboard.writeText = write; delete globalThis.__brclioDeviceCopy; }, priorWrite);
    await priorWrite.dispose();
  }
}
module.exports = { verifyTerminalDevices };
