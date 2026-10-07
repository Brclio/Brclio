#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const options = { arch: process.arch, version: JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version };
for (let index = 2; index < process.argv.length; index += 2) {
  const flag = process.argv[index];
  if (!['--arch', '--version', '--output'].includes(flag) || !process.argv[index + 1]) {
    throw new Error('Usage: node scripts/build-mac-finder-extension.mjs [--arch arm64|x64] [--version X.Y.Z] [--output /path/BrclioFinderSync.appex]');
  }
  options[flag.slice(2)] = process.argv[index + 1];
}
if (process.platform !== 'darwin') throw new Error('Finder Sync extension compilation requires macOS and Xcode command-line tools.');
if (!['arm64', 'x64'].includes(options.arch)) throw new Error(`Unsupported architecture: ${options.arch}`);
if (!/^\d+\.\d+\.\d+$/.test(options.version)) throw new Error(`Expected numeric release version X.Y.Z; received ${options.version}`);

const output = path.resolve(options.output ?? path.join(root, 'native', 'macos', 'build', options.arch, 'BrclioFinderSync.appex'));
if (path.basename(output) !== 'BrclioFinderSync.appex') throw new Error('Output must end with BrclioFinderSync.appex.');
const native = path.join(root, 'native', 'macos');
const temporary = mkdtempSync(path.join(os.tmpdir(), 'brclio-finder-build-'));
const bundle = path.join(temporary, 'BrclioFinderSync.appex');
function run(executable, args, extra = {}) {
  return execFileSync(executable, args, { encoding: 'utf8', stdio: [extra.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'], ...extra }).trim();
}
try {
  mkdirSync(path.join(bundle, 'Contents', 'MacOS'), { recursive: true });
  mkdirSync(path.join(bundle, 'Contents', 'Resources'), { recursive: true });
  writeFileSync(path.join(bundle, 'Contents', 'Info.plist'), readFileSync(path.join(native, 'Info.plist'), 'utf8').replaceAll('__VERSION__', options.version));
  const sdk = run('xcrun', ['--sdk', 'macosx', '--show-sdk-path']);
  const target = `${options.arch === 'x64' ? 'x86_64' : 'arm64'}-apple-macos12.0`;
  run('xcrun', ['--sdk', 'macosx', 'swiftc', '-sdk', sdk, '-target', target,
    '-module-name', 'BrclioFinderSync', '-swift-version', '5', '-O',
    '-emit-executable', '-application-extension', '-parse-as-library',
    '-Xlinker', '-e', '-Xlinker', '_NSExtensionMain',
    '-framework', 'FinderSync', '-framework', 'AppKit', '-framework', 'Foundation',
    path.join(native, 'FinderSync.swift'), '-o', path.join(bundle, 'Contents', 'MacOS', 'BrclioFinderSync')]);
  run('/usr/bin/plutil', ['-lint', path.join(bundle, 'Contents', 'Info.plist')]);
  run('/usr/bin/codesign', ['--force', '--sign', '-', '--entitlements', path.join(native, 'FinderSync.entitlements'), '--timestamp=none', bundle]);
  run('/usr/bin/codesign', ['--verify', '--strict', '--verbose=2', bundle]);
  const entitlements = run('/usr/bin/codesign', ['--display', '--entitlements', '-', '--xml', bundle]);
  const encoded = run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '-'], { input: entitlements });
  const signed = JSON.parse(encoded);
  if (signed['com.apple.security.app-sandbox'] !== true ||
      signed['com.apple.security.files.user-selected.read-only'] !== true ||
      signed['com.apple.security.inherit'] === true) {
    throw new Error('Finder Sync must carry its own sandbox and user-selected read-only entitlements, without inherit.');
  }
  const architectures = run('/usr/bin/lipo', ['-archs', path.join(bundle, 'Contents', 'MacOS', 'BrclioFinderSync')]);
  if (architectures !== (options.arch === 'x64' ? 'x86_64' : 'arm64')) throw new Error(`Unexpected architecture: ${architectures}`);
  mkdirSync(path.dirname(output), { recursive: true });
  rmSync(output, { recursive: true, force: true });
  renameSync(bundle, output);
  console.log(JSON.stringify({ output, bundleId: 'com.brclio.toolbox.finder-sync', version: options.version, arch: options.arch, signature: 'adhoc', sandbox: true }));
} catch (error) {
  if (error.stderr) process.stderr.write(error.stderr.toString());
  throw error;
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
