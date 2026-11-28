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
  const host = await connect(owner.ticket); t.after(() => host.terminate());
  assert.equal((await call('fixture-clara','join',{code:owner.code})).status,403);
  assert.equal((await call(viewerId,'join',{code:'x'.repeat(32)})).status,404);
  const viewer = await call(viewerId,'join',{code:owner.code});
  const ready = once(host,'message');
  const observer = await connect(viewer.ticket); t.after(() => observer.terminate());
  assert.equal(JSON.parse((await ready)[0].toString()).ready,true);
  await assert.rejects(connect(viewer.ticket));
  const receive = once(observer,'message'); host.send('可见文字');
  assert.deepEqual(JSON.parse((await receive)[0].toString()),{text:'可见文字'});
  const done = once(host,'close'); observer.send('guest input'); await done;
  assert.equal((await call(viewerId,'join',{code:owner.code})).status,404);
  for (const frame of ['\x1b]52;fake','\r','x'.repeat(8193)]) assert.equal(validFrame(frame),false);
});

test('live publishing enforces the finite authorization lease, revocation, closed grants and room expiry',async () => {
  const {TerminalLiveRoom} = await import('../src/terminal-live-room.js');
  const {sharedVaultPath} = await import('../src/terminal-shared-vaults.js');
  const ref = {ownerId:'owner',vaultId:'94669d49-44ba-4ce6-9013-0d4bd8e1fbce'};
  const actor = id => ({id,mode:'native',exp:Math.floor(Date.now()/1000)+600,sessionKey:'fixture'});
  let active = true,validLogin = true,reads = 0;
  const acl = sharedVaultPath(ref.ownerId,ref.vaultId);
  const relay = new TerminalLiveRoom();
  relay.store = {snapshot:async () => {reads++; return {read:key => key === acl ?
    {version:1,...ref,members:active ? [{id:'observer',state:'active'}] : []} :
    {sessions:validLogin ? {fixture:actor('observer')} : {}}};}};
  const frames = [];
  const room = () => ({ref,viewerId:'observer',ownerGrant:actor('owner'),viewerGrant:actor('observer'),
    viewer:{send:text=>frames.push(JSON.parse(text)),close(){}},expires:Date.now()+180000,last:0});
  let session = relay.room = room();
  await relay.frame(session,'owner','first'); assert.equal(reads,1);
  session.last = 0; await relay.frame(session,'owner','next'); assert.equal(reads,1);
  assert.ok(session.authorizedUntil <= Date.now()+15000);
  active=false; session.authorizedUntil=0; session.last=0;
  await relay.frame(session,'owner','revoked-content'); assert.equal(relay.room,null);
  assert.deepEqual(frames,[{text:'first'},{text:'next'}]);
  active=true; validLogin=false; session=relay.room=room();
  await relay.frame(session,'owner','logged-out'); assert.equal(relay.room,null);
  session=relay.room=room(); session.expires=Date.now()-1;
  await relay.frame(session,'owner','expired'); assert.equal(relay.room,null);
  assert.equal(frames.length,2);
});
