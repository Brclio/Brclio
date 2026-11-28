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
