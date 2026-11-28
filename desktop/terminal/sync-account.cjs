'use strict';

const path = '/api/account/apps/terminal/data';
async function syncAccount(request, operation, payload) {
  if (operation === 'session') {
    const { user } = await request({ path: '/api/account/session' });
    return { user: user ? { id: user.id, email: user.email } : null };
  }
  if (!payload || typeof payload.expectedUserId !== 'string' || !/^[a-zA-Z0-9-]{1,128}$/.test(payload.expectedUserId))
    throw new Error('请先确认当前登录账号。');
  let record;
  if (operation === 'read') record = await request({ path });
  else if (operation === 'write') {
    const { expectedUserId, revision, data } = payload;
    record = await request({ path, method:'PUT', body:{ expectedUserId, revision, data } });
  } else throw new Error('未知的终端同步操作。');
  if (record.userId !== payload.expectedUserId) throw new Error('账号已变化，请重新打开终端同步。');
  return record;
}
module.exports = { syncAccount };

// The cached proof ties a previously verified account to this exact local login.
// A replaced token makes the cache unusable; the renderer never sees either token.
function localIdentity(directory, sessionStore = require('../account.cjs').createAccountStore(directory)) {
  const fs = require('node:fs/promises');
  const path = require('node:path');
  const {createHash, randomUUID} = require('node:crypto');
  const record = path.join(directory, 'terminal-account-binding.json');
  const digest = token => createHash('sha256').update(token).digest('hex');
  async function current() {
    const token = await sessionStore.read();
    if (!token) return {known:true, user:null};
    try {
      const data = JSON.parse(await fs.readFile(record, 'utf8'));
      if (data.digest === digest(token) && /^[a-zA-Z0-9-]{1,128}$/.test(data.user?.id))
        return {known:true, user:{id:data.user.id, email:data.user.email}};
    } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
    return {known:false,user:null};
  }
  async function verify(request) {
    const token = await sessionStore.read();
    const result = await syncAccount(request, 'session');
    if (token !== await sessionStore.read()) throw new Error('账号已变化，请重试。');
    if (!result.user) {
      await fs.rm(record, {force:true});
      return result;
    }
    if (!token || !/^[a-zA-Z0-9-]{1,128}$/.test(result.user.id)) throw new Error('本机登录信息已失效。');
    const temporary = record + '.' + randomUUID() + '.tmp';
    try {
      await fs.writeFile(temporary, JSON.stringify({digest:digest(token),user:result.user}), {flag:'wx', mode:0o600});
      await fs.rename(temporary,record);
    } finally { await fs.rm(temporary,{force:true}); }
    return result;
  }
  return {current, verify};
}
module.exports.localIdentity = localIdentity;
