import {uuidPattern} from './feedback-store.js';
import logSchema from '../../desktop/software-log-schema.json' with {type: 'json'};

const categories = new Set(['bug', 'crash', 'performance', 'account', 'update', 'download', 'suggestion', 'other']);
const levels = new Set(['INFO', 'WARN', 'ERROR']);
const actions = new Set(logSchema.actions);
const enumFields = Object.entries(logSchema.enums).map(([key, values]) => [key, new Set(values)]);
const numericFields = Object.entries(logSchema.numbers);
const sevenDays = 7 * 24 * 60 * 60 * 1000;

export class FeedbackInputError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

function safeHost(value) {
  if (typeof value !== 'string' || value.length > 160) return null;
  const host = value.toLowerCase();
  // Opaque subdomains occasionally embed credentials. Keep only normal DNS/IP labels.
  if (/^\[[a-f\d:]{2,45}\]$/.test(host)) return host;
  if (host !== 'localhost' && (!host.includes('.') || !host.split('.').every(label => /^[a-z\d](?:[a-z\d-]{0,30}[a-z\d])?$/.test(label)))) return null;
  return host;
}

// Text input is user-authored. Strip common credentials, request targets,
// home paths and email addresses even if an older client sent raw diagnostics.
export function cleanFeedbackText(value) {
  return value
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ')
    .replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/gi, '[已隐藏私钥]')
    .replace(/\b(?:authorization|proxy-authorization|cookie|set-cookie)\s*:\s*[^\r\n]+/gi, '[已隐藏请求凭据]')
    .replace(/(?:https?|ftp):\/\/[^\s<>"'，。；）】]+/gi, raw => {
      try { const url = new URL(raw); const host = safeHost(url.hostname); return host ? url.protocol + '//' + host : '[已隐藏网址]'; }
      catch { return '[已隐藏网址]'; }
    })
    .replace(/\b(?:bearer|basic)\s+[\w./+=-]+/gi, '[已隐藏凭据]')
    .replace(/(?:["']?(?:xsec_token|access[_-]?token|refresh[_-]?token|api[_-]?key|token|secret|password|passwd|session(?:id)?|csrf)["']?|密码|令牌|密钥)\s*[:=：]\s*(?:"[^"\n]*"|'[^'\n]*'|[^\s&;,，。；]+)/gi, '[已隐藏凭据]')
    .replace(/\b(?:gh[pousr]_|github_pat_|sk-(?:proj-)?)[\w.-]{8,}/gi, '[已隐藏凭据]')
    .replace(/\beyJ[A-Za-z\d_-]+\.[A-Za-z\d_-]+\.[A-Za-z\d_-]+/g, '[已隐藏凭据]')
    .replace(/(?<![\w.+-])[\w.+-]+@[a-z\d.-]+\.[a-z]{2,}/gi, '[已隐藏邮箱]')
    .replace(/(?:\/(?:Users|home)\/[^\s，。；]+|[a-z]:\\Users\\[^\r\n，。；]+)/gi, '[已隐藏本地路径]')
    .trim();
}

export function boundedText(value, limit, field, optional = false) {
  if (optional && (value === undefined || value === '')) return '';
  if (typeof value !== 'string' || value.length > limit || (!optional && !value.trim())) {
    throw new FeedbackInputError(`${field}请填写 1 至 ${limit} 个字符`);
  }
  return cleanFeedbackText(value);
}

function diagnosticFields(values) {
  const result = {};
  if (!values || typeof values !== 'object' || Array.isArray(values)) return result;
  for (const [name, allowed] of enumFields) if (allowed.has(values[name])) result[name] = values[name];
  for (const [name, [min, max]] of numericFields) {
    const number = values[name];
    if (Number.isSafeInteger(number) && number >= min && number <= max) result[name] = number;
  }
  const host = safeHost(values.host);
  if (host && result.stage && result.code) result.host = host;
  return result;
}

function normalizeLogs(logs, now) {
  if (logs === undefined) return [];
  if (!Array.isArray(logs) || logs.length > 1792) throw new FeedbackInputError('诊断附件最多包含 1792 条最近七天的日志');
  const retained = [];
  for (const entry of logs) {
    if (!entry || typeof entry.time !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(entry.time) ||
        !levels.has(entry.level) || typeof entry.action !== 'string' || !entry.action || entry.action.length > 80) {
      throw new FeedbackInputError('诊断日志格式无效，请在客户端重新读取日志');
    }
    const time = Date.parse(entry.time);
    if (!Number.isFinite(time)) throw new FeedbackInputError('诊断日志日期无效');
    if (time < now - sevenDays || time > now) continue;
    // A newer client may already have an action unknown to this deployment.
    // Preserve its timing and level without storing an arbitrary supplied name.
    const action = actions.has(entry.action) ? entry.action : 'app.unknown';
    retained.push({time: new Date(time).toISOString(), level: entry.level, action, fields: diagnosticFields(entry.fields)});
  }
  return retained.sort((a, b) => a.time < b.time ? -1 : a.time > b.time ? 1 : 0);
}

export function submissionInput(input, now) {
  if (!input || typeof input.requestId !== 'string' || !uuidPattern.test(input.requestId) || !categories.has(input.category)) throw new FeedbackInputError('反馈编号或问题类别无效');
  const title = boundedText(input.title, 120, '标题'), description = boundedText(input.description, 6000, '问题说明');
  const appVersion = input.appVersion ?? '', platform = input.platform ?? '';
  if (typeof appVersion !== 'string' || !/^[a-zA-Z0-9.+_-]{0,40}$/.test(appVersion) ||
      typeof platform !== 'string' || !/^[a-zA-Z0-9 ._()-]{0,48}$/.test(platform)) throw new FeedbackInputError('客户端版本或平台格式无效');
  return {id: input.requestId, title, description, category: input.category, appVersion, platform, logs: normalizeLogs(input.logs, now)};
}
