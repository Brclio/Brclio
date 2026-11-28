import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chromium } from '@playwright/test';

async function openSnippetEditor(page) {
  await page.locator('#terminal-actions').click();
  await page.locator('#actions-filter').fill('命名剪藏');
  await page.locator('#snippets-details[open]').waitFor();
}

async function verifySnippetLibrary(page) {
  await openSnippetEditor(page);
  const name = page.locator('#snippets-name'), body = page.locator('#snippets-text');
  await name.fill('未保存的草稿');
  await body.fill('unsaved');
  await page.locator('#actions-close').click();
  await openSnippetEditor(page);
  assert.equal(await name.inputValue(), '');
  await name.fill('查看目录');
  await body.fill('demo-command');
  await page.locator('#snippets-save').click();
  assert.equal(await page.locator('#snippets-status').textContent(), '已保存。');
  const snippet = await page.locator('#snippets-list').inputValue();
  await page.locator('#snippets-list').selectOption('');
  await page.locator('#snippets-kind').selectOption('note');
  await name.fill('排查笔记');
  await body.fill('first line\nsecond line');
  await page.locator('#snippets-save').click();
  const note = await page.locator('#snippets-list').inputValue();
  await page.reload();
  await openSnippetEditor(page);
  await page.locator('#snippets-list').selectOption(note);
  assert.equal(await body.inputValue(), 'first line\nsecond line');
  await body.fill('edited note');
  assert.equal(await page.locator('#snippets-paste').isDisabled(), true);
  await page.locator('#snippets-save').click();
  await page.locator('#snippets-list').selectOption(snippet);
  await page.locator('#snippets-list').selectOption(note);
  assert.equal(await body.inputValue(), 'edited note');
  await page.locator('#snippets-remove').click();
  assert.equal(await page.locator('#snippets-list option').count(), 2);
  assert.deepEqual(await page.evaluate(() => inputProbe.writes), []);
  await page.locator('#actions-close').click();
  return snippet;
}

