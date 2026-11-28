import {createAccountStore,userPath} from './account-store.js';
import {sharedVaultPath} from './terminal-shared-vaults.js';
import {random} from './accounts-crypto.js';
import {json} from './http.js';

export const lifetime = 3 * 60 * 1000;
export function liveAccountStore(env) {
  return createAccountStore(env, fetch,async () => {
    if (typeof env.TERMINAL_LIVE_REPO_READ_TOKEN !== 'string' || !env.TERMINAL_LIVE_REPO_READ_TOKEN) throw new Error('Live account reader unavailable');
    return env.TERMINAL_LIVE_REPO_READ_TOKEN;
  });
}
export async function eligible(store, vaultRef, grants, viewerId) {
  const snapshot = await store.snapshot();
  const vault = await snapshot.read(sharedVaultPath(vaultRef.ownerId,vaultRef.vaultId));
  if (vault?.version !== 1 || vault.ownerId !== vaultRef.ownerId || vault.vaultId !== vaultRef.vaultId ||
      !vault.members?.some(member => member.id === viewerId && member.state === 'active')) return false;
  const results = await Promise.all(grants.map(async actor => {
    const grant = (await snapshot.read(userPath(actor.id,'credentials')))?.sessions?.[actor.sessionKey];
    return grant && grant.mode === actor.mode && grant.exp === actor.exp && grant.exp > Date.now()/1000;
  }));
  return results.every(Boolean);
}
export function validFrame(frame) {
  return typeof frame === 'string' && frame.length <= 8192 &&
    !/[\x00-\x09\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/u.test(frame);
}
// Each object is addressed by owner and vault. Room tickets, sockets, grants
// and consent are volatile. An isolate restart ends the session.
export class TerminalLiveRoom {
  constructor(_ctx, env) { this.env = env; }
  finish(room) {
    if (!room || room !== this.room) return;
    this.room = null;
    clearTimeout(room.timer); clearTimeout(room.flushTimer);
    for (const key of ['owner','viewer']) {
      try {room[key]?.close(1000,'会话已结束');} catch {}
    }
  }
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/socket') return this.socket(request);
    const input = await request.json();
    if (this.room?.expires <= Date.now()) this.finish(this.room);
    if (path === '/create') {
      if (this.room) return json({error:'这个主机库已有临时会话。'},409);
      const room = {ref:input.ref,viewerId:input.viewerId,ownerGrant:input.grant,code:random(24),
        ownerTicket:random(),expires:Date.now()+lifetime,last:0};
      this.room = room;
      room.timer = setTimeout(() => this.finish(room),lifetime);
      return json({role:'owner',ticket:room.ownerTicket,code:room.code,expires:room.expires});
    }
    const room = this.room;
    if (path !== '/join' || !room || !room.owner || room.code !== input.code ||
        room.viewerId !== input.grant.id || room.viewer || room.viewerTicket) return json({error:'邀请已结束或不属于当前账号。'},404);
    room.viewerGrant = input.grant;
    room.viewerTicket = random();
    return json({role:'viewer',ticket:room.viewerTicket,expires:room.expires});
  }
  socket(request) {
    const room = this.room;
    if (!room || Date.now() >= room.expires || request.headers.get('Upgrade')?.toLowerCase() !== 'websocket')
      return json({error:'临时会话已结束。'},404);
    const ticket = request.headers.get('Authorization')?.replace(/^Bearer /,'');
    const role = ticket && ticket === room.ownerTicket ? 'owner' : ticket && ticket === room.viewerTicket ? 'viewer' : null;
    if (!role || room[role]) return json({error:'连接凭据已失效。'},403);
    const [client,server] = Object.values(new WebSocketPair());
    delete room[role+'Ticket'];
    room[role] = server;
    server.accept();
    server.addEventListener('close',() => this.finish(room));
    server.addEventListener('error',() => this.finish(room));
    server.addEventListener('message',event => {
      this.frame(room,role,event.data).catch(() => this.finish(room));
    });
    if (room.owner && room.viewer) for (const socket of [room.owner,room.viewer]) socket.send('{"ready":true}');
    return new Response(null,{status:101,webSocket:client});
  }
  schedule(room) {
    if (this.room !== room || room.checking || room.flushTimer || room.pending === undefined) return;
    room.flushTimer = setTimeout(() => {
      room.flushTimer = undefined;
      const latest = room.pending; room.pending = undefined;
      this.frame(room,'owner',latest).catch(() => this.finish(room));
    },Math.max(0,room.last + 2000 - Date.now()));
  }
  async frame(room,role,text) {
    if (room !== this.room) return;
    if (Date.now() >= room.expires || role !== 'owner' || !room.viewer || !validFrame(text)) {this.finish(room);return;}
    if (room.checking || Date.now()-room.last < 2000) {
      room.pending = text;
      this.schedule(room);
      return;
    }
    room.checking = true; room.last = Date.now();
    try {
      // At most twelve authorization refreshes in a three-minute session.
      // No changed output means no reads. A failed refresh closes both sockets.
      const now = Date.now();
      if (!room.authorizedUntil || now >= room.authorizedUntil) {
        const valid = await eligible(this.store || liveAccountStore(this.env),room.ref,[room.ownerGrant,room.viewerGrant],room.viewerId);
        if (this.room !== room) return;
        if (!valid) {this.finish(room);return;}
        room.authorizedUntil = Math.min(now + 15000,room.ownerGrant.exp * 1000,room.viewerGrant.exp * 1000,room.expires);
      }
      if (Date.now() >= room.authorizedUntil) {this.finish(room);return;}
      room.viewer.send(JSON.stringify({text}));
    } finally {room.checking = false; this.schedule(room);}
  }
}
