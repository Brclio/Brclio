import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {fileURLToPath} from 'node:url';

test('actual workerd accepts fetch options and binary WebSocket frames',async()=>{
  const bundled=await build({stdin:{contents:`
    import {readConfig,readSubscription} from './src/config.js';
    import {SocketQueue} from './src/tunnel.js';
    const env={GITHUB_DATA_REPOSITORY:'owner/users',GITHUB_PROGRAM_DATA_REPOSITORY:'owner/program',PROXY_SUBSCRIPTION_URL:'https://subscription.example/sub'};
    const text=JSON.stringify({proxies:[{type:'vless',uuid:'00112233-4455-6677-8899-aabbccddeeff',tls:true,network:'ws',servername:'vpn.example.com',port:443,'ws-opts':{path:'/tunnel',headers:{Host:'vpn.example.com'}}}]});
    export default {async fetch(){
      const modes=[];
      const mock=async(url,options)=>{const request=new Request(url,options);modes.push(request.redirect);return request.url.startsWith('https://api.github.com/')?new Response('',{status:404}):new Response(text);};
      const config=await readConfig(env,{fresh:true,fetchImpl:mock,tokenProvider:async()=> 'fixture-installation-token'});const nodes=await readSubscription(config.subscriptionUrl,mock);
      const [client,server]=Object.values(new WebSocketPair());client.accept();
      const queue=new SocketQueue(server);server.accept();client.send(new Uint8Array([1,2,3]));
      const bytes=await queue.read(3);const binaryType=server.binaryType;queue.close();client.close();
      return Response.json({modes,nodes:nodes.length,binaryType,bytes:[...bytes]});
    }};`,resolveDir:fileURLToPath(new URL('..',import.meta.url)),sourcefile:'runtime-fixture.js'},bundle:true,write:false,format:'esm',platform:'browser',external:['crypto']});
  const mf=new Miniflare(convertV4MiniflareOptions({modules:true,compatibilityDate:'2026-10-18',compatibilityFlags:['nodejs_compat','global_fetch_strictly_public'],script:bundled.outputFiles[0].text}));
  try{const response=await mf.dispatchFetch('https://runtime-test.example/');assert.equal(response.status,200);assert.deepEqual(await response.json(),{modes:['manual','manual'],nodes:1,binaryType:'arraybuffer',bytes:[1,2,3]});}finally{await mf.dispose();}
});
