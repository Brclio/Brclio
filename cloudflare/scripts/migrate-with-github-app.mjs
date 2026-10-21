#!/usr/bin/env node
// Mint repository-scoped GitHub App credentials in memory, back up the source,
// then invoke the shared migration tool. Secret values never enter argv/files.
import {readFile, stat, lstat, mkdir, chmod} from 'node:fs/promises';
import {resolve, join, dirname} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {spawn} from 'node:child_process';
import {webcrypto} from 'node:crypto';
import {githubInstallationToken} from '../src/github-app.js';

if (!globalThis.crypto) globalThis.crypto = webcrypto;
const HERE = dirname(fileURLToPath(import.meta.url));
const PYTHON_MIGRATION = join(HERE, 'migrate-user-data.py');
const SHA = /^[0-9a-f]{40}$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const FLAGS = new Map([
  ['--app-id', 'appId'], ['--installation-id', 'installationId'], ['--private-key-file', 'privateKeyFile'],
  ['--source', 'source'], ['--target', 'target'], ['--source-head', 'sourceHead'], ['--target-head', 'targetHead'], ['--backup-dir', 'backupDir']
]);
const HELP = `Usage: node cloudflare/scripts/migrate-with-github-app.mjs
  --app-id ID --installation-id ID --private-key-file /absolute/key.pem
  [--source BrclioData/BrclioData] [--target BrclioData/BrclioUserData]
  [--source-head SHA] [--target-head SHA]

The default is a read-only plan. To apply, additionally provide:
  --apply --writers-frozen --source-head SHA --target-head SHA
  --backup-dir /absolute/new-private-directory

Apply first creates a private source.git mirror and source.bundle, verifies the
bundle and source HEAD, and preserves both files for recovery. Tokens are minted
from the App key in memory and passed to child processes only via environment.
`;

export class AppMigrationError extends Error {
  constructor(state, message = 'GitHub App migration stopped; inspect status and repository heads before retrying') {
    super(message); this.name = 'AppMigrationError'; this.state = state;
  }
}
const requireValue = value => { if (!value) throw new AppMigrationError({stage: 'arguments'}, 'Invalid migration arguments'); };
export function parseArguments(argv) {
  if (argv.length === 1 && argv[0] === '--help') return {help: true};
  const options = {source: 'BrclioData/BrclioData', target: 'BrclioData/BrclioUserData', apply: false, writersFrozen: false};
  const seen = new Set();
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    requireValue(!seen.has(flag)); seen.add(flag);
    if (flag === '--apply' || flag === '--writers-frozen') {
      options[flag === '--apply' ? 'apply' : 'writersFrozen'] = true; continue;
    }
    requireValue(FLAGS.has(flag));
    const value = argv[++index];
    requireValue(typeof value === 'string' && value.length > 0 && !value.startsWith('--') && !/[\0\r\n]/.test(value));
    options[FLAGS.get(flag)] = value;
  }
  requireValue(/^[1-9][0-9]{0,19}$/.test(options.appId || '') && /^[1-9][0-9]{0,19}$/.test(options.installationId || '') && options.privateKeyFile);
  for (const repository of [options.source, options.target]) {
    requireValue(REPOSITORY.test(repository) && repository.split('/').every(part => part !== '.' && part !== '..'));
  }
  requireValue(options.source.toLowerCase() !== options.target.toLowerCase());
  for (const head of [options.sourceHead, options.targetHead]) if (head !== undefined) requireValue(SHA.test(head));
  if (options.apply) requireValue(options.writersFrozen && options.sourceHead && options.targetHead && options.backupDir);
  else requireValue(!options.writersFrozen && !options.backupDir);
  options.privateKeyFile = resolve(options.privateKeyFile);
  if (options.backupDir) options.backupDir = resolve(options.backupDir);
  return options;
}

