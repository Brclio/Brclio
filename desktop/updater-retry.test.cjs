'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {createUpdater, API_URL} = require('./updater.cjs');

const payload = Buffer.from('complete retry fixture installer');
const digest = crypto.createHash('sha256').update(payload).digest('hex');
const assetName = 'Brclio-0.2.0-mac-arm64.dmg';
const prefix = 'https://github.com/Brclio/Brclio/releases/download/v0.2.0/';
const manifestURL = prefix + 'SHA256SUMS.txt', assetURL = prefix + assetName;
const release = {tag_name:'v0.2.0', assets:[
  {name:assetName, size:payload.length, browser_download_url:assetURL, digest:'sha256:'+digest},
  {name:'SHA256SUMS.txt', browser_download_url:manifestURL},
]};
const networkError = () => Object.assign(Error('更新网络连接失败。'), {code:'BRCLIO_UPDATE_NETWORK'});

async function until(condition) {
  const deadline = performance.now() + 3000;
  while (!condition()) {
    if (performance.now() > deadline) throw Error('fixture condition not reached');
    await new Promise(setImmediate);
  }
}
async function fixture(t, fetch, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(),'brclio-updater-retry-'));
  t.after(() => fs.rm(directory,{recursive:true,force:true}));
  const calls = [], operations = [], states = [];
  const updater = createUpdater({currentVersion:'0.1.0', platform:'darwin', architecture:'arm64', directory, retryDelay:0,
    fetch:async(url,init) => { calls.push({url,init}); return fetch(url,init); },
    onOperation:async(kind,active,targets) => {operations.push({kind,active,targets});},
    onState:state => states.push(state), ...options});
  return {updater,directory,calls,operations,states};
}

test('checking retries early failures, awaits a fresh route per attempt and stops immediately on success', async t => {
  let attempts=0, ready=0, calls=0;
  const operations=[];
  const f=await fixture(t, async()=>{
    assert.equal(ready,attempts,'network must wait for the fresh route');
    if(++calls<3)throw networkError();
    return new Response(JSON.stringify(release));
  },{onOperation:async(kind,active)=>{operations.push([kind,active]);if(active){attempts++;await new Promise(setImmediate);ready=attempts;}}});
  const result=await f.updater.check();
  assert.equal(result.status,'available');assert.equal(result.retryCount,2);assert.equal(result.retryLimit,10);
  assert.equal(result.retrying,false);assert.equal(result.retryExhausted,false);assert.equal(result.retryStage,'check');
  assert.equal(calls,3);
  assert.deepEqual(operations,[['check',true],['check',true],['check',true],['check',false]]);
  assert.ok(f.states.filter(state=>state.retrying).every(state=>state.status==='checking'));
  assert.ok(!f.states.some(state=>state.status==='error'));
});

test('checking exhausts ten retries at eleven attempts and a manual check resets every retry field', async t => {
  let failing=true;
  const f=await fixture(t,async()=>{if(failing)throw networkError();return new Response(JSON.stringify(release));});
  const exhausted=await f.updater.check();
  assert.equal(f.calls.length,11);assert.equal(exhausted.status,'error');assert.equal(exhausted.retryCount,10);
  assert.equal(exhausted.retryExhausted,true);assert.equal(exhausted.retrying,false);
  assert.match(exhausted.error,/自动重试 10 次.*手动重试/);
  assert.equal(f.operations.filter(value=>value.active).length,11);assert.equal(f.operations.filter(value=>!value.active).length,1);
  failing=false;
  const pending=f.updater.check();
  assert.equal(f.updater.state().retryCount,0);assert.equal(f.updater.state().retryExhausted,false);
  assert.equal((await pending).status,'available');assert.equal(f.updater.state().retryCount,0);assert.equal(f.calls.length,12);
});

test('each check timeout gets a fresh twenty-second budget even when fetch ignores cancellation', async t => {
  t.mock.timers.enable({apis:['setTimeout']});
  let firstSignal, calls=0;
  const f=await fixture(t,async(_url,init)=>{if(++calls===1){firstSignal=init.signal;return new Promise(()=>{});}return new Response(JSON.stringify(release));},{requestTimeout:20});
  const checking=f.updater.check();await until(()=>firstSignal);
  t.mock.timers.tick(19);assert.equal(firstSignal.aborted,false);assert.equal(calls,1);
  t.mock.timers.tick(1);
  const result=await checking;assert.equal(firstSignal.aborted,true);assert.equal(result.status,'available');assert.equal(result.retryCount,1);assert.equal(calls,2);
});

test('default retry backoff is one, two, four then at most five seconds', async t => {
  t.mock.timers.enable({apis:['setTimeout']});
  let calls=0;
  const f=await fixture(t,async()=>{if(++calls<5)throw networkError();return new Response(JSON.stringify(release));},{retryDelay:undefined});
  const checking=f.updater.check();
  for(const [index,wait] of [1000,2000,4000,5000].entries()){
    await until(()=>f.updater.state().retrying&&calls===index+1);
    t.mock.timers.tick(wait-1);assert.equal(calls,index+1);
    t.mock.timers.tick(1);await until(()=>calls===index+2);
  }
  assert.equal((await checking).retryCount,4);
});

