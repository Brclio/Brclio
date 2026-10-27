import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const web = path.join(root, 'web');
const output = path.join(root, 'artifacts');
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.png': 'image/png', '.wasm': 'application/wasm' };
const report = { browser: [], nativeUI: [], androidUI: [], screenshots: [], errors: [] };
const server = http.createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    if (pathname === '/api/account/session') { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ user: null, googleEnabled: false })); return; }
    const target = path.resolve(web, '.' + (pathname === '/' ? '/index.html' : pathname));
    if (!target.startsWith(web + path.sep)) { response.writeHead(403); response.end(); return; }
    const data = await readFile(target);
    response.writeHead(200, { 'Content-Type': types[path.extname(target)] || 'application/octet-stream', 'Cache-Control': 'no-store' }); response.end(data);
  } catch { response.writeHead(404); response.end('Not found'); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  await mkdir(output, { recursive: true });
  browser = await chromium.launch({ executablePath: process.env.BRCLIO_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1060 }, acceptDownloads: true });
  const page = await context.newPage();
  page.on('pageerror', error => report.errors.push(error.message));
  await page.goto(url); await page.waitForFunction(() => document.body.dataset.ready === 'true');
  await page.locator('[data-view="xhs"]').first().click();
  assert.equal(await page.locator('#xhs-parse').isDisabled(), true);
  assert.equal(await page.locator('#xhs-watch-clipboard').isChecked(), false);
  assert.equal(await page.locator('#xhs-watch-clipboard').isDisabled(), true);
  assert.equal(await page.locator('#xhs-availability').isVisible(), true); assert.equal(await page.locator('#xhs-share-images').isHidden(),true);
  await page.locator('[data-view="tools"]').first().click(); await page.locator('#tool-filter').fill('小红书');
  assert.equal(await page.locator('.tool-card:visible').count(), 1); await page.locator('.tool-card:visible').click();
  await page.locator('#open-search').click(); await page.locator('#global-search').fill('实况'); await page.keyboard.press('Enter');
  assert.equal(await page.locator('#view-xhs').isVisible(), true);
  report.browser.push('Native downloads and clipboard opt-in are unavailable in browser; registry filtering and global search navigate to XHS.');
  for (const width of [1440, 900, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const name of ['note', 'profile', 'live']) {
      await page.locator('#xhs-tab-' + name).click();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), false, `${name} overflows at ${width}`);
    }
  }
  report.browser.push('All three tabs fit widths 320, 390, 900 and 1440.');
  await page.setViewportSize({ width: 1440, height: 1060 }); await page.locator('#xhs-tab-live').click();
  await page.locator('#xhs-live-support').filter({ hasText: '支持本地制作' }).waitFor();
  await page.locator('#xhs-live-files').setInputFiles(path.join(web, 'assets/avatar.png'));
  await page.locator('#xhs-live-source-info').filter({ hasText: '1 张图片' }).waitFor();
  await page.locator('#xhs-live-format').selectOption('jpeg');
  await page.locator('#xhs-live-duration').fill('8'); await page.locator('#xhs-live-duration').dispatchEvent('change');
  await page.locator('#xhs-live-generate').click(); await page.locator('#xhs-live-cancel').click();
  await page.locator('#xhs-live-status').filter({ hasText: '制作已取消' }).waitFor({ timeout: 30000 });
  assert.equal(await page.locator('#xhs-live-result').isHidden(), true);
  await page.locator('#xhs-live-duration').fill('0.5'); await page.locator('#xhs-live-duration').dispatchEvent('change');
  await page.locator('#xhs-live-preview').click(); await page.locator('#xhs-live-generate').click();
  await page.locator('#xhs-live-result').waitFor({ timeout: 60000 });
  assert.match(await page.locator('#xhs-live-result-info').innerText(), /0.5 秒.*JPG \+ MOV/);
  await page.waitForFunction(() => {const image=document.getElementById('xhs-live-preview-image');return image.complete&&image.naturalWidth>0});
  const downloads = [];
  for (const id of ['package', 'pair', 'photo', 'mov']) {
    const pending = page.waitForEvent('download'); await page.locator('#xhs-live-export-' + id).click(); const download = await pending;
    downloads.push(download.suggestedFilename()); await download.delete();
  }
  assert.match(downloads[0], /\.zip$/); assert.match(downloads[1], /配对文件\.zip$/); assert.match(downloads[2], /\.JPG$/); assert.match(downloads[3], /\.MOV$/);
  report.browser.push('Real WebCodecs creation cancels safely, creates a 0.5-second JPG+MOV, displays its cover, and exports PVT ZIP, paired ZIP, JPG and MOV.');
  await page.evaluate(() => scrollTo(0, 0)); await page.screenshot({ path: path.join(output, 'xhs-ui-live-browser.png'), fullPage: true }); report.screenshots.push('artifacts/xhs-ui-live-browser.png');
  await context.close();

  const liveAuditContext = await browser.newContext({viewport:{width:1440,height:1060}});
  const liveAudit = await liveAuditContext.newPage(); liveAudit.on('pageerror',error=>report.errors.push(error.message));
  await liveAudit.route('**/xhs/lib/live-photo-maker.js',async route=>{
    const response=await route.fetch(),body=await response.text();
    await route.fulfill({response,body:body.replace('export async function inspectLivePhotoFiles(', 'async function inspectActualFiles(')+`
      export async function inspectLivePhotoFiles(files,options={}) {
        if(globalThis.__pauseInspect) { globalThis.__inspectStarted=true; await new Promise((resolve,reject)=>{
          const finish=()=>{options.signal?.removeEventListener('abort',abort);resolve()},abort=()=>{options.signal?.removeEventListener('abort',abort);reject(options.signal.reason)};
          globalThis.__finishInspect=finish; options.signal?.addEventListener('abort',abort,{once:true});
        }); }
        return inspectActualFiles(files,options);
      }`});
  });
  await liveAudit.addInitScript(()=>{
    const create=document.createElement.bind(document);
    document.createElement=(name,...args)=>{
      const element=create(name,...args);
      if(String(name).toLowerCase()==='video' && window.__pauseCover) {
        Object.defineProperty(element,'src',{configurable:true,set(value){window.__coverStarted=true;window.__heldCoverVideo=element},get(){return ''}});
        element.load=()=>{};
      }
      return element;
    };
  });
  await liveAudit.goto(url);await liveAudit.waitForFunction(()=>document.body.dataset.ready==='true');
  await liveAudit.locator('[data-view="xhs"]').first().click();await liveAudit.locator('#xhs-tab-live').click();
  await liveAudit.locator('#xhs-live-files').setInputFiles(path.join(web,'assets/icon.png'));
  await liveAudit.locator('#xhs-live-source-info').filter({hasText:'1 张图片'}).waitFor();
  await liveAudit.locator('#xhs-live-duration').fill('.5');await liveAudit.locator('#xhs-live-duration').dispatchEvent('change');
  await liveAudit.locator('#xhs-live-generate').click();await liveAudit.locator('#xhs-live-result').waitFor({timeout:60000});
  await liveAudit.evaluate(()=>{window.__pauseInspect=true;window.__inspectStarted=false});
  await liveAudit.locator('#xhs-live-files').setInputFiles(path.join(web,'assets/avatar.png'));
  await liveAudit.waitForFunction(()=>window.__inspectStarted);
  assert.equal(await liveAudit.locator('#xhs-live-result').isHidden(),true,'A new pending input must invalidate the old export immediately.');
  assert.equal(await liveAudit.locator('#xhs-live-generate').isDisabled(),true,'New input inspection cannot overlap generating the old material.');
  await liveAudit.locator('#xhs-live-cancel').click();await liveAudit.locator('#xhs-live-source-info').filter({hasText:'素材读取已取消'}).waitFor();
  await liveAudit.evaluate(()=>{window.__finishInspect?.();window.__pauseInspect=false});
  assert.equal(await liveAudit.locator('#xhs-live-result').isHidden(),true);assert.equal(await liveAudit.locator('#xhs-live-generate').isDisabled(),true);
  await liveAudit.locator('#xhs-live-files').setInputFiles(path.join(web,'assets/icon.png'));
  await liveAudit.locator('#xhs-live-source-info').filter({hasText:'1 张图片'}).waitFor();
  await liveAudit.locator('#xhs-live-duration').fill('.5');await liveAudit.locator('#xhs-live-duration').dispatchEvent('change');
  await liveAudit.locator('#xhs-live-format').selectOption('heic');
  await liveAudit.evaluate(()=>{window.__pauseCover=true;window.__coverStarted=false});
  await liveAudit.locator('#xhs-live-generate').click();await liveAudit.waitForFunction(()=>window.__coverStarted,{timeout:60000});
  assert.equal(await liveAudit.locator('#xhs-live-result').isHidden(),true,'The result is not published before the asynchronous HEIC cover stage finishes.');
  await liveAudit.locator('#xhs-live-cancel').click();await liveAudit.locator('#xhs-live-status').filter({hasText:'制作已取消'}).waitFor();
  await liveAudit.evaluate(()=>{window.__heldCoverVideo?.dispatchEvent(new Event('loadeddata'));window.__pauseCover=false});
  assert.equal(await liveAudit.locator('#xhs-live-result').isHidden(),true,'Late cover events cannot resurrect a cancelled export.');
  await liveAudit.locator('#xhs-live-generate').click();await liveAudit.locator('#xhs-live-result').waitFor({timeout:60000});
  report.browser.push('Input inspection clears old exports and blocks overlapping generation; cancellation during a completed HEIC encode but stalled cover decode remains cancelled, ignores late events and permits a real retry.');
  const imageFixtures=await liveAudit.evaluate(()=>[[320,192,'#d94435'],[128,256,'#1e50dc']].map(([width,height,color])=>{
    const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;const context=canvas.getContext('2d');context.fillStyle=color;context.fillRect(0,0,width,height);return canvas.toDataURL('image/png').split(',')[1];
  }));
  await liveAudit.locator('#xhs-live-files').setInputFiles(imageFixtures.map((value,index)=>({name:`aspect-${index}.png`,mimeType:'image/png',buffer:Buffer.from(value,'base64')})));
  await liveAudit.locator('#xhs-live-source-info').filter({hasText:'2 张图片'}).waitFor();
  for(const [id,value]of [['duration','1'],['cover','.75']]){await liveAudit.locator('#xhs-live-'+id).fill(value);await liveAudit.locator('#xhs-live-'+id).dispatchEvent('change')}
  await liveAudit.locator('#xhs-live-motion').selectOption('still');await liveAudit.locator('#xhs-live-format').selectOption('jpeg');
  await liveAudit.locator('#xhs-live-preview').click();await liveAudit.locator('#xhs-live-preview-canvas').waitFor();
  await liveAudit.waitForFunction(()=>{const c=document.getElementById('xhs-live-preview-canvas');return c.width===320&&c.height===192&&c.getContext('2d').getImageData(160,96,1,1).data[2]>200});
  const previewPixels=await liveAudit.evaluate(()=>{const c=document.getElementById('xhs-live-preview-canvas'),x=c.getContext('2d');return {width:c.width,height:c.height,edge:[...x.getImageData(0,96,1,1).data],center:[...x.getImageData(160,96,1,1).data]}});
  assert.deepEqual(previewPixels.edge.slice(0,3),[254,252,246]);assert.deepEqual(previewPixels.center.slice(0,3),[30,80,220]);
  await liveAudit.locator('#xhs-live-generate').click();await liveAudit.locator('#xhs-live-result').waitFor({timeout:60000});
  await liveAudit.waitForFunction(()=>{const img=document.getElementById('xhs-live-preview-image');return img.complete&&img.naturalWidth>0});
  const coverPixels=await liveAudit.evaluate(()=>{const img=document.getElementById('xhs-live-preview-image'),c=document.createElement('canvas');c.width=img.naturalWidth;c.height=img.naturalHeight;const x=c.getContext('2d');x.drawImage(img,0,0);return {width:c.width,height:c.height,edge:[...x.getImageData(0,96,1,1).data],center:[...x.getImageData(160,96,1,1).data]}});
  assert.equal(coverPixels.width,previewPixels.width);assert.equal(coverPixels.height,previewPixels.height);
  for(const key of ['edge','center'])for(let i=0;i<3;i++)assert.ok(Math.abs(coverPixels[key][i]-previewPixels[key][i])<8,`${key} preview and encoded cover differ`);
  const geometry=await liveAudit.evaluate(async fixtures=>{
    const images=await Promise.all(fixtures.map(value=>new Promise(resolve=>{const image=new Image();image.onload=()=>resolve(image);image.src='data:image/png;base64,'+value})));
    const module=await import('./xhs/lib/live-photo-maker.js');let drawn;
    module.drawLivePhotoImageFrame({canvas:{width:320,height:192},fillRect(){},drawImage(...args){drawn=args.slice(1)}},images,{time:.75,duration:1,motion:'zoom'});
    return drawn;
  },imageFixtures);
  for(const [index,value]of [110.68,-2.64,98.64,197.28].entries())assert.ok(Math.abs(geometry[index]-value)<.0001,`Shared frame geometry ${index}: ${geometry[index]}`);
  const encodedSource=await liveAudit.evaluate(async()=>{
    const bytes=new Uint8Array(await(await fetch(document.getElementById('xhs-live-preview-video').src)).arrayBuffer());let binary='';for(const byte of bytes)binary+=String.fromCharCode(byte);return btoa(binary);
  });
  await liveAudit.locator('#xhs-live-files').setInputFiles({name:'real-preview-source.mov',mimeType:'video/quicktime',buffer:Buffer.from(encodedSource,'base64')});
  await liveAudit.locator('#xhs-live-source-info').filter({hasText:'视频'}).waitFor();
  await liveAudit.locator('#xhs-live-duration').fill('.5');await liveAudit.locator('#xhs-live-duration').dispatchEvent('change');
  await liveAudit.locator('#xhs-live-cover').fill('.2');await liveAudit.locator('#xhs-live-cover').dispatchEvent('change');
  await liveAudit.locator('#xhs-live-speed').selectOption('2');await liveAudit.locator('#xhs-live-preview').click();
  await liveAudit.waitForFunction(()=>{const video=document.getElementById('xhs-live-preview-video');return video.readyState>=2&&video.currentTime>.1});
  assert.equal(await liveAudit.locator('#xhs-live-preview-video').evaluate(video=>video.playbackRate),2,'Real decoded video must retain 2x after loading its Blob source.');
  await liveAudit.locator('#xhs-live-generate').click();await liveAudit.locator('#xhs-live-result').waitFor({timeout:60000});
  await liveAudit.waitForFunction(()=>document.getElementById('xhs-live-preview-video').readyState>=1);
  assert.equal(await liveAudit.locator('#xhs-live-preview-video').evaluate(video=>video.playbackRate),1,'An already-speed-adjusted encoded result must play at its native 1x rate.');
  report.browser.push('A real H.264/MOV source retains the selected 2x preview rate after metadata loading; its newly encoded result resets to 1x instead of applying the speed twice.');
  await liveAudit.evaluate(value=>{
    const binary=atob(value),bytes=Uint8Array.from(binary,char=>char.charCodeAt(0)),files=new DataTransfer();files.items.add(new File([bytes],'dropped.png',{type:'image/png'}));
    document.querySelector('[for="xhs-live-files"]').dispatchEvent(new DragEvent('drop',{dataTransfer:files,bubbles:true,cancelable:true}));
  },imageFixtures[0]);
  await liveAudit.locator('#xhs-live-file-list').filter({hasText:'dropped.png'}).waitFor();
  assert.equal(await liveAudit.locator('#view-xhs').isVisible(),true);
  report.browser.push('Mixed portrait/landscape preview and encoded cover keep the same canvas, letterboxing, frame choice and 5.5% push geometry; drag-and-drop uses the same validated local-material path.');
  await liveAuditContext.close();

  const noAudioContext = await browser.newContext({viewport:{width:1440,height:1060}});
  const noAudioPage = await noAudioContext.newPage(); noAudioPage.on('pageerror',error=>report.errors.push(error.message));
  await noAudioPage.route('**/xhs/lib/live-photo-maker.js',async route=>{
    const response=await route.fetch(),body=await response.text();
    await route.fulfill({response,body:body
      .replace('export async function checkLivePhotoSupport(', 'async function checkActualLivePhotoSupport(')
      .replace('export async function createLivePhoto(', 'async function createActualLivePhoto(')+`
      export async function checkLivePhotoSupport() { return {...await checkActualLivePhotoSupport(),audioSupported:false}; }
      export async function createLivePhoto(options) { window.__noAudioInclude=options.includeAudio; return createActualLivePhoto(options); }
    `});
  });
  await noAudioPage.goto(url);await noAudioPage.waitForFunction(()=>document.body.dataset.ready==='true');
  await noAudioPage.locator('[data-view="xhs"]').first().click();await noAudioPage.locator('#xhs-tab-live').click();
  await noAudioPage.locator('#xhs-live-support').filter({hasText:'支持本地制作'}).waitFor();
  await noAudioPage.locator('#xhs-live-files').setInputFiles({name:'no-aac-source.mov',mimeType:'video/quicktime',buffer:Buffer.from(encodedSource,'base64')});
  await noAudioPage.locator('#xhs-live-source-info').filter({hasText:'视频'}).waitFor();
  assert.equal(await noAudioPage.locator('#xhs-live-audio').isDisabled(),true,'Loading a video must preserve the unavailable AAC capability.');
  await noAudioPage.locator('#xhs-live-speed').selectOption('2');await noAudioPage.locator('#xhs-live-speed').selectOption('1');
  assert.equal(await noAudioPage.locator('#xhs-live-audio').isDisabled(),true,'Returning to 1x must not enable an unavailable AAC encoder.');
  await noAudioPage.evaluate(()=>{document.getElementById('xhs-live-audio').checked=true});
  await noAudioPage.locator('#xhs-live-duration').fill('.5');await noAudioPage.locator('#xhs-live-duration').dispatchEvent('change');
  await noAudioPage.locator('#xhs-live-cover').fill('.2');await noAudioPage.locator('#xhs-live-cover').dispatchEvent('change');
  await noAudioPage.locator('#xhs-live-format').selectOption('jpeg');await noAudioPage.locator('#xhs-live-generate').click();
  await noAudioPage.locator('#xhs-live-result').waitFor({timeout:60000});
  assert.equal(await noAudioPage.evaluate(()=>window.__noAudioInclude),false,'Stale checkbox state must never request unavailable AAC.');
  assert.doesNotMatch(await noAudioPage.locator('#xhs-live-result-info').textContent(),/保留声音/);
  assert.equal(await noAudioPage.locator('#xhs-live-audio').isDisabled(),true);
  report.browser.push('Unavailable AAC stays disabled after video loading, speed changes and real silent generation; stale checked state cannot request an unsupported audio encoder.');
  await noAudioContext.close();

  const nativeContext = await browser.newContext({ viewport: { width: 1440, height: 1060 } });
  const nativePage = await nativeContext.newPage(); nativePage.on('pageerror', error => report.errors.push(error.message));
  await nativePage.route('**/bridge.js', async route => {
    const response = await route.fetch(); const body = await response.text();
    await route.fulfill({ response, body: body + `
      window.__xhsCalls=[]; window.__xhsEmit=null; window.__copied=''; window.__clipboard=''; window.__deferArchive=false;window.__videoFailure=false;window.__saveImagesCancel=false;window.__clearCancel=true;window.__deferTransfer=false;window.__onlyOriginalHint=false;
      window.__profile={status:'paused',profileUrl:'https://www.xiaohongshu.com/user/profile/'+'b'.repeat(24),directory:'/tmp/Brclio-XHS',intervalSeconds:17,jitterSeconds:5,items:[]};
      window.brclio={...window.BrclioHost,copyText:async text=>{window.__copied=text},onXhsEvent(callback){window.__xhsEmit=callback},async xhsRequest(action,input){
        window.__xhsCalls.push({action,input});
        if(action==='loginState') return {status:'logged-in',loggedIn:true,nickname:'测试小红书账号'};
        if(action==='profileState') return structuredClone(window.__profile);
        if(action==='parse' && window.__onlyOriginalHint)return {title:'仅声明原视频',hasOriginalVideo:true,images:[],videos:[],originalVideos:[]};
        if(action==='parse') return {noteId:'a'.repeat(24),title:'测试笔记',content:'完整的笔记文案',images:[{url:'https://fixture/x.jpg',index:1},{url:'https://fixture/y.jpg',index:2,liveVideo:{url:'https://fixture/live.mp4'}}],videos:[{label:'720P',url:'https://fixture/play.mp4'}],originalVideos:[{label:'平台原文件',url:'https://fixture/original.mp4'},{label:'原视频备用线路',url:'https://fixture/original-backup.mp4'}]};
        if(action==='chooseDirectory') return '/tmp/Brclio-XHS';
        if(action==='readClipboard') return window.__clipboard;
        if(action==='startProfile') return window.__profile={...input,status:'downloading',items:[{id:'a'.repeat(24),title:'待下载笔记',status:'pending'}]};
        if(action==='pauseProfile') return window.__profile={...window.__profile,status:'paused'};
        if(action==='clearLogin')return window.__clearCancel?{cancelled:true}:{loginState:{status:'logged-out',loggedIn:false},profileState:{status:'paused',items:[]}};
        if(['saveImages','saveNote','copyImages','shareImages'].includes(action) && window.__deferTransfer)return await new Promise(resolve=>window.__finishTransfer=resolve);
        if(action==='cancelTransfer'){window.__finishTransfer?.({ok:true,cancelled:true});return {ok:true}}
        if(action==='saveImages' && window.__saveImagesCancel)return {ok:true,cancelled:true};
        if(action==='saveVideo' && window.__videoFailure)return {ok:false,error:{message:'测试下载失败'}};
        if(action==='saveVideo') return await new Promise(resolve=>window.__finishVideo=resolve);
        if(action==='cancelVideo'){window.__finishVideo({cancelled:true});return {ok:true}}
        if(action==='exportArchive' && window.__deferArchive) return await new Promise(resolve=>window.__finishArchive=resolve);
        if(action==='cancelArchive'){window.__finishArchive({cancelled:true});return {ok:true}}
        return {ok:true,count:input?.images?.length||0};
      }}; window.BrclioHost=window.brclio;` });
  });
  await nativePage.goto(url); await nativePage.waitForFunction(() => document.body.dataset.ready === 'true');
  assert.equal(await nativePage.evaluate(() => window.__xhsCalls.length), 0, 'Unused XHS tool must not request native state or clipboard.');
  await nativePage.locator('[data-view="xhs"]').first().click(); await nativePage.waitForFunction(() => window.__xhsCalls.some(call => call.action === 'profileState'));
  assert.equal(await nativePage.locator('#xhs-interval').inputValue(), '17'); assert.equal(await nativePage.locator('#xhs-jitter').inputValue(), '5');
  await nativePage.locator('#xhs-tab-profile').click(); await nativePage.locator('#xhs-interval').fill('29');
  await nativePage.evaluate(() => window.__xhsEmit({type:'profile',state:{...window.__profile,intervalSeconds:10,jitterSeconds:3}}));
  assert.equal(await nativePage.locator('#xhs-interval').inputValue(), '29'); assert.equal(await nativePage.locator('#xhs-jitter').inputValue(), '3');
  report.nativeUI.push('No XHS calls occur before opening the tool; restored timing settings populate while unsaved edits remain intact.');
  await nativePage.locator('#xhs-tab-note').click(); await nativePage.locator('#xhs-share').fill('https://www.xiaohongshu.com/explore/' + 'a'.repeat(24)); await nativePage.locator('#xhs-parse').click();
  await nativePage.locator('#xhs-note-title').filter({ hasText: '测试笔记' }).waitFor(); assert.equal(await nativePage.locator('#xhs-share-images').isHidden(),true);
  assert.equal(await nativePage.locator('#xhs-video-select option').count(), 3); assert.match(await nativePage.locator('#xhs-video-select option').first().textContent(), /原视频/);
  await nativePage.locator('.xhs-image-card').first().getByRole('button',{name:'打开原图',exact:true}).click();
  assert.equal(await nativePage.locator('#xhs-image-dialog').isVisible(),true);assert.match(await nativePage.locator('#xhs-image-original').getAttribute('src'),/^brclio-xhs:\/\/local\/api\/image/);
  await nativePage.keyboard.press('Escape');await nativePage.waitForFunction(()=>document.getElementById('xhs-image-original').getAttribute('src')===null);
  await nativePage.locator('#xhs-video-select').selectOption('2');await nativePage.locator('#xhs-copy-video-link').click();assert.equal(await nativePage.evaluate(()=>window.__copied),'https://fixture/play.mp4');
  await nativePage.locator('#xhs-open-video-link').click();assert.equal(await nativePage.evaluate(()=>window.__xhsCalls.find(call=>call.action==='openVideo').input.url),'https://fixture/play.mp4');await nativePage.locator('#xhs-video-select').selectOption('0');
  report.nativeUI.push('Original-image viewing opens a local dialog and releases its source on Escape; video link copy/open follows the chosen candidate.');
  await nativePage.locator('#xhs-copy-content').click();assert.equal(await nativePage.evaluate(()=>window.__copied),'测试笔记\n\n完整的笔记文案');
  const captionPending=nativePage.waitForEvent('download');await nativePage.locator('#xhs-export-content').click();const caption=await captionPending;
  const captionBytes=await readFile(await caption.path()),captionText=captionBytes.toString('utf8');assert.equal(captionBytes.subarray(0,3).toString('hex'),'efbbbf');
  for(const field of ['标题：测试笔记','文案：','来源：','生成时间：','解析引擎：Node.js'])assert.ok(captionText.includes(field),field);await caption.delete();
  await nativePage.locator('#xhs-export-selected').click();
  assert.deepEqual(await nativePage.evaluate(()=>window.__xhsCalls.find(call=>call.action==='exportArchive'&&call.input.format==='selected').input.images.map(image=>image.index)),[1,2]);
  await nativePage.locator('.xhs-image-select').first().uncheck(); await nativePage.locator('#xhs-save-images').click();
  assert.equal(await nativePage.evaluate(() => window.__xhsCalls.find(call => call.action === 'saveImages').input.images.length), 1);
  await nativePage.locator('#xhs-copy-image-links').click(); assert.equal(await nativePage.evaluate(() => window.__copied), 'https://fixture/y.jpg');
  await nativePage.locator('#xhs-export-images').click(); await nativePage.locator('#xhs-export-live').click();
  assert.deepEqual(await nativePage.evaluate(() => window.__xhsCalls.filter(call => call.action === 'exportArchive' && call.input.format !== 'selected').map(call => ({format:call.input.format,indices:call.input.images.map(image=>image.index),note:call.input.note.content}))), [{format:'images',indices:[2],note:'完整的笔记文案'},{format:'live',indices:[2],note:'完整的笔记文案'}]);
  await nativePage.locator('#xhs-invert-selection').click(); assert.equal(await nativePage.locator('.xhs-image-select').first().isChecked(), true); assert.equal(await nativePage.locator('.xhs-image-select').last().isChecked(), false);
  await nativePage.locator('.xhs-image-card').first().getByRole('button',{name:'复制链接',exact:true}).click(); assert.equal(await nativePage.evaluate(() => window.__copied), 'https://fixture/x.jpg');
  await nativePage.evaluate(() => window.__deferArchive=true); await nativePage.locator('#xhs-export-images').click(); await nativePage.locator('#xhs-cancel-archive').click(); await nativePage.locator('#xhs-message').filter({hasText:'ZIP 导出已取消'}).waitFor();
  await nativePage.locator('#xhs-save-video').click();
  await nativePage.evaluate(()=>{const requestId=window.__xhsCalls.filter(call=>call.action==='saveVideo').at(-1).input.requestId;window.__xhsEmit({type:'video',state:{requestId,receivedBytes:1024,completed:1,total:1}})});
  assert.equal(await nativePage.locator('#xhs-video-progress').getAttribute('value'),null,'Unknown total is indeterminate rather than 0%.');assert.match(await nativePage.locator('#xhs-video-status').innerText(),/1024/);
  await nativePage.evaluate(()=>{const requestId=window.__xhsCalls.filter(call=>call.action==='saveVideo').at(-1).input.requestId;window.__xhsEmit({type:'video',state:{requestId,loadedBytes:1024,totalBytes:2048}})});
  assert.equal(await nativePage.locator('#xhs-video-progress').evaluate(progress=>progress.value),50);
  await nativePage.evaluate(()=>{const requestId=window.__xhsCalls.filter(call=>call.action==='saveVideo').at(-1).input.requestId;window.__xhsEmit({type:'video',state:{requestId,loadedBytes:2048,totalBytes:2048}})});
  assert.equal(await nativePage.locator('#xhs-video-progress').evaluate(progress=>progress.value),99,'Receiving the final bytes is not yet native save completion.');
  await nativePage.evaluate(()=>window.__finishVideo({ok:true,cancelled:false}));await nativePage.locator('#xhs-video-status').filter({hasText:'视频已下载并保存'}).waitFor();assert.equal(await nativePage.locator('#xhs-video-progress').evaluate(progress=>progress.value),100);
  await nativePage.locator('#xhs-save-video').click(); await nativePage.locator('#xhs-cancel-video').click(); await nativePage.locator('#xhs-video-status').filter({hasText:'已取消'}).waitFor();assert.equal(await nativePage.locator('#xhs-video-progress').isHidden(),true);
  report.nativeUI.push('Unknown-size video progress remains indeterminate with received bytes; known byte ratios show progress below 100 until native save succeeds, and cancelled progress is hidden.');
  assert.match(await nativePage.evaluate(() => window.__xhsCalls.find(call => call.action === 'saveVideo').input.video.url), /original/);
  assert.deepEqual(await nativePage.evaluate(()=>window.__xhsCalls.find(call=>call.action==='saveVideo').input.video.backupUrls),['https://fixture/original-backup.mp4']);assert.match(await nativePage.evaluate(()=>window.__xhsCalls.find(call=>call.action==='saveVideo').input.filename),/-原视频\.mp4$/);
  report.nativeUI.push('Selected originals and links, inversion, selected images/live ZIP payloads with full note text, archive cancellation, original-video selection and video cancellation match the native contracts.');
  for (const [button,successMessage] of [
    [nativePage.locator('.xhs-image-card').first().getByRole('button',{name:'复制原图',exact:true}),'原图已复制。'],
    [nativePage.locator('#xhs-copy-images'),'所选原图已复制。']
  ]) {
    await nativePage.evaluate(()=>window.__deferTransfer=true); await button.click();
    await nativePage.locator('#xhs-transfer-cancel').waitFor(); await nativePage.locator('#xhs-transfer-cancel').click();
    await nativePage.locator('#xhs-transfer-status').filter({hasText:'素材处理已取消'}).waitFor();
    assert.equal(await nativePage.locator('#xhs-message').innerText(),'已取消复制。','Cancelled original-image copying must not report clipboard success.');
    assert.equal(await nativePage.locator('#xhs-transfer-progress').isHidden(),true);
    await nativePage.evaluate(()=>window.__deferTransfer=false); await button.click();
    await nativePage.locator('#xhs-message').filter({hasText:successMessage}).waitFor();
    assert.equal(await nativePage.locator('#xhs-transfer-status').innerText(),'所选素材已处理完成。');
    assert.equal(await nativePage.locator('#xhs-transfer-progress').evaluate(progress=>progress.value),100);
  }
  report.nativeUI.push('Single-image and selected-image clipboard cancellation report cancellation in both global and transfer status; only successful copies show success and 100% progress.');
  for (const [button,action,type] of [['xhs-save-images','saveImages','transfer'],['xhs-save-note','saveNote','transfer'],['xhs-copy-images','copyImages','clipboard']]) {
    await nativePage.evaluate(()=>window.__deferTransfer=true); await nativePage.locator('#'+button).click();
    await nativePage.locator('#xhs-transfer-cancel').waitFor();
    assert.equal(await nativePage.locator('#xhs-parse').isDisabled(),true); assert.equal(await nativePage.locator('#xhs-export-selected').isDisabled(),true);
    const requestId=await nativePage.evaluate(action=>window.__xhsCalls.filter(call=>call.action===action).at(-1).input.requestId,action); assert.match(requestId,/^transfer-/);
    await nativePage.evaluate(({type,requestId})=>window.__xhsEmit({type,state:{requestId,receivedBytes:1024,completed:1,total:2,message:'本次请求进度'}}),{type,requestId});
    assert.equal(await nativePage.locator('#xhs-transfer-status').innerText(),'本次请求进度');
    assert.equal(await nativePage.locator('#xhs-transfer-progress').getAttribute('value'),null,'Active item counts do not establish a byte percentage.');
    await nativePage.evaluate(({type,requestId})=>window.__xhsEmit({type,state:{requestId,loadedBytes:2048,totalBytes:2048,completed:1,total:2,message:'本次请求进度'}}),{type,requestId});
    assert.equal(await nativePage.locator('#xhs-transfer-progress').getAttribute('value'),null,'One completed file cannot report 100% for an unfinished batch.');
    await nativePage.evaluate(type=>window.__xhsEmit({type,state:{requestId:'older-request',message:'过期进度'}}),type);
    assert.equal(await nativePage.locator('#xhs-transfer-status').innerText(),'本次请求进度');
    await nativePage.locator('#xhs-transfer-cancel').click(); await nativePage.locator('#xhs-transfer-status').filter({hasText:'素材处理已取消'}).waitFor();assert.equal(await nativePage.locator('#xhs-transfer-progress').isHidden(),true);
    if (action==='copyImages') assert.equal(await nativePage.locator('#xhs-message').innerText(),'已取消复制。');
    assert.equal(await nativePage.locator('#xhs-parse').isDisabled(),false); await nativePage.evaluate(()=>window.__deferTransfer=false);
  }
  report.nativeUI.push('Mixed selected-media ZIP preserves every selected image; image/note/clipboard operations have unique progress, cancellation and mutual exclusion, and ignore stale progress.');
  await nativePage.evaluate(() => {window.__videoFailure=true;window.__saveImagesCancel=true});
  await nativePage.locator('#xhs-save-video').click(); await nativePage.locator('#xhs-message').filter({hasText:'测试下载失败'}).waitFor(); assert.equal(await nativePage.locator('#xhs-video-status').innerText(),'测试下载失败');
  await nativePage.locator('.xhs-image-card').first().getByRole('button',{name:'保存原图',exact:true}).click(); await nativePage.locator('#xhs-message').filter({hasText:'已取消保存'}).waitFor();
  await nativePage.locator('#xhs-tab-profile').click(); await nativePage.locator('#xhs-clear-login').click(); await nativePage.locator('#xhs-message').filter({hasText:'已取消清除'}).waitFor(); assert.match(await nativePage.locator('#xhs-login-status').innerText(),/已登录小红书.*测试小红书账号/);
  await nativePage.evaluate(() => window.__clearCancel=false); await nativePage.locator('#xhs-clear-login').click(); assert.match(await nativePage.locator('#xhs-login-status').innerText(),/尚未登录/);
  report.nativeUI.push('Failed video downloads and cancelled single-image saves never claim success; cancelled session cleanup preserves login, and successful nested loginState updates correctly.');

  await nativePage.locator('#xhs-tab-note').click(); await nativePage.evaluate(()=>window.__onlyOriginalHint=true); await nativePage.locator('#xhs-parse').click();
  await nativePage.locator('#xhs-note-title').filter({hasText:'仅声明原视频'}).waitFor();
  assert.equal(await nativePage.locator('#xhs-videos-section').isVisible(),true);assert.match(await nativePage.locator('#xhs-original-status').innerText(),/暂未取得可下载地址/);assert.equal(await nativePage.locator('#xhs-save-video').isDisabled(),true);assert.equal(await nativePage.locator('#xhs-open-video-link').isDisabled(),true);
  report.nativeUI.push('A page declaration without a resolved original-video URL is reported accurately and never exposes an empty download action.');
  await nativePage.locator('#xhs-tab-profile').click(); await nativePage.locator('#xhs-profile-start').click(); await nativePage.locator('#xhs-profile-status').filter({hasText:'正在下载'}).waitFor();
  assert.equal(await nativePage.locator('#xhs-profile-start').isDisabled(),true); await nativePage.locator('#xhs-profile-pause').click(); assert.equal(await nativePage.locator('#xhs-profile-resume').isDisabled(),false);
  await nativePage.evaluate(()=>{window.__largeQueue=Array.from({length:150},(_,i)=>({id:i.toString(16).padStart(24,'0'),title:'队列 '+(i+1),sequence:i+1,status:[10,77,140].includes(i)?'failed':'pending'}));window.__xhsEmit({type:'profile',state:{status:'paused',items:window.__largeQueue}})});
  assert.equal(await nativePage.locator('#xhs-profile-items li').count(),100); assert.equal(await nativePage.locator('#xhs-queue-more').isVisible(),true);
  await nativePage.locator('#xhs-queue-more').click(); assert.equal(await nativePage.locator('#xhs-profile-items li').count(),150);
  await nativePage.locator('#xhs-queue-filter').selectOption('failed'); assert.equal(await nativePage.locator('#xhs-profile-items li').count(),3);
  await nativePage.evaluate(()=>{window.__keptQueueRow=document.querySelector('#xhs-profile-items li');window.__xhsEmit({type:'profile',state:{status:'paused',nextRequestAt:Date.now()+5000,items:window.__largeQueue}})});
  assert.equal(await nativePage.evaluate(()=>window.__keptQueueRow===document.querySelector('#xhs-profile-items li')),true,'Countdown-only updates preserve existing queue row nodes.');
  await nativePage.locator('#xhs-queue-filter').selectOption('all');
  await nativePage.evaluate(()=>window.__xhsEmit({type:'profile',state:{status:'waiting',nextRequestAt:Date.now()+10000,items:window.__largeQueue}}));
  const countdown=await nativePage.locator('#xhs-profile-countdown').innerText();await nativePage.waitForFunction(text=>document.getElementById('xhs-profile-countdown').textContent!==text,countdown);assert.match(await nativePage.locator('#xhs-profile-countdown').innerText(),/还需等待/);
  await nativePage.evaluate(()=>window.__xhsEmit({type:'profile',state:{status:'paused',items:window.__largeQueue}}));assert.equal(await nativePage.locator('#xhs-profile-countdown').isHidden(),true);

  report.nativeUI.push('The queue initially renders 100 records, expands on demand, filters failed notes and preserves row nodes during countdown-only updates.');
  await nativePage.evaluate(() => window.__xhsEmit({type:'profile',state:{status:'paused',failed:2,items:[{id:'a'.repeat(24),url:'https://www.xiaohongshu.com/explore/'+'a'.repeat(24),title:'失败笔记一',status:'failed',error:'测试错误'},{id:'c'.repeat(24),url:'https://www.xiaohongshu.com/explore/'+'c'.repeat(24),title:'失败笔记二',status:'failed'}]}}));
  await nativePage.locator('#xhs-copy-failed').click(); assert.equal((await nativePage.evaluate(() => window.__copied)).split('\n').length,2);
  await nativePage.locator('#xhs-profile-items li').last().getByRole('button',{name:'复制链接',exact:true}).click(); assert.match(await nativePage.evaluate(() => window.__copied), /cccccccccccccccccccccccc/);
  await nativePage.locator('#xhs-profile-items li').last().getByRole('button',{name:'转单篇',exact:true}).click(); assert.equal(await nativePage.locator('#xhs-panel-note').isVisible(),true); assert.match(await nativePage.locator('#xhs-share').inputValue(), /cccccccccccccccccccccccc/);
  report.nativeUI.push('Profile start/pause and event updates work; individual/all failed links copy correctly and transfer to single-note input without automatic parsing.');
  const callsBefore = await nativePage.evaluate(() => window.__xhsCalls.filter(call=>call.action==='readClipboard').length);
  await nativePage.evaluate(() => {window.__clipboard='https://xhslink.cn/o/new-note';window.dispatchEvent(new Event('focus'))});
  assert.equal(await nativePage.evaluate(() => window.__xhsCalls.filter(call=>call.action==='readClipboard').length),callsBefore);
  await nativePage.locator('#xhs-watch-clipboard').check(); await nativePage.locator('#xhs-clipboard-notice').waitFor();
  const parsesBefore = await nativePage.evaluate(() => window.__xhsCalls.filter(call=>call.action==='parse').length);
  await nativePage.locator('#xhs-use-clipboard').click(); assert.equal(await nativePage.locator('#xhs-share').inputValue(),'https://xhslink.cn/o/new-note');
  await nativePage.evaluate(() => window.dispatchEvent(new Event('focus'))); assert.equal(await nativePage.locator('#xhs-clipboard-notice').isHidden(),true);
  assert.equal(await nativePage.evaluate(() => window.__xhsCalls.filter(call=>call.action==='parse').length),parsesBefore);
  await nativePage.locator('[data-view="copy"]').first().click(); const hiddenCalls = await nativePage.evaluate(() => window.__xhsCalls.filter(call=>call.action==='readClipboard').length);
  await nativePage.evaluate(() => {window.__clipboard='https://xhslink.com/a/hidden-note';window.dispatchEvent(new Event('focus'))});
  assert.equal(await nativePage.evaluate(() => window.__xhsCalls.filter(call=>call.action==='readClipboard').length),hiddenCalls);
  report.nativeUI.push('Clipboard recognition is off by default, reads only while XHS is visible and enabled, deduplicates links, and never parses without the user.');
  await nativePage.locator('[data-view="xhs"]').first().click(); await nativePage.locator('#xhs-tab-profile').click(); await nativePage.evaluate(() => scrollTo(0,0));
  await nativePage.screenshot({ path:path.join(output,'xhs-ui-profile-contract.png'),fullPage:true }); report.screenshots.push('artifacts/xhs-ui-profile-contract.png');
  await nativePage.locator('#xhs-tab-note').click();await nativePage.locator('#xhs-engine').selectOption('python');await nativePage.reload();await nativePage.waitForFunction(()=>document.body.dataset.ready==='true');assert.equal(await nativePage.locator('#xhs-engine').inputValue(),'python');
  report.nativeUI.push('The parser engine preference survives reload in its own local key without initializing XHS or changing account/path settings.');
  await nativeContext.close();

  const androidContext = await browser.newContext({viewport:{width:390,height:1000}});
  const androidPage = await androidContext.newPage(); androidPage.on('pageerror', error => report.errors.push(error.message));
  await androidPage.route('**/bridge.js',async route=>{
    const response=await route.fetch();const body=await response.text();
    await route.fulfill({response,body:body+`
      window.__androidCalls=[];window.__generated=[];window.__androidEmit=null;
      window.BrclioHost={...window.BrclioHost,getPlatform:async()=>({platform:'android',version:'0.1.15',capabilities:{filePicker:true,folderPicker:true,systemIntegration:false,globalShortcut:false}}),onXhsEvent(callback){window.__androidEmit=callback},async saveGenerated(blob,filename,options){window.__generated.push({filename,mime:blob.type,size:blob.size,requestId:options?.requestId});return {ok:true}},async xhsRequest(action,input){
        window.__androidCalls.push({action,input});
        if(action==='parse')return {title:'安卓测试笔记',content:'安卓完整文案',images:[{index:1,url:'https://fixture/android.jpg'}],videos:[{url:'https://fixture/android.mp4',label:'原视频'}]};
        return {ok:true};
      }};`});
  });
  await androidPage.goto(url);await androidPage.waitForFunction(()=>document.body.dataset.ready==='true');
  assert.equal(await androidPage.evaluate(()=>Boolean(window.brclio)),false,'Android must use BrclioHost without the Electron global.');
  await androidPage.evaluate(()=>window.dispatchEvent(new CustomEvent('brclio:xhs-share',{detail:{text:'https://xhslink.com/a/android-share'}})));
  assert.equal(await androidPage.locator('#view-xhs').isVisible(),true);assert.equal(await androidPage.locator('#xhs-share').inputValue(),'https://xhslink.com/a/android-share');
  assert.equal(await androidPage.locator('#xhs-parse').isDisabled(),false);assert.equal(await androidPage.locator('#xhs-tab-profile').isDisabled(),true);assert.equal(await androidPage.locator('#xhs-engine option[value="python"]').evaluate(option=>option.disabled),false);
  assert.equal(await androidPage.evaluate(()=>window.__androidCalls.length),0,'Receiving a share must not automatically parse or initialize desktop-only profile state.');
  await androidPage.locator('#xhs-parse').click();await androidPage.locator('#xhs-note-title').filter({hasText:'安卓测试笔记'}).waitFor(); assert.match(await androidPage.locator('#xhs-note-summary').innerText(),/本地解析/); assert.equal(await androidPage.locator('#xhs-engine option[value="node"]').textContent(),'本地解析');
  assert.equal(await androidPage.locator('#xhs-share-images').isVisible(),true); await androidPage.locator('#xhs-share-images').click(); assert.deepEqual(await androidPage.evaluate(()=>window.__androidCalls.find(call=>call.action==='shareImages').input.images.map(image=>image.index)),[1]); await androidPage.locator('.xhs-image-select').uncheck();assert.equal(await androidPage.locator('#xhs-share-images').isDisabled(),true);await androidPage.locator('.xhs-image-select').check();
  assert.match(await androidPage.locator('.xhs-image-card img').getAttribute('src'),/^https:\/\/appassets\.androidplatform\.net\/xhs-media\?url=.*kind=image$/);
  assert.match(await androidPage.locator('#xhs-video-preview').getAttribute('src'),/kind=video$/);
  await androidPage.locator('#xhs-engine').selectOption('python'); await androidPage.locator('#xhs-parse').click();
  assert.equal(await androidPage.evaluate(()=>window.__androidCalls.filter(call=>call.action==='parse').at(-1).input.engine),'python');await androidPage.locator('#xhs-engine').selectOption('node');
  await androidPage.locator('#xhs-save-images').click();await androidPage.locator('#xhs-export-content').click();
  await androidPage.waitForFunction(()=>window.__generated.length===1);assert.match(await androidPage.evaluate(()=>window.__generated[0].filename),/\.txt$/);
  await androidPage.locator('#xhs-tab-live').click();await androidPage.locator('#xhs-live-support').filter({hasText:'支持本地制作'}).waitFor();
  await androidPage.locator('#xhs-live-files').setInputFiles(path.join(web,'assets/icon.png'));await androidPage.locator('#xhs-live-source-info').filter({hasText:'1 张图片'}).waitFor();
  await androidPage.locator('#xhs-live-duration').fill('0.5');await androidPage.locator('#xhs-live-duration').dispatchEvent('change');await androidPage.locator('#xhs-live-generate').click();await androidPage.locator('#xhs-live-result').waitFor({timeout:60000});
  await androidPage.locator('#xhs-live-export-package').click();await androidPage.waitForFunction(()=>window.__generated.length===2);
  assert.match(await androidPage.evaluate(()=>window.__generated[1].filename),/\.zip$/);assert.ok(await androidPage.evaluate(()=>window.__generated[1].size)>1000);
  report.androidUI.push('BrclioHost-only Android enables single-note downloads and local Live Photo creation, restricts profile to desktop and retains online Python fallback, uses same-origin media, accepts shared text without auto-parse, shares selected originals through the system, and exports generated TXT/PVT ZIP through native saveGenerated.');
  await androidPage.evaluate(()=>scrollTo(0,0));await androidPage.screenshot({path:path.join(output,'xhs-ui-android-contract.png'),fullPage:true});report.screenshots.push('artifacts/xhs-ui-android-contract.png');assert.match(await androidPage.evaluate(()=>window.__generated.at(-1).requestId),/^transfer-/);await androidContext.close();
  assert.deepEqual(report.errors,[]); report.passed=true;
  console.log(JSON.stringify(report,null,2));
} catch (error) { report.passed=false; report.failure=error.stack; throw error; }
finally { await browser?.close(); await new Promise(resolve=>server.close(resolve)); await writeFile(path.join(output,'xhs-ui-verification.json'),JSON.stringify(report,null,2)+'\n'); }
