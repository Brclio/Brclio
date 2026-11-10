'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { isIP } = require('node:net');
const { randomUUID } = require('node:crypto');

const RETAIN_DAYS = 7;
const DAILY_LIMIT = 256;
const schema = require('./software-log-schema.json');
const ACTIONS = new Set(schema.actions);
const UI_ACTIONS = new Set(schema.uiActions);
const LEVELS = new Set(['INFO', 'WARN', 'ERROR']);
const ENUM_FIELDS = Object.fromEntries(Object.entries(schema.enums).map(([key, values]) => [key, new Set(values)]));
const NUMBER_FIELDS = schema.numbers;

function safeHost(value) {
  if (typeof value !== 'string' || value.length > 160) return;
  const host = value.toLowerCase();
  if (isIP(host) || (/^\[[0-9a-f:]+\]$/.test(host) && isIP(host.slice(1, -1)) === 6)) return host;
  if (host === 'localhost' || (host.includes('.') && host.split('.').every(label =>
    /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/.test(label)))) return host;
}

// All output is reconstructed from known fields. Never serialize a caller's input,
// filenames, clipboard, note titles, error messages/stacks, URLs, tokens or stderr.
function safeFields(input = {}) {
  const fields = {};
  for (const [key, values] of Object.entries(ENUM_FIELDS)) {
    if (values.has(input?.[key])) fields[key] = input[key];
  }
  for (const [key, [min, max]] of Object.entries(NUMBER_FIELDS)) {
    const value = input?.[key];
    if (Number.isSafeInteger(value) && value >= min && value <= max) fields[key] = value;
  }
  if (fields.stage && ENUM_FIELDS.code.has(fields.code)) {
    const host = safeHost(input?.host);
    if (host) fields.host = host;
  }
  return fields;
}

function errorFields(error) {
  const diagnostic = error?.diagnostic;
  const codes = [diagnostic?.code, error?.code, error?.cause?.code];
  let code = codes.find(value => ENUM_FIELDS.code.has(value));
  // Only classify messages, never retain the message contents.
  if (!code) {
    if (error?.name === 'AbortError') code = 'ABORTED';
    else if (error?.name === 'TimeoutError' || /超时|timed out/i.test(error?.message || '')) code = 'TIMEOUT';
    else if (/fetch failed|network|网络/i.test(error?.message || '')) code = 'NETWORK_ERROR';
    else code = 'OPERATION_FAILED';
  }
  return safeFields({ ...diagnostic, code, status: error?.status || error?.statusCode });
}

