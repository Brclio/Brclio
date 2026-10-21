import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, readFile, stat, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {AppMigrationError, childEnvironment, parseArguments, runChild, runMigration} from '../scripts/migrate-with-github-app.mjs';

const sourceToken = 'ghs_' + 'a'.repeat(40), targetToken = 'ghs_' + 'b'.repeat(40);
const required = ['--app-id', '12345', '--installation-id', '98765', '--private-key-file', '/tmp/example-app.pem'];
const sourceHead = '1'.repeat(40), targetHead = '2'.repeat(40);
const counts = {users: 1, sourceBlobs: 3, derivedBrclioData: 1, alreadyPresent: 0, newFiles: 4};
const repository = (name, head) => ({repository: name, branch: 'main', head, tree: '3'.repeat(40)});
function summary(options, head = sourceHead) {
  if (!options.apply) return {operation: 'plan', source: repository(options.source, head), target: repository(options.target, targetHead), counts, expectedFilesDigest: 'a'.repeat(64)};
  return {operation: 'applied', source: repository(options.source, head), targetBefore: repository(options.target, targetHead),
    counts, targetHead: '4'.repeat(40), targetTree: '5'.repeat(40), sourceRetained: true, verified: true,
    backupRef: 'refs/heads/codex/backups/user-data-migration/20261021T010101Z-test123', manifestPath: 'migrations/20261021T010101Z-test123.json'};
}
async function setup(context) {
  const root = await mkdtemp(join(tmpdir(), 'brclio-app-migration-'));
  context.after(() => rm(root, {recursive: true, force: true}));
  const keyFile = join(root, 'app.pem'); await writeFile(keyFile, 'private-key-value-must-never-reach-subprocess-env', {mode: 0o600});
  return {root, keyFile, options: parseArguments(['--app-id', '12345', '--installation-id', '98765', '--private-key-file', keyFile])};
}
function git(args, cwd) {
  const result = spawnSync('git', args, {cwd, encoding: 'utf8', env: childEnvironment(process.env)});
  assert.equal(result.status, 0, 'Local Git fixture command failed');
  return result.stdout.trim();
}
async function gitSource(root) {
  const path = join(root, 'source-origin'); await mkdir(path);
  git(['init', '--initial-branch=main'], path);
  await writeFile(join(path, 'record.json'), '{"preserved":"original bytes"}\n');
  git(['add', 'record.json'], path);
  git(['-c', 'user.name=Migration Test', '-c', 'user.email=migration@example.test', 'commit', '-m', 'Initial source'], path);
  git(['branch', 'extra-reference'], path);
  git(['tag', 'preserved-tag'], path);
  return {path, head: git(['rev-parse', 'HEAD'], path)};
}

test('CLI parsing defaults to plan and requires exact pins, frozen writers and a new backup path for apply', () => {
  const plan = parseArguments(required);
  assert.equal(plan.apply, false); assert.equal(plan.source, 'BrclioData/BrclioData'); assert.equal(plan.target, 'BrclioData/BrclioUserData');
  const applied = parseArguments([...required, '--apply', '--writers-frozen', '--source-head', sourceHead, '--target-head', targetHead, '--backup-dir', '/tmp/fresh-backup']);
  assert.equal(applied.apply, true); assert.equal(applied.backupDir, '/tmp/fresh-backup');
  for (const args of [
    [], [...required, '--unexpected'], [...required, '--app-id', '5'], [...required, '--apply'],
    [...required, '--writers-frozen'], [...required, '--backup-dir', '/tmp/unused'],
    [...required, '--source', '../repo'], [...required, '--target', 'BrclioData/BrclioData'],
    [...required, '--source-head', 'bad'], [...required, '--target-head', 'a'.repeat(39)],
    [...required, '--apply', '--writers-frozen', '--source-head', sourceHead, '--target-head', targetHead],
    [...required, '--source', 'owner/repo\ncredential'], [...required, '--private-key-file'], ['--help', ...required]
  ]) assert.throws(() => parseArguments(args), AppMigrationError);
  assert.deepEqual(parseArguments(['--help']), {help: true});
});

