'use strict';

// Optional local audit; the source repository is deliberately not a CI dependency.
// The downloader baseline supplied for this migration is recorded for review.
const fs = require('node:fs/promises');
const path = require('node:path');
const vm = require('node:vm');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');

const BASELINE_COMMIT = 'a818212fc0d4450f8cf192e644cdc2f39103e810';
const DEFAULT_SOURCE = '/Users/bornforthis/Github/WebSite/xhs-images-video-vercel-downloader';
const ROOT = path.resolve(__dirname, '..');
const MODULES = [
  'lib/archive.js',
  'lib/image-dimensions.js',
  'lib/media-tracks.js',
  'desktop/native-clipboard.js',
  'desktop/login-state.js',
  'desktop/note-state.js',
  'desktop/profile-source.js',
  'desktop/xhs-login-reset.js',
  'api/python_image.py',
];

function argumentsFor(args) {
  const options = { source: process.env.XHS_SOURCE_DIRECTORY || DEFAULT_SOURCE, json: false, help: false };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--json') options.json = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--source') {
      const value = args[++index];
      if (!value || value.startsWith('--')) throw new Error('--source requires a source repository directory.');
      options.source = value;
    } else if (arg.startsWith('--source=')) {
      options.source = arg.slice('--source='.length);
      if (!options.source) throw new Error('--source requires a source repository directory.');
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

// These source functions use an unindented closing brace. Preserve their exact
// text, and compile the extracted expression to fail if that boundary is invalid.
// This is intentionally a narrow provenance check, not a JavaScript reformatter.
function exportedFunction(source, name, filename) {
  const pattern = new RegExp(`^export (?:async )?function ${name}\\(`, 'gm');
  const matches = [...source.matchAll(pattern)];
  if (matches.length !== 1) throw new Error(`${filename}: expected one exported ${name} function.`);
  const start = matches[0].index;
  const remainder = source.slice(start);
  const closing = /^\}(?:\r?$)/m.exec(remainder);
  if (!closing) throw new Error(`${filename}: cannot locate the closing brace of ${name}.`);
  const result = remainder.slice(0, closing.index + 1);
  try { new vm.Script(`(${result.replace(/^export /, '')})`, { filename }); }
  catch { throw new Error(`${filename}: ${name} no longer matches the supported function layout.`); }
  return Buffer.from(result);
}

const digest = bytes => createHash('sha256').update(bytes).digest('hex');

async function main() {
  const options = argumentsFor(process.argv.slice(2));
  if (options.help) {
    console.log('Usage: node scripts/check-xhs-source-parity.cjs [--source DIRECTORY] [--json]\n'
      + 'Source: --source, then XHS_SOURCE_DIRECTORY, then the local downloader checkout.\n'
      + 'Read-only and optional; checks exact copied functions and modules, without modifying files.');
    return;
  }
  const source = path.resolve(options.source);
  try {
    if (!(await fs.stat(source)).isDirectory()) throw new Error('Not a directory');
  } catch {
    throw new Error(`Cannot access XHS source repository: ${source}. Set --source DIRECTORY or XHS_SOURCE_DIRECTORY. This local audit is not required by CI.`);
  }
  let sourceCommit;
  try { sourceCommit = execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
  catch { throw new Error(`Cannot read Git HEAD in XHS source repository: ${source}`); }
  const sourceFiles = [...MODULES, 'lib/xhs.js', 'desktop/update-manager.js'];
  const dirty = execFileSync('git', ['-C', source, 'status', '--short', '--', ...sourceFiles],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const checks = [];
  async function check(sourceFile, targetFile, functionName) {
    const sourcePath = path.join(source, sourceFile), targetPath = path.join(ROOT, targetFile);
    let original, copied;
    try { [original, copied] = await Promise.all([fs.readFile(sourcePath), fs.readFile(targetPath)]); }
    catch (error) { throw new Error(`Cannot read parity input ${error.path || ''}: ${error.code || error.message}`); }
    if (functionName) {
      original = exportedFunction(original.toString('utf8'), functionName, sourcePath);
      copied = exportedFunction(copied.toString('utf8'), functionName, targetPath);
    }
    checks.push({ name: functionName || sourceFile, sourceFile, targetFile,
      identical: original.equals(copied), sourceSha256: digest(original), targetSha256: digest(copied) });
  }
  await check('lib/xhs.js', 'desktop/xhs/lib/xhs.js', 'fetchNotePage');
  await check('desktop/update-manager.js', 'desktop/xhs/desktop/electron-fetch.js', 'createElectronUpdateFetch');
  for (const filename of MODULES) await check(filename, `desktop/xhs/${filename}`);
  const report = { passed: checks.every(check => check.identical), sourceDirectory: source,
    sourceCommit, migrationBaselineCommit: BASELINE_COMMIT,
    sourceChanges: dirty ? dirty.split('\n') : [], checks };
  if (options.json) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(`XHS source HEAD: ${sourceCommit}`);
    console.log(`Migration baseline: ${BASELINE_COMMIT}`);
    if (dirty) console.log('Source has local changes in audited files; comparison uses current file bytes.');
    for (const check of checks) console.log(`${check.identical ? 'PASS' : 'FAIL'} ${check.name}`);
    console.log(`${checks.filter(check => check.identical).length}/${checks.length} source parity checks passed.`);
  }
  if (!report.passed) process.exitCode = 1;
}

main().catch(error => { console.error(`XHS source parity audit failed: ${error.message}`); process.exitCode = 2; });
