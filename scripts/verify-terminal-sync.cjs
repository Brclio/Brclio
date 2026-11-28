'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { _electron: electron, expect } = require('@playwright/test');

async function main() {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'brclio-terminal-sync-test-'));
  let app;
  try {
    await fs.writeFile(path.join(temp, 'fixture.html'), '<!doctype html><meta charset="utf-8"><title>Brclio synchronization fixture</title>');
    await fs.writeFile(path.join(temp, 'main.cjs'), `
      const { app, BrowserWindow } = require('electron');
      const path = require('node:path');
      app.setPath('userData', path.join(__dirname, 'profile'));
      const windows = [];
      app.whenReady().then(() => {
        for (const label of ['first', 'second']) {
          const win = new BrowserWindow({ show: false, webPreferences: { partition: label, sandbox: true } });
          windows.push(win);
          win.loadFile(path.join(__dirname, 'fixture.html'), { hash: label });
        }
      });`);
    app = await electron.launch({ args: [path.join(temp, 'main.cjs')] });
    await expect.poll(() => app.windows().filter(w => w.url().includes('fixture.html#')).length).toBe(2);
    const accounts = new Map(), clouds = new Map(), calls = [];
    let blockNextWrite = false, releaseWrite;
    let blockReadFor, releaseRead;
    for (const page of app.windows()) {
      accounts.set(page, 'Alice');
      await page.exposeFunction('fixtureSyncRequest', async (operation, payload) => {
        const id = accounts.get(page);
        calls.push({ operation, id, payload });
        if (operation === 'local-session' || operation === 'session') return { known: true, user: id ? { id, email: id + '@example.invalid' } : null };
        if (!id || payload.expectedUserId !== id) throw new Error('wrong account');
        const record = clouds.get(id) || { userId: id, revision: 0, data: { hosts: [], forwards: [] } };
        if (operation === 'read') {
          const result = structuredClone(record);
          if (blockReadFor === page) {
            blockReadFor = null;
            await new Promise(resolve => { releaseRead = resolve; });
          }
          return result;
        }
        assert.equal(operation, 'write');
        if (payload.revision !== record.revision) throw new Error('revision conflict');
        const saved = { userId: id, revision: record.revision + 1, data: structuredClone(payload.data) };
        clouds.set(id, saved);
        if (blockNextWrite) {
          blockNextWrite = false;
          await new Promise(resolve => { releaseWrite = resolve; });
        }
        return structuredClone(saved);
      });
      const from = name => path.join(__dirname, '..', 'desktop', 'terminal', name);
      for (const file of ['sync-partitions.js', 'connection.js', 'forward-model.js', 'sync-model.js', 'sync-controls.js']) {
        await page.addScriptTag({ content: await fs.readFile(from(file), 'utf8') });
      }
      await page.evaluate(() => {
        window.hosts = window.BrclioConnection.store(localStorage);
        window.BrclioTerminalSync.bind({
          syncTerminal: window.fixtureSyncRequest,
          onSyncAccountChanged(callback) { window.changeAccount = callback; },
        });
        window.BrclioTerminalSync.open();
      });
      await expect.poll(() => page.evaluate(() => window.BrclioTerminalPartitions.owner)).toBe('Alice');
    }
    const first = app.windows().find(p => p.url().endsWith('#first'));
    const second = app.windows().find(p => p.url().endsWith('#second'));
    const field = (page, name) => page.locator('[data-sync="' + name + '"]');
    // The read-only local identity probe is the only operation until explicit opt-in.
    assert.ok(calls.every(call => call.operation === 'local-session'));
    await first.evaluate(() => {
      window.hosts.save({ name: 'shared', host: 'initial.example', identityFile: '/local/dev/key', tags: ['work'] });
      window.hosts.recordUse('ssh', { host: 'private-recent.example' });
      window.BrclioForwardModel.store(localStorage).save({ name: 'demo', type: 'dynamic', listenHost: '127.0.0.1', listenPort: 6001,
        connection: { host: 'initial.example', identityFile: '/local/dev/key' } });
    });
    await field(first, 'enable').click();
    await expect(field(first, 'status')).toContainText('已同步');
    const payload = clouds.get('Alice').data;
    assert.equal(payload.hosts.length, 1);
    assert.equal(payload.forwards.length, 1);
    assert.doesNotMatch(JSON.stringify(payload), /identityFile|private-recent|\/local\/dev\/key/);
    await field(second, 'enable').click();
    await expect(field(second, 'status')).toContainText('已同步');
    assert.deepEqual(await second.evaluate(() => window.hosts.all()), payload.hosts);
    assert.equal(await first.evaluate(() => window.hosts.all()[0].identityFile), '/local/dev/key');
    assert.deepEqual(await second.evaluate(() => window.hosts.recents()), []);
    const writes = () => calls.filter(call => call.operation === 'write').length;
    const reads = () => calls.filter(call => call.operation === 'read').length;
    const initialWrites = writes();
    for (const device of [first, second, first]) {
      const count = reads();
      await field(device, 'refresh').click();
      await expect.poll(reads).toBeGreaterThan(count);
    }
    assert.equal(writes(), initialWrites, 'unchanged devices do not create remote writes');

    await field(first, 'disable').click();
    await first.evaluate(() => window.hosts.save({ name: 'shared', host: 'first.example' }));
    await second.evaluate(() => window.hosts.save({ name: 'shared', host: 'second.example' }));
    await expect.poll(() => clouds.get('Alice').data.hosts[0].host).toBe('second.example');
    await field(first, 'enable').click();
    await expect(field(first, 'conflicts')).toBeVisible();
    await field(first, 'items').locator('select').selectOption('cloud');
    await field(first, 'resolve').click();
    await expect.poll(() => first.evaluate(() => window.hosts.all()[0]?.host)).toBe('second.example');
    await expect(field(first, 'conflicts')).toBeHidden();

    // Hold the A response over a switch to B. The terminal must never apply it to B.
    blockNextWrite = true;
    await first.evaluate(() => window.hosts.save({ name: 'only-alice', host: 'a.example' }));
    await expect.poll(() => typeof releaseWrite).toBe('function');
    accounts.set(first, 'Bob');
    await first.evaluate(() => window.changeAccount());
    await expect.poll(() => first.evaluate(() => window.BrclioTerminalPartitions.owner)).toBe('Bob');
    releaseWrite();
    await expect(field(first, 'enable')).toBeVisible();
    assert.deepEqual(await first.evaluate(() => [window.hosts.all(), window.hosts.recents(), window.BrclioForwardModel.store(localStorage).all()]), [[], [], []]);
    await first.evaluate(() => window.hosts.save({ name: 'shared', host: 'only-b.example' }));
    await field(first, 'enable').click();
    await expect(field(first, 'status')).toContainText('已同步');
    assert.deepEqual(clouds.get('Bob').data.hosts.map(item => item.host), ['only-b.example']);
    assert.ok(clouds.get('Alice').data.hosts.some(item => item.name === 'only-alice'));
    const beforeSizeBlock = writes();
    await first.evaluate(() => {
      const tags = Array.from({ length: 16 }, (_, n) => '界'.repeat(38) + n);
      window.hosts.replace(Array.from({ length: 96 }, (_, n) => ({ name: 'large-' + n, host: 'fixture', tags })));
      window.dispatchEvent(new Event('brclio-terminal-library-changed'));
    });
    await expect(field(first, 'status')).toContainText('112 KiB');
    await first.evaluate(() => window.dispatchEvent(new Event('online')));
    assert.equal(writes(), beforeSizeBlock, 'oversized data must never enter the network write');
    await first.evaluate(() => {
      window.hosts.replace([{ name: 'small', host: 'recovered' }]);
      window.dispatchEvent(new Event('brclio-terminal-library-changed'));
    });
    await expect.poll(() => clouds.get('Bob').data.hosts.map(entry => entry.name)).toEqual(['small']);

    blockReadFor = first;
    await first.evaluate(() => window.hosts.save({ name: 'device-only', host: 'offline' }));
    await expect.poll(() => typeof releaseRead).toBe('function');
    await field(first, 'disable').click();
    releaseRead();
    await expect(field(first, 'enable')).toBeVisible();
    assert.ok(!clouds.get('Bob').data.hosts.some(entry => entry.name === 'device-only'), 'disable during an outstanding read prevents a follow-up write');
    accounts.set(first, null);
    await first.evaluate(() => window.changeAccount());
    await expect.poll(() => first.evaluate(() => [window.BrclioTerminalPartitions.ready, window.BrclioTerminalPartitions.owner])).toEqual([true, null]);
    assert.deepEqual(await first.evaluate(() => window.hosts.all()), []);
    accounts.set(first, 'Alice');
    await first.evaluate(() => window.changeAccount());
    await expect(field(first, 'disable')).toBeVisible();
    await expect.poll(() => first.evaluate(() => window.hosts.all().map(entry => entry.name))).toContain('only-alice');
    assert.ok(!(await first.evaluate(() => window.hosts.all())).some(entry => entry.name === 'device-only'));
    console.log('Terminal sync passed: two devices, no-op refreshes, conflicts, payload limits, opt-out during I/O, sign-out, account isolation and delayed responses.');
  } finally {
    await app?.close();
    await fs.rm(temp, { recursive: true, force: true });
  }
}

if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { verifyTerminalSync: main };