test('child environment removes credential and trace inputs before adding transient clone credentials', () => {
  const env = childEnvironment({PATH: '/bin', KEEP: 'yes', GITHUB_TOKEN: 'old-personal-token', GITHUB_APP_PRIVATE_KEY: 'secret', SOURCE_GITHUB_INSTALLATION_TOKEN: sourceToken,
    GIT_TRACE: '1', GIT_TRACE_CURL: '1', GIT_CURL_VERBOSE: '1', GIT_CONFIG_COUNT: '3', GIT_CONFIG_VALUE_0: 'secret', GIT_ASKPASS: '/untrusted',
    GCM_TRACE: '1', GH_DEBUG: 'api', NODE_OPTIONS: '--require untrusted', NODE_DEBUG: 'http', SSLKEYLOGFILE: '/untrusted/tls.log', PYTHONPATH: '/untrusted', DEBUG: '*'});
  assert.equal(env.KEEP, 'yes'); assert.equal(env.PATH, '/bin');
  for (const key of ['GITHUB_TOKEN', 'GITHUB_APP_PRIVATE_KEY', 'SOURCE_GITHUB_INSTALLATION_TOKEN', 'GIT_TRACE', 'GIT_TRACE_CURL', 'GIT_CURL_VERBOSE', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_VALUE_0', 'GIT_ASKPASS', 'GCM_TRACE', 'GH_DEBUG', 'NODE_OPTIONS', 'NODE_DEBUG', 'SSLKEYLOGFILE', 'PYTHONPATH', 'DEBUG']) assert.equal(env[key], undefined, key);
  assert.equal(env.GIT_CONFIG_GLOBAL, '/dev/null'); assert.equal(env.GIT_CONFIG_NOSYSTEM, '1'); assert.equal(env.GIT_TERMINAL_PROMPT, '0');
});

test('plan mints distinct single-repository credentials and passes them only through isolated Python environment', async context => {
  const {options} = await setup(context), calls = [], issued = [];
  const result = await runMigration(options, {
    env: {PATH: process.env.PATH, GITHUB_TOKEN: 'must-not-inherit', GITHUB_APP_PRIVATE_KEY: 'must-not-inherit'},
    mint: async (env, repo) => { issued.push(repo); assert.equal(env.GITHUB_APP_ID, '12345'); assert.ok(env.GITHUB_APP_PRIVATE_KEY.startsWith('private-key-value')); return repo === options.source ? sourceToken : targetToken; },
    runChild: async (command, args, config) => {
      calls.push({command, args, config});
      assert.equal(command, 'python3'); assert.equal(args[0], '-I');
      assert.equal(config.env.GITHUB_INSTALLATION_TOKEN, targetToken); assert.equal(config.env.SOURCE_GITHUB_INSTALLATION_TOKEN, sourceToken);
      assert.equal(config.env.GITHUB_TOKEN, undefined); assert.equal(config.env.GITHUB_APP_PRIVATE_KEY, undefined);
      assert.ok(!args.join(' ').includes('ghs_')); assert.ok(!args.join(' ').includes('private-key-value'));
      return {code: 0, stdout: JSON.stringify({...summary(options), injectedSecret: sourceToken})};
    }
  });
  assert.deepEqual(issued.sort(), [options.source, options.target].sort()); assert.equal(calls.length, 1);
  assert.equal(result.operation, 'plan'); assert.equal(result.localBackup, undefined);
  assert.ok(!JSON.stringify(result).includes('ghs_'));
});

test('apply creates a restorable mirror and verified private bundle before invoking Python', async context => {
  const {root, keyFile} = await setup(context), source = await gitSource(root);
  const options = parseArguments(['--app-id', '12345', '--installation-id', '98765', '--private-key-file', keyFile,
    '--apply', '--writers-frozen', '--source-head', source.head, '--target-head', targetHead, '--backup-dir', join(root, 'private-backup')]);
  let cloneCalls = 0, migrationCalls = 0;
  const result = await runMigration(options, {
    mint: async (_env, repo) => repo === options.source ? sourceToken : targetToken,
    runChild: async (command, args, config) => {
      if (command === 'python3') {
        migrationCalls++;
        assert.equal((await stat(options.backupDir)).mode & 0o777, 0o700);
        assert.equal((await stat(join(options.backupDir, 'source.bundle'))).mode & 0o777, 0o600);
        assert.equal(config.env.GIT_CONFIG_VALUE_0, undefined);
        return {code: 0, stdout: JSON.stringify(summary(options, source.head))};
      }
      assert.ok(!args.join(' ').includes('ghs_'));
      if (args[0] === 'clone') {
        cloneCalls++;
        assert.equal(args[2], 'https://github.com/BrclioData/BrclioData.git');
        assert.equal(config.env.GIT_CONFIG_COUNT, '1');
        assert.equal(config.env.GIT_CONFIG_KEY_0, 'http.https://github.com/.extraheader');
        assert.equal(config.env.GIT_CONFIG_VALUE_0, 'Authorization: Basic ' + Buffer.from('x-access-token:' + sourceToken).toString('base64'));
        return runChild(command, [args[0], args[1], source.path, args[3]], config);
      }
      assert.equal(config.env.GIT_CONFIG_VALUE_0, undefined);
      return runChild(command, args, config);
    }
  });
  assert.equal(cloneCalls, 1); assert.equal(migrationCalls, 1); assert.equal(result.localBackup.status, 'verified');
  const localConfig = await readFile(join(options.backupDir, 'source.git', 'config'), 'utf8');
  assert.ok(!localConfig.includes('ghs_')); assert.ok(!localConfig.toLowerCase().includes('extraheader')); assert.ok(!localConfig.includes('Authorization'));
  const restored = join(root, 'restored');
  git(['clone', join(options.backupDir, 'source.bundle'), restored], root);
  assert.equal(git(['rev-parse', 'HEAD'], restored), source.head);
  assert.equal(await readFile(join(restored, 'record.json'), 'utf8'), '{"preserved":"original bytes"}\n');
  assert.equal(git(['tag', '--list'], restored), 'preserved-tag');
  assert.ok(git(['branch', '-r'], restored).includes('origin/extra-reference'));
});

test('existing backup directory fails before minting or subprocesses', async context => {
  const {root, options} = await setup(context);
  options.apply = true; options.writersFrozen = true; options.backupDir = join(root, 'exists'); options.sourceHead = sourceHead; options.targetHead = targetHead;
  await mkdir(options.backupDir); let calls = 0;
  await assert.rejects(runMigration(options, {mint: async () => { calls++; }, runChild: async () => { calls++; }}), error => {
    assert.ok(error instanceof AppMigrationError); assert.equal(error.state.backup.status, 'not-created'); return true;
  });
  assert.equal(calls, 0);
});

test('a source HEAD mismatch retains the private mirror and stops before bundle or migration', async context => {
  const {root, options} = await setup(context), source = await gitSource(root);
  Object.assign(options, {apply: true, writersFrozen: true, sourceHead, targetHead, backupDir: join(root, 'mismatched')});
  let python = 0;
  await assert.rejects(runMigration(options, {
    mint: async () => sourceToken,
    runChild: async (command, args, config) => {
      if (command === 'python3') { python++; throw new Error('must not migrate'); }
      return runChild(command, args[0] === 'clone' ? [args[0], args[1], source.path, args[3]] : args, config);
    }
  }), error => {
    assert.equal(error.message, 'GitHub App migration stopped; inspect status and repository heads before retrying');
    assert.equal(error.state.stage, 'backup-source-head'); assert.equal(error.state.backup.status, 'incomplete'); return true;
  });
  assert.equal(python, 0); assert.equal((await stat(join(options.backupDir, 'source.git'))).isDirectory(), true);
});

test('App, clone, migration and hostile child summaries fail with fixed errors without credential details', async context => {
  const {root, options} = await setup(context);
  for (const failure of ['app', 'python', 'summary']) {
    await assert.rejects(runMigration(options, {
      mint: async () => { if (failure === 'app') throw new Error(sourceToken + ' private-key-value'); return sourceToken; },
      runChild: async () => failure === 'python' ? {code: 1, stdout: sourceToken, stderr: sourceToken} : {code: 0, stdout: JSON.stringify({operation: 'plan', token: sourceToken})}
    }), error => {
      assert.ok(error instanceof AppMigrationError); assert.ok(!JSON.stringify(error).includes('ghs_'));
      assert.ok(!error.message.includes('private-key-value')); assert.equal(error.state.backup.status, 'not-created'); return true;
    });
  }
  Object.assign(options, {apply: true, writersFrozen: true, sourceHead, targetHead, backupDir: join(root, 'clone-failed')});
  await assert.rejects(runMigration(options, {
    mint: async () => sourceToken,
    runChild: async () => ({code: 1, stdout: sourceToken, stderr: 'Authorization: ' + sourceToken})
  }), error => { assert.equal(error.state.stage, 'backup-mirror'); assert.equal(error.state.backup.status, 'incomplete'); assert.ok(!JSON.stringify(error).includes('ghs_')); return true; });
});
