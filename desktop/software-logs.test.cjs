'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createSoftwareLogs, DAILY_LIMIT } = require('./software-logs.cjs');
const { MAX_BYTES, validateAccountRequest } = require('./account.cjs');

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'brclio-software-logs-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let clock = new Date(2026, 10, 10, 12);
  const open = () => createSoftwareLogs({ directory, version: '0.2.10', now: () => new Date(clock) });
  return { directory, log: open(), open, changeDay: day => { clock = new Date(2026, 10, day, 12); } };
}

test('captures local IPC redirect failures before serialization without storing any inputs or raw errors', async t => {
  const { log, directory, open } = await fixture(t);
  const secret = 'NEVER_SAVE_THIS_SECRET';
  const diagnostic = { code: 'XHS_URL_HOST', stage: 'redirect', hop: 2, host: 'blocked.example', protocol: 'https',
    url: 'https://blocked.example/private?token=' + secret, token: secret };
  const error = Object.assign(new Error(secret), { status: 400, diagnostic });
  await assert.rejects(log.observeIPC('brclio:xhs:request', ['parse', { engine: 'python', text: secret }],
    async () => { throw error; }), value => value === error);
  await log.observeIPC('brclio:account:request', [{ path: '/api/account/login', body: { password: secret } }], async () => ({ token: secret }));
  await log.observeIPC('brclio:clipboard:write', [secret], async () => ({ copied: true }));
  await log.observeIPC('brclio:xhs:request', ['saveVideo', { filename: secret }], async () =>
    ({ ok: false, error: { message: secret, code: 'ENOSPC' }, path: secret }));
  log.recordDiagnostic('python.request_failed', { error, stderr: secret, durationMs: 80 });
  log.recordUI('live.generate', 'cancel');
  assert.throws(() => log.recordUI(secret, 'ok'));
  assert.throws(() => log.recordUI('ui.error', secret));
  const report = await log.read();
  assert.equal(report.entryCount, 6);
  assert.equal(report.days, 7);
  const parse = report.logs.find(entry => entry.action === 'xhs.parse');
  assert.equal(parse.level, 'ERROR');
  assert.equal(parse.fields.code, 'XHS_URL_HOST'); assert.equal(parse.fields.host, 'blocked.example');
  assert.equal(parse.fields.hop, 2); assert.equal(parse.fields.protocol, 'https'); assert.equal(parse.fields.status, 400);
  assert.equal(parse.fields.engine, 'python');
  assert.equal(report.logs.find(entry => entry.action === 'xhs.saveVideo').fields.code, 'ENOSPC');
  assert.equal(report.logs.at(-1).fields.outcome, 'cancel');
  assert.match(report.text, /\[ERROR\] xhs\.parse/);
  assert.equal(JSON.stringify(report).includes(secret), false);
  const files = await fs.readdir(directory);
  assert.deepEqual(files, ['2026-11-10.json']);
  assert.equal((await fs.readFile(path.join(directory, files[0]), 'utf8')).includes(secret), false);
  if (process.platform !== 'win32') assert.equal((await fs.stat(path.join(directory, files[0]))).mode & 0o777, 0o600);
  assert.deepEqual((await open().read()).logs, report.logs);
});

test('bounds each local calendar day, prunes expired files, and handles concurrent appends and reads', async t => {
  const { log, directory, changeDay } = await fixture(t);
  for (let day = 1; day <= 7; day++) {
    changeDay(day);
    log.record('paths.contextMenu', 'INFO', { count: day });
    assert.equal((await log.read()).entryCount, day);
  }
  changeDay(8);
  for (let i = 1; i <= DAILY_LIMIT + 35; i++) log.record('xhs.note.completed', 'INFO', { sequence: i });
  const report = await log.read();
  assert.equal(report.entryCount, 6 + DAILY_LIMIT);
  assert.equal((await fs.readdir(directory)).length, 7);
  assert.equal(report.logs[6].fields.sequence, 36);
  assert.equal(report.logs.at(-1).fields.sequence, DAILY_LIMIT + 35);
  changeDay(20);
  assert.equal((await log.read()).entryCount, 0);
  assert.deepEqual(await fs.readdir(directory), []);
});

test('read only exports known fields and valid records, skips damaged files and rejects hosts carrying credentials', async t => {
  const { log, directory } = await fixture(t);
  log.record('xhs.parse', 'ERROR', { code: 'XHS_URL_HOST', host: 'user:secret@example.org', stage: 'redirect', port: 999999 });
  const saved = await log.read();
  assert.deepEqual(saved.logs[0].fields, { code: 'XHS_URL_HOST', stage: 'redirect' });
  const target = path.join(directory, '2026-11-10.json');
  const entry = saved.logs[0];
  await fs.writeFile(target, JSON.stringify([{ ...entry, fields: { secret: 'unsafe', code: 'unsafe' } },
    { ...entry, action: 'unsafe' }, { ...entry, time: 'unsafe' }, { ...entry, level: 'unsafe' }]));
  const report = await log.read();
  assert.equal(report.entryCount, 1);
  assert.equal(JSON.stringify(report).includes('unsafe'), false);
  await fs.writeFile(target, '{');
  log.record('app.start');
  assert.equal((await log.read()).entryCount, 1);
});

test('only the fixed native feedback POST accepts a seven-day log payload up to 1 MiB', () => {
  const input = { path: '/api/account/feedback', method: 'POST', body: { feedback: 'x'.repeat(MAX_BYTES) } };
  assert.equal(validateAccountRequest(input).method, 'POST');
  for (const variant of [{ method: 'PUT' }, { method: 'GET' }, { path: '/api/account/login' },
    { path: '/api/account/feedback?extra=1' }, { body: { feedback: 'x'.repeat(1024 * 1024) } }]) {
    assert.throws(() => validateAccountRequest({ ...input, ...variant }));
  }
});
