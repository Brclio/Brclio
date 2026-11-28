'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { stripVTControlCharacters } = require('node:util');

const MAX_BYTES = 256 * 1024;
const MAX_LOGS = 16;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const title = (value, limit) => typeof value === 'string' && value.trim() && value.trim().length <= limit &&
  !/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/u.test(value) ? value.trim() : '';
const plain = raw => stripVTControlCharacters(raw.replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\|$)|\x1b[PX^_][\s\S]*?(?:\x1b\\|$)/g, ''))
  .replace(/\r\n/g, '\n').replace(/[\r\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, '');

function registerLogs({ handle, owner, directory, storage, target }) {
  let epoch = 0;
  let active = null;
  let timer = null;
  let lastError = null;

  function checkEncryption() {
    if (!storage.isEncryptionAvailable() || (process.platform === 'linux' && storage.getSelectedStorageBackend?.() === 'basic_text'))
      throw new Error('系统加密存储暂不可用。');
  }
  function root(user) {
    return path.join(directory, 'terminal-logs', createHash('sha256').update(user).digest('hex'));
  }
  function ids(user) {
    try { return fs.readdirSync(root(user)).filter(uuid.test.bind(uuid)); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  }
  function write(user, record) {
    checkEncryption();
    const dir = root(user);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, record.id);
    const temp = path.join(dir, '.write-' + randomUUID());
    try {
      fs.writeFileSync(temp, storage.encryptString(JSON.stringify(record)), { flag: 'wx', mode: 0o600 });
      fs.renameSync(temp, file);
    } finally { fs.rmSync(temp, { force: true }); }
  }
  function read(user, id) {
    if (typeof id !== 'string' || !uuid.test(id)) throw new Error('请选择日志。');
    checkEncryption();
    const file = path.join(root(user), id);
    const info = fs.lstatSync(file);
    if (!info.isFile() || info.size > 2 * 1024 * 1024) throw new Error('日志文件无效。');
    const log = JSON.parse(storage.decryptString(fs.readFileSync(file)));
    if (log.id !== id || typeof log.text !== 'string' || !Array.isArray(log.bookmarks)) throw new Error('日志格式无效。');
    return log;
  }
  const allowedDays = [0, 1, 7, 30, 90, 365];
  function retention(user) {
    try {
      const days = JSON.parse(fs.readFileSync(path.join(root(user),'retention.json'),'utf8')).days;
      if (!allowedDays.includes(days)) throw new Error('日志保留期限无效。');
      return days;
    } catch (error) { if (error.code === 'ENOENT') return 0; throw error; }
  }
  function applyRetention(user, days) {
    if (!days) return;
    const threshold = Date.now() - days * 86400000;
    for (const id of ids(user)) {
      if (id === active?.log.id) continue;
      const log = read(user,id);
      if (!log.bookmarks.length && Date.parse(log.updatedAt) < threshold) fs.unlinkSync(path.join(root(user),id));
    }
  }
  function flush() {
    if (!active?.dirty) return;
    active.log.text = plain(active.raw);
    active.log.updatedAt = new Date().toISOString();
    write(active.user, active.log);
    active.dirty = false;
  }
  function stop() {
    clearTimeout(timer);
    timer = null;
    try { flush(); }
    finally { active = null; }
  }
  function stopSafely() {
    const user = active?.user;
    try { stop(); } catch (error) { lastError = { user, message: '会话日志写入失败：' + error.message }; }
  }
  function observe(channel, payload) {
    if (!active || active.pane !== payload?.id) return;
    if (channel === 'exit') { stopSafely(); return; }
    if (channel !== 'data' || typeof payload.data !== 'string') return;
    const bytes = Buffer.from(payload.data);
    const remaining = MAX_BYTES - active.bytes;
    if (bytes.length >= remaining) {
      active.raw += new TextDecoder().decode(bytes.subarray(0, remaining), { stream: true });
      active.log.full = true;
      active.dirty = true;
      stopSafely();
      return;
    }
    active.raw += payload.data;
    active.bytes += bytes.length;
    active.dirty = true;
    if (!timer) {
      timer = setTimeout(() => {
        timer = null;
        try { flush(); } catch (error) {
          lastError = { user: active?.user, message: '会话日志写入失败：' + error.message };
          active = null;
        }
      }, 2500);
      timer.unref?.();
    }
  }
  function reset() {
    epoch++;
    stopSafely();
    lastError = null;
  }
  async function action(op, input = {}) {
    const before = epoch;
    const user = await owner();
    if (before !== epoch) throw new Error('账号已切换，请重新打开会话日志。');
    if (typeof user !== 'string' || !user || user.length > 256) throw new Error('请先在 Brclio 主窗口登录。');
    if (active && active.user !== user) reset();
    const state = () => ({ active: active?.log.id || null, pane: active?.pane || null, error: lastError?.user === user ? lastError.message : '' });
    if (op === 'status') return state();
    if (op === 'retention') {
      if (!allowedDays.includes(input.days)) throw new Error('请选择有效的日志保留期限。');
      const dir = root(user), temporary = path.join(dir,'.retention-' + randomUUID());
      fs.mkdirSync(dir,{recursive:true,mode:0o700});
      try {
        fs.writeFileSync(temporary,JSON.stringify({days:input.days}),{flag:'wx',mode:0o600});
        fs.renameSync(temporary,path.join(dir,'retention.json'));
      } finally { fs.rmSync(temporary,{force:true}); }
      applyRetention(user,input.days);
      return state();
    }
    if (op === 'list') {
      const days = retention(user);
      applyRetention(user,days);
      const logs = ids(user).map(id => {
        const { text, bookmarks, ...item } = active?.log.id === id ? active.log : read(user, id);
        return { ...item, bookmarks: bookmarks.length };
      }).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
      return { ...state(), logs, days };
    }
    if (op === 'start') {
      if (active) throw new Error('请先停止当前录制。');
      const pane = target(input.pane);
      if (!pane || ['ssh-keygen', 'tmux-control', 'port-forward'].includes(pane.profile)) throw new Error('当前窗格不适合录制。');
      applyRetention(user,retention(user));
      if (ids(user).length >= MAX_LOGS) throw new Error('已保存 16 份日志，请先删除旧日志。');
      const name = title(input.name, 80);
      if (!name) throw new Error('请输入 1 到 80 字的日志名称。');
      const date = new Date().toISOString();
      const log = { id: randomUUID(), name, ...(pane.host ? {host:pane.host} : {}), startedAt: date, updatedAt: date, bookmarks: [], text: '', full: false };
      write(user, log);
      active = { user, pane: input.pane, log, raw: '', bytes: 0, dirty: false };
      lastError = null;
      return state();
    }
    if (op === 'stop') { stop(); return state(); }
    if (op === 'clear') {
      if (active) throw new Error('请先停止录制。');
      for (const id of ids(user)) fs.unlinkSync(path.join(root(user), id));
      lastError = null;
      return state();
    }
    const id = input.id;
    const live = !!active && active.log.id === id;
    const record = live ? { ...active.log, text: plain(active.raw) } : read(user, id);
    if (op === 'read') return record;
    if (op === 'delete') {
      if (live) throw new Error('请先停止录制。');
      fs.unlinkSync(path.join(root(user), id));
      return;
    }
    if (op !== 'bookmark') throw new Error('未知日志操作。');
    const label = title(input.label, 64);
    const offset = input.offset ?? record.text.length;
    if (!label || record.bookmarks.length >= 32 || !Number.isSafeInteger(offset) || offset < 0 || offset > record.text.length)
      throw new Error('书签名称或位置无效，每份日志最多 32 个书签。');
    const next = { ...record, bookmarks: [...record.bookmarks, { label, offset }] };
    write(user, next);
    if (live) { active.log = next; active.dirty = false; }
    return next;
  }
  handle('local-logs', action);
  return { observe, reset };
}
module.exports = { registerLogs };
