'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Exercise the actual fixture installed into the release smoke's main process.
// It must intercept current-source isolated sessions as well as older net.fetch
// callers, otherwise the native package test accidentally reads live releases.
const source = fs.readFileSync(path.join(__dirname, 'mac-installer-smoke.cjs'), 'utf8');
const marker = 'await application.evaluate(({ net, session }, fixture) => {';
const start = source.indexOf(marker);
const end = source.indexOf('\n    }, { version: targetVersion', start);
assert.ok(start >= 0 && end > start);
const callback = source.slice(start + 'await application.evaluate('.length, end) + '\n}';

test('macOS native replacement fixture intercepts isolated proxy sessions without live network', async () => {
  const bytes = Buffer.from('local actual DMG fixture bytes');
  const fileURL = 'file:///private/test-package.dmg';
  const nativeCalls = [];
  const net = { fetch: async url => { nativeCalls.push(url); assert.equal(url, fileURL); return new Response(bytes); } };
  const sessions = new Map();
  const session = { defaultSession: {}, fromPartition(name) {
    if (!sessions.has(name)) sessions.set(name, {});
    return sessions.get(name);
  } };
  const context = { Response, URL };
  const inject = vm.runInNewContext(`(${callback})`, context);
  inject({ net, session }, { version: '0.2.0', architecture: 'arm64', size: bytes.length, expected: 'a'.repeat(64), fileURL });
  assert.equal(await session.defaultSession.resolveProxy('https://api.github.com/'), 'DIRECT');
  assert.equal(await session.fromPartition('brclio-update-system').resolveProxy('https://api.github.com/'), 'DIRECT');
  const metadataURL = 'https://api.github.com/repos/Brclio/Brclio/releases/latest';
  const assetURL = 'https://github.com/Brclio/Brclio/releases/download/v0.2.0/Brclio-0.2.0-mac-arm64.dmg';
  assert.equal((await (await net.fetch(metadataURL)).json()).tag_name, 'v0.2.0');
  const builtin = session.fromPartition('brclio-update-direct');
  const proxyURL = url => 'https://tools.brclio.com/api/update?url=' + encodeURIComponent(url);
  assert.equal((await (await builtin.fetch(proxyURL(metadataURL))).json()).tag_name, 'v0.2.0');
  assert.deepEqual(Buffer.from(await (await builtin.fetch(proxyURL(assetURL))).arrayBuffer()), bytes);
  assert.deepEqual(nativeCalls, [fileURL]);
  await assert.rejects(builtin.fetch(proxyURL('https://unrecognized.example/')), /Unexpected update request/);
});
