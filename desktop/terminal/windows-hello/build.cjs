'use strict';

const path = require('node:path');
const fs = require('node:fs/promises');
const { execFileSync } = require('node:child_process');

const output = path.resolve(__dirname, '../../../runtime/win-x64/terminal-hello');
const binary = path.join(output, 'build/Release/brclio_hello.node');
async function build() {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Build the Windows Hello helper on Windows x64.');
  await fs.mkdir(output, { recursive: true });
  let stale = false;
  for (const name of ['hello.cpp', 'binding.gyp']) {
    const source = await fs.readFile(path.join(__dirname, name));
    const dest = path.join(output, name);
    if (!(await fs.readFile(dest).catch(() => Buffer.alloc(0))).equals(source)) { await fs.writeFile(dest, source); stale = true; }
  }
  if (stale) await fs.rm(binary, { force: true });
  if (stale || !await fs.stat(binary).catch(() => null)) {
    execFileSync(process.execPath, [require.resolve('node-gyp/bin/node-gyp.js'), 'rebuild', '--directory', output], { stdio: 'inherit' });
  }
  return binary;
}
module.exports = { build, binary };
if (require.main === module) build().then(async file => {
  const native = require(file), assert = require('node:assert/strict');
  const available = await native.available(); assert.equal(typeof available, 'boolean');
  assert.equal(await native.verify(Buffer.alloc(8)), false);
  assert.throws(() => native.verify(Buffer.from([1])));
  console.log('Windows Hello ABI verified. UserConsentVerifier available:', available);
}).catch(error => { console.error(error); process.exitCode = 1; });
