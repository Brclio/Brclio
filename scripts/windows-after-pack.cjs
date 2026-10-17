'use strict';

const path = require('node:path');
const { build } = require('./windows-build-shell.cjs');

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return;
  const arch = typeof context.arch === 'string' ? context.arch : { 1: 'x64', 3: 'arm64' }[context.arch];
  if (arch !== 'x64') throw new Error('Brclio Windows Explorer extension currently requires an x64 application build.');
  const result = build({ arch, version: context.packager.appInfo.version,
    output: path.join(context.appOutDir, 'resources', 'windows-shell') });
  console.log(JSON.stringify(result));
};
