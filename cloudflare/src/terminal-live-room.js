import {random} from './accounts-crypto.js';
import {json} from './http.js';

export const lifetime = 3 * 60 * 1000;
export function validFrame(frame) {
  return typeof frame === 'string' && frame.length <= 8192 &&
    !/[\x00-\x09\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/u.test(frame);
}
// Each object is addressed by owner and vault. Room tickets, sockets, grants
// and consent are volatile. An isolate restart ends the session.
export class TerminalLiveRoom {
  finish(room) {
    if (!room || room !== this.room) return;
    this.room = null;
    clearTimeout(room.timer); clearTimeout(room.flushTimer); clearTimeout(room.renewTimer);
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
      if (this.room) {
        const current = this.room;
        if (!current.owner && current.ownerGrant.proof === input.grant.proof && current.viewerId === input.viewerId) {
          current.ownerGrant = input.grant;
          return json({role:'owner',ticket:current.ownerTicket,code:current.code,expires:current.expires});
        }
        return json({error:'这个主机库已有临时会话。'},409);
      }
      const room = {ref:input.ref,viewerId:input.viewerId,ownerGrant:input.grant,code:random(24),
        ownerTicket:random(),expires:Date.now()+lifetime,last:0};
      this.room = room;
      room.timer = setTimeout(() => this.finish(room),lifetime);
      return json({role:'owner',ticket:room.ownerTicket,code:room.code,expires:room.expires});
    }
    const room = this.room;
    if (path === '/renew') {
      const role = room && (input.grant.id === room.ref.ownerId ? 'owner' : 'viewer');
      if (!room?.challenge || input.challenge !== room.challenge || input.viewerId !== room.viewerId ||
          room[role+'Grant']?.proof !== input.grant.proof) return json({error:'授权挑战已经失效。'},403);
      room[role+'Grant'] = input.grant;
      room[role+'Renewed'] = true;
      if (room.ownerRenewed && room.viewerRenewed) {
        clearTimeout(room.renewTimer);
        room.challenge = undefined;
        this.schedule(room);
        this.deliverDraft(room);
      }
      return json({renewed:true});
    }
    if (path !== '/join' || !room || !room.owner || room.code !== input.code ||
        room.viewerId !== input.grant.id || room.viewer || (room.viewerTicket && room.viewerGrant.proof !== input.grant.proof)) return json({error:'邀请已结束或不属于当前账号。'},404);
    room.viewerGrant = input.grant;
    room.viewerTicket ??= random();
    return json({role:'viewer',ticket:room.viewerTicket,expires:room.expires});
  }
  socket(request) {
    const room = this.room;
    if (!room || Date.now() >= room.expires || request.headers.get('Upgrade')?.toLowerCase() !== 'websocket')
      return json({error:'临时会话已结束。'},404);
    const ticket = /^Bearer ([a-zA-Z0-9_-]{43})$/.exec(request.headers.get('Authorization') || '')?.[1];
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
    if (this.room !== room || room.challenge || room.flushTimer || room.pending === undefined) return;
    room.flushTimer = setTimeout(() => {
      room.flushTimer = undefined;
      const latest = room.pending; room.pending = undefined;
      this.frame(room,'owner',latest).catch(() => this.finish(room));
    },Math.max(0,room.last + 2000 - Date.now()));
  }
  deliverDraft(room) {
    if (room.pendingDraft === undefined || room.challenge) return;
    if (Date.now() >= Math.min(room.ownerGrant.until,room.viewerGrant.until)) return;
    room.owner.send(JSON.stringify({draft:room.pendingDraft}));
    room.pendingDraft = undefined;
  }
  renew(room) {
    if (room.challenge) return;
    room.challenge = random(24); room.ownerRenewed = false; room.viewerRenewed = false;
    room.renewTimer = setTimeout(() => this.finish(room),12000);
    for (const peer of [room.owner,room.viewer]) peer.send(JSON.stringify({refresh:room.challenge}));
  }
  async frame(room,role,text) {
    if (room !== this.room) return;
    if (Date.now() >= room.expires || !room.viewer || !room.owner || !validFrame(text)) {this.finish(room);return;}
    if (role === 'viewer') {
      let message;
      try { message = JSON.parse(text); } catch { this.finish(room); return; }
      if (typeof message?.draft !== 'string' || !message.draft.trim() || message.draft.length > 512 ||
          !validFrame(message.draft) || /[\r\n\u2028\u2029]/u.test(message.draft)) {this.finish(room);return;}
      if (room.draftAt && Date.now() - room.draftAt < 5000 || (room.draftCount || 0) >= 6) return;
      room.draftAt = Date.now(); room.draftCount = (room.draftCount || 0) + 1;
      room.pendingDraft = message.draft;
      if (Date.now() >= Math.min(room.ownerGrant.until,room.viewerGrant.until)) this.renew(room);
      else this.deliverDraft(room);
      return;
    }
    if (role !== 'owner') {this.finish(room);return;}
    if (room.challenge || Date.now() >= Math.min(room.ownerGrant.until,room.viewerGrant.until)) {
      room.pending = text;
      this.renew(room);
      return;
    }
    if (Date.now()-room.last < 2000) {room.pending = text;this.schedule(room);return;}
    room.last = Date.now();
    room.viewer.send(JSON.stringify({text}));
  }
}
