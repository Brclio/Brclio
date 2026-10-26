'use strict';
// Real Brclio main window + UI, existing CSP, local codec fixtures only.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { _electron, expect } = require('@playwright/test');
const root = path.resolve(__dirname, '..');
const artifacts = path.join(root, 'artifacts');
const reportPath = path.join(artifacts, 'xhs-live-verification.json');
const report = { passed: false, testedAt: new Date().toISOString(), platform: process.platform, checks: [], consoleErrors: [] };
let electronApp, page, temporary;
const readJSONCommand = (command, args) => JSON.parse(execFileSync(command, args, { encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] }));
const probe = filename => readJSONCommand('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-show_packets', '-of', 'json', filename]);
async function field(id, value) { await page.locator(`#xhs-live-${id}`).fill(String(value)); await page.locator(`#xhs-live-${id}`).dispatchEvent('change'); }
async function exportFile(button, label) {
  const count = await electronApp.evaluate(() => global.__xhsLiveDownloads.length);
  await page.locator(`#xhs-live-${button}`).click();
  await page.waitForFunction(() => !document.querySelector('#xhs-message').classList.contains('error'), { timeout: 15000 });
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const entry = await electronApp.evaluate((_electron, index) => global.__xhsLiveDownloads[index], count);
    if (entry?.state === 'completed') return entry.path;
    if (entry?.state && entry.state !== 'progressing') throw new Error(`Download ${label}: ${entry.state}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Download timed out: ${label}`);
}
async function generate() {
  await page.locator('#xhs-live-generate').click();
  await page.waitForFunction(() => !document.querySelector('#xhs-live-result').hidden || /失败|不支持|无法|不能|不可|超出/.test(document.querySelector('#xhs-live-status').textContent), { timeout: 90000 });
  assert.equal(await page.locator('#xhs-live-result').isVisible(), true, await page.locator('#xhs-live-status').textContent());
  await page.waitForFunction(() => document.querySelector('#xhs-live-cancel').hidden);
}
async function inspectMovie(filename, { duration, audio, cover }) {
  const info = probe(filename), video = info.streams.find(stream => stream.codec_type === 'video');
  assert.equal(video.codec_name, 'h264');
  assert.ok(Math.abs(Number(info.format.duration) - duration) < .002, `duration ${info.format.duration}`);
  assert.equal(info.streams.some(stream => stream.codec_type === 'audio'), audio);
  const metadata = info.streams.find(stream => stream.codec_tag_string === 'mebx');
  assert.ok(metadata, 'Live Photo still-image metadata track');
  const key = info.packets.find(packet => packet.stream_index === metadata.index);
  assert.ok(Math.abs(Number(key.pts_time) - cover) < .035, `cover ${key.pts_time}`);
  assert.match(info.format.tags['com.apple.quicktime.content.identifier'], /^[\da-f-]{36}$/i);
  execFileSync('ffmpeg', ['-v', 'error', '-i', filename, '-map', '0:v', ...(audio ? ['-map', '0:a'] : []), '-f', 'null', '-'], { timeout: 30000, stdio: 'pipe' });
  return { duration: Number(info.format.duration), audio, cover: Number(key.pts_time), identifier: info.format.tags['com.apple.quicktime.content.identifier'], bytes: (await fs.stat(filename)).size };
}
async function main() {
  await fs.mkdir(artifacts, { recursive: true });
  temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'brclio-xhs-live-'));
  const outputs = path.join(temporary, 'exports'); await fs.mkdir(outputs);
  const videoPath = path.join(temporary, 'with-audio.mp4');
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x192:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '6', '-c:v', 'libx264', '-bf', '0', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ac', '2', videoPath], { timeout: 30000, stdio: 'pipe' });
  // Bootstrap installs deterministic network interception before the actual main
  // module starts. Every session (including XHS's hidden partition) stays local.
  const bootstrap = path.join(temporary, 'bootstrap.cjs');
  const metadata = JSON.parse(await fs.readFile(path.join(root,'package.json'),'utf8'));
  await fs.writeFile(path.join(temporary,'package.json'),JSON.stringify({name:metadata.name,version:metadata.version,productName:metadata.productName,main:'bootstrap.cjs'}));
  // The installed Electron package resolves to an executable in plain Node; the
  // child process uses its built-in electron module instead.
  await fs.writeFile(bootstrap, `const { app, session } = require('electron');
app.commandLine.appendSwitch('autoplay-policy','no-user-gesture-required');
global.__xhsLiveDownloads=[]; global.__xhsLiveNetwork=[]; const sessions=new WeakSet();
function localSession(value) {
  if(sessions.has(value)) return; sessions.add(value);
  for (const scheme of ['https','http']) value.protocol.handle(scheme, request => {
    global.__xhsLiveNetwork.push(request.url);
    if (new URL(request.url).pathname.startsWith('/api/account/')) return Response.json({user:null,csrf:'fixture-csrf',googleEnabled:false,passwordEnabled:true});
    return new Response('<!doctype html><title>Offline fixture</title><p>Local verification; no external connection.</p>',{headers:{'content-type':'text/html'}});
  });
  value.on('will-download', (_event,item) => {
    const entry={path:${JSON.stringify(outputs)}+'/'+global.__xhsLiveDownloads.length+'-'+item.getFilename(),state:'progressing'};
    global.__xhsLiveDownloads.push(entry); item.setSavePath(entry.path); item.once('done',(_event,state)=>{entry.state=state});
  });
}
app.on('session-created',localSession);
app.whenReady().then(()=>localSession(session.defaultSession));
require(${JSON.stringify(path.join(root, 'desktop/main.cjs'))});
`);
  electronApp = await _electron.launch({ executablePath: require('electron'), args: [temporary], env: { ...process.env, BRCLIO_USER_DATA: path.join(temporary, 'user-data'), ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' }, timeout: 30000 });
  page = await electronApp.firstWindow();
  page.setDefaultTimeout(15000);
  page.on('pageerror', error => report.consoleErrors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') report.consoleErrors.push(message.text()); });
  await page.waitForFunction(() => document.body.dataset.ready === 'true');
  assert.match(page.url(), /^file:\/\//);
  report.origin = page.url(); report.csp = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content');
  await page.locator('[data-view="xhs"]').first().click();
  await page.locator('#xhs-tab-live').click();
  await page.locator('#xhs-live-support').filter({ hasText: '支持本地制作' }).waitFor();
  const support = await page.evaluate(async () => (await import('./xhs/lib/live-photo-maker.js')).checkLivePhotoSupport());
  assert.equal(support.supported, true); assert.equal(support.heicSupported, true); assert.equal(support.audioSupported, true);
  report.support = support;
  const images = await page.evaluate(() => ['#d94335', '#3764cc'].map(color => { const canvas = document.createElement('canvas'); canvas.width=320; canvas.height=192; const context=canvas.getContext('2d'); context.fillStyle=color; context.fillRect(0,0,320,192); return canvas.toDataURL('image/png').split(',')[1]; }));
  const imagePaths = images.map((_, index) => path.join(temporary, `image-${index + 1}.png`));
  await Promise.all(images.map((data, index) => fs.writeFile(imagePaths[index], Buffer.from(data, 'base64'))));
  await page.locator('#xhs-live-files').setInputFiles(imagePaths);
  await page.locator('#xhs-live-source-info').filter({hasText:'2 张图片'}).waitFor();
  await page.getByRole('button',{name:'将 image-2.png 上移',exact:true}).click();
  assert.match(await page.locator('#xhs-live-file-list li').first().textContent(), /image-2.png/);
  await page.locator('#xhs-live-format').selectOption('jpeg');
  await field('duration',1); await field('cover',.25); await page.locator('#xhs-live-motion').selectOption('still');
  await page.locator('#xhs-live-preview').click();
  await page.locator('#xhs-live-preview-canvas').waitFor({state:'visible'});
  await generate();
  assert.match(await page.locator('#xhs-live-result-info').textContent(), /JPG \+ MOV/);
  const jpegMovie=await exportFile('export-mov','JPEG movie');
  report.checks.push({name:'ordered JPEG slideshow + source preview + paired MOV',...await inspectMovie(jpegMovie,{duration:1,audio:false,cover:.25})});
  const jpegPhoto=await exportFile('export-photo','JPEG photo');
  const jpegData=await fs.readFile(jpegPhoto); assert.equal(jpegData[0],255); assert.equal(jpegData[1],216);
  const coverPixel=execFileSync('ffmpeg',['-v','error','-i',jpegPhoto,'-vf','scale=1:1','-frames:v','1','-f','rawvideo','-pix_fmt','rgb24','-'],{timeout:30000,stdio:['ignore','pipe','pipe']});
  assert.ok(coverPixel[2]>coverPixel[0]+60,'JPEG cover must preserve the reordered first (blue) image');
  report.jpegCoverPixel=[...coverPixel];
  const jpegPackage=await exportFile('export-package','JPEG PVT');
  await page.locator('#xhs-live-format').selectOption('heic');
  assert.equal(await page.locator('#xhs-live-result').isVisible(),false,'settings invalidate the prior result');
  await generate();
  assert.match(await page.locator('#xhs-live-result-info').textContent(), /HEIC \+ MOV/);
  const heicPhoto=await exportFile('export-photo','HEIC photo');
  const heicData=await fs.readFile(heicPhoto); assert.equal(heicData.subarray(4,8).toString(),'ftyp');
  if(process.platform==='darwin') {
    const swift=path.join(temporary,'inspect-cover.swift');
    await fs.writeFile(swift,`import Foundation
import ImageIO
import CoreGraphics
let source=CGImageSourceCreateWithURL(URL(fileURLWithPath:CommandLine.arguments[1]) as CFURL,nil)!
let image=CGImageSourceCreateImageAtIndex(source,0,nil)!
let properties=CGImageSourceCopyPropertiesAtIndex(source,0,nil)! as NSDictionary
let maker=properties[kCGImagePropertyMakerAppleDictionary] as! NSDictionary
let context=CGContext(data:nil,width:1,height:1,bitsPerComponent:8,bytesPerRow:4,space:CGColorSpace(name:CGColorSpace.sRGB)!,bitmapInfo:CGImageAlphaInfo.premultipliedLast.rawValue)!
context.draw(image,in:CGRect(x:0,y:0,width:1,height:1))
let pixel=context.data!.assumingMemoryBound(to:UInt8.self)
let output:[String:Any]=["type":CGImageSourceGetType(source)! as String,"width":image.width,"height":image.height,"identifier":maker["17"]!,"pixel":[pixel[0],pixel[1],pixel[2]]]
print(String(data:try! JSONSerialization.data(withJSONObject:output),encoding:.utf8)!)
`);
    report.nativeHeic=readJSONCommand('swift',[swift,heicPhoto]);
    assert.equal(report.nativeHeic.type,'public.heic');assert.equal(report.nativeHeic.width,320);assert.equal(report.nativeHeic.height,192);
    assert.ok(report.nativeHeic.pixel[2]>report.nativeHeic.pixel[0]+60,'HEIC cover must preserve the reordered first (blue) image');
    assert.ok(heicPhoto.includes(report.nativeHeic.identifier),'HEIC MakerApple 17 must match the exported pair filename');
  }
  const heicPackage=await exportFile('export-package','HEIC PVT');
  const pair=await exportFile('export-pair','HEIC pair');
  report.checks.push({name:'real HEIC Worker/WASM under production file CSP + PVT and pair ZIP',bytes:heicData.length});
  await page.waitForFunction(()=>document.querySelector('#xhs-live-preview-image').complete && document.querySelector('#xhs-live-preview-image').naturalWidth>0);
  await page.evaluate(()=>window.scrollTo(0,0));
  await page.screenshot({path:path.join(artifacts,'xhs-live-heic.png'),fullPage:true});
  // Read exported ZIPs independently, validate every CRC, actual pair IDs, and
  // the package metadata rather than only checking filenames in renderer state.
  const python=process.env.BRCLIO_TEST_PYTHON || (process.platform==='win32'?'python':'python3');
  const zipped=readJSONCommand(python,['-c',`import json,zipfile,sys,plistlib,re\nout=[]\nfor filename in sys.argv[1:]:\n with zipfile.ZipFile(filename) as archive:\n  assert archive.testzip() is None\n  names=archive.namelist(); stem=re.search(r'Brclio-Live-([a-fA-F0-9-]{36})',names[0]).group(1)\n  media=[n for n in names if n.endswith(('.JPG','.HEIC','.MOV'))]\n  assert len(media)==2\n  for name in media: assert stem.encode() in archive.read(name)\n  bundles=[n for n in names if n.endswith('metadata.plist')]\n  if bundles:\n   assert plistlib.loads(archive.read(bundles[0]))=={'PFVideoComplementMetadataVersionKey':'1'}\n   assert 'README.txt' in names and all('.pvt/' in name for name in media)\n  out.append({'files':names,'crc':True,'pairIdentifier':stem})\nprint(json.dumps(out))`,jpegPackage,heicPackage,pair]);
  report.zip=zipped;
  await page.locator('#xhs-live-files').setInputFiles(videoPath);
  await page.locator('#xhs-live-source-info').filter({hasText:'视频 · 6.00 秒'}).waitFor();
  await field('start',1);await field('duration',.6);await field('cover',.2);
  await page.locator('#xhs-live-audio').check();
  await generate();
  assert.match(await page.locator('#xhs-live-result-info').textContent(),/保留声音/);
  const audioMovie=await exportFile('export-mov','audio movie');
  report.checks.push({name:'trimmed video + HEIC + retained AAC audio',...await inspectMovie(audioMovie,{duration:.6,audio:true,cover:.2})});
  const pcm=execFileSync('ffmpeg',['-v','error','-i',audioMovie,'-map','0:a','-f','f32le','-acodec','pcm_f32le','-'],{timeout:30000,stdio:['ignore','pipe','pipe']});
  let sum=0;for(let at=0;at+4<=pcm.length;at+=4)sum+=pcm.readFloatLE(at)**2;const rms=Math.sqrt(sum/(pcm.length/4));assert.ok(rms>.01,'retained audio is audible');report.audioRms=rms;
  await page.locator('#xhs-live-speed').selectOption('2');
  assert.equal(await page.locator('#xhs-live-audio').isDisabled(),true);
  await page.locator('#xhs-live-preview').click();
  await expect.poll(() => page.locator('#xhs-live-preview-video').evaluate(video=>video.playbackRate)).toBe(2);
  await generate();
  assert.doesNotMatch(await page.locator('#xhs-live-result-info').textContent(),/保留声音/);
  const fastMovie=await exportFile('export-mov','2x movie');
  report.checks.push({name:'2x video preview + silent encoded output',...await inspectMovie(fastMovie,{duration:.6,audio:false,cover:.2})});
  // A real sparse MP4 on disk exceeds 2 GiB while only the short selected clip
  // is decoded. An ISO-BMFF free box pads the fixture without invalidating it.
  const largeVideoPath=path.join(temporary,'large-native-video.mp4'),source=await fs.readFile(videoPath),sourceBytes=2*1024**3+1,free=Buffer.alloc(8);
  free.writeUInt32BE(sourceBytes-source.length);free.write('free',4,4,'ascii');
  await fs.writeFile(largeVideoPath,Buffer.concat([source,free]));await fs.truncate(largeVideoPath,sourceBytes);
  await page.evaluate(()=>document.querySelector('#xhs-live-files').addEventListener('change',event=>{
    const file=event.target.files[0];window.__xhsLargeInputSize=file.size;
    file.arrayBuffer=()=>{throw new Error('Full source must not be read into memory')};
  },{capture:true,once:true}));
  await page.locator('#xhs-live-files').setInputFiles(largeVideoPath);
  await page.locator('#xhs-live-source-info').filter({hasText:'视频 · 6.00 秒'}).waitFor();
  await field('start',.25);await field('duration',.6);await field('cover',.2);
  await generate();
  const largeMovie=await exportFile('export-mov','large source movie');
  assert.equal(await page.evaluate(()=>window.__xhsLargeInputSize),sourceBytes);
  report.checks.push({name:'real >2 GiB disk video streamed through file document + HEIC/audio clip',sourceBytes,...await inspectMovie(largeMovie,{duration:.6,audio:true,cover:.2})});
  // Start a long real codec job and cancel through the visible UI immediately.
  await field('duration',2); await field('cover',.5);
  await page.locator('#xhs-live-generate').click();
  await page.locator('#xhs-live-cancel').waitFor({state:'visible'});
  await page.locator('#xhs-live-cancel').click();
  await page.locator('#xhs-live-status').filter({hasText:'制作已取消'}).waitFor();
  assert.equal(await page.locator('#xhs-live-result').isVisible(),false);
  assert.equal(await page.locator('#xhs-live-generate').isEnabled(),true);
  report.checks.push({name:'UI cancellation leaves no stale export and permits retry'});
  await page.evaluate(()=>window.scrollTo(0,0));
  await page.screenshot({path:path.join(artifacts,'xhs-live-cancel.png'),fullPage:true});
  const samples=path.join(artifacts,'xhs-live-samples');await fs.mkdir(samples,{recursive:true});
  for(const [source,name] of [[jpegPackage,'jpeg-pvt.zip'],[heicPackage,'heic-pvt.zip'],[heicPhoto,'cover.HEIC'],[audioMovie,'with-audio.MOV'],[fastMovie,'2x-silent.MOV']]) await fs.copyFile(source,path.join(samples,name));
  report.samples=samples;
  report.interceptedNetwork=await electronApp.evaluate(()=>global.__xhsLiveNetwork);
  assert.deepEqual(report.consoleErrors,[]);
  report.passed=true;
}
main().catch(error=>{report.error=error.stack||String(error);process.exitCode=1;}).finally(async()=>{
  if(page && !report.passed) await page.screenshot({path:path.join(artifacts,'xhs-live-failure.png'),fullPage:true}).catch(()=>{});
  if(electronApp) await electronApp.close().catch(()=>{});
  if(temporary) await fs.rm(temporary,{recursive:true,force:true});
  await fs.writeFile(reportPath,JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({passed:report.passed,checks:report.checks.length,report:reportPath,...(report.error?{error:report.error.split('\n')[0]}:{})}));
});
