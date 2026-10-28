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
  'lib/xhs.js',
  'lib/archive.js',
  'lib/image-dimensions.js',
  'lib/media-tracks.js',
  'desktop/native-clipboard.js',
  'desktop/login-state.js',
  'desktop/note-state.js',
  'desktop/profile-source.js',
  'desktop/xhs-login-reset.js',
  'api/image.js',
  'api/python_image.py',
];
const FUNCTIONS = [
  ['desktop/update-manager.js', 'desktop/xhs/desktop/electron-fetch.js', 'createElectronUpdateFetch'],
  ...['inspectVideoHandle', 'safeFilename', 'abortError', 'throwIfAborted', 'sleep', 'assertSafeDirectory',
    'ensureNoteDirectory', 'noteDirectoryName', 'isSafeDirectoryName', 'renameNoteDirectory',
    'assertSafeTarget', 'atomicWrite', 'verifyFile', 'detectImageType', 'cancelQuietly', 'abortableOperation']
    .map(name => ['desktop/media-download.js', 'desktop/xhs/desktop/media-download.js', name]),
  ...['parseSafeInteger', 'parseContentRange', 'readBufferWithLimit', 'getSourceUrl']
    .map(name => ['api/video.js', 'desktop/xhs/api/video.js', name]),
  ...['formatBytes', 'declaredVideoSize', 'archiveLimitProfile', 'isArchiveSizeLimitError', 'createArchiveBudget',
    'readApiError', 'imageTooLargeError', 'responseSizeLimitError', 'responseBlobWithLimit', 'fetchImageBlob',
    'readVideoApiError', 'getVideoMeta', 'videoTooLargeError', 'videoSizeLimitError', 'assertVideoSizeWithinLimit',
    'downloadVideoByChunks', 'tryDirectVideoDownload', 'fetchVideoBlobWithFallback', 'preflightLiveArchive',
    'fetchImageArchiveData', 'fetchVideoArchiveData']
    .map(name => ['app.js', 'desktop/xhs/lib/source-download.js', name]),
];
const DOWNLOAD_CONSTANTS = ['MEBIBYTE', 'DESKTOP_ARCHIVE_LIMIT_BYTES', 'CONSTRAINED_ARCHIVE_LIMIT_BYTES',
  'ARCHIVE_OVERHEAD_RESERVE_BYTES', 'ARCHIVE_SIZE_LIMIT_ERROR'];
// These whole files bind the source units to Brclio's account, IPC, lifecycle,
// packaging or UI. Record their hashes separately: passing a copied-unit check
// never certifies that these adaptations have identical download behavior.
const ADAPTATIONS = [
  ['api/parse.js', 'desktop/xhs/api/parse.js', 'API response exposes original candidates without the source membership filter.'],
  ['api/video.js', 'desktop/xhs/api/video.js', 'Source membership checks are outside this client; video helper functions are checked separately.'],
  ['api/python_parse.py', 'desktop/xhs/api/python_parse.py', 'HTTP response adapter differs; all parser and page-fetch helpers are checked separately.'],
  ['api/python_video.py', 'desktop/xhs/api/python_video.py', 'Source membership path gate is omitted.'],
  ['desktop/python-worker.py', 'desktop/xhs/python-worker.py', 'Worker source root and installed runtime layout differ.'],
  ['desktop/python-backend.js', 'desktop/xhs/desktop/python-backend.js', 'Packaged paths and application shutdown integration differ.'],
  ['desktop/media-download.js', 'desktop/xhs/desktop/media-download.js', 'Source membership checks are outside this client; copied filesystem helpers are checked separately.'],
  ['desktop/native-video-download.js', 'desktop/xhs/desktop/native-video-download.js', 'Native save, error and progress integration uses Brclio IPC.'],
  ['desktop/image-clipboard.js', 'desktop/xhs/desktop/image-clipboard.js', 'Clipboard transfer lifetime and account integration differ.'],
  ['desktop/profile-browser.js', 'desktop/xhs/desktop/profile-browser.js', 'Brclio session partition, cancellation and discovery recovery integration differ.'],
  ['desktop/profile-manager.js', 'desktop/xhs/desktop/profile-manager.js', 'Brclio queue integration and account gates differ.'],
  ['desktop/main.js', 'desktop/xhs/index.mjs', 'Application service, IPC and filesystem host adapter; not a whole-file source copy.'],
  ['app.js', 'web/xhs.js', 'Renderer bindings and download orchestration; not a whole-file source copy.'],
  ['app.js', 'desktop/xhs/lib/source-download.js', 'Dependency-injected factory; its 21 source download functions and five archive constants are checked individually.'],
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
function copiedFunction(source, name, filename) {
  const pattern = new RegExp(`^(?:export )?(?:async )?function ${name}\\(`, 'gm');
  const matches = [...source.matchAll(pattern)];
  if (matches.length !== 1) throw new Error(`${filename}: expected one ${name} function.`);
  const start = matches[0].index;
  const remainder = source.slice(start);
  const closing = /^\}(?:\r?$)/m.exec(remainder);
  if (!closing) throw new Error(`${filename}: cannot locate the closing brace of ${name}.`);
  const result = remainder.slice(0, closing.index + 1);
  try { new vm.Script(`(${result.replace(/^export /, '')})`, { filename }); }
  catch { throw new Error(`${filename}: ${name} no longer matches the supported function layout.`); }
  return Buffer.from(result);
}

