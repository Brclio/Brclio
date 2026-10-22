'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const source=fs.readFileSync(require.resolve('../web/bridge.js'),'utf8');
function host(){
  const messages=[],listeners=new Map();
  const window={AndroidBridge:{postMessage:value=>messages.push(JSON.parse(value))},addEventListener:(name,listener)=>listeners.set(name,listener),removeEventListener:name=>listeners.delete(name)};
  vm.runInNewContext(source,{window,setTimeout,clearTimeout});
  return {window,messages,host:window.BrclioHost,update:state=>listeners.get('brclio:update')?.({detail:state})};
}
test('Android download bridge accepts progress and completion after two hours without a total-duration rejection',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const f=host(),states=[];f.host.onUpdateState(state=>states.push(state));
  let settled=false;const pending=f.host.downloadUpdate();pending.then(()=>{settled=true;},()=>{settled=true;});
  for(let minute=1;minute<=120;minute++){
    t.mock.timers.tick(60_000);
    f.update({status:'downloading',downloadedBytes:minute*1024,progress:Math.floor(minute/2)});
    await Promise.resolve();assert.equal(settled,false);
  }
  assert.equal(states.length,120);assert.equal(states.at(-1).downloadedBytes,120*1024);
  const complete={status:'downloaded',canInstall:true};f.window.__brclioResolve(f.messages[0].id,{result:complete});
  assert.equal(await pending,complete);assert.equal(settled,true);
});
test('Android bridge preserves bounded waits for check requests and native download failures still reject',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const f=host(),check=f.host.checkForUpdates();const checkFailure=assert.rejects(check,/系统操作尚未完成/);
  t.mock.timers.tick(90_000);await checkFailure;
  const download=f.host.downloadUpdate();const failed=assert.rejects(download,/自动重试 10 次/);
  f.window.__brclioResolve(f.messages.at(-1).id,{error:'自动重试 10 次后仍未完成，请手动继续。'});
  await failed;
});
