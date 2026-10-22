'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const crypto=require('node:crypto');
const {createUpdater,API_URL}=require('./updater.cjs');

const bytes=Buffer.from('a complete, trusted resumable update package');
const sha=value=>crypto.createHash('sha256').update(value).digest('hex');
const assetName='Brclio-0.2.0-mac-arm64.dmg';
const base='https://github.com/Brclio/Brclio/releases/download/v0.2.0/';
const url=base+assetName;
const release=(payload=bytes,digest=true)=>({tag_name:'v0.2.0',assets:[{name:assetName,size:payload.length,browser_download_url:url,...(digest?{digest:'sha256:'+sha(payload)}:{})},{name:'SHA256SUMS.txt',browser_download_url:base+'SHA256SUMS.txt'}]});
const metadata=(payload=bytes)=>({version:1,releaseVersion:'0.2.0',assetName,downloadURL:url,size:payload.length,expectedSHA256:sha(payload),etag:'"stable"'});
const network=()=>Object.assign(Error('更新连接中断。'),{code:'BRCLIO_UPDATE_NETWORK'});
const interrupted=(prefix,headers={},error=network())=>{let sent=false;return new Response(new ReadableStream({pull(c){if(!sent){sent=true;c.enqueue(prefix);}else c.error(error);}},{highWaterMark:0}),{headers:{etag:'"stable"',...headers}});};
const tail=(offset,payload=bytes,headers={})=>new Response(payload.subarray(offset),{status:206,headers:{'Content-Range':`bytes ${offset}-${payload.length-1}/${payload.length}`,'Content-Length':String(payload.length-offset),etag:'"stable"',...headers}});
async function directory(t){const root=await fs.mkdtemp(path.join(os.tmpdir(),'brclio-resume-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));return root;}
async function seed(root,prefix,meta=metadata()) {await fs.writeFile(path.join(root,assetName+'.part'),prefix,{mode:0o600});await fs.writeFile(path.join(root,assetName+'.part.json'),JSON.stringify(meta),{mode:0o600});}
function fixture(root,asset,options={}){
  const calls=[],states=[],operations=[];
  const updater=createUpdater({currentVersion:'0.1.0',platform:'darwin',architecture:'arm64',directory:root,retryDelay:0,
    fetch:async(address,init)=>{calls.push({url:address,init});assert.equal(new Headers(init.headers).get('accept-encoding'),'identity');
      if(address===API_URL)return new Response(JSON.stringify(options.release||release()));
      if(address.endsWith('SHA256SUMS.txt'))return new Response(`${options.expected||sha(bytes)}  ${assetName}`);
      return asset(init,calls.filter(value=>value.url===url).length);
    },onState:state=>states.push(state),onOperation:(kind,active)=>operations.push([kind,active]),...options.updater});
  return {updater,calls,states,operations};
}
async function until(condition){const limit=performance.now()+3000;while(!condition()){if(performance.now()>limit)throw Error('fixture condition not reached');await new Promise(setImmediate);}}

test('an interrupted attempt requests only the missing suffix, rehashes the prefix and never duplicates bytes',async t=>{
  const root=await directory(t),offset=13;
  const f=fixture(root,(init,attempt)=>{const headers=new Headers(init.headers);
    if(attempt===1){assert.equal(headers.get('range'),null);return interrupted(bytes.subarray(0,offset));}
    assert.equal(headers.get('range'),`bytes=${offset}-`);assert.equal(headers.get('if-range'),'"stable"');return tail(offset);
  });
  await f.updater.check();const result=await f.updater.download();
  assert.equal(result.status,'downloaded');assert.equal(result.retryCount,1);assert.equal(result.resumedBytes,offset);assert.equal(result.downloadedBytes,bytes.length);
  assert.equal(result.resumable,false);assert.deepEqual(await fs.readFile(path.join(root,assetName)),bytes);assert.deepEqual(await fs.readdir(root),[assetName]);
  assert.equal(f.calls.filter(value=>value.url.endsWith('SHA256SUMS.txt')).length,2);
});

test('exhaustion preserves a private bound prefix for both manual retries and a restarted updater',async t=>{
  for(const restart of [false,true]){
    const root=await directory(t),offset=11;let recover=false;
    const asset=(init,attempt)=>{if(recover){assert.equal(new Headers(init.headers).get('range'),`bytes=${offset}-`);return tail(offset);}if(attempt===1)return interrupted(bytes.subarray(0,offset));throw network();};
    let f=fixture(root,asset);await f.updater.check();const failed=await f.updater.download();
    assert.equal(failed.retryCount,10);assert.equal(failed.retryExhausted,true);assert.equal(failed.resumable,true);assert.equal(failed.downloadedBytes,offset);assert.ok(failed.progress>0);
    assert.deepEqual(await fs.readFile(path.join(root,assetName+'.part')),bytes.subarray(0,offset));
    const saved=JSON.parse(await fs.readFile(path.join(root,assetName+'.part.json'),'utf8'));assert.deepEqual(saved,metadata());
    if(process.platform!=='win32')for(const suffix of ['.part','.part.json'])assert.equal((await fs.stat(path.join(root,assetName+suffix))).mode&0o777,0o600);
    recover=true;if(restart){f=fixture(root,asset);await f.updater.check();}
    const pending=f.updater.download();if(!restart)assert.equal(f.updater.state().downloadedBytes,offset);
    const result=await pending;assert.equal(result.status,'downloaded');assert.equal(result.retryCount,0);assert.equal(result.resumedBytes,offset);
  }
});

test('misaligned, oversized, encoded or multipart partial responses are rejected and clear untrusted cache',async t=>{
  const offset=9;
  for(const headers of [
    {'Content-Range':`bytes 8-${bytes.length-1}/${bytes.length}`},
    {'Content-Range':`bytes ${offset}-${bytes.length-1}/${bytes.length+1}`},
    {'Content-Range':`bytes ${offset}-${bytes.length}/${bytes.length}`},
    {'Content-Length':'1'},{'Content-Encoding':'gzip'},{'Content-Type':'multipart/byteranges; boundary=x'},
    {etag:'"changed"'},
  ]){
    const root=await directory(t);await seed(root,bytes.subarray(0,offset));const f=fixture(root,()=>tail(offset,bytes,headers));
    await f.updater.check();const result=await f.updater.download();assert.equal(result.status,'error');assert.equal(result.retryCount,0);assert.equal(result.resumable,false);assert.deepEqual(await fs.readdir(root),[]);
  }
  const root=await directory(t);const f=fixture(root,()=>tail(1));await f.updater.check();assert.equal((await f.updater.download()).status,'error');assert.deepEqual(await fs.readdir(root),[]);
});

test('a server ignoring Range truncates safely and reports a full restart instead of appending',async t=>{
  const root=await directory(t),offset=8;await seed(root,bytes.subarray(0,offset));
  const f=fixture(root,init=>{assert.equal(new Headers(init.headers).get('if-range'),'"stable"');return new Response(bytes,{headers:{etag:'"new-etag"','Content-Length':String(bytes.length)}});});
  await f.updater.check();const result=await f.updater.download();assert.equal(result.status,'downloaded');assert.equal(result.resumedBytes,0);
  assert.ok(f.states.some(value=>value.message==='服务器未接受续传，正在重新下载。'));assert.deepEqual(await fs.readFile(path.join(root,assetName)),bytes);
});

test('416 completes only an already full partial with the correct full local hash',async t=>{
  for(const prefix of [bytes,bytes.subarray(0,7),Buffer.alloc(bytes.length,120)]){
    const root=await directory(t);await seed(root,prefix);
    const f=fixture(root,init=>{assert.equal(new Headers(init.headers).get('range'),`bytes=${prefix.length}-`);return new Response(null,{status:416});});
    await f.updater.check();const result=await f.updater.download();
    assert.equal(result.status,prefix.equals(bytes)?'downloaded':'error');assert.equal(result.retryCount,0);
    assert.deepEqual(await fs.readdir(root),prefix.equals(bytes)?[assetName]:[]);
  }
});

test('changed manifest or bound identity never appends an old partial',async t=>{
  for(const patch of [{expectedSHA256:'a'.repeat(64)},{releaseVersion:'0.9.0'},{downloadURL:'https://github.com/Brclio/Brclio/releases/download/v0.9.0/'+assetName}]){
    const root=await directory(t);await seed(root,bytes.subarray(0,9),{...metadata(),...patch});
    const f=fixture(root,init=>{assert.equal(new Headers(init.headers).get('range'),null);return new Response(bytes);});await f.updater.check();assert.equal((await f.updater.download()).status,'downloaded');
  }
});

test('a newly fetched manifest hash changing between attempts discards the previous prefix before a fresh download',async t=>{
  const root=await directory(t),replacement=Buffer.alloc(bytes.length,122);let attempts=0,assets=0;
  const updater=createUpdater({currentVersion:'0.1.0',platform:'darwin',architecture:'arm64',directory:root,retryDelay:0,
    onOperation:(kind,active)=>{if(kind==='download'&&active)attempts++;},
    fetch:async(address,init)=>{
      if(address===API_URL)return new Response(JSON.stringify(release(bytes,false)));
      if(address.endsWith('SHA256SUMS.txt'))return new Response(`${sha(attempts===1?bytes:replacement)}  ${assetName}`);
      assets++;assert.equal(new Headers(init.headers).get('range'),null);
      return attempts===1?interrupted(bytes.subarray(0,8)):new Response(replacement);
    }});
  await updater.check();const result=await updater.download();assert.equal(result.status,'downloaded');assert.equal(result.retryCount,1);assert.equal(result.resumedBytes,0);assert.equal(assets,2);
  assert.deepEqual(await fs.readFile(path.join(root,assetName)),replacement);
});

test('server segments may end before total and each next attempt resumes at the actual written end',async t=>{
  const root=await directory(t);await seed(root,bytes.subarray(0,5));let sent=0;
  const f=fixture(root,init=>{const offset=Number(/^bytes=(\d+)-$/.exec(new Headers(init.headers).get('range'))[1]);
    const end=Math.min(bytes.length-1,offset+11);const segment=bytes.subarray(offset,end+1);sent+=segment.length;
    return new Response(segment,{status:206,headers:{'Content-Range':`bytes ${offset}-${end}/${bytes.length}`,'Content-Length':String(segment.length),etag:'"stable"'}});
  });await f.updater.check();const result=await f.updater.download();assert.equal(result.status,'downloaded');assert.equal(sent,bytes.length-5);assert.deepEqual(await fs.readFile(path.join(root,assetName)),bytes);
});

test('cancellation and hard timeout retain their completed prefix without enabling installation',async t=>{
  for(const timeout of [false,true]){
    const root=await directory(t);let waiting=false;
    const f=fixture(root,init=>{let sent=false;return new Response(new ReadableStream({pull(c){if(!sent){sent=true;c.enqueue(bytes.subarray(0,7));return;}waiting=true;
      if(!timeout){c.error(Object.assign(Error('用户取消。'),{name:'AbortError'}));return;}
      return new Promise(resolve=>init.signal.addEventListener('abort',()=>{c.error(network());resolve();},{once:true}));
    }},{highWaterMark:0}),{headers:{etag:'"stable"'}});},{updater:timeout?{downloadTimeout:30,idleTimeout:200}: {}});
    await f.updater.check();const pending=f.updater.download();await until(()=>waiting);const result=await pending;
    assert.equal(result.status,'error');assert.equal(result.canInstall,false);assert.equal(result.resumable,true);assert.equal(result.downloadedBytes,7);assert.deepEqual(await fs.readFile(path.join(root,assetName+'.part')),bytes.subarray(0,7));
  }
});

test('complete-length bad hashes and modifications during append fail final on-disk verification without retry',async t=>{
  for(const mutate of [false,true]){
    const root=await directory(t);if(mutate)await seed(root,bytes.subarray(0,7));
    const original=fs.open;let changed=false;
    if(mutate)t.mock.method(fs,'open',async(filename,...args)=>{const handle=await original(filename,...args);if(filename.endsWith('.part')){const write=handle.write.bind(handle);handle.write=async(...values)=>{const result=await write(...values);if(!changed){changed=true;await write(Buffer.from('X'),0,1,0);}return result;};}return handle;});
    const f=fixture(root,()=>mutate?tail(7):new Response(Buffer.alloc(bytes.length,120)));await f.updater.check();const result=await f.updater.download();
    assert.equal(result.status,'error');assert.match(result.error,/SHA256/);assert.equal(result.retryCount,0);assert.equal(result.resumable,false);assert.deepEqual(await fs.readdir(root),[]);
    t.mock.restoreAll();
  }
});

test('cache symlinks, nonregular files and oversized sidecars are refused without touching unrelated files',async t=>{
  for(const mode of ['part-link','meta-link','directory','huge']){
    if(process.platform==='win32'&&mode.endsWith('-link'))continue;
    const root=await directory(t),unrelated=path.join(root,'unrelated');await fs.writeFile(unrelated,'keep');
    await seed(root,bytes.subarray(0,5));const partial=path.join(root,assetName+'.part'),sidecar=partial+'.json';
    if(mode==='part-link'){await fs.unlink(partial);await fs.symlink(unrelated,partial);}
    if(mode==='meta-link'){await fs.unlink(sidecar);await fs.symlink(unrelated,sidecar);}
    if(mode==='directory'){await fs.unlink(partial);await fs.mkdir(partial);await fs.writeFile(path.join(partial,'keep'),'keep');}
    if(mode==='huge')await fs.writeFile(sidecar,'x'.repeat(4097));
    const f=fixture(root,()=>{throw Error('Unsafe cache must not start an installer request');});await f.updater.check();assert.equal((await f.updater.download()).status,'error');assert.equal(await fs.readFile(unrelated,'utf8'),'keep');
    if(mode==='directory')assert.equal(await fs.readFile(path.join(partial,'keep'),'utf8'),'keep');
  }
});
