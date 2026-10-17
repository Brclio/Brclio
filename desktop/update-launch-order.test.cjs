'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Exercise the actual main-process ACK function without launching Electron or
// requiring a second implementation of its update ordering.
const mainSource = fs.readFileSync(path.join(__dirname, 'main.cjs'), 'utf8');
const start = mainSource.indexOf('async function acknowledgeUpdate() {');
const end = mainSource.indexOf('\nasync function describePaths(', start);
assert.ok(start >= 0 && end > start);
const acknowledgeSource = mainSource.slice(start, end);
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const flush = () => new Promise(resolve => setImmediate(resolve));

function launch({ result, repair, platform = 'win32', packaged = true }) {
  const events = [];
  const context = {
    rendererReady: true, pendingUpdateLaunchArgs: ['--brclio-update-job', 'job', '--brclio-update-token', 'token'],
    installer: {
      acknowledgeLaunch: async () => { events.push('ack'); },
      readResult: async () => { events.push('helper-result'); return result; },
    },
    app: { getVersion: () => '0.1.7', isPackaged: packaged }, process: { platform },
    integration: { repairWindows: async () => { events.push('repair'); if (repair) await repair; } },
    updater: { restoreResult: value => { events.push(`ui:${value.status}`); } },
    console: { error: (...args) => { throw new Error(args.join(' ')); }, warn: () => { events.push('repair-warning'); } },
    setTimeout,
  };
  return { events, done: vm.runInNewContext(`${acknowledgeSource}\nacknowledgeUpdate();`, context) };
}

test('update launch acknowledges and waits for helper success before a potentially long UAC repair', async () => {
  const committed = deferred();
  const consent = deferred();
  const running = launch({ result: committed.promise, repair: consent.promise });
  await flush();
  assert.deepEqual(running.events, ['ack', 'helper-result']);
  committed.resolve({ status: 'installed', launchAcknowledged: true });
  await flush();
  assert.deepEqual(running.events, ['ack', 'helper-result', 'repair']);
  consent.resolve();
  await running.done;
  assert.deepEqual(running.events, ['ack', 'helper-result', 'repair', 'ui:installed']);
});

test('declined repair preserves committed installation and publishes its result after reporting the repair', async () => {
  const running = launch({ result: { status: 'installed', launchAcknowledged: true }, repair: Promise.reject(new Error('UAC declined')) });
  await running.done;
  assert.deepEqual(running.events, ['ack', 'helper-result', 'repair', 'repair-warning', 'ui:installed']);
});

test('failed, unacknowledged and non-Windows update results do not trigger Windows repair', async () => {
  for (const options of [
    { result: { status: 'error', error: 'restored old app' } },
    { result: { status: 'installed', launchAcknowledged: false } },
    { result: { status: 'installed', launchAcknowledged: true }, platform: 'darwin' },
    { result: { status: 'installed', launchAcknowledged: true }, packaged: false },
  ]) {
    const running = launch(options);
    await running.done;
    assert.deepEqual(running.events, ['ack', 'helper-result', `ui:${options.result.status}`]);
  }
});
