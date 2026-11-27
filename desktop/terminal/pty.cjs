'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const MAX_INPUT = 1024 * 1024;
const HIGH_WATER = 128 * 1024;
const LOW_WATER = 32 * 1024;
const UUID = /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i;

function dimensions(cols, rows) {
  if (!Number.isInteger(cols) || cols < 2 || cols > 1000 || !Number.isInteger(rows) || rows < 1 || rows > 500) {
    throw new Error('终端窗口尺寸无效。');
  }
}

function executable(file) {
  if (!file || !path.isAbsolute(file)) return false;
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch { return false; }
}

function shellProfiles(platform, env) {
  if (platform === 'win32') {
    const system = path.join(env.SystemRoot || 'C:\\Windows', 'System32');
    const powershell = path.join(system, 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const cmd = path.join(system, 'cmd.exe');
    const programFiles = env.ProgramFiles || 'C:\\Program Files';
    const pwsh = [path.join(programFiles, 'PowerShell', '7', 'pwsh.exe'),
      ...(env.PATH || '').split(';').filter(dir => path.isAbsolute(dir)).map(dir => path.join(dir, 'pwsh.exe'))].find(executable);
    return [
      { id: 'default', label: '系统默认', file: executable(powershell) ? powershell : cmd },
      { id: 'powershell', label: 'Windows PowerShell', file: powershell },
      { id: 'pwsh', label: 'PowerShell 7', file: pwsh },
      { id: 'cmd', label: '命令提示符', file: cmd },
    ].filter(profile => executable(profile.file));
  }
  // Use the account's login shell even when Brclio was launched from Finder.
  const login = [os.userInfo().shell, env.SHELL, '/bin/zsh', '/bin/bash', '/bin/sh'].find(executable);
  return [
    { id: 'default', label: '登录 Shell', file: login },
    { id: 'zsh', label: 'zsh', file: '/bin/zsh' },
    { id: 'bash', label: 'bash', file: '/bin/bash' },
  ].filter(profile => executable(profile.file));
}

function shellEnvironment(env, file, platform) {
  const result = { ...env, TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'Brclio' };
  for (const key of Object.keys(result)) {
    if (/^(BRCLIO_|ELECTRON_|ITERM_|LC_TERMINAL$|LC_TERMINAL_VERSION$|TERM_PROGRAM_VERSION$|TERM_SESSION_ID$|TMUX$|TMUX_PANE$|STY$|WINDOW$|WINDOWID$|TERMCAP$|COLUMNS$|LINES$)/i.test(key)) delete result[key];
  }
  if (platform !== 'win32') result.SHELL = file;
  return result;
}

function loadDriver() {
  if (process.platform === 'win32' && __dirname.includes('app.asar' + path.sep)) {
    // Windows ConPTY starts a Node worker. It needs a physical script path.
    return require(path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', 'node-pty', 'lib', 'index.js'));
  }
  return require('node-pty');
}

function createPtySessions({ home, send, platform = process.platform, env = process.env, load = loadDriver }) {
  const sessions = new Map();

  function get(id) {
    const state = sessions.get(id);
    if (!state) throw new Error('终端会话已结束。');
    return state;
  }

  function create({ id, profile = 'default', cwd = home, cols = 80, rows = 24 } = {}) {
    if (typeof id !== 'string' || !UUID.test(id) || sessions.has(id)) throw new Error('终端会话标识无效。');
    if (sessions.size >= 32) throw new Error('最多可同时打开 32 个终端会话。');
    dimensions(cols, rows);
    if (typeof cwd !== 'string' || !path.isAbsolute(cwd) || cwd.includes('\0') || !fs.statSync(cwd, { throwIfNoEntry: false })?.isDirectory()) {
      throw new Error('请选择有效的本地工作目录。');
    }
    const selected = shellProfiles(platform, env).find(item => item.id === profile);
    if (!selected) throw new Error('这台电脑没有可用的所选 Shell。');

    const options = {
      name: 'xterm-256color', cols, rows, cwd, env: shellEnvironment(env, selected.file, platform),
      ...(platform === 'win32' ? { useConpty: true } : {}),
    };
    const pty = load().spawn(selected.file, platform === 'win32' ? [] : ['-l'], options);
    const state = { pty, outstanding: 0, paused: false, forceKill: null };
    sessions.set(id, state);
    state.data = pty.onData(data => {
      state.outstanding += data.length;
      if (!state.paused && state.outstanding >= HIGH_WATER) {
        state.paused = true;
        pty.pause();
      }
      send('data', { id, data });
    });
    const exit = pty.onExit(({ exitCode, signal }) => {
      clearTimeout(state.forceKill);
      state.data.dispose();
      exit.dispose();
      if (sessions.get(id) === state) {
        sessions.delete(id);
        send('exit', { id, exitCode, signal });
      }
    });
    return { id, shell: selected.file, pid: pty.pid, cwd,
      ...(platform === 'win32' ? { windowsBuild: Number(os.release().split('.')[2]) } : {}),
    };
  }

  function ack(id, count) {
    const state = sessions.get(id);
    if (!state || !Number.isSafeInteger(count) || count <= 0 || count > state.outstanding) return;
    state.outstanding -= count;
    if (state.paused && state.outstanding <= LOW_WATER) {
      state.paused = false;
      state.pty.resume();
    }
  }

  function close(id) {
    const state = sessions.get(id);
    if (!state) return;
    sessions.delete(id);
    state.data.dispose();
    if (state.paused) state.pty.resume();
    if (platform !== 'win32') {
      // A shell can trap SIGHUP. Stop it if it outlives this closed session.
      state.forceKill = setTimeout(() => state.pty.kill('SIGKILL'), 1200);
      state.forceKill.unref();
    }
    state.pty.kill();
  }

  return {
    profiles: () => shellProfiles(platform, env).map(({ id, label }) => ({ id, label })),
    create, ack, close,
    write(id, data, binary = false) {
      if (typeof data !== 'string' || data.length > MAX_INPUT) throw new Error('终端输入无效或过长。');
      get(id).pty.write(binary === true ? Buffer.from(data, 'latin1') : data);
    },
    resize(id, cols, rows) {
      dimensions(cols, rows);
      get(id).pty.resize(cols, rows);
    },
    closeAll() { for (const id of sessions.keys()) close(id); },
  };
}

module.exports = { createPtySessions };