// Ignore inherited Git credential helpers, tracing/debug settings and credential
// variables. A clone receives exactly one transient extraheader through env.
export function childEnvironment(input = process.env) {
  const output = {};
  for (const [name, value] of Object.entries(input)) {
    if (/^(?:GIT_|GCM_|GH_|GITHUB_|SOURCE_GITHUB_|SSH_|PYTHON|NODE_OPTIONS$|NODE_DEBUG(?:_|$)|UNDICI_|SSLKEYLOGFILE$|DEBUG$|CURL_(?:VERBOSE|TRACE))/.test(name)) continue;
    output[name] = value;
  }
  return {...output, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never', PYTHONDONTWRITEBYTECODE: '1'};
}

export function runChild(command, args, options = {}) {
  return new Promise((fulfill, reject) => {
    const child = spawn(command, args, {cwd: options.cwd, env: options.env, stdio: ['ignore', 'pipe', 'pipe']});
    let stdout = '', stderrBytes = 0, overflow = false;
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('child failed')); }, options.timeout || 20 * 60 * 1000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', value => {
      stdout += value;
      if (Buffer.byteLength(stdout) > 1024 * 1024) { overflow = true; child.kill('SIGKILL'); }
    });
    // stderr is deliberately discarded: Git or a remote can include sensitive
    // URLs, diagnostics or header values despite otherwise sanitized settings.
    child.stderr.on('data', value => { stderrBytes += value.length; if (stderrBytes > 1024 * 1024) { overflow = true; child.kill('SIGKILL'); } });
    child.on('error', () => { clearTimeout(timer); reject(new Error('child failed')); });
    child.on('close', code => { clearTimeout(timer); if (overflow) reject(new Error('child failed')); else fulfill({code, stdout}); });
  });
}
function publicRepository(value, expected) {
  if (!value || typeof value !== 'object' || value.repository !== expected || typeof value.branch !== 'string' || !SHA.test(value.head) || !SHA.test(value.tree)) throw new Error('invalid summary');
  return {repository: value.repository, branch: value.branch, head: value.head, tree: value.tree};
}
function migrationSummary(raw, options) {
  const value = JSON.parse(raw);
  if (!value || value.operation !== (options.apply ? 'applied' : 'plan')) throw new Error('invalid summary');
  const summary = {operation: value.operation, source: publicRepository(value.source, options.source)};
  if (options.sourceHead && summary.source.head !== options.sourceHead) throw new Error('invalid source pin');
  if (options.apply) {
    summary.targetBefore = publicRepository(value.targetBefore, options.target);
    if (summary.targetBefore.head !== options.targetHead) throw new Error('invalid target pin');
    if (!SHA.test(value.targetHead) || !SHA.test(value.targetTree) || value.sourceRetained !== true || value.verified !== true) throw new Error('invalid summary');
    if (typeof value.backupRef !== 'string' || !/^refs\/heads\/codex\/backups\/user-data-migration\/[A-Za-z0-9-]+$/.test(value.backupRef) ||
      typeof value.manifestPath !== 'string' || !/^migrations\/[A-Za-z0-9-]+\.json$/.test(value.manifestPath)) throw new Error('invalid summary');
    Object.assign(summary, {targetHead: value.targetHead, targetTree: value.targetTree, backupRef: value.backupRef,
      manifestPath: value.manifestPath, sourceRetained: true, verified: true});
  } else {
    summary.target = publicRepository(value.target, options.target);
    if (options.targetHead && summary.target.head !== options.targetHead) throw new Error('invalid target pin');
    if (!/^[0-9a-f]{64}$/.test(value.expectedFilesDigest)) throw new Error('invalid summary');
    summary.expectedFilesDigest = value.expectedFilesDigest;
  }
  summary.counts = {};
  for (const key of ['users', 'sourceBlobs', 'derivedBrclioData', 'alreadyPresent', 'newFiles']) {
    if (!Number.isSafeInteger(value.counts?.[key]) || value.counts[key] < 0) throw new Error('invalid summary');
    summary.counts[key] = value.counts[key];
  }
  return summary;
}

