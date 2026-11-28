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
