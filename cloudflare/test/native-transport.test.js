import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import tls from 'node:tls';
import {nativeHTTPSRequest,selectNativeNodes,probeURL} from '../scripts/native-transport.mjs';
let dir,cert,server,proxy,bridge;const sockets=new Set();
before(async()=>{
  dir=await mkdtemp(join(tmpdir(),'brclio-native-gate-test-'));
  execFileSync('openssl',['req','-x509','-newkey','ec','-pkeyopt','ec_paramgen_curve:P-256','-nodes','-keyout',join(dir,'key.pem'),'-out',join(dir,'cert.pem'),'-days','1','-sha256','-subj','/CN=github.com','-addext','subjectAltName=DNS:github.com','-addext','extendedKeyUsage=serverAuth','-addext','keyUsage=digitalSignature,keyCertSign','-addext','basicConstraints=critical,CA:TRUE'],{stdio:'ignore'});
  cert=await readFile(join(dir,'cert.pem'),'utf8');const key=await readFile(join(dir,'key.pem'),'utf8');
  server=tls.createServer({cert,key,minVersion:'TLSv1.2'},socket=>socket.once('data',()=>socket.end('HTTP/1.1 200 OK\r\nContent-Length: 5\r\nConnection: close\r\n\r\nhello')));server.on('tlsClientError',()=>{});
  server.on('connection',socket=>{sockets.add(socket);socket.once('close',()=>sockets.delete(socket));});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  proxy=http.createServer();proxy.on('connection',socket=>{sockets.add(socket);socket.on('error',()=>{});socket.once('close',()=>sockets.delete(socket));});
  proxy.on('connect',(_request,client,head)=>{const upstream=net.connect(server.address().port,'127.0.0.1');upstream.on('error',()=>client.destroy());client.once('close',()=>upstream.destroy());upstream.once('connect',()=>{client.write('HTTP/1.1 200 Connection Established\r\n\r\n');if(head.length)upstream.write(head);client.pipe(upstream).pipe(client);});});
  await new Promise(resolve=>proxy.listen(0,'127.0.0.1',resolve));bridge={proxyRules:`http://127.0.0.1:${proxy.address().port}`};
});
after(async()=>{for(const socket of sockets)socket.destroy();await Promise.all([new Promise(resolve=>proxy.close(resolve)),new Promise(resolve=>server.close(resolve))]);await rm(dir,{recursive:true,force:true});});
test('production native HTTPS adapter encrypts through CONNECT and verifies the true target hostname',async()=>{
  const response=await nativeHTTPSRequest('https://github.com/Brclio/Brclio/releases/latest',{bridge,signal:AbortSignal.timeout(3000),testCA:cert});assert.equal(response.status,200);assert.equal(await response.text(),'hello');
  await assert.rejects(()=>nativeHTTPSRequest('https://api.github.com/',{bridge,signal:AbortSignal.timeout(3000),testCA:cert}));
  await assert.rejects(()=>nativeHTTPSRequest('https://github.com/',{bridge,signal:AbortSignal.timeout(3000)}));
  await assert.rejects(()=>nativeHTTPSRequest('https://private.example/',{bridge,signal:AbortSignal.timeout(3000),testCA:cert}),/failed/);
});
test('native selection probes all16 candidates once and selects lowest successful end-to-end HTTPS latency',async()=>{
  const nodes=Array.from({length:16},(_,index)=>({index})),seen=[];let closed=0;
  const result=await selectNativeNodes(nodes,AbortSignal.timeout(1000),{now:()=>0,bridgeFactory:async({nodes})=>({node:nodes[0],close:async()=>{closed++;}}),request:async(target,{bridge,method,signal,headers})=>{seen.push(bridge.node.index);assert.equal(target,probeURL);assert.equal(method,'HEAD');assert.equal(signal.aborted,false);assert.equal(headers['User-Agent'],'Brclio-Updater/1.0');return new Response(null,{status:bridge.node.index===0?403:200});}});
  assert.equal(seen.length,16);assert.equal(closed,16);assert.equal(result.nodes.length,15);assert.equal(result.nodes[0].index,1);assert.equal(result.candidates,16);assert.equal(result.reachable,15);
  let stamp=0;const ordered=await selectNativeNodes([nodes[0],nodes[1]],AbortSignal.timeout(1000),{now:()=>stamp++,bridgeFactory:async({nodes})=>({node:nodes[0],close:async()=>{}}),request:async(_target,{bridge})=>{if(!bridge.node.index)await new Promise(resolve=>setTimeout(resolve,5));return new Response(null,{status:200});}});assert.equal(ordered.nodes[0].index,1);
});