function localDay(date) {
  const pad = value => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
function formatEntry(entry) {
  const date = new Date(entry.time);
  const time = date.toTimeString().slice(0, 8);
  const values = Object.entries(entry.fields).map(([key, value]) => `${key}=${value}`);
  return [localDay(date), time, `[${entry.level}]`, entry.action, ...values].join(' ');
}

function createSoftwareLogs({ directory, version, platform = process.platform, arch = process.arch, now = () => new Date() }) {
  let pending = Promise.resolve();
  let lastPruned = '';
  const filename = day => path.join(directory, `${day}.json`);
  const previousDays = date => Array.from({ length: RETAIN_DAYS }, (_, index) => {
    const day = new Date(date); day.setDate(day.getDate() - index); return localDay(day);
  });
  function enqueue(task) {
    const operation = pending.then(task);
    pending = operation.catch(() => {});
    return operation;
  }
  async function prune(date) {
    const day = localDay(date);
    if (day === lastPruned) return;
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const keep = new Set(previousDays(date));
    for (const name of await fs.readdir(directory)) {
      const expired = /^\d{4}-\d{2}-\d{2}\.json$/.test(name) && !keep.has(name.slice(0, 10));
      if (expired || /^\.[a-f0-9-]{36}\.tmp$/.test(name)) {
        await fs.unlink(path.join(directory, name));
      }
    }
    lastPruned = day;
  }
  async function readDay(day) {
    try {
      const file = filename(day);
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.size > DAILY_LIMIT * 1024) return [];
      const value = JSON.parse(await fs.readFile(file, 'utf8'));
      if (!Array.isArray(value)) return [];
      return value.slice(-DAILY_LIMIT).filter(entry => ACTIONS.has(entry?.action) && LEVELS.has(entry.level) &&
        typeof entry.time === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(entry.time) &&
        Number.isFinite(Date.parse(entry.time)))
        .map(({ time, action, level, fields }) => ({ time, level, action, fields: safeFields(fields) }));
    } catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return []; throw error; }
  }

  // Coalesce bursts of native job events while a disk write is in flight.
  let batch = [];
  let scheduled = false;
  async function flush() {
    scheduled = false;
    const entries = batch; batch = [];
    const date = now();
    await prune(date);
    const keep = new Set(previousDays(date));
    const groups = new Map();
    for (const entry of entries) {
      const day = localDay(new Date(entry.time));
      if (!keep.has(day)) continue;
      if (!groups.has(day)) groups.set(day, []);
      groups.get(day).push(entry);
    }
    for (const [day, additions] of groups) {
      const records = (await readDay(day)).concat(additions).slice(-DAILY_LIMIT);
      const temporary = path.join(directory, `.${randomUUID()}.tmp`);
      try {
        await fs.writeFile(temporary, JSON.stringify(records), { mode: 0o600, flag: 'wx' });
        await fs.rename(temporary, filename(day));
      } finally { await fs.rm(temporary, { force: true }); }
    }
  }
  function record(action, level = 'INFO', fields = {}) {
    if (!ACTIONS.has(action) || !LEVELS.has(level)) return;
    const entry = { time: now().toISOString(), level, action, fields: safeFields(fields) };
    batch.push(entry);
    if (batch.length > RETAIN_DAYS * DAILY_LIMIT) batch.shift();
    if (!scheduled) {
      scheduled = true;
      void enqueue(async () => {
        try { await flush(); }
        catch { console.warn('Brclio 软件日志暂时无法写入。'); }
      });
    }
  }
  async function observeIPC(channel, args, operation) {
    let action = channel.slice('brclio:'.length).replaceAll(':', '.');
    let engine;
    if (channel === 'brclio:xhs:request') {
      action = typeof args[0] === 'string' && args[0].length < 32 ? 'xhs.' + args[0] : '';
      if (action === 'xhs.parse') engine = args[1]?.engine || 'node';
    } else if (channel === 'brclio:account:request') {
      const route = args[0]?.path;
      action = typeof route === 'string' && /^\/api\/account\/[a-z]{1,16}$/.test(route) ? 'account.' + route.slice(13) : '';
    }
    if (!ACTIONS.has(action)) return operation();
    const start = Date.now();
    try {
      const result = await operation();
      const failure = result?.ok === false || result?.status === 'error';
      const cancelled = result?.cancelled || result?.canceled;
      record(action, failure ? 'ERROR' : 'INFO', {
        outcome: failure ? 'error' : cancelled ? 'cancel' : 'ok', engine, durationMs: Date.now() - start,
        count: typeof result?.count === 'number' ? result.count : undefined,
        ...(failure ? errorFields(result.error) : {}),
      });
      return result;
    } catch (error) {
      record(action, 'ERROR', { outcome: 'error', engine, durationMs: Date.now() - start, ...errorFields(error) });
      throw error;
    }
  }

  return {
    record, observeIPC,
    recordDiagnostic(event, fields) {
      const action = 'xhs.' + event;
      if (!ACTIONS.has(action)) return;
      const level = /error|failed|blocked|interrupted/.test(event) ? 'ERROR' : event === 'request.retry' ? 'WARN' : 'INFO';
      const diagnostic = event === 'python.request_failed' ? errorFields(fields?.error) : {};
      record(action, level, { ...fields, state: fields?.status, ...diagnostic });
    },
    recordUI(action, outcome) {
      if (!UI_ACTIONS.has(action) || !ENUM_FIELDS.outcome.has(outcome)) throw new Error('软件日志事件无效。');
      record(action, outcome === 'error' ? 'ERROR' : 'INFO', { outcome });
    },
    async read() {
      return enqueue(async () => {
        const date = now();
        await prune(date);
        const oldest = date.getTime() - RETAIN_DAYS * 86400000;
        const days = previousDays(date).reverse();
        const logs = (await Promise.all(days.map(readDay))).flat().filter(entry => {
          const time = Date.parse(entry.time);
          return time >= oldest && time <= date.getTime();
        }).sort((a, b) => a.time.localeCompare(b.time));
        const header = `Brclio ${version} · ${platform} ${arch} · 最近 ${RETAIN_DAYS} 天`;
        return { days: RETAIN_DAYS, entryCount: logs.length, logs, text: [header, ...logs.map(formatEntry)].join('\n') };
      });
    },
    settle: () => pending,
  };
}

module.exports = { createSoftwareLogs, errorFields, DAILY_LIMIT };
