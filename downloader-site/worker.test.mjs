import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {serve, validateIndex} from './worker.mjs';

const site='https://tools.brclio.com/downloader/';
const gh='https://github.com/Brclio/Brclio/releases/download/';
const bytes=new TextEncoder().encode('Brclio installer fixture');
const sha=createHash('sha256').update(bytes).digest('hex');
const docs={};
for(const [edition,prefix] of [['lite','Brclio-Downloader-Lite-'],['full','Brclio-Downloader-']]){
  docs[edition]={version:'1.0.0',assets:['mac-arm64.dmg','mac-x64.dmg','windows-x64.exe'].map(suffix=>({
    name:prefix+'1.0.0-'+suffix,size:bytes.length,sha256:sha}))};
}
function setup(override){
  const store=new Map(),calls=[],promises=[];
  const cache={match: async key=>store.get(key.url)?.clone(),put:async(key,res)=>{store.set(key.url,res.clone());}};
  const context={waitUntil(p){promises.push(p);}};
  const fetcher=async(url,opts)=>{
    calls.push(url);assert.equal(opts.redirect,'manual');assert.ok(opts.signal);
    const other=override?.(url);
    if(other)return other;
    if(url===gh+'lite-stable/latest.json')return Response.json(docs.lite);
    if(url===gh+'downloader-stable/latest.json')return Response.json(docs.full);
    if(url===gh+'lite-v1.0.0/'+docs.lite.assets[0].name)return new Response(null,{status:302,headers:{location:'https://release-assets.githubusercontent.com/github-production-release-asset/123/abc?k=1'}});
    if(url.startsWith('https://release-assets.githubusercontent.com/'))return new Response(bytes);
    assert.fail(url);
  };
  return {calls,request:(pathname='',opts)=>serve(new Request(site+pathname,opts),context,{cache,fetcher}),
    settled:()=>Promise.all(promises),store};
}
test('landing lists three lite downloads and three full releases, without exposing nodes or arbitrary upstream URLs',async()=>{
  const f=setup();const response=await f.request();assert.equal(response.status,200);
  const page=await response.text();assert.equal((page.match(/href="\/downloader\/lite\//g)||[]).length,3);
  assert.equal((page.match(/href="\/downloader\/full\//g)||[]).length,3);assert.ok(page.includes('SHA-256'));
  const full=await f.request('full/windows-x64');assert.equal(full.status,302);
  assert.equal(full.headers.get('Location'),gh+'downloader-v1.0.0/Brclio-Downloader-1.0.0-windows-x64.exe');
});
test('lite file checks size and SHA, streams a verified cached file on subsequent requests, and supports HEAD',async()=>{
  const f=setup();const res=await f.request('lite/mac-arm64?url=bad');assert.equal(res.status,200);
  assert.equal(res.headers.get('X-Checksum-Sha256'),sha);
  assert.deepEqual(new Uint8Array(await res.arrayBuffer()),bytes);await f.settled();
  const count=f.calls.length;assert.equal(count,3);
  const head=await f.request('lite/mac-arm64',{method:'HEAD'});
  assert.equal(head.status,200);assert.equal(await head.text(),'');assert.equal(head.headers.get('content-length'),String(bytes.length));
  assert.equal(f.calls.length,count);
});
test('index rejects duplicate, missing, wrong product/version/size, and path injection',()=>{
  for(const edit of [x=>x.assets.pop(), x=>{x.assets[0]=x.assets[1]},x=>{x.assets[0].size=32*1024*1024},x=>{x.version='../v9'},x=>{x.assets[0].sha256='no'}]){
    const doc=structuredClone(docs.lite);edit(doc);assert.throws(()=>validateIndex(doc,'lite'));
  }
});
test('corrupt or large assets and untrusted redirects fail closed and never enter the binary cache',async()=>{
  for(const response of [()=>new Response(new Uint8Array(bytes.length)),()=>new Response(new Uint8Array(bytes.length+1)),()=>Response.redirect('https://example.org/file',302),()=>new Response(bytes,{headers:{'content-length':'1'}})]){
    const f=setup(url=>url.includes('/lite-v1.0.0/')?response():null);const res=await f.request('lite/mac-arm64');
    assert.equal(res.status,502);assert.ok(!res.headers.has('Content-Disposition'));await f.settled();
    assert.ok(![...f.store.keys()].some(k=>k.includes('/file/')));assert.ok(!f.calls.some(x=>x.startsWith('https://example.org/')));
  }
});
test('unsupported methods or routes do not perform upstream requests, and one missing edition leaves the other available',async()=>{
  const f=setup(url=>url===gh+'downloader-stable/latest.json'?new Response(null,{status:404}):null);
  assert.equal((await f.request('lite/linux')).status,404);assert.equal((await f.request('',{method:'POST'})).status,405);assert.equal(f.calls.length,0);
  const page=await f.request();assert.equal(page.status,200);assert.ok((await page.text()).includes('暂时无法读取完整版'));
});