for (const platform of ['darwin', 'win32']) {
  test(platform + ' broadcasts only deliberate input to explicitly joined local panes', async () => {
    const browser = await chromium.launch({ executablePath: process.env.BRCLIO_CHROME ||
      (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined) });
    try {
      const page = await browser.newPage();
      page.setDefaultTimeout(6000);
      await page.addInitScript(platform => {
        const listeners = new Set();
        const state = { writes: [], emit: (id, data) => {
          for (const fn of listeners) fn({ id, data });
        } };
        window.inputProbe = state;
        window.brclioTerminal = {
          platform, profiles: async () => [{ id: 'default', label: 'Shell' }],
          create: async ({ id }) => ({ id, shell: 'test', pid: 1 }),
          write: async (id, data, binary) => { state.writes.push({ id, data, binary }); },
          close: async () => {}, resize: async () => {}, ack() {},
          onData(fn) { listeners.add(fn); return () => listeners.delete(fn); }, onExit: () => () => {},
          paste: async () => 'one\ntwo💡', copy: async () => {},
          onPresentation() {}, getPresentation: async () => 'window', onDynamicChanged() {},
          onCapturedHotkey() {}, getAlertSettings: async () => ({}), recordHotkey: async () => {},
        };
      }, platform);
      await page.goto(new URL('../desktop/terminal/index.html', import.meta.url).href);
      const active = page.locator('.pane.active:visible');
      await active.locator('.xterm-helper-textarea').waitFor({ state: 'attached' });
      await page.setViewportSize({ width: 580, height: 360 });
      await page.locator('#terminal-actions').click();
      const filter = page.locator('#actions-filter');
      const filterBefore = await filter.boundingBox();
      await page.locator('#actions-list').evaluate(list => { list.scrollTop = list.scrollHeight; });
      assert.deepEqual(await filter.boundingBox(), filterBefore);
      assert.equal(await page.locator('#actions-list').evaluate(list => list.scrollTop > 0 && list.scrollWidth <= list.clientWidth), true);
      await filter.fill('粘贴历史');
      assert.equal(await page.locator('#paste-record').isVisible(), true);
      await filter.fill('no-such-control');
      assert.equal(await page.locator('#actions-empty').isVisible(), true);
      await filter.fill('');
      assert.equal(await page.locator('#history-details').evaluate(el => el.open), false);
      await page.locator('#actions-close').click();
      await page.waitForFunction(() => !document.querySelector('#inspect-panes').childElementCount);
      await page.setViewportSize({ width: 1280, height: 720 });
      const snippet = await verifySnippetLibrary(page);
      await active.locator('textarea').focus();
      await page.keyboard.press('Control+k');
      await page.waitForFunction(() => inputProbe.writes.some(item => item.data === '\x0b'));
      await page.keyboard.press(platform === 'darwin' ? 'Meta+f' : 'Control+Shift+f');
      assert.equal(await page.locator('#find-input').evaluate(input => input === document.activeElement), true);
      await page.keyboard.press('Escape');
      await page.evaluate(() => { inputProbe.writes.length = 0; });
      const first = await active.getAttribute('data-id');
      await page.locator('#new-tab').click();
      const tabs = page.locator('#tabs [role=tab]');
      const moved = await tabs.last().getAttribute('id');
      await tabs.last().dragTo(tabs.first());
      assert.equal(await tabs.first().getAttribute('id'), moved);
      await page.locator('#close-pane').click();
      await page.locator('#split-right').click();
      const second = await active.getAttribute('data-id');
      await page.locator('#terminal-actions').click();
      await page.locator('#broadcast-options summary').click();
      for (const id of [first, second]) await page.locator('#broadcast-members input[value="' + id + '"]').check();
      await page.locator('#broadcast-toggle').click();
      await page.waitForFunction(() => !document.querySelector('#broadcast-members').childElementCount);
      await page.locator('#split-down').click();
      const excluded = await active.getAttribute('data-id');
      assert.equal(await active.getAttribute('data-broadcast'), null);
      const source = page.locator('.pane[data-id="' + first + '"]');
      await source.locator('textarea').focus();
      await openSnippetEditor(page);
      await page.locator('#snippets-list').selectOption(snippet);
      await page.locator('#snippets-paste').click();
      await page.waitForFunction(() => inputProbe.writes.length > 0);
      assert.deepEqual(await page.evaluate(() => inputProbe.writes.map(({id,data}) => [id,data])), [[first, 'demo-command']]);
      await page.evaluate(() => { inputProbe.writes.length = 0; });
      // Only the source PTY should receive its own device status reply. The
      // two shells deliberately request different bracketed paste modes.
      await page.evaluate(([a, b]) => {
        inputProbe.emit(b, '\x1b[?2004h');
        inputProbe.emit(a, '\x1b[?2004l\x1b[6n');
      }, [first, second]);
      await page.waitForFunction(id => inputProbe.writes.some(item => item.id === id && /\dR$/.test(item.data)), first);
      assert.equal(await page.evaluate(id => inputProbe.writes.filter(item => item.id === id).length, second), 0);
      await page.evaluate(() => { inputProbe.writes.length = 0; });
      await page.locator('#terminal-actions').click();
      await page.locator('#history-details summary').click();
      await page.locator('#paste-record').check();
      await page.locator('#actions-close').click();
      await page.locator('#paste').click();
      await page.keyboard.press('Control+c');
      await page.waitForFunction(() => inputProbe.writes.length >= 4);
      const writes = await page.evaluate(() => inputProbe.writes);
      const data = id => writes.filter(item => item.id === id).map(item => item.data);
      assert.deepEqual(data(first), ['one\rtwo💡', '\x03']);
      assert.deepEqual(data(second), ['\x1b[200~one\rtwo💡\x1b[201~', '\x03']);
      assert.deepEqual(data(excluded), []);
      await page.evaluate(() => { inputProbe.writes.length = 0; });
      await page.locator('#terminal-actions').click();
      await page.locator('#history-details summary').click();
      await page.locator('#paste-again').click();
      await page.waitForFunction(() => inputProbe.writes.length > 0);
      assert.deepEqual(await page.evaluate(() => inputProbe.writes.map(item => item.id)), [first]);
      await page.evaluate(id => { inputProbe.writes.length = 0; inputProbe.emit(id, '\x1b[?1000h\x1b[?1006h'); }, first);
      await source.locator('.xterm-screen').click({ position: { x: 16, y: 12 } });
      await page.waitForFunction(() => inputProbe.writes.some(item => /^\x1b\[</.test(item.data)));
      assert.equal(await page.evaluate(id => inputProbe.writes.every(item => item.id === id), first), true);
      await page.locator('#close-pane').click();
      assert.equal(await page.locator('#broadcast-status').isVisible(), false);
      assert.equal(await page.locator('.pane[data-broadcast]').count(), 0);
    } finally { await browser.close(); }
  });
}
