// Public post-deploy verification. No account or repository credentials are needed.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { validateIndex } from './worker.mjs';

const site = 'https://tools.brclio.com/downloader/';
const gh = 'https://github.com/Brclio/Brclio/releases/download/';
async function read(url, redirect = 'follow') {
  const response = await fetch(url,{redirect,signal:AbortSignal.timeout(90000),headers:{'User-Agent':'Brclio-Downloader-Verification'}});
  assert.ok(!response.headers.get('cf-mitigated'),'unexpected Cloudflare challenge at '+url);
  return response;
}
async function json(url) {
  const response = await read(url);
  assert.equal(response.status,200,url);
  return response.json();
}

const lite = validateIndex(await json(gh+'lite-stable/latest.json'),'lite');
const full = validateIndex(await json(gh+'downloader-stable/latest.json'),'full');
const page = await read(site,'manual');
assert.equal(page.status,200);
const html = await page.text();
assert.ok(html.includes('<title>Brclio 下载器'));
for(const file of lite.assets){
  const path = site+'lite/'+file.id;
  assert.ok(html.includes('href="/downloader/lite/'+file.id+'"'));
  const res = await read(path,'manual');
  assert.equal(res.status,200,path);
  assert.equal(res.headers.get('content-type'),'application/octet-stream');
  assert.equal(res.headers.get('x-checksum-sha256'),file.sha256);
  assert.equal(res.headers.get('content-disposition'),'attachment; filename="'+file.name+'"');
  const hash = createHash('sha256'); let size=0;
  for await(const chunk of res.body){
    size+=chunk.length; assert.ok(size<=file.size); hash.update(chunk);
  }
  assert.equal(size,file.size); assert.equal(hash.digest('hex'),file.sha256);
  console.log(file.name,size,file.sha256);
}
for(const file of full.assets){
  const res = await read(site+'full/'+file.id,'manual');
  assert.equal(res.status,302); assert.equal(res.headers.get('location'),file.url);
  console.log('Full release link verified',file.name);
}
const homepage = await read('https://tools.brclio.com/','manual');
assert.equal(homepage.status,200); assert.match(await homepage.text(),/<title>[^<]*Brclio/i);
const health = await json('https://tools.brclio.com/api/health');
assert.equal(health.ok,true); assert.equal(health.service,'brclio-client-services');
const main = await json('https://tools.brclio.com/api/releases/latest');
assert.match(main.tag,/^v\d+\.\d+\.\d+$/);
assert.equal(main.releaseURL,'https://github.com/Brclio/Brclio/releases/tag/'+main.tag);
console.log('Existing client service healthy; latest stable client:',main.tag);
