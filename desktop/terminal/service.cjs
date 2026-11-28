'use strict';

const { fork } = require('node:child_process');
const path = require('node:path');

const serviceError = '终端服务意外退出，请新建标签页重试。';

function forkService(home, env = process.env) {
  return fork(path.join(__dirname, 'service-child.cjs'), [home], {
    execPath: process.execPath, execArgv: [], windowsHide: true,
    env: { ...env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
  });
}

function createPtyService({ home, send, launch = forkService }) {
  let current;
  let serial = 0;

  function retire(state, reason, notify) {
    if (current !== state) return;
    current = undefined;
    clearTimeout(state.idle);
    for (const request of state.requests.values()) {
      clearTimeout(request.timer);
      request.reject(new Error(reason));
    }
    state.requests.clear();
    if (notify) {
      for (const id of state.live.keys()) send('exit', { id, exitCode: -1, error: reason });
    }
    state.live.clear();
    if (state.child.connected) state.child.disconnect();
    if (state.child.pid && state.child.exitCode === null && state.child.signalCode === null) {
      const deadline = setTimeout(() => state.child.kill('SIGKILL'), 7000);
      deadline.unref();
      state.child.once('exit', () => clearTimeout(deadline));
    }
  }

  function retireWhenIdle(state) {
    if (state !== current || state.live.size || state.requests.size || state.idle) return;
    // Reuse the process when a profile lookup immediately precedes a new tab.
    // After the last pane exits, native ConPTY workers must not keep it alive.
    state.idle = setTimeout(() => retire(state, '终端会话已结束。', false), 200);
    state.idle.unref();
  }

  function start() {
    const child = launch(home);
    const state = { child, requests: new Map(), live: new Map(), idle: null };
    current = state;
    const lost = () => retire(state, serviceError, true);
    child.on('error', lost);
    child.once('disconnect', lost);
    child.once('exit', lost);
    child.on('message', message => {
      if (state !== current) return;
      if (message.channel === 'exit' || message.channel === 'data') {
        if (message.channel === 'exit') state.live.delete(message.payload.id);
        send(message.channel, message.payload);
        if (message.channel === 'exit') retireWhenIdle(state);
        return;
      }
      const request = state.requests.get(message.serial);
      if (!request) return;
      clearTimeout(request.timer);
      state.requests.delete(message.serial);
      if (message.error) {
        request.reject(new Error(message.error));
      } else {
        if (request.method === 'create') {
          const host = request.id.connection?.host;
          state.live.set(message.result.id, { shell: message.result.shell, pid: message.result.pid,
            profile: request.id.profile || 'default', host: typeof host === 'string' ? host.trim() : undefined });
        }
        if (request.method === 'close') state.live.delete(request.id);
        request.resolve(message.result);
      }
      retireWhenIdle(state);
    });
    return state;
  }

  function post(state, message) {
    try {
      state.child.send(message, error => { if (error) retire(state, serviceError, true); });
    } catch { retire(state, serviceError, true); }
  }

  async function call(method, args) {
    const state = current || (['profiles', 'create'].includes(method) && start());
    if (!state) {
      if (method === 'close') return;
      throw new Error('终端会话已结束。');
    }
    if (state.requests.size >= 512) throw new Error('终端服务繁忙，请稍后重试。');
    clearTimeout(state.idle);
    state.idle = null;
    const key = ++serial;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => retire(state, '终端服务无响应，请新建标签页重试。', true), 30000);
      timer.unref();
      state.requests.set(key, { resolve, reject, timer, method, id: args[0] });
      post(state, { serial: key, method, args });
    });
  }

  return {
    profiles: () => call('profiles', []),
    create: options => call('create', [options]),
    target: id => current?.live.get(id),
    write: (...args) => call('write', args),
    resize: (...args) => call('resize', args),
    close: id => call('close', [id]),
    ack(...args) { if (current) post(current, { method: 'ack', args }); },
    closeAll() { if (current) retire(current, '终端窗口已关闭。', false); },
  };
}

module.exports = { createPtyService, forkService };
