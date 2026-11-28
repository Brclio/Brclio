import test from 'node:test';
import assert from 'node:assert/strict';
import {terminalLogCloud,logCloudRoute} from '../src/terminal-log-cloud.js';
import {sharedVaultPath} from '../src/terminal-shared-vaults.js';
import {appDataPath,userPath} from '../src/account-store.js';
import {randomUUID} from 'node:crypto';

function fixture() {
  const files=new Map(), users={}, exp=Math.floor(Date.now()/1000)+600;
  for (const id of ['alice','bob','eve','guest']) {
    users[id]={id,sessionKey:'session-'+id,mode:'native',exp,profile:{id,username:id}};
    files.set(userPath(id,'credentials'),{version:1,sessions:{['session-'+id]:{mode:'native',exp}}});
  }
  const vaultId=randomUUID(), scope={ownerId:'alice',vaultId};
  const path=sharedVaultPath('alice',vaultId), vault={version:1,...scope,members:[
    {id:'bob',state:'active',role:'editor'},{id:'eve',state:'active',role:'reader'},{id:'guest',state:'invited',role:'editor'}],hosts:[{host:'node.test'}]};
  files.set(path,vault);
  const store={transaction:fn => fn({read:async (key,fallback=null)=>structuredClone(files.has(key)?files.get(key):fallback),
    write:(key,value)=>files.set(key,structuredClone(value))})};
  const blob={version:1,salt:Buffer.alloc(16).toString('base64'),iv:Buffer.alloc(12).toString('base64'),
    tag:Buffer.alloc(16).toString('base64'),data:Buffer.from('only cipher here').toString('base64')};
  const call=async (actor,action,area,extra={})=>{
    const response=await terminalLogCloud(new Request('https://example.test'+logCloudRoute,{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({expectedUserId:actor,action,scope:area,...extra})}),users[actor],store);
    return {status:response.status,body:await response.json()};
  };
  const publish=(actor,area,extra={})=>call(actor,'publish',area,{id:randomUUID(),name:'test copy',host:'node.test',days:7,revision:0,blob,...extra});
  return {files,users,scope,vault,call,publish};
}
test('personal encrypted log copies are inaccessible to another account and deletion tombstones the blob',async()=>{
  const {files,call,publish}=fixture();
  const id=randomUUID();
  assert.equal((await publish('alice',null,{id})).status,200);
  assert.deepEqual((await call('bob','list',null)).body.entries,[]);
  assert.equal((await call('bob','read',null,{id})).status,404);
  assert.ok((await call('alice','read',null,{id})).body.blob);
  assert.equal((await call('alice','remove',null,{id,revision:0})).status,409);
  assert.equal((await call('alice','remove',null,{id,revision:1})).status,200);
  assert.equal((await call('alice','read',null,{id})).status,404);
  assert.deepEqual(files.get(appDataPath('alice','tlog-data-'+id.replaceAll('-',''))),{version:1,deleted:true});
});
test('shared log reads and mutations check current membership, scope, host and session on every request',async()=>{
  const {files,scope,vault,call,publish}=fixture(), id=randomUUID();
  assert.equal((await publish('bob',scope,{id,host:'unrelated.test'})).status,400);
  assert.equal((await publish('eve',scope,{id})).status,403);
  assert.equal((await publish('bob',scope,{id})).status,200);
  assert.equal((await call('guest','read',scope,{id})).status,404);
  assert.equal((await call('eve','read',scope,{id})).status,200);
  assert.equal((await call('eve','remove',scope,{id,revision:1})).status,403);
  vault.members=vault.members.filter(m=>m.id!=='eve');
  assert.equal((await call('eve','read',scope,{id})).status,404);
  files.get(userPath('bob','credentials')).sessions={};
  assert.equal((await call('bob','list',scope)).status,401);
  assert.equal((await call('alice','remove',scope,{id,revision:1})).status,200);
});
test('expired copies stop being served before lazy retention cleanup and cleartext fields are rejected',async()=>{
  const {files,call,publish}=fixture(), id=randomUUID();
  assert.equal((await publish('alice',null,{password:'must-not-leave-device'})).status,400);
  assert.equal((await publish('alice',null,{id})).status,200);
  files.get(appDataPath('alice','tlog-personal')).entries[0].expiresAt=Date.now()-1;
  assert.equal((await call('alice','read',null,{id})).status,404);
  assert.deepEqual((await call('alice','list',null)).body.entries,[]);
  assert.deepEqual(files.get(appDataPath('alice','tlog-data-'+id.replaceAll('-',''))),{version:1,deleted:true});
});

