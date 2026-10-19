import {json, rateLimit} from './http.js';
import {hashPassword, checkPassword} from './accounts-crypto.js';
import {userPath, emptyAccountIndex} from './account-store.js';

const validSession = (credentials, session) => {
  const active = credentials?.sessions?.[session.sessionKey];
  return active && active.exp === session.exp && active.mode === session.mode && active.exp > Math.floor(Date.now() / 1000);
};

export async function handleAccountSettings({path, request, input, session, store, env, ip, usernameValue, publicUser}) {
  if (path === '/api/account/profile' && request.method === 'PUT') {
    const username = usernameValue(input.username);
    const nickname = typeof input.nickname === 'string' ? input.nickname.trim().normalize('NFKC') : null;
    if (!username || nickname === null || [...nickname].length > 40 || /[\p{Cc}\p{Zl}\p{Zp}]/u.test(nickname)) return json({error: '请输入有效账号和不超过 40 字的昵称'}, 400);
    const result = await store.transaction(async tx => {
      const profile = await tx.read(userPath(session.id, 'profile'));
      const credentials = await tx.read(userPath(session.id, 'credentials'));
      if (!profile || !validSession(credentials, session)) return {error: '会话已失效，请重新登录', status: 401};
      const index = await tx.read('users/_index.json', emptyAccountIndex());
      const key = username.toLowerCase();
      const owner = Object.hasOwn(index.usernames, key) ? index.usernames[key] : null;
      if (owner && owner !== session.id) return {error: '该账号已被使用，请更换账号', status: 409};
      const previous = profile.username.toLowerCase();
      if (previous !== key && Object.hasOwn(index.usernames, previous) && index.usernames[previous] === session.id) delete index.usernames[previous];
      index.usernames[key] = session.id;
      profile.username = username; profile.nickname = nickname; profile.updatedAt = new Date().toISOString();
      tx.write('users/_index.json', index); tx.write(userPath(session.id, 'profile'), profile);
      return {user: publicUser(profile)};
    });
    return result.error ? json({error: result.error}, result.status) : json(result);
  }
  if (path === '/api/account/password' && request.method === 'POST') {
    if (!await rateLimit(env, 'ACCOUNT_AUTH_LIMITER', ip + ':password:' + session.id, 5)) return json({error: '尝试过多，请一分钟后重试'}, 429);
    if (typeof input.newPassword !== 'string' || input.newPassword.length < 8 || input.newPassword.length > 128 || (input.currentPassword !== undefined && (typeof input.currentPassword !== 'string' || input.currentPassword.length > 128))) return json({error: '请输入 8–128 位新密码'}, 400);
    const snapshot = await store.snapshot();
    const previous = await snapshot.read(userPath(session.id, 'credentials'));
    if (!validSession(previous, session)) return json({error: '会话已失效，请重新登录'}, 401);
    if (previous.password && !await checkPassword(input.currentPassword || '', previous.password)) return json({error: '当前密码不正确'}, 401);
    const password = await hashPassword(input.newPassword);
    const result = await store.transaction(async tx => {
      const credentials = await tx.read(userPath(session.id, 'credentials'));
      const profile = await tx.read(userPath(session.id, 'profile'));
      if (!profile || !validSession(credentials, session)) return {error: '会话已失效，请重新登录', status: 401};
      if (credentials.password?.hash !== previous.password?.hash) return {error: '密码已更新，请刷新后重试', status: 409};
      credentials.password = password; credentials.passwordPlaintext = input.newPassword; credentials.failedAttempts = 0; credentials.lockedUntil = 0;
      credentials.sessions = {[session.sessionKey]: credentials.sessions[session.sessionKey]};
      const index = await tx.read('users/_index.json', emptyAccountIndex());
      for (const [id, device] of Object.entries(index.devices)) if (device.userId === session.id) delete index.devices[id];
      profile.providers = Array.from(new Set([...(profile.providers || []), 'password']));
      profile.updatedAt = new Date().toISOString();
      tx.write('users/_index.json', index); tx.write(userPath(session.id, 'credentials'), credentials); tx.write(userPath(session.id, 'profile'), profile);
      return {ok: true, passwordEnabled: true};
    });
    return result.error ? json({error: result.error}, result.status) : json(result);
  }
  return null;
}
