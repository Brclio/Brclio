'use strict';

const path = require('node:path');
const { existsSync } = require('node:fs');
const { access } = require('node:fs/promises');
const { build } = require('./windows-build-shell.cjs');

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return;
  const arch = typeof context.arch === 'string' ? context.arch : { 1: 'x64', 3: 'arm64' }[context.arch];
  if (arch !== 'x64') throw new Error('Brclio Windows Explorer extension currently requires an x64 application build.');
  // node-pty looks for conpty.dll next to the selected addon, under conpty/.
  // Keep the native binaries and worker from the same verified prebuild.
  const ptyRoot = path.join(context.appOutDir, 'resources', 'app.asar.unpacked', 'node_modules', 'node-pty');
  const prebuilt = path.join(ptyRoot, 'prebuilds', 'win32-' + arch);
  await Promise.all([
    access(path.join(ptyRoot, 'lib', 'index.js')),
    access(path.join(ptyRoot, 'lib', 'worker', 'conoutSocketWorker.js')),
    ...['conpty.node', 'conpty_console_list.node', 'conpty/conpty.dll', 'conpty/OpenConsole.exe']
      .map(file => access(path.join(prebuilt, file))),
  ]);
  if (['Release', 'Debug'].some(type => existsSync(path.join(ptyRoot, 'build', type, 'conpty.node')))) {
    throw new Error('Another conpty.node shadows the packaged Windows prebuild.');
  }
  const result = build({ arch, version: context.packager.appInfo.version,
    output: path.join(context.appOutDir, 'resources', 'windows-shell') });
  console.log(JSON.stringify(result));
};
