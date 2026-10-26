'use strict';
// Requires an isolated debug emulator. Live Python is opt-in and uses only an
// anonymous direct-image URL fixture; no account or real note is submitted.
const fs=require('node:fs/promises'),path=require('node:path'),assert=require('node:assert/strict');
const {execFileSync}=require('node:child_process'),WebSocket=require('ws');
const root=path.resolve(__dirname,'..'),output=path.join(root,'artifacts'),device=process.env.BRCLIO_ANDROID_DEVICE||'emulator-5588';
const adb=process.env.BRCLIO_ADB||(process.env.ANDROID_HOME?path.join(process.env.ANDROID_HOME,'platform-tools',process.platform==='win32'?'adb.exe':'adb'):'adb');
const command=(...args)=>execFileSync(adb,['-s',device,...args],{encoding:'utf8',timeout:30000});
const delay=ms=>new Promise(r=>setTimeout(r,ms));
let socket,sequence=0;const pending=new Map();
const cdp=(method,params={})=>new Promise((resolve,reject)=>{const id=++sequence;const timer=setTimeout(()=>{pending.delete(id);reject(new Error(`${method} timed out`))},30000);pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params}));});
async function evaluate(expression,awaitPromise=true){const result=await cdp('Runtime.evaluate',{expression,returnByValue:true,awaitPromise,userGesture:true});if(result.exceptionDetails)throw new Error(result.exceptionDetails.text+' '+(result.exceptionDetails.exception?.description||''));return result.result.value;}
async function until(expression,timeout=30000){const deadline=Date.now()+timeout;while(Date.now()<deadline){const value=await evaluate(expression);if(value)return value;await delay(100);}throw new Error('Condition timed out: '+expression);}
async function screenshot(name){const image=await cdp('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});await fs.writeFile(path.join(output,name),Buffer.from(image.data,'base64'));}
async function pickerSave(){await delay(800);command('shell','uiautomator','dump','/sdcard/xhs-window.xml');const xml=command('shell','cat','/sdcard/xhs-window.xml');await fs.writeFile(path.join(output,'xhs-android-picker.xml'),xml);const node=[...xml.matchAll(/<node[^>]+>/g)].map(x=>x[0]).find(x=>/resource-id="android:id\/button1"/.test(x)&&/enabled="true"/.test(x));if(!node)throw new Error('System save button not found');const box=node.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/).slice(1).map(Number);command('shell','input','tap',String((box[0]+box[2])>>1),String((box[1]+box[3])>>1));}
const report={passed:false,checks:[],device};
(async()=>{
 await fs.mkdir(output,{recursive:true});
 command('shell','rm','-f','/sdcard/Download/xhs-fixture-caption.txt');
 command('shell','am','force-stop','com.brclio.toolbox.debug');
 command('shell','am','start','-W','-f','0x10008000','-n','com.brclio.toolbox.debug/com.brclio.toolbox.MainActivity','-a','android.intent.action.SEND','-t','text/plain','--es','android.intent.extra.TEXT','https://www.xiaohongshu.com/explore/0123456789abcdef01234567');
 let pid='';for(let attempt=0;attempt<100&&!pid;attempt++){try{pid=command('shell','pidof','com.brclio.toolbox.debug').trim()}catch{}if(!pid)await delay(100);}assert.ok(pid,'debug application must start');await delay(700);command('forward','tcp:9225',`localabstract:webview_devtools_remote_${pid}`);
 let target;for(let attempt=0;attempt<100&&!target;attempt++){try{const pages=await(await fetch('http://127.0.0.1:9225/json/list')).json();target=pages.find(p=>p.url.includes('/assets/web/index.html'))}catch{}if(!target)await delay(200);}assert.ok(target,'debug WebView endpoint must become ready');socket=new WebSocket(target.webSocketDebuggerUrl);await new Promise(r=>socket.once('open',r));socket.on('message',data=>{const message=JSON.parse(data);const request=pending.get(message.id);if(request){pending.delete(message.id);clearTimeout(request.timer);message.error?request.reject(new Error(message.error.message)):request.resolve(message.result)}});
 await cdp('Runtime.enable');await until("document.body.dataset.ready==='true'");
 await evaluate("window.__nativeSaveGenerated=BrclioHost.saveGenerated;BrclioHost.saveGenerated=async(blob,filename,options)=>{window.__lastGeneratedFilename=filename;window.__lastGeneratedResult={state:'pending'};try{const result=await window.__nativeSaveGenerated(blob,filename,options);window.__lastGeneratedResult={state:'done',result};return result}catch(error){window.__lastGeneratedResult={state:'error',message:error.message};throw error}};true");
 report.platform=await evaluate('BrclioHost.getPlatform()');assert.equal(report.platform.platform,'android');
 assert.match(await evaluate("document.querySelector('#xhs-share').value"),/0123456789abcdef01234567/);report.checks.push('system shared XHS text fills single-note draft');
 const info=await evaluate("BrclioHost.xhsRequest('info')");assert.equal(info.capabilities.profile,false);assert.equal(info.capabilities.python,true);
 const safety=await evaluate(`(async()=>{
  const requestId='generated-cancel-fixture';
  const opened=await BrclioHost.xhsRequest('beginGenerated',{filename:'xhs-cancel-fixture.zip',mime:'application/zip',size:10,requestId});
  const first=await BrclioHost.xhsRequest('appendGenerated',{token:opened.token,offset:0,data:'SGVsbG8='});
  let busyError='';try{await BrclioHost.installUpdate()}catch(error){busyError=error.message}
  const cancelled=await BrclioHost.xhsRequest('cancelTransfer',{requestId});
  const lateAppend=await BrclioHost.xhsRequest('appendGenerated',{token:opened.token,offset:5,data:'V29ybGQ='});
  const lateFinish=await BrclioHost.xhsRequest('finishGenerated',{token:opened.token});
  let idleError='';try{await BrclioHost.installUpdate()}catch(error){idleError=error.message}
  let videoError='';try{await BrclioHost.xhsRequest('openVideo',{url:'https://127.0.0.1/private'})}catch(error){videoError=error.message}
  return {opened,first,busyError,cancelled,lateAppend,lateFinish,idleError,videoError};
 })()`);
 assert.equal(safety.first.received,5);assert.equal(safety.opened.requestId,'generated-cancel-fixture');assert.match(safety.busyError,/请先完成或取消小红书/);
 assert.equal(safety.cancelled.cancelled,true);assert.equal(safety.lateAppend.cancelled,true);assert.equal(safety.lateFinish.cancelled,true);
 assert.match(safety.idleError,/检查|下载/);assert.ok(!safety.idleError.includes('请先完成或取消小红书'));assert.match(safety.videoError,/小红书|官方|安全/);
 report.checks.push('real native generated request cancellation rejects late chunks/commit and guards update installation only while busy');
 report.checks.push('real native openVideo rejects private hosts before opening an external activity');
 await evaluate("document.querySelector('[data-view=xhs]').click();document.querySelector('#xhs-tab-live').click()");
 report.codecs=await evaluate("import('./xhs/lib/live-photo-maker.js').then(module=>module.checkLivePhotoSupport())");
 await evaluate("window.__textSave={state:'pending'};BrclioHost.saveGenerated(new Blob(['本地文案\\nfixture-caption'],{type:'text/plain;charset=utf-8'}),'xhs-fixture-caption.txt').then(value=>window.__textSave={state:'done',value},error=>window.__textSave={state:'error',message:error.message});true",false);
 await pickerSave();const saved=await until("window.__textSave.state!=='pending'&&window.__textSave");assert.equal(saved.state,'done',JSON.stringify(saved));assert.equal(saved.value.cancelled,false);
 const text=command('shell','cat','/sdcard/Download/xhs-fixture-caption.txt');assert.equal(text,'本地文案\nfixture-caption');report.checks.push('real native chunk transfer + SAF text/plain charset export preserves exact bytes');
 await evaluate("document.querySelector('#xhs-live-files').click();true",false);await delay(700);command('shell','uiautomator','dump','/sdcard/xhs-filepicker.xml');const picker=command('shell','cat','/sdcard/xhs-filepicker.xml');assert.match(picker,/documentsui|Documents|文件|Recent/);await fs.writeFile(path.join(output,'xhs-android-files.xml'),picker);command('shell','input','keyevent','4');report.checks.push('real Android image/video file chooser opens and cancels');
 // Choose a real content:// image through Android's Documents UI.
 command('push',path.join(root,'resources/icon.png'),'/sdcard/Download/xhs-fixture.png');
 command('shell','am','broadcast','-a','android.intent.action.MEDIA_SCANNER_SCAN_FILE','-d','file:///sdcard/Download/xhs-fixture.png');
 await evaluate("document.querySelector('#xhs-live-files').click();true",false);await delay(700);
 command('shell','uiautomator','dump','/sdcard/xhs-select.xml');let selection=command('shell','cat','/sdcard/xhs-select.xml');
 let item=[...selection.matchAll(/<node[^>]+>/g)].map(x=>x[0]).find(x=>/text="xhs-fixture.png"/.test(x));
 if(!item){
   const listButton=[...selection.matchAll(/<node[^>]+>/g)].map(x=>x[0]).find(x=>/content-desc="List view"/.test(x));
   if(listButton){const box=listButton.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/).slice(1).map(Number);command('shell','input','tap',String((box[0]+box[2])>>1),String((box[1]+box[3])>>1));await delay(300)}
   command('shell','uiautomator','dump','/sdcard/xhs-select.xml');selection=command('shell','cat','/sdcard/xhs-select.xml');item=[...selection.matchAll(/<node[^>]+>/g)].map(x=>x[0]).find(x=>/text="xhs-fixture.png"/.test(x));
 }
 if(!item)throw new Error('Pushed fixture not listed in native image picker');
 const selectedBox=item.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/).slice(1).map(Number);command('shell','input','tap',String((selectedBox[0]+selectedBox[2])>>1),String((selectedBox[1]+selectedBox[3])>>1));
 await until("document.querySelector('#xhs-live-source-info').textContent.includes('1 张图片')");
 await evaluate("document.querySelector('#xhs-live-duration').value='.5';document.querySelector('#xhs-live-duration').dispatchEvent(new Event('change'));document.querySelector('#xhs-live-cover').value='.2';document.querySelector('#xhs-live-cover').dispatchEvent(new Event('change'));document.querySelector('#xhs-live-format').value='heic';document.querySelector('#xhs-live-format').dispatchEvent(new Event('change'));document.querySelector('#xhs-live-generate').click();true",false);
 await until("!document.querySelector('#xhs-live-result').hidden",90000);
 assert.match(await evaluate("document.querySelector('#xhs-live-result-info').textContent"),/HEIC/);report.checks.push('native content image selection + actual Android WebCodecs and HEIC Worker under CSP');
 await evaluate("document.querySelector('#xhs-live-export-package').click();true",false);await delay(800);command('shell','input','keyevent','4');await until("window.__lastGeneratedResult?.state==='done'&&window.__lastGeneratedResult.result.cancelled&&!document.querySelector('#xhs-live-export-package').disabled");report.checks.push('real SAF generated export cancellation returns to editable result');
 await evaluate("document.querySelector('#xhs-live-export-package').click();true",false);await pickerSave();await until("window.__lastGeneratedResult?.state==='done'&&!window.__lastGeneratedResult.result.cancelled");
 const list=await evaluate('window.__lastGeneratedFilename');assert.match(list,/^Brclio-Live-.*\.zip$/);command('pull',`/sdcard/Download/${list}`,path.join(output,'xhs-android-live.pvt.zip'));report.checks.push('real native generated HEIC+MOV PVT ZIP saves through SAF');
 const noteId='0123456789abcdef01234567',original='https://sns-video-bd.xhscdn.com/spectrum/fixture-original.mp4';
 const html='<script>window.__INITIAL_STATE__='+JSON.stringify({note:{noteDetailMap:{[noteId]:{note:{noteId,title:'本地原视频',desc:'夹具文案',video:{consumer:{originVideoKey:original}}}}}}})+'</script>';
 // Stub only the source-page bytes in the debug WebView, keeping the real
 // bridge parser and all actual generated-file native calls above unchanged.
 await evaluate(`window.__originalAndroidPost=AndroidBridge.postMessage.bind(AndroidBridge);AndroidBridge.postMessage=raw=>{const message=JSON.parse(raw);if(message.method==='xhsRequest'&&message.payload.action==='fetchNote'){queueMicrotask(()=>window.__brclioResolve(message.id,{result:${JSON.stringify({html,finalUrl:`https://www.xiaohongshu.com/explore/${noteId}`})}}));}else window.__originalAndroidPost(raw)};true`);
 const parsed=await evaluate(`BrclioHost.xhsRequest('parse',{text:'https://www.xiaohongshu.com/explore/${noteId}'})`);assert.equal(parsed.originalVideos[0].url,original);assert.equal(parsed.content,'夹具文案');report.checks.push('real local pure parser + Android adapter retain original-video candidates without account services');
 await evaluate('AndroidBridge.postMessage=window.__originalAndroidPost;true');
 const permissionDump=command('shell','dumpsys','activity','permissions');
 const uid=command('shell','cmd','package','list','packages','-U','com.brclio.toolbox.debug').match(/uid:(\d+)/)?.[1];
 assert.ok(uid,'debug package UID');
 const blocks=permissionDump.split(/(?=^\s*\* UID \d+ holds:)/m);
 const own=blocks.filter(block=>new RegExp('^\\s*\\* UID '+uid+' holds:','m').test(block)).join('\n');
 const persisted=[...own.matchAll(/\b(?:persistedModeFlags|persisted)=0x([\da-f]+)/gi)].map(match=>parseInt(match[1],16));
 if(own.includes('UriPermission{')) assert.ok(persisted.length,'recognize the actual persisted-grant fields instead of passing vacuously');
 assert.ok(persisted.every(flags=>flags===0),'completed exports must not retain persistent read/write URI grants');
 await fs.writeFile(path.join(output,'xhs-android-uri-permissions.txt'),own||'No URI permission records for the isolated debug package.\n');
 report.uriPermissions={uid,persistedModeFlags:persisted};report.checks.push('completed SAF exports release persistent URI read/write grants');
 if(process.env.BRCLIO_XHS_LIVE_PYTHON==='1') {
   command('shell','svc','wifi','enable');command('shell','svc','data','enable');await delay(1500);
   try {
     const python=await evaluate("BrclioHost.xhsRequest('parse',{text:'https://ci.xiaohongshu.com/fixture-original?imageView2/format/jpg',engine:'python'})");
     assert.equal(python.success,true);assert.equal(python.engine,'python');assert.equal(python.images.length,1);
     report.publicPython={success:true,engine:python.engine,imageCount:python.images.length,authentication:'none',requestKind:'direct-image URL fixture'};
     report.checks.push('actual APK anonymously calls the fixed public Python endpoint with a direct-image fixture');
   } finally { command('shell','svc','wifi','disable');command('shell','svc','data','disable'); }
 }
 const apk=path.join(root,'android/app/build/outputs/apk/debug/app-debug.apk');const apkBytes=await fs.readFile(apk);report.apk={path:apk,bytes:apkBytes.length,sha256:require('node:crypto').createHash('sha256').update(apkBytes).digest('hex')};
 await screenshot('xhs-android-live.png');report.passed=true;
})().catch(error=>{report.error=error.stack;process.exitCode=1}).finally(async()=>{socket?.close();await fs.writeFile(path.join(output,'xhs-android-verification.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({passed:report.passed,checks:report.checks.length,...(report.error?{error:report.error.split('\n')[0]}:{})}));});
