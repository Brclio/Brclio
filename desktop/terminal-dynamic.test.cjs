'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { parse, dynamicSource } = require('./terminal/dynamic-profiles.cjs');

const base = { Guid: 'dev.example', Name: '开发', Tags: ['Work'], 'Normal Font': 'Menlo 16',
  'Scrollback Lines': 345, 'Blinking Cursor': false,
  'Ansi 1 Color': { 'Red Component': 1, 'Green Component': 0.5, 'Blue Component': 0 } };
const pack = (...items) => JSON.stringify({ Profiles: items });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

test('iTerm2 dynamic JSON imports only supported visual fields and rejects malformed documents atomically', () => {
  const [result] = parse(pack({ ...base, Command: 'unsupported', 'Custom Command': 'Yes',
    'Dynamic Profile Parent GUID': 'unknown', 'Working Directory': '/tmp', Rewritable: true }));
  assert.deepEqual(result, { guid: 'dev.example', name: '开发', tags: 'Dynamic, Work', colors: { red: '#ff8000' },
    font: '"Menlo", monospace', size: 16, scrollback: 345, blink: false });
  for (const bad of [pack(base, base), pack({ Name: 'x' }), pack({ ...base, Tags: 'a' }),
    pack({ ...base, 'Foreground Color': {} }), pack({ ...base, 'Normal Font': '20px url(file) 16' }), 'invalid']) {
    assert.throws(() => parse(bad));
  }
  assert.deepEqual(parse(pack()), []);
});

test('watching one selected file survives atomic saves, holds the last valid profile, and releases all tracking on stop', { timeout: 8000 }, async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "brclio-dyn' "));
  const file = path.join(dir, 'profiles.json');
  const other = path.join(dir, 'other.json');
  await fs.writeFile(file, pack(base));
  const events = [];
  const source = dynamicSource(value => events.push(value), 40);
  t.after(async () => { source.stop(); await fs.rm(dir, { recursive: true, force: true }); });
  async function next(predicate) {
    for (let i = 0; i < 100; i++) {
      const event = events.findLast(predicate);
      if (event) return event;
      await delay(35);
    }
    assert.fail('Timed out waiting for a file change: ' + JSON.stringify(events));
  }
  const first = await source.choose(async () => file, true);
  assert.equal(first.source, 'profiles.json');
  assert.equal(first.profiles[0].name, '开发');
  await next(e => e.profiles[0].name === '开发');
  const count = events.length;
  await fs.writeFile(other, pack({ ...base, Name: '其他' }));
  await delay(150);
  assert.equal(events.length, count);
  await fs.writeFile(other, pack({ ...base, Name: '重命名' }));
  await fs.rename(other, file);
  await next(e => e.profiles[0].name === '重命名');
  await fs.writeFile(file, 'damaged');
  const error = await next(e => Boolean(e.error));
  assert.equal(error.profiles[0].name, '重命名');
  await fs.writeFile(other, '{{');
  await assert.rejects(source.choose(async () => other, true), /JSON/);
  await fs.unlink(file);
  await next(e => e.error.includes('ENOENT'));
  await fs.writeFile(file, pack({ ...base, Name: '修复' }));
  await next(e => e.profiles[0].name === '修复');
  source.track(false);
  const paused = events.length;
  await fs.writeFile(file, pack({ ...base, Name: '再启用' }));
  await delay(150);
  assert.equal(events.length, paused);
  source.track(true);
  await next(e => e.profiles[0].name === '再启用');
  let finish;
  const pending = source.choose(() => new Promise(resolve => { finish = resolve; }), true);
  source.stop();
  finish(file);
  assert.equal(await pending, null);
  assert.throws(() => source.track(true), /选择/);
  const ended = events.length;
  await fs.writeFile(file, pack());
  await delay(150);
  assert.equal(events.length, ended);
});

test('dynamic profiles reject remote paths, special or oversized files and malformed UTF-8', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'brclio-dyn-limit-'));
  const source = dynamicSource(() => {});
  t.after(async () => { source.stop(); await fs.rm(dir, { force: true, recursive: true }); });
  await assert.rejects(source.choose(async () => '//server/share/p.json', false), /本地/);
  const file = path.join(dir, 'x.json');
  await fs.writeFile(file, Buffer.alloc(256 * 1024 + 1));
  await assert.rejects(source.choose(async () => file, false), /256/);
  await fs.writeFile(file, Buffer.from([0xff]));
  await assert.rejects(source.choose(async () => file, false), /UTF-8/);
  if (process.platform !== 'win32') {
    const other = path.join(dir, 'link.json');
    await fs.symlink(file, other);
    await assert.rejects(source.choose(async () => other, false));
  }
});
