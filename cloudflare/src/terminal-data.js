import {json, readJSON} from './http.js';
import {appDataPath, userPath} from './account-store.js';

export const terminalDataRoute = '/api/account/apps/terminal/data';
const maxBytes = 112 * 1024;
const text = (v, n) => typeof v === 'string' && v.length <= n && !/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/u.test(v);
const port = v => Number.isSafeInteger(v) && v >= 1 && v <= 65535;
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const only = (v, keys) => object(v) && Object.keys(v).every(k => keys.includes(k));
const named = v => text(v, 64) && v.trim().length > 0;
const address = v => text(v, 255) && /^(?:[\da-z_][\da-z_.-]*|[\da-f:]*:[\da-f:.]+(?:%[\da-z_.-]+)?)$/i.test(v);
const connectionFields = ['host','user','port','jump'];
function connection(v) {
  return address(v.host) && (v.user === '' || (text(v.user,128) && /^[\da-z_][\da-z_.@-]*$/i.test(v.user))) &&
    (v.port === null || port(v.port)) && (v.jump === undefined || (text(v.jump, 2048) && /^[\da-z_.:%@,\[\]-]+$/i.test(v.jump)));
}
function host(v) {
  return only(v,[...connectionFields,'name','group','tags','favorite']) && named(v.name) && connection(v) &&
    (v.group === undefined || text(v.group,120)) && (v.favorite === undefined || typeof v.favorite === 'boolean') &&
    (v.tags === undefined || (Array.isArray(v.tags) && v.tags.length <= 16 && v.tags.every(tag => text(tag,40))));
}
function forward(v) {
  return only(v,['name','type','listenHost','listenPort','connection','destinationHost','destinationPort']) && named(v.name) &&
    only(v.connection, connectionFields) && connection(v.connection) && address(v.listenHost) && port(v.listenPort) &&
    (v.type === 'dynamic' ? v.destinationHost === undefined && v.destinationPort === undefined :
      ['local','remote'].includes(v.type) && address(v.destinationHost) && port(v.destinationPort));
}
function collection(v, validate, limit) {
  return Array.isArray(v) && v.length <= limit && v.every(validate) && new Set(v.map(item => item.name)).size === v.length;
}
export function validTerminalData(v) {
  return only(v, ['hosts','forwards']) && collection(v.hosts, host, 2048) && collection(v.forwards, forward, 128) &&
    new TextEncoder().encode(JSON.stringify(v)).length <= maxBytes;
}

export async function terminalData(request, session, store) {
  const key = appDataPath(session.id, 'terminal');
  const initial = {version: 1, revision: 0, data: {hosts: [], forwards: []}, updatedAt: null};
  async function read(state) {
    const record = await state.read(key, initial);
    if (record.version !== 1 || !Number.isSafeInteger(record.revision) || record.revision < 0 || !validTerminalData(record.data))
      throw new Error('Invalid stored terminal configuration');
    return record;
  }
  if (request.method === 'GET') return json({userId: session.id, ...await read(await store.snapshot())});
  if (request.method !== 'PUT') return json({error:'此接口仅支持读取和更新。'},405);
  let input;
  try { input = await readJSON(request, maxBytes + 1024); }
  catch (error) { return json({error:'终端同步请求格式无效或超过大小限制。'}, error instanceof RangeError ? 413 : 400); }
  if (!object(input) || input.expectedUserId !== session.id) return json({error:'账号已变化，请重新打开终端同步。'},409);
  if (!Number.isSafeInteger(input.revision) || input.revision < 0 || !validTerminalData(input.data))
    return json({error:'终端配置格式无效或超过 112 KiB。'},400);
  const result = await store.transaction(async tx => {
    const grant = (await tx.read(userPath(session.id,'credentials')))?.sessions?.[session.sessionKey];
    if (!grant || grant.exp !== session.exp || grant.mode !== session.mode || grant.exp <= Date.now()/1000)
      return {error:'请重新登录。', status:401};
    const current = await read(tx);
    if (input.revision !== current.revision || current.revision === Number.MAX_SAFE_INTEGER)
      return {error:'云端终端配置已更新，请重新读取并解决冲突。', status:409};
    if (JSON.stringify(input.data) === JSON.stringify(current.data)) return current;
    const record = {version:1, revision:current.revision + 1, data:input.data, updatedAt:new Date().toISOString()};
    tx.write(key,record);
    return record;
  });
  return result.error ? json({error:result.error},result.status) : json({userId:session.id,...result});
}
