import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const INSTALLER = /\.(exe|dmg|zip|apk)$/i;
const MANIFEST = 'SHA256SUMS.txt';

export function releaseFilenames(version) {
  if (!VERSION.test(version)) throw new Error('Release version must use X.Y.Z without a v prefix.');
  return [
    `Brclio-${version}-windows-x64.exe`,
    `Brclio-${version}-mac-arm64.dmg`,
    `Brclio-${version}-mac-arm64.zip`,
    `Brclio-${version}-mac-x64.dmg`,
    `Brclio-${version}-mac-x64.zip`,
    `Brclio-${version}-android.apk`,
  ].sort();
}

async function packageNames(directory, version) {
  const names = (await readdir(directory)).filter(name => INSTALLER.test(name)).sort();
  if (!names.length) throw new Error('No installer files found; refusing to create an empty manifest.');
  if (version) {
    const expected = releaseFilenames(version);
    const missing = expected.filter(name => !names.includes(name));
    const extra = names.filter(name => !expected.includes(name));
    if (missing.length || extra.length) throw new Error(`Incomplete release. Missing: ${missing.join(', ') || 'none'}. Unexpected installers: ${extra.join(', ') || 'none'}.`);
  }
  for (const name of names) {
    if (/[\r\n\\]/.test(name)) throw new Error('Installer filename contains unsupported characters.');
    const stats = await lstat(path.join(directory, name));
    if (!stats.isFile() || stats.isSymbolicLink() || stats.size === 0) throw new Error(`Installer is not a nonempty regular file: ${name}`);
  }
  return names;
}

async function hashFile(filename) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}

export async function createManifest(directory, { version } = {}) {
  const names = await packageNames(directory, version);
  const lines = [];
  for (const name of names) lines.push(`${await hashFile(path.join(directory, name))}  ${name}`);
  await writeFile(path.join(directory, MANIFEST), lines.join('\n') + '\n');
  return names;
}

export async function verifyManifest(directory, { version } = {}) {
  const names = await packageNames(directory, version);
  const text = await readFile(path.join(directory, MANIFEST), 'utf8');
  const entries = new Map();
  for (const line of text.trimEnd().split(/\r?\n/)) {
    const match = /^([a-f0-9]{64}) {2}([^/\\\r\n]+)$/.exec(line);
    if (!match || match[2] === '.' || match[2] === '..' || entries.has(match[2])) throw new Error('Invalid or duplicate SHA256SUMS entry.');
    entries.set(match[2], match[1]);
  }
  if (names.length !== entries.size || names.some(name => !entries.has(name))) throw new Error('Manifest does not match the complete installer set.');
  for (const name of names) {
    if (await hashFile(path.join(directory, name)) !== entries.get(name)) throw new Error(`SHA-256 mismatch: ${name}`);
  }
  return names;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    const directory = args.shift();
    if (!directory || directory.startsWith('--')) throw new Error('Usage: node scripts/checksums.mjs DIRECTORY [--version X.Y.Z] [--verify]');
    let version;
    let verify = false;
    while (args.length) {
      const argument = args.shift();
      if (argument === '--version' && args.length && version === undefined) {
        version = args.shift();
        releaseFilenames(version);
      }
      else if (argument === '--verify' && !verify) verify = true;
      else throw new Error(`Unknown or repeated argument: ${argument}`);
    }
    if (version) releaseFilenames(version);
    const names = await (verify ? verifyManifest : createManifest)(path.resolve(directory), { version });
    console.log(`${verify ? 'Verified' : 'Wrote'} ${MANIFEST} for ${names.length} installer files.`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
