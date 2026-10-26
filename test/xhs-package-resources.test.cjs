'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const asar = require('@electron/asar');
const { verifyXhsAsar, requiredXhsFiles } = require('../scripts/verify-xhs-package.cjs');

test('XHS package gate rejects missing or damaged encoder resources and bundled test fixtures', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'brclio-xhs-resources-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  for (const filename of requiredXhsFiles) {
    const absolute = path.join(source, filename); await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, filename.endsWith('.wasm') ? Buffer.from('0061736d01000000', 'hex') : 'fixture');
  }
  async function pack(name) {
    // asar's writer resolves at end(), before the final OS write completes.
    // Snapshot each case and wait for its complete payload before inspecting it.
    const snapshot = path.join(root, name + '-source');
    await fs.cp(source, snapshot, { recursive: true });
    const archive = path.join(root, name + '.asar');
    await asar.createPackage(snapshot, archive);
    const header = asar.getRawHeader(archive);
    const payloadSize = directory => Object.values(directory.files || {}).reduce((sum, entry) => sum + (entry.files ? payloadSize(entry) : entry.size || 0), 0);
    const expected = 8 + header.headerSize + payloadSize(header.header);
    const deadline = Date.now() + 5000;
    while ((await fs.stat(archive)).size < expected) {
      if (Date.now() > deadline) throw new Error('ASAR fixture was not fully written.');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    return archive;
  }
  const valid = await pack('valid');
  assert.equal(verifyXhsAsar(valid).files.length, requiredXhsFiles.length);
  const encoder = path.join(source, 'web/xhs/assets/vendor/heic/heic-encoder.wasm');
  await fs.rm(encoder); const missing = await pack('missing');
  assert.throws(() => verifyXhsAsar(missing), /missing/);
  await fs.writeFile(encoder, 'not wasm'); const damaged = await pack('damaged');
  assert.throws(() => verifyXhsAsar(damaged), /not WASM/);
  await fs.writeFile(encoder, Buffer.from('0061736d01000000', 'hex'));
  await fs.mkdir(path.join(source, 'desktop/xhs/test'), { recursive: true });
  await fs.writeFile(path.join(source, 'desktop/xhs/test/private-fixture.js'), 'fixture');
  const withTests = await pack('fixtures');
  assert.throws(() => verifyXhsAsar(withTests), /test fixtures/);
  await t.test('Windows-style ASAR listings preserve all resource and fixture checks', () => {
    const listPackage = asar.listPackage;
    const listing = t.mock.method(asar, 'listPackage', (...args) =>
      listPackage(...args).map(entry => entry.replaceAll('/', '\\')));
    try {
      assert.equal(verifyXhsAsar(valid).files.length, requiredXhsFiles.length);
      assert.throws(() => verifyXhsAsar(missing), /missing/);
      assert.throws(() => verifyXhsAsar(damaged), /not WASM/);
      assert.throws(() => verifyXhsAsar(withTests), /test fixtures/);
    } finally {
      listing.mock.restore();
    }
  });
});
