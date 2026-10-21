import {json} from './http.js';
import {AccountStorageError, appDataPath, userPath} from './account-store.js';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const active = (credentials, session) => {
  const grant = credentials?.sessions?.[session.sessionKey];
  return grant?.exp === session.exp && grant.mode === session.mode && grant.exp > Math.floor(Date.now() / 1000);
};
const failure = result => json({error: result.error, ...(result.code ? {code: result.code} : {})}, result.status);
const conflict = () => ({error: '云端数据已更新，请先重新读取并确认后再同步；本地数据已保留', code: 'REVISION_CONFLICT', status: 409});
function validJSON(value, depth = 0) {
  if (depth > 16) return false;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.length <= 1000 && value.every(entry => validJSON(entry, depth + 1));
  return object(value) && Object.entries(value).every(([key, entry]) => !['__proto__', 'constructor', 'prototype'].includes(key) && validJSON(entry, depth + 1));
}
function merge(previous, patch) {
  const result = {...previous};
  for (const [key, value] of Object.entries(patch)) result[key] = object(value) && object(previous[key]) ? merge(previous[key], value) : value;
  return result;
}
function validMiniappData(data) {
  if (!Object.hasOwn(data, 'duel')) return true;
  const duel = data.duel, preferences = duel?.preferences;
  const names = value => Array.isArray(value) && value.length === 2 && value.every(name => typeof name === 'string' && name.trim().length > 0 && name.length <= 16 && !/[\u0000-\u001f\u007f]/.test(name));
  if (!object(duel) || !object(preferences) || ![1, 3, 5].includes(preferences.targetScore) || typeof preferences.haptics !== 'boolean' || !names(preferences.names) || !Array.isArray(duel.matches) || duel.matches.length > 20) return false;
  const ids = new Set();
  for (const match of duel.matches) {
    if (!object(match) || typeof match.id !== 'string' || !/^[A-Za-z0-9._:-]{1,80}$/.test(match.id) || ids.has(match.id) || !Number.isSafeInteger(match.at) || match.at < 1577836800000 || ![0, 1].includes(match.winner) || !names(match.names) || !Array.isArray(match.scores) || match.scores.length !== 2 || !match.scores.every(score => Number.isInteger(score) && score >= 0 && score <= 5) || ![1, 3, 5].includes(match.scores[match.winner]) || match.scores[1 - match.winner] >= match.scores[match.winner] || !(match.bestMs === null || Number.isFinite(match.bestMs) && match.bestMs >= 0 && match.bestMs <= 5000)) return false;
    ids.add(match.id);
  }
  return true;
}
export async function readBrclioData(state, id) {
  const current = await state.read(appDataPath(id, 'brclio'));
  const value = current === null ? await state.read(userPath(id, 'data'), {version: 1, preferences: {}, updatedAt: null}) : current;
  if (!object(value) || value.version !== 1 || !object(value.preferences) || (value.revision !== undefined && (!Number.isSafeInteger(value.revision) || value.revision < 0))) throw new AccountStorageError('Invalid Brclio data');
  return value;
}
export async function handleAccountData({path, request, input, session, store, preferencesValue}) {
  if (path === '/api/account/data') {
    if (request.method === 'GET') {
      const data = await readBrclioData(await store.snapshot(), session.id);
      return json({userId: session.id, preferences: data.preferences, updatedAt: data.updatedAt, revision: data.revision || 0});
    }
    if (request.method !== 'PUT') return json({error: '不支持的请求方法'}, 405);
    const preferences = preferencesValue(input.preferences);
    if (!preferences || (input.revision !== undefined && (!Number.isSafeInteger(input.revision) || input.revision < 0))) return json({error: '复制偏好格式无效'}, 400);
    const result = await store.transaction(async tx => {
      if (!active(await tx.read(userPath(session.id, 'credentials')), session)) return {error: '会话已失效，请重新登录', status: 401};
      const current = await readBrclioData(tx, session.id);
      if ((input.revision !== undefined && input.revision !== (current.revision || 0)) || current.revision >= Number.MAX_SAFE_INTEGER) return conflict();
      const data = {...current, preferences: {...current.preferences, ...preferences}, revision: (current.revision || 0) + 1, updatedAt: new Date().toISOString()};
      tx.write(appDataPath(session.id, 'brclio'), data);
      return {userId: session.id, preferences: data.preferences, updatedAt: data.updatedAt, revision: data.revision};
    });
    return result.error ? failure(result) : json(result);
  }
  if (!path.startsWith('/api/account/apps/')) return null;
  // App IDs are an explicit server registry. New programs cannot claim arbitrary
  // paths by sending an application name or a user ID in their request.
  if (path !== '/api/account/apps/miniapp/data') return json({error: '应用尚未接入'}, 404);
  const appId = 'miniapp', recordPath = appDataPath(session.id, appId);
  async function read(state) {
    const value = await state.read(recordPath, {version: 1, revision: 0, data: {}, updatedAt: null});
    if (!object(value) || value.version !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 0 || !object(value.data) || !validJSON(value.data) || !validMiniappData(value.data)) throw new AccountStorageError('Invalid app data');
    return value;
  }
  const response = value => ({userId: session.id, appId, version: 1, revision: value.revision, data: value.data, updatedAt: value.updatedAt});
  if (request.method === 'GET') return json(response(await read(await store.snapshot())));
  if (request.method !== 'PUT') return json({error: '不支持的请求方法'}, 405);
  if (!Number.isSafeInteger(input.revision) || input.revision < 0 || !object(input.data) || !validJSON(input.data) || new TextEncoder().encode(JSON.stringify(input.data)).length > 12000) return json({error: '请输入有效版本和不超过 12000 字节的应用数据'}, 400);
  const result = await store.transaction(async tx => {
    if (!active(await tx.read(userPath(session.id, 'credentials')), session)) return {error: '会话已失效，请重新登录', status: 401};
    const current = await read(tx);
    if (current.revision !== input.revision || current.revision >= Number.MAX_SAFE_INTEGER) return conflict();
    const value = {...current, data: merge(current.data, input.data), revision: current.revision + 1, updatedAt: new Date().toISOString()};
    if (!validMiniappData(value.data)) return {error: '挑战偏好或最近 20 局记录格式无效，已保留云端原数据', status: 400};
    if (new TextEncoder().encode(JSON.stringify(value.data)).length > 12000) return {error: '合并后的应用数据超过 12000 字节', status: 400};
    tx.write(recordPath, value);
    return response(value);
  });
  return result.error ? failure(result) : json(result);
}
