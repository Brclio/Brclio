'use strict';

const path = require('node:path');
const { existsSync } = require('node:fs');
const { access, cp } = require('node:fs/promises');
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
  // electron-builder also rebuilds the addon in the developer's node_modules
  // without running node-pty's companion DLL copy step. Keep npm start usable
  // after building an installer.
  const developmentPty = path.dirname(require.resolve('node-pty/package.json'));
  for (const configuration of ['Release', 'Debug']) {
    const directory = path.join(developmentPty, 'build', configuration);
    if (existsSync(path.join(directory, 'conpty.node'))) {
      await cp(path.join(developmentPty, 'prebuilds', 'win32-' + arch, 'conpty'),
        path.join(directory, 'conpty'), { recursive: true });
    }
  }
  const result = build({ arch, version: context.packager.appInfo.version,
    output: path.join(context.appOutDir, 'resources', 'windows-shell') });
  console.log(JSON.stringify(result));
};
