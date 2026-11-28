'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

function program(platform, env) {
  if (platform === 'win32') {
    const windows = env.SystemRoot || 'C:\\Windows';
    const file = path.join(windows, 'System32', 'wsl.exe');
    return fs.existsSync(file) ? file : undefined;
  }
  for (const directory of [...(env.PATH || '').split(':'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin']) {
    if (!path.isAbsolute(directory)) continue;
    const file = path.join(directory, 'tmux');
    try { fs.accessSync(file, fs.constants.X_OK); if (fs.statSync(file).isFile()) return file; } catch {}
  }
}

function argumentsFor(name, platform) {
  // The target is a literal tmux session name, never a command or format.
  if (typeof name !== 'string' || !/^[a-zA-Z0-9_][a-zA-Z0-9_-]{0,63}$/.test(name)) throw new Error('tmux 会话名仅支持字母、数字、下划线和连字符。');
  // -CC requires a POSIX tty. Using the tmux -C pipe transport for WSL
  // preserves bytes and avoids the Windows console interpreting tmux's DCS.
  return [...(platform === 'win32' ? ['--exec', 'tmux', '-C'] : ['-CC']), 'new-session', '-A', '-s', name];
}

function wslPipe(file, args, options) {
  const child = spawn(file, args, { cwd: options.cwd, env: options.env, windowsHide: true, stdio: 'pipe' });
  let finished = false, exited;
  // stdout is the protocol. WSL diagnostics are not protocol messages.
  child.stderr.resume();
  child.stdout.setEncoding('latin1');
  function finish(exitCode) { if (!finished) { finished = true; exited?.({ exitCode }); } }
  child.once('close', code => finish(code ?? -1));
  child.once('error', () => finish(-1));
  child.stdin.on('error', () => {});
  return {
    pid: child.pid,
    onData(fn) { child.stdout.on('data', fn); return { dispose: () => child.stdout.off('data', fn) }; },
    onExit(fn) { exited = fn; return { dispose() { exited = undefined; } }; },
    write: text => child.stdin.write(text),
    pause: () => child.stdout.pause(), resume: () => child.stdout.resume(),
    resize() {}, kill: () => child.kill(),
  };
}

module.exports = { program, argumentsFor, wslPipe };
