'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { MAC_SELECTION_SCRIPT, getMacSelectedPaths, getSelectedPaths, createSelectionCopier } = require('./selected-paths.cjs');

function runScript({ foreground = ['com.apple.finder'], selection = [] } = {}) {
  let checks = 0;
  let queries = 0;
  const app = {};
  Object.defineProperty(app, 'bundleIdentifier', { get: () => foreground[Math.min(checks++, foreground.length - 1)] });
  const context = {
    ObjC: { import: () => {}, unwrap: value => value },
    $: { NSWorkspace: { sharedWorkspace: { frontmostApplication: app } } },
    Application: name => {
      assert.equal(name, 'Finder'); queries++;
      return { selection: () => selection.map(url => ({ url: () => url })) };
    },
  };
  vm.runInNewContext(MAC_SELECTION_SCRIPT, context);
  return { run: () => context.run(), queries: () => queries };
}

test('Finder native script queries only foreground selection and emits one JSON array', () => {
  const urls = ['file:///Users/test/a%20b.txt', 'file:///Users/test/%E4%B8%AD%E6%96%87'];
  const f = runScript({ selection: urls });
  assert.deepEqual(JSON.parse(f.run()), urls);
  assert.equal(f.queries(), 1);
  const other = runScript({ foreground: ['com.brclio.toolbox'], selection: urls });
  assert.throws(() => other.run(), /BRCLIO_NOT_FINDER/);
  assert.equal(other.queries(), 0);
  assert.throws(() => runScript().run(), /BRCLIO_NO_SELECTION/);
  assert.throws(() => runScript({ selection: Array(1001).fill(urls[0]) }).run(), /BRCLIO_TOO_MANY/);
  assert.throws(() => runScript({ foreground: ['com.apple.finder', 'com.brclio.toolbox'], selection: urls }).run(), /BRCLIO_FOCUS_CHANGED/);
});

test('macOS selection uses a bounded fixed native command and preserves literal filenames', async () => {
  const paths = ['/Users/test/中文 空格 & $(literal) `x` \' ".txt', '/Users/test/a%#b', '/Volumes/Disk/文件夹'];
  let calls = 0;
  const result = await getMacSelectedPaths(async (command, args, options) => {
    calls++;
    assert.equal(command, '/usr/bin/osascript');
    assert.deepEqual(args, ['-l', 'JavaScript', '-e', MAC_SELECTION_SCRIPT]);
    assert.equal(options.encoding, 'utf8');
    assert.equal(options.timeout, 60000);
    assert.equal(options.maxBuffer, 4 * 1024 * 1024);
    return { stdout: JSON.stringify(paths.map(value => pathToFileURL(value, { windows: false }).href)) };
  });
  assert.equal(calls, 1);
  assert.deepEqual(result, paths);
});

test('macOS selection rejects malformed, remote, virtual and ambiguous path data', async () => {
  for (const stdout of ['bad', 'null', '{}', '[]', '[1]', '["https://example.com/a"]', '["file://server/share/a"]', '["file:///tmp/a#fragment"]', '["file:///tmp/a?query"]', '["file:///tmp/a%00b"]', '["file:///tmp/a%0Ab"]', JSON.stringify(Array(1001).fill('file:///tmp/a')), ' '.repeat(4 * 1024 * 1024 + 1)]) {
    await assert.rejects(getMacSelectedPaths(async () => ({ stdout })), /本地路径/);
  }
});

test('native Finder errors identify foreground, selection, permission and focus failures', async () => {
  for (const [detail, pattern] of [['BRCLIO_NOT_FINDER', /请先在 Finder/], ['BRCLIO_NO_SELECTION', /尚未选中/], ['BRCLIO_TOO_MANY', /1000/], ['BRCLIO_FOCUS_CHANGED', /窗口已切换/], ['Not authorized to send Apple events. (-1743)', /自动化.*Finder/], ['ETIMEDOUT', /暂时无法读取/]]) {
    await assert.rejects(getMacSelectedPaths(async () => { throw Object.assign(new Error('native error'), { stderr: detail }); }), pattern);
  }
  await assert.rejects(getSelectedPaths({ platform: 'android' }), /仅支持/);
});

test('selection copier copies all selected items and avoids overlapping native queries', async () => {
  let finish;
  const query = new Promise(resolve => { finish = resolve; });
  let queries = 0;
  const copied = [];
  const copy = createSelectionCopier({ getPaths: () => { queries++; return query; }, copyPaths: async paths => { copied.push(paths); }, onError: () => assert.fail('unexpected error') });
  const first = copy();
  await copy();
  assert.equal(queries, 1);
  finish(['/tmp/a', '/tmp/folder']);
  await first;
  assert.deepEqual(copied, [['/tmp/a', '/tmp/folder']]);
  await copy();
  assert.equal(queries, 2);
});

test('selection failure leaves clipboard copying untouched and allows retry after error', async () => {
  const errors = [];
  let attempts = 0;
  const copied = [];
  const copy = createSelectionCopier({ getPaths: async () => { if (++attempts === 1) throw new Error('no selection'); return ['/tmp/a']; },
    copyPaths: async paths => copied.push(paths), onError: async error => errors.push(error.message) });
  await copy();
  assert.deepEqual(copied, []);
  assert.deepEqual(errors, ['no selection']);
  await copy();
  assert.deepEqual(copied, [['/tmp/a']]);
});

test('the actual macOS automation runtime compiles the fixed selection script', { skip: process.platform !== 'darwin' }, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'brclio-selection-script-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const source = path.join(directory, 'selection.js');
  await fs.writeFile(source, MAC_SELECTION_SCRIPT);
  // Compile only: no Finder events, selection changes or permission prompts.
  await promisify(execFile)('/usr/bin/osacompile', ['-l', 'JavaScript', '-o', path.join(directory, 'selection.scpt'), source], { timeout: 15000 });
});
