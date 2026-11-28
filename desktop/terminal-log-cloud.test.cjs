'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const {registerCloudLogs,seal,unseal,associated}=require('./terminal/terminal-log-cloud.cjs');
const secret='a separate passphrase', id=randomUUID();
const record={id,name:'test session',host:'fixture.test',text:'some chosen terminal output',bookmarks:[{label:'start',offset:0}]};
test('two devices decrypt a selected encrypted log only with its passphrase and bound metadata',async()=>{
  const aad=associated(null,'alice',id,record.name,record.host);
  const blob=await seal(record,secret,aad);
  assert.ok(!JSON.stringify(blob).includes(record.text));
  assert.deepEqual(await unseal(blob,secret,aad),record);
  await assert.rejects(unseal(blob,'wrong passphrase',aad),/口令/);
  await assert.rejects(unseal(blob,secret,associated(null,'bob',id,record.name,record.host)),/口令/);
  await assert.rejects(unseal({...blob,tag:Buffer.alloc(16).toString('base64')},secret,aad),/口令/);
});
test('publishing a stopped log requires individual consent and rechecks identity after confirmation',async()=>{
  let action, grant=false, changesAccount=false, current=record, scoped={userId:'alice'}, published, prompts=0;
  registerCloudLogs({handle:(_,fn)=>{action=fn;}, localUser:async()=>({id:scoped.userId}),scope:()=>scoped,
    readStopped:async()=>current,confirm:async()=>{prompts++;if(changesAccount) scoped={userId:'bob'};return grant;},
    accountRequest:async({body})=>{if(body.action==='publish') published=body; return {userId:'alice',revision:0,entries:[]};}});
  const input={localId:id,password:secret,days:7,revision:0,scope:null};
  assert.deepEqual(await action('publish',input),{canceled:true});assert.equal(published,undefined);
  current={...record,text:'-----BEGIN OPENSSH PRIVATE KEY-----'};
  await assert.rejects(action('publish',input),/私钥/);assert.equal(prompts,1);
  current=record;grant=true;changesAccount=true;
  await assert.rejects(action('publish',input),/登录/);assert.equal(published,undefined);
  changesAccount=false;scoped={userId:'alice'};
  await action('publish',input);
  assert.ok(published.blob);assert.ok(!JSON.stringify(published).includes(secret));assert.ok(!JSON.stringify(published).includes(record.text));
});

test('two independent desktop clients and a team reader resolve the same chosen copy through the Worker ACL',async()=>{
  const {terminalLogCloud,logCloudRoute}=await import('../cloudflare/src/terminal-log-cloud.js');
  const {sharedVaultPath}=await import('../cloudflare/src/terminal-shared-vaults.js');
  const {userPath}=await import('../cloudflare/src/account-store.js');
  const files=new Map(), expires=Math.floor(Date.now()/1000)+3600;
  const scope={ownerId:'alice',vaultId:randomUUID()};
  files.set(sharedVaultPath(scope.ownerId,scope.vaultId),{version:1,...scope,name:'Lab',members:[{id:'bob',role:'reader',state:'active'}],hosts:[{host:record.host}]});
  const store={transaction:fn=>fn({read:async(key,fallback=null)=>structuredClone(files.has(key)?files.get(key):fallback),write:(key,value)=>files.set(key,structuredClone(value))})};
  function device(actor,hasLocal=false) {
    let action;
    files.set(userPath(actor,'credentials'),{version:1,sessions:{[actor]:{mode:'native',exp:expires}}});
    const view={userId:actor};
    registerCloudLogs({handle:(_,fn)=>{action=fn;},scope:()=>view,localUser:async()=>({id:actor}),readStopped:async()=>{
      if (!hasLocal) throw new Error('No local log on this device');return record;
    },confirm:async()=>true,accountRequest:async ({path,body})=>{
      if (path.endsWith('/shared-vaults')) return {userId:actor,vault:{state:'active',role:'owner',name:'Lab',hosts:[{host:record.host}]}};
      const req=new Request('https://fixture.test'+logCloudRoute,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
      const response=await terminalLogCloud(req,{id:actor,sessionKey:actor,mode:'native',exp:expires,profile:{username:actor}},store);
      const value=await response.json();
      if (!response.ok) throw new Error(value.error);
      return value;
    }});
    return action;
  }
  const source=device('alice',true), other=device('alice'), team=device('bob'), outsider=device('mallory');
  const input={localId:id,password:secret,days:7,revision:0};
  const privateCopy=(await source('publish',{...input,scope:null})).entries[0];
  assert.deepEqual((await other('read',{id:privateCopy.id,scope:null,password:secret})).record,record);
  await assert.rejects(outsider('read',{id:privateCopy.id,scope:null,password:secret}),/权限/);
  const shared=(await source('publish',{...input,scope})).entries[0];
  assert.deepEqual((await team('read',{id:shared.id,scope,password:secret})).record,record);
  files.get(sharedVaultPath(scope.ownerId,scope.vaultId)).members=[];
  await assert.rejects(team('read',{id:shared.id,scope,password:secret}),/权限/);
});
