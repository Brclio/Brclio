'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { randomUUID } = require('node:crypto');
const { test } = require('node:test');
const { createPtySessions } = require('./terminal/pty.cjs');
const { createPtyService, forkService } = require('./terminal/service.cjs');

test('flow control waits for consumed data and releases every explicitly closed session', () => {
  const actions = [];
  const messages = [];
  let output;
  let exit;
  const fake = {
    pid: 42,
    onData(listener) { output = listener; return { dispose() {} }; },
    onExit(listener) { exit = listener; return { dispose() {} }; },
    pause() { actions.push('pause'); },
    resume() { actions.push('resume'); },
    kill() { actions.push('kill'); exit({ exitCode: 0 }); },
    write(data) { actions.push(data); },
    resize(cols, rows) { actions.push([cols, rows]); },
  };
  const sessions = createPtySessions({ home: os.tmpdir(), send: (...args) => messages.push(args),
    load: () => ({ spawn: () => fake }) });
  const id = randomUUID();
  sessions.create({ id });
  assert.throws(() => sessions.create({ id }), /标识/);
  assert.throws(() => sessions.resize(id, 1, 25), /尺寸/);
  assert.throws(() => sessions.write(id, 'a'.repeat(1024 * 1024 + 1)), /过长/);
  sessions.write(id, '\x03');
  sessions.write(id, '\xff', true);
  sessions.resize(id, 92, 35);
  const data = 'a'.repeat(150 * 1024);
  output(data);
  sessions.ack(id, data.length + 1);
  sessions.ack(id, 115 * 1024);
  assert.deepEqual(actions, ['\x03', Buffer.from([255]), [92, 35], 'pause']);
  sessions.ack(id, 4 * 1024);
  output(data);
  sessions.closeAll();
  sessions.close(id);
  sessions.ack(id, 1);
  assert.deepEqual(actions, ['\x03', Buffer.from([255]), [92, 35], 'pause', 'resume', 'pause', 'resume', 'kill']);
  assert.deepEqual(messages.map(([type, event]) => [type, event.id]), [['data', id], ['data', id]]);
  assert.throws(() => sessions.write(id, 'x'), /已结束/);
});

test('two native PTYs use independent shells and return the actual exit codes', {
  skip: !['darwin', 'win32'].includes(process.platform),
  timeout: 20000,
}, async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'brclio-terminal-test-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const ids = [randomUUID(), randomUUID()];
  const outputs = new Map(ids.map(id => [id, '']));
  const ended = new Map();
  const waits = ids.map(id => new Promise(resolve => ended.set(id, resolve)));
  let serviceExit;
  const sessions = createPtyService({
    home,
    launch(directory) {
      const child = forkService(directory, { ...process.env, ZDOTDIR: home, HISTFILE: path.join(home, '.history') });
      serviceExit = once(child, 'exit');
      return child;
    },
    send(type, event) {
      if (type === 'exit') { ended.get(event.id)(event.exitCode); return; }
      outputs.set(event.id, outputs.get(event.id) + event.data);
      sessions.ack(event.id, event.data.length);
    },
  });
  t.after(() => sessions.closeAll());
  const windows = process.platform === 'win32';
  await Promise.all(ids.map(id => sessions.create({ id, profile: windows ? 'cmd' : 'zsh', cols: 71, rows: 27 })));
  for (const [index, id] of ids.entries()) {
    await sessions.resize(id, 95, 34);
    await sessions.write(id, windows
      ? 'set TOKEN=BRCLIO\recho %TOKEN%-SESSION-' + index + '\rexit ' + (index + 1) + '\r'
      : 'test -t 0 && test -t 1 && printf "BRCLIO-%s-%d\\n" SESSION ' + index + '; stty size; exit ' + (index + 1) + '\r');
  }
  assert.deepEqual(await Promise.all(waits), [1, 2]);
  for (const [index, id] of ids.entries()) {
    assert.match(outputs.get(id), new RegExp('BRCLIO-SESSION-' + index));
    assert.doesNotMatch(outputs.get(id), new RegExp('BRCLIO-SESSION-' + (1 - index)));
    if (!windows) assert.match(outputs.get(id), /34\s+95/);
  }
  assert.equal((await serviceExit)[0], 0, 'Last shell exit should release its native service');
});
