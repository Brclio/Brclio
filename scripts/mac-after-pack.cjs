'use strict';

const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execute = promisify(execFile);

// FinderSync lives outside app.asar. electron-builder 26 deliberately excludes
// Contents/PlugIns from automatic signing, so the native build script signs the
// complete .appex with its own sandbox entitlements before the parent is sealed.
module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const arch = typeof context.arch === 'string' ? context.arch : { 1: 'x64', 3: 'arm64' }[context.arch];
  if (!['arm64', 'x64'].includes(arch)) throw new Error('FinderSync packaging requires an arm64 or x64 build.');
  const identity = context.packager.platformSpecificBuildOptions.identity;
  if (identity !== '-') {
    throw new Error('FinderSync currently supports ad-hoc signing only. Sign the containing app with identity "-"; a future Developer ID build must sign both targets consistently.');
  }
  const version = context.packager.appInfo.version;
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const output = path.join(app, 'Contents', 'PlugIns', 'BrclioFinderSync.appex');
  const buildScript = path.join(__dirname, 'build-mac-finder-extension.mjs');
  const result = await execute(process.execPath, [buildScript, '--arch', arch, '--version', version, '--output', output], {
    cwd: path.resolve(__dirname, '..'), maxBuffer: 4 * 1024 * 1024, timeout: 120000,
  });
  if (result.stdout.trim()) console.log(result.stdout.trim());
  if (result.stderr.trim()) console.error(result.stderr.trim());
};