test('only a vault owner sets prospective retention and reads the last 64 minimal ciphertext-access events',async()=>{
  const {files,scope,call,publish}=fixture();
  const first=randomUUID(), next=randomUUID();
  assert.equal((await publish('bob',scope,{id:first,days:30})).status,200);
  const original=(await call('bob','list',scope)).body.entries[0].expiresAt;
  assert.equal((await call('alice','policy',null,{days:7,revision:0})).status,400);
  for (const actor of ['bob','eve','guest']) {
    assert.ok([403,404].includes((await call(actor,'policy',scope,{days:1,revision:1})).status));
    assert.ok([403,404].includes((await call(actor,'audit',scope)).status));
  }
  assert.equal((await call('alice','policy',scope,{days:7,revision:0})).status,409);
  const changed=await call('alice','policy',scope,{days:7,revision:1});
  assert.equal(changed.body.maximumDays,7);
  assert.equal(changed.body.entries[0].expiresAt,original);
  assert.equal((await publish('bob',scope,{days:30,revision:2})).status,400);
  assert.equal((await publish('bob',scope,{days:7,id:next,revision:2})).status,200);
  assert.equal((await call('guest','read',scope,{id:next})).status,404);
  for (let i=0;i<66;i++) {
    const response=await call(i%2?'bob':'eve','read',scope,{id:i%2?first:next});
    assert.equal(response.status,200);
  }
  const events=(await call('alice','audit',scope)).body.events;
  assert.equal(events.length,64);
  for (const [i,event] of events.entries()) {
    assert.deepEqual(Object.keys(event).sort(),['actor','event','id','time']);
    assert.equal(event.actor,i%2?'eve':'bob');
    assert.equal(event.event,'read-copy');
    assert.equal(event.id,i%2?next:first);
    assert.ok(Number.isSafeInteger(event.time));
  }
  for (const actor of ['alice','bob','eve']) {
    const result=(await call(actor,'list',scope)).body;
    assert.equal(result.revision,3,'audits do not invalidate a pending publication form');
    assert.ok(!Object.hasOwn(result,'events') && !Object.hasOwn(result,'audit'));
  }
  const before=JSON.stringify(files.get(appDataPath('alice','tlog-index-'+scope.vaultId.replaceAll('-',''))));
  await call('eve','list',scope);await call('alice','audit',scope);
  assert.equal(JSON.stringify(files.get(appDataPath('alice','tlog-index-'+scope.vaultId.replaceAll('-','')))),before);
});

test('authenticated team reads commit before returning and bounded Git ref retries preserve both audits or fail closed',async t=>{
  const {repositoryFixture}=await import('./fixtures/private-record-store.js');
  const {handleAccount}=await import('../src/accounts.js');
  const {seal,digest}=await import('../src/accounts-crypto.js');
  const {files,scope,users,publish}=fixture(), id=randomUUID();
  await publish('bob',scope,{id});
  const env={SESSION_SECRET:'integration-synthetic-key-for-log-tests',ACCOUNT_LIMITER:{limit:async()=>({success:true})}};
  const tokens={};
  for (const actor of ['bob','eve','alice']) {
    const session=users[actor],sid='test-'+actor;
    tokens[actor]=await seal({typ:'account',id:actor,sid,csrf:'test',exp:session.exp,mode:'native'},env.SESSION_SECRET);
    files.set(userPath(actor,'credentials'),{version:1,sessions:{[await digest(sid)]:{exp:session.exp,mode:'native'}}});
    files.set(userPath(actor,'profile'),{version:1,id:actor,username:actor});
  }
  let conflicting=false, revoke=false, block=true, entered=0, release;
  const rendezvous=new Promise(resolve=>{release=resolve;});
  const repo=repositoryFixture(Object.fromEntries(files),async call=>{
    if (call.path !== '/git/refs/heads/main') return;
    if (conflicting) return new Response(null,{status:422});
    if (revoke) {
      revoke=false;
      await repo.store.transaction(async tx=>{
        const path=sharedVaultPath(scope.ownerId,scope.vaultId), vault=await tx.read(path);
        vault.members=vault.members.filter(member=>member.id!=='eve');
        tx.write(path,vault);
      });
    }
    if (block) {
      if (++entered===2) {block=false;release();}
      await rendezvous;
    }
  });
  const fetchAs=(actor,action,extra={})=>handleAccount(new Request('https://example.test'+logCloudRoute,{
    method:'POST',headers:{'Content-Type':'application/json','X-Brclio-Client':'native',Authorization:'Bearer '+tokens[actor]},
    body:JSON.stringify({expectedUserId:actor,scope,action,...extra})}),env,{accountStore:repo.store});
  const both=await Promise.all([fetchAs('bob','read',{id}),fetchAs('eve','read',{id})]);
  assert.ok(both.every(response=>response.status===200));
  assert.equal(repo.updates.length,2);
  const stored=(await (await fetchAs('alice','audit')).json()).events;
  assert.deepEqual(stored.map(e=>e.actor).sort(),['bob','eve']);
  conflicting=true;
  const before=repo.calls.length;
  const failed=await fetchAs('bob','read',{id});
  const calls=repo.calls.slice(before);
  assert.equal(failed.status,409);
  assert.ok(!Object.hasOwn(await failed.json(),'blob'));
  assert.equal(calls.filter(c=>c.method==='PATCH').length,2);
  assert.ok(calls.length<=32,'bounded authenticated GitHub subrequests: '+calls.length);
  t.diagnostic('Two failed Git ref writes used '+calls.length+' authenticated GitHub API calls including session checks.');
  assert.equal(repo.updates.length,2);
  conflicting=false; revoke=true;
  const revoked=await fetchAs('eve','read',{id});
  assert.equal(revoked.status,404);
  assert.ok(!Object.hasOwn(await revoked.json(),'blob'));
  assert.equal(repo.updates.length,3,'only the membership revocation was published');
  assert.deepEqual((await (await fetchAs('alice','audit')).json()).events,stored);
});
