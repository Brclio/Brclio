import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {fileURLToPath} from 'node:url';

test('actual workerd streams a fixed-length segmented installer response',async()=>{
  const total=8*1024*1024+37;
  const built=await build({stdin:{contents:`
    import {relayUpdate,SEGMENT_BYTES} from './src/relay.js';
    const total=${total};
    export default {async fetch(request,env,ctx){const response=await relayUpdate('https://github.com/Brclio/Brclio/releases/download/v1/test.exe',[{}],{waitUntil:p=>ctx.waitUntil(p),transport:async(target,node,{range})=>{
      if(target.hostname==='github.com')return {status:302,headers:new Headers({location:'https://release-assets.githubusercontent.com/github-production-release-asset/123/abcdef?signature=test'}),body:new Response('').body,close(){}};
      const start=Number(/bytes=(\\d+)/.exec(range)[1]),end=Math.min(total-1,start+SEGMENT_BYTES-1);let left=end-start+1;
      const body=new ReadableStream({pull(c){if(!left){c.close();return;}const n=Math.min(16384,left);left-=n;c.enqueue(new Uint8Array(n).fill(7));}});
      return {status:206,headers:new Headers({'content-range':'bytes '+start+'-'+end+'/'+total,'content-length':String(end-start+1),etag:'same','content-type':'application/octet-stream'}),body,close(){}};
    }});return response;}};`,resolveDir:fileURLToPath(new URL('..',import.meta.url)),sourcefile:'runtime-stream-fixture.js'},bundle:true,write:false,format:'esm',platform:'browser',external:['crypto']});
  const mf=new Miniflare(convertV4MiniflareOptions({modules:true,compatibilityDate:'2026-10-18',compatibilityFlags:['nodejs_compat','global_fetch_strictly_public'],script:built.outputFiles[0].text}));
  try{const response=await fetch(await mf.ready);assert.equal(response.status,200);assert.equal(response.headers.get('content-length'),String(total));const bytes=new Uint8Array(await response.arrayBuffer());assert.equal(bytes.length,total);assert.equal(bytes[0],7);assert.equal(bytes.at(-1),7);}finally{await mf.dispose();}
});