export async function runMigration(options, dependencies = {}) {
  const state = {stage: 'configuration', backup: {status: 'not-created'}};
  const mint = dependencies.mint || githubInstallationToken;
  const execute = dependencies.runChild || runChild;
  const baseEnv = childEnvironment(dependencies.env || process.env);
  try {
    if (options.apply && !(options.writersFrozen === true && SHA.test(options.sourceHead || '') && SHA.test(options.targetHead || '') && options.backupDir)) throw new Error('invalid apply options');
    const keyInfo = await stat(options.privateKeyFile);
    if (!keyInfo.isFile() || keyInfo.size > 20000) throw new Error('invalid key file');
    const privateKey = await readFile(options.privateKeyFile, 'utf8');
    if (options.apply) {
      try { await lstat(options.backupDir); throw new Error('backup directory must be new'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    state.stage = 'app-authentication';
    const env = {GITHUB_APP_ID: options.appId, GITHUB_APP_INSTALLATION_ID: options.installationId, GITHUB_APP_PRIVATE_KEY: privateKey};
    const [sourceToken, targetToken] = await Promise.all([mint(env, options.source), mint(env, options.target)]);
    if (options.apply) {
      state.stage = 'backup-directory';
      await mkdir(options.backupDir, {mode: 0o700});
      await chmod(options.backupDir, 0o700);
      const mirror = join(options.backupDir, 'source.git'), bundle = join(options.backupDir, 'source.bundle');
      state.backup = {status: 'incomplete', directory: options.backupDir, mirror, bundle};
      const cloneEnv = {...baseEnv, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
        GIT_CONFIG_VALUE_0: 'Authorization: Basic ' + Buffer.from('x-access-token:' + sourceToken).toString('base64')};
      state.stage = 'backup-mirror';
      const cloned = await execute('git', ['clone', '--mirror', `https://github.com/${options.source}.git`, mirror], {env: cloneEnv, cwd: options.backupDir});
      if (cloned.code !== 0) throw new Error('clone failed');
      state.stage = 'backup-source-head';
      const head = await execute('git', ['--git-dir', mirror, 'rev-parse', 'HEAD'], {env: baseEnv, cwd: options.backupDir});
      if (head.code !== 0 || head.stdout.trim() !== options.sourceHead) throw new Error('source head mismatch');
      state.stage = 'backup-bundle';
      const bundled = await execute('git', ['--git-dir', mirror, 'bundle', 'create', bundle, '--all'], {env: baseEnv, cwd: options.backupDir});
      if (bundled.code !== 0) throw new Error('bundle failed');
      await chmod(bundle, 0o600);
      const bundleInfo = await stat(bundle);
      if (!bundleInfo.isFile() || bundleInfo.size === 0 || (bundleInfo.mode & 0o777) !== 0o600) throw new Error('invalid bundle');
      state.stage = 'backup-verification';
      const verified = await execute('git', ['--git-dir', mirror, 'bundle', 'verify', bundle], {env: baseEnv, cwd: options.backupDir});
      if (verified.code !== 0) throw new Error('bundle verification failed');
      state.backup.status = 'verified'; state.backup.sourceHead = options.sourceHead;
    }
    state.stage = 'migration';
    const args = ['-I', PYTHON_MIGRATION, '--source', options.source, '--target', options.target];
    if (options.sourceHead) args.push('--source-head', options.sourceHead);
    if (options.targetHead) args.push('--target-head', options.targetHead);
    if (options.apply) args.push('--apply', '--writers-frozen');
    const childEnv = {...baseEnv, GITHUB_INSTALLATION_TOKEN: targetToken, SOURCE_GITHUB_INSTALLATION_TOKEN: sourceToken};
    const migrated = await execute('python3', args, {env: childEnv, cwd: HERE});
    if (migrated.code !== 0) throw new Error('migration stopped');
    const summary = migrationSummary(migrated.stdout, options);
    if (options.apply) summary.localBackup = state.backup;
    return summary;
  } catch {
    // This exception carries only paths, a finite stage and backup status. Child
    // output, App private keys, JWTs and installation tokens are never included.
    throw new AppMigrationError(state);
  }
}

export async function main(argv = process.argv.slice(2)) {
  try {
    const options = parseArguments(argv);
    if (options.help) { process.stdout.write(HELP); return 0; }
    const summary = await runMigration(options);
    process.stdout.write(JSON.stringify(summary) + '\n');
    return 0;
  } catch (error) {
    const safe = error instanceof AppMigrationError ? error : new AppMigrationError({stage: 'configuration', backup: {status: 'not-created'}});
    process.stderr.write(JSON.stringify({operation: 'stopped', error: safe.message, ...safe.state}) + '\n');
    return 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exitCode = await main();
