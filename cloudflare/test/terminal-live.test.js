import {test} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {createRequire} from 'node:module';
import {liveFixture} from './terminal-live-fixture.js';
import {validFrame} from '../src/terminal-live-room.js';
const Socket = createRequire(import.meta.url)('ws');

test('two scoped account grants produce a one-way, expiring, non-replayable live view', {timeout:45000},async t => {
  const f = await liveFixture(); t.after(() => f.mf.dispose());
  const {ref,viewerId}=f;
  async function call(id,action,fields) {
    const req = await fetch(new URL('/api/account/apps/terminal/live-view',f.url),{method:'POST',
      headers:{'Content-Type':'application/json','X-Brclio-Client':'native',Authorization:'Bearer ' + f.tokens[id]},
      body:JSON.stringify({expectedUserId:id,...ref,action,...fields})});
    return {status:req.status,...await req.json()};
  }
  const connect = async token => {
    const url = new URL('/terminal-live-socket/'+ref.ownerId+'/'+ref.vaultId,f.url); url.protocol='ws:';
    const ws = new Socket(url,{headers:{Authorization:'Bearer '+token}}); ws.on('error',()=>{});
    await once(ws,'open'); return ws;
  };
  const owner = await call(ref.ownerId,'create',{viewerId});
  assert.equal(owner.status,200); assert.ok(owner.expires <= Date.now()+180000);
  assert.equal((await call(ref.ownerId,'create',{viewerId})).ticket,owner.ticket);
  const host = await connect(owner.ticket); t.after(() => host.terminate());
  assert.equal((await call('fixture-clara','join',{code:owner.code})).status,403);
  assert.equal((await call(viewerId,'join',{code:'x'.repeat(32)})).status,404);
  const viewer = await call(viewerId,'join',{code:owner.code});
  assert.equal((await call(viewerId,'join',{code:owner.code})).ticket,viewer.ticket);
  const ready = once(host,'message');
  const observer = await connect(viewer.ticket); t.after(() => observer.terminate());
  assert.equal(JSON.parse((await ready)[0].toString()).ready,true);
  await assert.rejects(connect(viewer.ticket));
  const receive = once(observer,'message'); host.send('可见文字');
  assert.deepEqual(JSON.parse((await receive)[0].toString()),{text:'可见文字'});
  f.revoke();
  await new Promise(resolve => setTimeout(resolve,15500));
  const ownerRefresh = once(host,'message'), viewerRefresh = once(observer,'message');
  host.send('MUST REMAIN WITHHELD');
  const challenge = JSON.parse((await ownerRefresh)[0].toString()).refresh;
  assert.ok(challenge); assert.deepEqual(JSON.parse((await viewerRefresh)[0].toString()),{refresh:challenge});
  const [ownerDenied,viewerDenied] = await Promise.all([call(ref.ownerId,'renew',{challenge,viewerId}),call(viewerId,'renew',{challenge})]);
  assert.equal(ownerDenied.status,403); assert.equal(viewerDenied.status,403);
  const done = once(host,'close'); observer.send('guest input'); await done;
  assert.equal((await call(viewerId,'join',{code:owner.code})).status,403);
  for (const frame of ['\x1b]52;fake','\r','x'.repeat(8193)]) assert.equal(validFrame(frame),false);
});

test('an expired publisher or spectator lease pauses delivery until both original grants renew the same challenge',async () => {
  const {TerminalLiveRoom} = await import('../src/terminal-live-room.js');
  const ref = {ownerId:'owner',vaultId:'94669d49-44ba-4ce6-9013-0d4bd8e1fbce'};
  const relay = new TerminalLiveRoom(), frames = [], hostState = [];
  const grant = id => ({id,proof:'fixture-grant-'+id,until:Date.now()+15000});
  const session = relay.room = {ref,viewerId:'observer',ownerGrant:grant('owner'),viewerGrant:grant('observer'),
    owner:{send:text=>hostState.push(JSON.parse(text)),close(){}},viewer:{send:text=>frames.push(JSON.parse(text)),close(){}},
    expires:Date.now()+180000,last:0};
  await relay.frame(session,'owner','first');
  session.viewerGrant.until=0;
  await relay.frame(session,'owner','after-expiry'); assert.equal(frames.length,2); assert.ok(frames[1].refresh);
  assert.equal(hostState[0].refresh,frames[1].refresh);
  const renew = (proof,challenge=frames[1].refresh) => relay.fetch(new Request('https://room.internal/renew',{method:'POST',
    body:JSON.stringify({viewerId:'observer',grant:proof,challenge})}));
  assert.equal((await renew({...grant('observer'),proof:'wrong-session'})).status,403);
  assert.equal((await renew(grant('owner'),'wrong-challenge')).status,403);
  assert.equal((await renew(grant('owner'))).status,200);
  await relay.frame(session,'owner','latest-before-second-consent');
  assert.equal(frames.length,2);
  session.last=0; assert.equal((await renew(grant('observer'))).status,200);
  await new Promise(resolve => setTimeout(resolve,20));
  assert.deepEqual(frames.at(-1),{text:'latest-before-second-consent'});
  session.expires=Date.now()-1;
  await relay.frame(session,'owner','expired'); assert.equal(relay.room,null);
});
