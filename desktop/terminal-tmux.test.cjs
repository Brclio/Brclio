'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { test } = require('node:test');
const { control, list, rows } = require('./terminal/tmux-protocol.js');
const { program, argumentsFor } = require('./terminal/tmux-launch.cjs');
const { createPtyService, forkService } = require('./terminal/service.cjs');

test('tmux control framing, command responses, asynchronous output, split UTF-8 and disconnect', async () => {
  const sent = [], bytes = [], events = [];
  const client = control({ write: text => sent.push(text), ready: () => events.push('ready'), notify: () => events.push('layout'),
    output: (id, data) => bytes.push([id, [...data]]), ended: text => events.push(text) });
  const result = client.command('list-panes');
  client.push('old text\r\n\x1bP10');
  client.push('00p%begin 917 1 0\r\n%end 917 1 0\r\n%layout-change dummy\r\n');
  await Promise.resolve();
  assert.deepEqual(sent, ['list-panes\n']);
  client.push('%output %4 A\\033\\342\r\n%output %5 B\r\n%extended-output %4 23 : \\202\\254\r\n');
  client.push('%begin 918 2 1\r\na\r\n%end 900 2 1\r\nb\r\n%end 918 2 1\r\n');
  assert.deepEqual(await result, ['a', '%end 900 2 1', 'b']);
  assert.deepEqual(bytes, [['%4', [65, 27, 226]], ['%5', [66]], ['%4', [130, 172]]]);
  const failed = client.command('display-message');
  await Promise.resolve();
  client.push('%begin 919 3 1\ninvalid pane\n%error 919 3 1\n');
  await assert.rejects(failed, /invalid pane/);
  const stopped = client.command('list-windows');
  await Promise.resolve();
  client.push('%exit\r\n\x1b\\');
  await assert.rejects(stopped, /分离/);
  assert.deepEqual(events, ['ready', 'layout', 'tmux 已分离']);
});

test('tmux geometry and launch arguments only accept a named session and numeric pane targets', () => {
  assert.deepEqual(argumentsFor('Local-9', 'darwin'), ['-CC', 'new-session', '-A', '-s', 'Local-9']);
  assert.deepEqual(argumentsFor('Local-9', 'win32'), ['--exec', 'tmux', '-C', 'new-session', '-A', '-s', 'Local-9']);
  for (const name of ["bad;name", '#{name}', '-bad', '', 'bad\nname', null]) assert.throws(() => argumentsFor(name, 'darwin'));
  const parsed = rows(['@2 %5 0 0 40 12 81 12 0 2 work', '@2 %6 41 0 40 12 81 12 3 0 work',
    '@2 %7 83 0 40 12 81 12 0 0 bad', '@2 ;cmd 0 0 81 12 81 12 0 0 bad']);
  assert.deepEqual(parsed.map(v => [v.pane, v.window, v.left, v.width]), [['%5', '@2', 0, 40], ['%6', '@2', 41, 40]]);
});

