import {test} from 'node:test';
import assert from 'node:assert/strict';
import {officialTarget,redirectTarget,publicHTTPS,parseSubscription,vlessHeader,ByteReader,readHTTPHead,httpBody,encoder} from '../src/protocol.js';
import {SocketQueue} from '../src/tunnel.js';

const uuid='00112233-4455-6677-8899-aabbccddeeff';
const node={type:'vless',uuid,server:'104.17.1.1',port:443,tls:true,network:'ws',servername:'vpn.example.com','ws-opts':{path:'/tunnel?ed=2048',headers:{Host:'vpn.example.com'}}};
test('only official Brclio latest metadata and release assets are public targets',()=>{
  for(const u of ['https://api.github.com/repos/Brclio/Brclio/releases/latest','https://github.com/Brclio/Brclio/releases/download/v0.1.9/Brclio.dmg'])assert.ok(officialTarget(u));
  for(const u of ['https://api.github.com/repos/attacker/app/releases/latest','https://github.com/attacker/app/releases/download/v1/a.exe','https://github.com/Brclio/Brclio/releases/download/v1/a%2fb.exe','https://release-assets.githubusercontent.com/github-production-release-asset/1/id?a=b','https://api.github.com/repos/Brclio/Brclio/releases/latest?x=y','https://evil.example/a','http://github.com/Brclio/Brclio/releases/latest'])assert.throws(()=>officialTarget(u),u);
});
test('asset redirects are only accepted from official GitHub to signed asset storage',()=>{
  const previous='https://github.com/Brclio/Brclio/releases/download/v1/a.exe';
  assert.equal(redirectTarget('https://release-assets.githubusercontent.com/github-production-release-asset/123/abcd-ef?signature=abc',previous).hostname,'release-assets.githubusercontent.com');
  for(const host of ['https://evil.example/a','https://github.com/attacker/app/releases/download/v1/a.exe','https://release-assets.githubusercontent.com/arbitrary'])assert.throws(()=>redirectTarget(host,previous));
  assert.throws(()=>redirectTarget('https://release-assets.githubusercontent.com/github-production-release-asset/1/id','https://api.github.com/repos/Brclio/Brclio/releases/latest'));
});
test('subscription preserves VLESS data, deduplicates route IP hints, and rejects incompatible transport',()=>{
  const nodes=parseSubscription(JSON.stringify({proxies:[node,{...node,server:'104.17.2.2'},{...node,port:2087},{...node,type:'trojan'},{...node,tls:false},{...node,flow:'xtls-rprx-vision'}]}));
  assert.deepEqual(nodes,[{uuid,host:'vpn.example.com',port:443,path:'/tunnel?ed=2048'},{uuid,host:'vpn.example.com',port:2087,path:'/tunnel?ed=2048'}]);
  assert.throws(()=>parseSubscription(JSON.stringify({proxies:[{...node,servername:'other.example.com'}]})));
  assert.throws(()=>parseSubscription('x'.repeat(1024*1024+1)));
  assert.throws(()=>parseSubscription('proxies: []'));
});
test('VLESS TCP request encodes version, UUID, port and domain exactly',()=>{
  assert.equal(Buffer.from(vlessHeader(uuid,'github.com')).toString('hex'),'0000112233445566778899aabbccddeeff000101bb020a6769746875622e636f6d');
});
function readerFor(text, split=3){const bytes=encoder.encode(text);let offset=0;return new ByteReader(async()=>{if(offset>=bytes.length)return undefined;const chunk=bytes.slice(offset,offset+split);offset+=chunk.length;return chunk;});}
test('HTTP parser handles fragmented headers, chunked payload and trailers',async()=>{
  const reader=readerFor('HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nContent-Type: text/plain\r\n\r\n5\r\nhello\r\n6;ext=yes\r\n world\r\n0\r\nX-Trailer: yes\r\n\r\n');
  const head=await readHTTPHead(reader);let closed=false;
  assert.equal(await new Response(httpBody(reader,head.headers,()=>closed=true)).text(),'hello world');assert.equal(closed,true);
});
test('HTTP parser rejects ambiguous lengths and truncated downloads',async()=>{
  await assert.rejects(()=>readHTTPHead(readerFor('HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nContent-Length: 1\r\n\r\n')));
  const reader=readerFor('HTTP/1.1 200 OK\r\nContent-Length: 6\r\n\r\nshort');const head=await readHTTPHead(reader);
  await assert.rejects(()=>new Response(httpBody(reader,head.headers,()=>{})).text(),/未完成/);
});
test('TLS socket reader supports peek and bounds unread WebSocket data',async()=>{
  const socket=new EventTarget();socket.close=()=>{};
  const queue=new SocketQueue(socket,{idleMs:1000,maxQueued:5});
  const event=new Event('message');event.data=new Uint8Array([1,2,3]).buffer;socket.dispatchEvent(event);
  assert.deepEqual([...await queue.read(2,1)],[1,2]);assert.deepEqual([...await queue.read(3)],[1,2,3]);
  const oversized=new Event('message');oversized.data=new Uint8Array(6).buffer;socket.dispatchEvent(oversized);
  await assert.rejects(()=>queue.read(1),/缓冲/);queue.close();
});
test('subscription links must be HTTPS public hostnames',()=>{
  assert.equal(publicHTTPS('https://subscription.example/sub?token=abc').hostname,'subscription.example');
  for(const url of ['http://host.example/sub','https://127.0.0.1/x','https://10.0.0.1/x','https://[::1]/x','https://user:password@host.example/x','https://localhost/x'])assert.throws(()=>publicHTTPS(url));
});
test('first actual TLS client frame coalesces VLESS request and ClientHello',async()=>{
  const {tunnelRequest}=await import('../src/tunnel.js');
  const sends=[];
  await assert.rejects(()=>tunnelRequest(new URL('https://github.com/Brclio/Brclio/releases/download/v1/a.exe'),{uuid,host:'vpn.example.com',port:443,path:'/tunnel'}, {openSocket:async()=>({socket:{send:data=>sends.push(new Uint8Array(data))},queue:{read:async()=>undefined,close(){},fail(){}}})}));
  assert.equal(sends.length,1);
  const header=vlessHeader(uuid,'github.com');assert.deepEqual(sends[0].slice(0,header.length),header);assert.deepEqual([...sends[0].slice(header.length,header.length+3)],[0x16,0x03,0x01]);
});