function pythonParserCore(bytes, filename) {
  const source = bytes.toString('utf8');
  const end = source.indexOf('\nclass handler(');
  if (end < 0) throw new Error(`${filename}: cannot locate the Python HTTP adapter boundary.`);
  let core = source.slice(0, end + 1);
  // These two helpers implement the source product's public/member video
  // filtering. They are not used by Brclio. Every other helper, including page
  // fetching, redirect validation, extraction, ordering and pairing, is exact.
  for (const name of ['is_public_playback_video_url', 'public_playback_video']) {
    const declaration = new RegExp(`^def ${name}\\(`, 'm').exec(core);
    if (!declaration) continue;
    const start = declaration.index;
    const next = /^(?:def |class )/m.exec(core.slice(start + declaration[0].length));
    if (!next) throw new Error(`${filename}: cannot locate the end of Python membership helper ${name}.`);
    core = core.slice(0, start) + core.slice(start + declaration[0].length + next.index);
  }
  return Buffer.from(core);
}

const digest = bytes => createHash('sha256').update(bytes).digest('hex');

async function main() {
  const options = argumentsFor(process.argv.slice(2));
  if (options.help) {
    console.log('Usage: node scripts/check-xhs-source-parity.cjs [--source DIRECTORY] [--json]\n'
      + 'Source: --source, then XHS_SOURCE_DIRECTORY, then the local downloader checkout.\n'
      + 'Read-only and optional; checks exact copied functions and modules, without modifying files.\n'
      + 'Host/API adaptations are listed separately and are not certified identical by this audit.');
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
  const sourceFiles = [...new Set([...MODULES, ...FUNCTIONS.map(item => item[0]), ...ADAPTATIONS.map(item => item[0])])];
  const dirty = execFileSync('git', ['-C', source, 'status', '--short', '--', ...sourceFiles],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const checks = [];
  async function check(sourceFile, targetFile, functionName, select) {
    const sourcePath = path.join(source, sourceFile), targetPath = path.join(ROOT, targetFile);
    let original, copied;
    try { [original, copied] = await Promise.all([fs.readFile(sourcePath), fs.readFile(targetPath)]); }
    catch (error) { throw new Error(`Cannot read parity input ${error.path || ''}: ${error.code || error.message}`); }
    if (functionName) {
      original = copiedFunction(original.toString('utf8'), functionName, sourcePath);
      copied = copiedFunction(copied.toString('utf8'), functionName, targetPath);
    } else if (select) {
      original = select(original, sourcePath);
      copied = select(copied, targetPath);
    }
    checks.push({ name: functionName ? `${sourceFile}#${functionName}` : select ? `${sourceFile}#parser-and-page-fetch-core` : sourceFile,
      scope: functionName ? 'function' : select ? 'python-core-without-membership-filters' : 'whole-file', sourceFile, targetFile,
      identical: original.equals(copied), sourceSha256: digest(original), targetSha256: digest(copied) });
  }
  for (const filename of MODULES) await check(filename, `desktop/xhs/${filename}`);
  await check('lib/xhs.js', 'web/xhs/lib/xhs-parser.js');
  for (const [sourceFile, targetFile, functionName] of FUNCTIONS) await check(sourceFile, targetFile, functionName);
  for (const name of DOWNLOAD_CONSTANTS) {
    const select = (bytes, filename) => {
      const matches = [...bytes.toString('utf8').matchAll(new RegExp(`^const ${name} = .+;$`, 'gm'))];
      if (matches.length !== 1) throw new Error(`${filename}: expected one ${name} declaration.`);
      return Buffer.from(matches[0][0]);
    };
    await check('app.js', 'desktop/xhs/lib/source-download.js', undefined, select);
    checks[checks.length - 1].name = `app.js#${name}`;
    checks[checks.length - 1].scope = 'constant';
  }
  await check('api/python_parse.py', 'desktop/xhs/api/python_parse.py', undefined, pythonParserCore);
  const adaptations = [];
  for (const [sourceFile, targetFile, reason] of ADAPTATIONS) {
    const [original, copied] = await Promise.all([fs.readFile(path.join(source, sourceFile)), fs.readFile(path.join(ROOT, targetFile))]);
    adaptations.push({ sourceFile, targetFile, reason, identical: original.equals(copied),
      sourceSha256: digest(original), targetSha256: digest(copied) });
  }
  const report = { passed: checks.every(check => check.identical), sourceDirectory: source,
    sourceCommit, migrationBaselineCommit: BASELINE_COMMIT,
    scope: 'Copied source units only. Host/API adaptations require separate behavioral verification.',
    sourceChanges: dirty ? dirty.split('\n') : [], checks, adaptations };
  if (options.json) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(`XHS source HEAD: ${sourceCommit}`);
    console.log(`Migration baseline: ${BASELINE_COMMIT}`);
    if (dirty) console.log('Source has local changes in audited files; comparison uses current file bytes.');
    for (const check of checks) console.log(`${check.identical ? 'PASS' : 'FAIL'} ${check.name}`);
    console.log(`${checks.filter(check => check.identical).length}/${checks.length} copied source unit checks passed.`);
    console.log('Host/API adaptations below are NOT certified identical by these checks:');
    for (const item of adaptations) console.log(`ADAPTED ${item.targetFile}: ${item.reason}`);
  }
  if (!report.passed) process.exitCode = 1;
}

main().catch(error => { console.error(`XHS source parity audit failed: ${error.message}`); process.exitCode = 2; });