const binary = process.platform !== 'win32' && program(process.platform, process.env);
test('a real tmux -CC client maps separate panes, transports bytes and resize, then reattaches to the same processes', {
  skip: !binary && 'requires a POSIX tmux executable in PATH', timeout: 15000,
}, async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'brclio-cc-'));
  // tmux's Unix socket path is length-limited. os.tmpdir on macOS can be long.
  const tmp = fs.mkdtempSync('/tmp/brclio-cc-');
  const env = { ...process.env, TMUX_TMPDIR: tmp, HOME: home, ZDOTDIR: home, HISTFILE: path.join(home, '.history') };
  t.after(() => {
    try { execFileSync(binary, ['kill-server'], { env, stdio: 'ignore' }); } catch {}
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  });
  const received = new Map();
  let current, id, ready, finish;
  const sessions = createPtyService({ home, launch: dir => forkService(dir, env),
    send(channel, event) {
      if (event.id !== id) return;
      if (channel === 'exit') { current.end(event.error); finish(event.exitCode); return; }
      current.push(event.data);
      sessions.ack(id, event.data.length);
    },
  });
  t.after(() => sessions.closeAll());
  async function attach() {
    id = randomUUID();
    const handshake = new Promise((resolve, reject) => { ready = { resolve, reject }; });
    const ended = new Promise(resolve => { finish = resolve; });
    current = control({ write: text => sessions.write(id, text), ready: () => ready.resolve(), notify() {},
      output(pane, bytes) { received.set(pane, (received.get(pane) || '') + Buffer.from(bytes).toString('latin1')); },
      ended(reason) { ready.reject(new Error(reason)); } });
    await sessions.create({ id, profile: 'tmux-control', tmuxSession: 'test' });
    await handshake;
    return { ended, client: current };
  }
  const first = await attach();
  let panes = rows(await first.client.command(list));
  assert.equal(panes.length, 1);
  const firstID = panes[0].pane;
  await first.client.command('refresh-client -C 96,30');
  await first.client.command('split-window -h -t ' + firstID);
  await first.client.command('new-window');
  panes = rows(await first.client.command(list));
  assert.equal(panes.length, 3);
  assert.equal(new Set(panes.map(p => p.window)).size, 2);
  const second = panes.find(p => p.window === panes[0].window && p.pane !== firstID);
  assert.ok(second);
  assert.equal(panes[0].totalWidth, 96);
  await first.client.command('select-window -t ' + second.window);
  const input = Buffer.from("printf 'WIRE-%s\\n' VERIFIED\r", 'utf8');
  await first.client.command('send-keys -H -t ' + second.pane + ' ' + [...input].map(byte => byte.toString(16).padStart(2, '0')).join(' '));
  for (let i = 0; i < 60 && !received.get(second.pane)?.includes('WIRE-VERIFIED'); i++) await new Promise(r => setTimeout(r, 40));
  assert.match(received.get(second.pane), /WIRE-VERIFIED/);
  assert.doesNotMatch(received.get(firstID) || '', /WIRE-VERIFIED/);
  const getPids = cli => cli.command("list-panes -s -F '#{pane_id}:#{pane_pid}'");
  const pids = await getPids(first.client);
  await first.client.command('detach-client');
  assert.equal(await first.ended, 0);
  const next = await attach();
  assert.deepEqual(await getPids(next.client), pids);
  const restored = await next.client.command('capture-pane -p -t ' + second.pane);
  assert.match(restored.join('\n'), /WIRE-VERIFIED/);
  await next.client.command('detach-client');
  await next.ended;
});

test('the WSL pipe adapter handles a real unframed tmux -C byte stream and clean detach', {
  skip: !binary && 'requires POSIX tmux to verify the byte transport independently of WSL', timeout: 7000,
}, async t => {
  const tmp = fs.mkdtempSync('/tmp/brclio-tmux-pipe-');
  const env = { ...process.env, HOME: tmp, ZDOTDIR: tmp, TMUX_TMPDIR: tmp, TERM: 'xterm-256color' };
  t.after(() => {
    try { execFileSync(binary, ['kill-server'], { env, stdio: 'ignore' }); } catch {}
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  const { wslPipe } = require('./terminal/tmux-launch.cjs');
  const proc = wslPipe(binary, argumentsFor('pipe', 'win32').slice(2), { cwd: tmp, env });
  t.after(() => proc.kill());
  let ready, fail, exit;
  const opened = new Promise((resolve, reject) => { ready = resolve; fail = reject; });
  const closed = new Promise(resolve => { exit = resolve; });
  const client = control({ framed: false, write: data => proc.write(data), ready, output() {}, notify() {},
    ended: reason => fail(new Error(reason)) });
  proc.onData(data => client.push(data));
  proc.onExit(result => { client.end(); exit(result.exitCode); });
  await opened;
  assert.equal(rows(await client.command(list)).length, 1);
  await client.command('detach-client');
  assert.equal(await closed, 0);
});
