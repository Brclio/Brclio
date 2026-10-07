'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readWindowsEntries, QUERY_SCRIPT } = require('./windows-registry.cjs');
const { REGISTRY_KEYS, OWNER } = require('./integration.cjs');

const records = () => REGISTRY_KEYS.map(({ key }) => ({ key, exists: true, owner: OWNER,
  label: '复制路径 · Brclio', icon: "C:\\用户's & folder\\Brclio.exe", model: 'Single',
  command: '"C:\\用户 中文 & folder\\Brclio.exe" --copy-path -- "%1"' }));

test('Windows registry reading retains Unicode and quotes through explicit UTF-8 JSON', async () => {
  const expected = records();
  let invocation;
  const actual = await readWindowsEntries(async (program, args) => {
    invocation = { program, args };
    return { stdout: JSON.stringify(expected) };
  }, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  assert.deepEqual(actual, expected);
  assert.equal(Buffer.from(invocation.args.at(-1), 'base64').toString('utf16le'), QUERY_SCRIPT);
  assert.deepEqual(invocation.args.slice(0, -1), ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand']);
  assert.match(QUERY_SCRIPT, /OpenBaseKey\(\[Microsoft.Win32.RegistryHive\]::CurrentUser, \[Microsoft.Win32.RegistryView\]::Registry64\)/);
  assert.match(QUERY_SCRIPT, /\[Text.Encoding\]::UTF8.GetBytes/);
  assert.match(QUERY_SCRIPT, /OpenStandardOutput/);
  assert.doesNotMatch(QUERY_SCRIPT, /用户|folder|Brclio.exe/);
});

test('Windows registry reading rejects truncated, malformed, and incorrectly typed native results', async () => {
  for (const value of ['[]', 'not json', JSON.stringify([{ ...records()[0], exists: 1 }, ...records().slice(1)]), JSON.stringify(records().map(item => ({ ...item, command: 42 }))), ' '.repeat(256 * 1024 + 1)]) {
    await assert.rejects(readWindowsEntries(async () => ({ stdout: value }), 'powershell.exe'));
  }
  await assert.rejects(readWindowsEntries(async () => ({ stdout: JSON.stringify([records()[0], records()[0], records()[2]]) }), 'powershell.exe'));
  const missing = records().map(item => ({ ...item, exists: false, owner: null, label: null, icon: null, model: null, command: null }));
  assert.deepEqual(await readWindowsEntries(async () => ({ stdout: JSON.stringify(missing) }), 'powershell.exe'), missing);
});