test('cancellation, certificates, unsafe addresses and unknown errors stop without losing the specific error', async t => {
  for(const error of [
    Object.assign(Error('用户取消。'),{name:'AbortError',code:'BRCLIO_UPDATE_NETWORK'}),
    Object.assign(Error('证书校验失败。'),{code:'BRCLIO_UPDATE_SECURITY'}),
    Object.assign(Error('不允许的更新地址。'),{code:'BRCLIO_UPDATE_ROUTE'}),
    Object.assign(Error('证书无效。'),{code:'ERR_CERT_AUTHORITY_INVALID'}),
    Error('未知失败，请检查配置。'),
  ]){
    const f=await fixture(t,async()=>{throw error;});const result=await f.updater.check();
    assert.equal(f.calls.length,1);assert.equal(result.error,error.message);assert.equal(result.retryCount,0);assert.equal(result.retryExhausted,false);
  }
  let calls=0;
  const f=await fixture(t,async()=>{if(++calls===1)throw networkError();throw Object.assign(Error('停止：证书校验失败。'),{code:'BRCLIO_UPDATE_SECURITY'});});
  assert.equal((await f.updater.check()).error,'停止：证书校验失败。');assert.equal(calls,2);assert.equal(f.updater.state().retryExhausted,false);
});

test('a known security rejection stays permanent even when response cancellation stalls until timeout', async t => {
  t.mock.timers.enable({apis:['setTimeout']});
  for(const stage of ['check','download']){
    let cancelling=false;
    const f=await fixture(t,async url=>{
      if(stage==='download'&&url===API_URL)return new Response(JSON.stringify(release));
      return new Response(new ReadableStream({cancel(){cancelling=true;return new Promise(()=>{});}},{highWaterMark:0}),{status:403,headers:{'cf-mitigated':'challenge'}});
    },{requestTimeout:20});
    if(stage==='download')await f.updater.check();
    const pending=f.updater[stage]();await until(()=>cancelling);t.mock.timers.tick(20);
    const result=await pending;assert.equal(result.status,'error');assert.equal(result.retryCount,0);assert.match(result.error,/Cloudflare 安全验证/);assert.equal(f.calls.length,stage==='check'?1:2);
  }
});

test('manifest and installer failures share one budget and retain a usable prefix while refreshing the route', async t => {
  let manifests=0, assets=0, routes=0;
  let f;
  f=await fixture(t,async url=>{
    if(url===API_URL)return new Response(JSON.stringify(release));
    if(url===manifestURL){
      assert.equal(routes,++manifests);
      if(manifests<3)await assert.rejects(fs.stat(path.join(f.directory,assetName+'.part')),{code:'ENOENT'});
      else assert.deepEqual(await fs.readFile(path.join(f.directory,assetName+'.part')),payload.subarray(0,5));
      if(manifests===1)throw networkError();
      return new Response(`${digest}  ${assetName}`);
    }
    assert.equal(url,assetURL);
    if(++assets===1){let first=true;return new Response(new ReadableStream({pull(controller){if(first){first=false;controller.enqueue(payload.subarray(0,5));}else controller.error(networkError());}},{highWaterMark:0}));}
    return new Response(payload);
  },{onOperation:async(kind,active)=>{if(kind==='download'&&active)routes++;}});
  await f.updater.check();
  const result=await f.updater.download();
  assert.equal(result.status,'downloaded');assert.equal(result.retryCount,2);assert.equal(result.retryStage,'download');
  assert.equal(manifests,3);assert.equal(assets,2);assert.equal(routes,3);
  assert.deepEqual(await fs.readFile(path.join(f.directory,assetName)),payload);
  assert.deepEqual(await fs.readdir(f.directory),[assetName]);
  assert.ok(f.states.filter(state=>state.retrying&&state.retryStage==='download').every(state=>state.status==='downloading'));
});

test('installer connection timeout retries the complete attempt and does not wait indefinitely for headers', async t => {
  t.mock.timers.enable({apis:['setTimeout']});let assets=0, firstSignal;
  const f=await fixture(t,async(url,init)=>{
    if(url===API_URL)return new Response(JSON.stringify(release));
    if(url===manifestURL)return new Response(`${digest}  ${assetName}`);
    if(++assets===1){firstSignal=init.signal;return new Promise(()=>{});}return new Response(payload);
  },{requestTimeout:20});
  await f.updater.check();const downloading=f.updater.download();await until(()=>firstSignal);
  t.mock.timers.tick(20);
  const result=await downloading;assert.equal(result.status,'downloaded');assert.equal(result.retryCount,1);assert.equal(firstSignal.aborted,true);
  assert.equal(f.calls.filter(value=>value.url===manifestURL).length,2);assert.equal(assets,2);
});

test('download backoff may exceed ten minutes but still stops at exactly eleven failed attempts', async t => {
  t.mock.timers.enable({apis:['setTimeout']});
  const f=await fixture(t,async url=>{if(url===API_URL)return new Response(JSON.stringify(release));throw networkError();},{retryDelay:120000});
  await f.updater.check();const downloading=f.updater.download();
  const manifestCalls=()=>f.calls.filter(value=>value.url===manifestURL).length;
  for(let attempt=1;attempt<=10;attempt++){
    await until(()=>f.updater.state().message===`连接未成功，稍后自动重试 ${attempt}/10。`&&manifestCalls()===attempt);
    t.mock.timers.tick(119999);assert.equal(manifestCalls(),attempt);
    t.mock.timers.tick(1);await until(()=>manifestCalls()===attempt+1);
  }
  const result=await downloading;assert.equal(result.status,'error');assert.equal(result.retryCount,10);assert.equal(result.retryExhausted,true);assert.match(result.error,/自动重试 10 次.*手动重试/);
  assert.equal(manifestCalls(),11);assert.equal(f.operations.filter(value=>value.kind==='download'&&value.active).length,11);
  assert.equal(f.operations.filter(value=>value.kind==='download'&&!value.active).length,1);
  assert.deepEqual(await fs.readdir(f.directory),[]);
});
