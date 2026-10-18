'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto'),http=require('node:http');
const {createConnectBridge,parseProxyConfiguration,targetHost,VlessResponse,nodeLookup,publicIPv4}=require('./update-connect-bridge.cjs');
const {startRelay,request,node}=require('../test/update-proxy-fixture.cjs');
const config=()=>({version:1,ttlSeconds:600,nodes:[{...node}]});
test('node configuration permits only bounded explicit strict-TLS WSS settings',()=>{
 assert.equal(parseProxyConfiguration(config()).nodes[0].host,node.host);
 for(const mutate of [v=>v.nodes[0].host='127.0.0.1',v=>v.nodes[0].host='localhost',v=>v.nodes[0].servername='other.example.com',v=>v.nodes[0].wsHost='other.example.com',v=>v.nodes[0].port=80,v=>v.nodes[0].path='/bad\r\n',v=>v.nodes[0].path='//evil.example.com',v=>v.nodes[0].path='/%broken',v=>v.nodes[0].rejectUnauthorized=false,v=>v.ttlSeconds=601,v=>v.nodes=Array(17).fill(node)]){const v=config();mutate(v);assert.throws(()=>parseProxyConfiguration(v),/内置更新代理连接失败/);}
 for(const value of ['evil.invalid:443','github.com:80','github.com.:443','user@github.com:443','127.0.0.1:443','api.github.com:443/private'])assert.equal(targetHost(value),null);
 assert.equal(targetHost('API.GITHUB.COM:443'),'api.github.com');
});
test('dial addresses retain preferred public IPs while TLS authority stays DNS; special and DNS-rebound addresses are refused',async()=>{
 for(const ip of ['0.1.2.3','10.0.0.1','100.64.0.1','127.0.0.1','169.254.1.1','172.16.1.1','192.0.0.9','192.0.2.1','192.88.99.2','192.168.1.1','198.18.0.1','198.51.100.2','203.0.113.2','224.0.0.1','255.255.255.255','01.1.1.1','::1']){assert.equal(publicIPv4(ip),false);const v=config();v.nodes[0].dialAddress=ip;assert.throws(()=>parseProxyConfiguration(v));}
 for(const name of ['foo.local','foo.lan','foo.home','home.arpa','foo.home.arpa','LOCALHOST','relay.EXAMPLE.com']){const v=config();v.nodes[0].dialAddress=name;assert.throws(()=>parseProxyConfiguration(v));}
 for(const ip of ['1.1.1.1','172.64.1.1','198.41.1.1'])assert.equal(publicIPv4(ip),true);
 const lookup=nodeLookup({...node,dialAddress:'8.8.8.8'},(dial,options,callback)=>{assert.equal(dial,'8.8.8.8');assert.equal(options.family,4);callback(null,[{address:'8.8.8.8',family:4}],undefined);});
 const addresses=await new Promise((resolve,reject)=>lookup(node.host,{all:true},(error,value)=>error?reject(error):resolve(value)));assert.deepEqual(addresses,[{address:'8.8.8.8',family:4}]);
 const rebound=nodeLookup({...node,dialAddress:'relay.example.com'},(_dial,_options,callback)=>callback(null,'127.0.0.1',4));await assert.rejects(new Promise((resolve,reject)=>rebound(node.host,{},(error,value)=>error?reject(error):resolve(value))),/内置更新代理连接失败/);
});
test('VLESS response strips fragmented bounded addons and rejects invalid versions or truncated headers',async()=>{
 const parsed=new VlessResponse(),chunks=[];parsed.on('data',c=>chunks.push(c));parsed.write(Buffer.from([0]));parsed.write(Buffer.from([2,9]));parsed.end(Buffer.from([8,1,2,3]));await new Promise((resolve,reject)=>{parsed.on('end',resolve);parsed.on('error',reject);});assert.deepEqual(Buffer.concat(chunks),Buffer.from([1,2,3]));
 for(const data of [[1,0],[0],[0,2,1]]){const stream=new VlessResponse();stream.resume();const failure=new Promise(resolve=>stream.once('error',resolve));stream.end(Buffer.from(data));assert.match((await failure).message,/内置更新代理连接失败/);}
});
test('actual WSS CONNECT and native inner TLS transfer a continuous multi-megabyte official response',async t=>{
 const body=crypto.randomBytes(5*1024*1024+17),relay=await startRelay({body});t.after(()=>relay.close());
 const bridge=await createConnectBridge({nodes:[relay.node],WebSocketClass:relay.WebSocketClass});t.after(()=>bridge.close());
 assert.equal(new URL(bridge.proxyRules).hostname,'127.0.0.1');
 const result=await request(bridge.proxyRules);assert.equal(result.status,200);assert.equal(crypto.createHash('sha256').update(result.body).digest('hex'),crypto.createHash('sha256').update(body).digest('hex'));
 assert.deepEqual(relay.destinations,['api.github.com']);assert.equal(relay.requests[0].method,'GET');
});
test('untrusted WSS certificates and WSS redirects are rejected before any inner request',async t=>{
 for(const options of [{trustOuter:false},{redirect:true}]){const relay=await startRelay(options);t.after(()=>relay.close());const bridge=await createConnectBridge({nodes:[relay.node],WebSocketClass:relay.WebSocketClass});t.after(()=>bridge.close());await assert.rejects(request(bridge.proxyRules));assert.equal(relay.requests.length,0);assert.equal(relay.destinations.length,0);}
});
test('WSS SNI verification rejects a trusted certificate for a different node hostname',async t=>{
 const relay=await startRelay();t.after(()=>relay.close());const wrong={...relay.node,host:'other.example.com',servername:'other.example.com',wsHost:'other.example.com'};
 const bridge=await createConnectBridge({nodes:[wrong],WebSocketClass:relay.WebSocketClass});t.after(()=>bridge.close());await assert.rejects(request(bridge.proxyRules));assert.equal(relay.connections,0);assert.equal(relay.requests.length,0);
});
test('native inner TLS rejects a trusted certificate with the wrong official hostname',async t=>{
 const relay=await startRelay({originCertificate:'relay'});t.after(()=>relay.close());const bridge=await createConnectBridge({nodes:[relay.node],WebSocketClass:relay.WebSocketClass});t.after(()=>bridge.close());await assert.rejects(request(bridge.proxyRules),error=>/CERT_ALTNAME_INVALID/.test(error.code));assert.equal(relay.requests.length,0);
});
test('listener rejects nonofficial CONNECT and ordinary HTTP without opening a node',async t=>{
 const relay=await startRelay();t.after(()=>relay.close());const bridge=await createConnectBridge({nodes:[relay.node],WebSocketClass:relay.WebSocketClass});t.after(()=>bridge.close());await assert.rejects(request(bridge.proxyRules,{hostname:'evil.invalid'}),/CONNECT denied/);
 const url=new URL(bridge.proxyRules);const status=await new Promise((resolve,reject)=>{http.get({hostname:url.hostname,port:url.port,path:'http://github.com/'},res=>{res.resume();resolve(res.statusCode);}).on('error',reject);});assert.equal(status,403);assert.equal(relay.connections,0);
});
test('abort and explicit cleanup close active WSS sockets and stop the continuous response',async t=>{
 const relay=await startRelay({body:Buffer.alloc(1024*1024),slow:true});t.after(()=>relay.close());const bridge=await createConnectBridge({nodes:[relay.node],WebSocketClass:relay.WebSocketClass});t.after(()=>bridge.close());const controller=new AbortController();const pending=request(bridge.proxyRules,{signal:controller.signal});setTimeout(()=>controller.abort(),50);await assert.rejects(pending);await bridge.close();await bridge.close();await new Promise(resolve=>setTimeout(resolve,30));assert.equal(relay.activeWebSockets,0);await assert.rejects(request(bridge.proxyRules));
});
