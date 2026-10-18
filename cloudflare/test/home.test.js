import {test} from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';import vm from 'node:vm';import {setImmediate} from 'node:timers/promises';
const script=await readFile(new URL('../src/home-client.txt',import.meta.url),'utf8');
function fixture(version){const tag='v'+version,base='https://github.com/Brclio/Brclio/releases/';return{version,tag,publishedAt:'2026-10-18T00:00:00Z',releaseURL:base+'tag/'+tag,assets:[{platform:'android',name:'Brclio-'+version+'-android.apk',size:4096,url:base+'download/'+tag+'/Brclio-'+version+'-android.apk',checksumURL:base+'download/'+tag+'/SHA256SUMS.txt'}]};}
async function render(version,{available=true}={}){
 const elements=new Map();function element(){return{textContent:'',hidden:false,dataset:{},addEventListener(){},append(){},replaceChildren(){}};}
 const document={getElementById(id){if(!elements.has(id))elements.set(id,element());return elements.get(id);},querySelectorAll(){return[];},createElement:element};
 document.getElementById('development-note').textContent='neutral pending release metadata';
 vm.runInNewContext(script,{document,navigator:{clipboard:{writeText:async()=>{}}},URL,AbortController,setTimeout,clearTimeout,fetch:async()=>available?Response.json(fixture(version)):new Response('{}',{status:502})});
 await setImmediate();return elements;
}
test('homepage states proxy support only for validated published stable releases at or above 0.1.9',async()=>{
 for(const version of ['0.0.99','0.1.7','0.1.8']){const elements=await render(version);assert.match(elements.get('development-note').textContent,/尚未包含/);assert.doesNotMatch(elements.get('development-note').textContent,/已包含/);}
 for(const version of ['0.1.9','0.1.10','0.2.0','1.0.0']){const elements=await render(version);const text=elements.get('development-note').textContent;assert.match(text,/已包含内置更新代理/);assert.match(text,/系统代理优先/);assert.match(text,/临时关闭/);assert.match(text,/重新启动后恢复默认开启/);}
});
test('homepage makes no new-release capability claim before or after failed metadata validation',async()=>{
 const failed=await render('0.1.9',{available:false});assert.equal(failed.get('development-note').textContent,'neutral pending release metadata');assert.equal(failed.get('download-grid').hidden,true);
 const html=await readFile(new URL('../src/home.html',import.meta.url),'utf8');assert.match(html,/支持情况将在确认正式版本后显示/);assert.doesNotMatch(html,/当前公开发布的 v0\.1\.8/);
});
