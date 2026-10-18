'use strict';
// Offline-only fixture. Its public test credentials are never application files.
const fs=require('node:fs'),path=require('node:path'),https=require('node:https'),net=require('node:net'),tls=require('node:tls');
const {once}=require('node:events');const WebSocket=require('ws');
const dir=path.join(__dirname,'fixtures/update-proxy-tls');
const ca=fs.readFileSync(path.join(dir,'ca.pem'));
const credential=name=>({key:fs.readFileSync(path.join(dir,name+'.key')),cert:fs.readFileSync(path.join(dir,name+'.pem'))});
const node={uuid:'12345678-1234-1234-1234-123456789abc',host:'relay.example.com',dialAddress:'1.1.1.1',port:443,path:'/tunnel',servername:'relay.example.com',wsHost:'relay.example.com'};
async function startRelay({body=Buffer.from('official fixture'),originCertificate='origin',trustOuter=true,redirect=false,slow=false,respond}={}){
 const sockets=new Set(),requests=[],destinations=[];let connections=0;
 const origin=https.createServer(credential(originCertificate),(req,res)=>{
  requests.push({method:req.method,url:req.url,range:req.headers.range});if(respond){respond(req,res);return;}res.writeHead(200,{'Content-Length':body.length});
  if(req.method==='HEAD'){res.end();return;}
  if(!slow){res.end(body);return;}
  let offset=0;const timer=setInterval(()=>{if(offset>=body.length){clearInterval(timer);res.end();return;}res.write(body.subarray(offset,offset+1024));offset+=1024;},5);res.on('close',()=>clearInterval(timer));
 });
 origin.on('connection',s=>{sockets.add(s);s.on('error',()=>{});s.once('close',()=>sockets.delete(s));});origin.on('tlsClientError',()=>{});origin.listen(0,'127.0.0.1');await once(origin,'listening');
 const outer=https.createServer(credential('relay'));outer.on('tlsClientError',()=>{});outer.on('connection',s=>{sockets.add(s);s.on('error',()=>{});s.once('close',()=>sockets.delete(s));});
 let wss;
 if(redirect)outer.on('upgrade',(_req,s)=>{connections++;s.end('HTTP/1.1 302 Found\r\nLocation: https://evil.invalid/private\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');});
 else{
  wss=new WebSocket.Server({server:outer,perMessageDeflate:false});
  wss.on('connection',ws=>{
   connections++;let upstream;
   ws.on('error',()=>{});ws.once('close',()=>upstream?.destroy());
   ws.once('message',(header,binary)=>{
    if(!binary||header.length<23||header[0]!==0||header.subarray(1,17).toString('hex')!==node.uuid.replaceAll('-','')||header[17]!==0||header[18]!==1||header.readUInt16BE(19)!==443||header[21]!==2||header.length!==23+header[22]){ws.terminate();return;}
    destinations.push(header.subarray(23).toString('ascii'));
    upstream=net.connect({host:'127.0.0.1',port:origin.address().port});upstream.on('error',()=>ws.terminate());
    upstream.on('data',data=>{upstream.pause();ws.send(data,{binary:true},()=>upstream.resume());});upstream.on('end',()=>ws.close());
    ws.send(Buffer.from([0]),{binary:true});ws.send(Buffer.from([0]),{binary:true});
    ws.on('message',(data,isBinary)=>{if(!isBinary){ws.terminate();return;}if(!upstream.write(data)){ws.pause();upstream.once('drain',()=>ws.resume());}});
   });
  });
 }
 outer.listen(0,'127.0.0.1');await once(outer,'listening');
 class LocalWebSocket extends WebSocket{
  constructor(address,options){const u=new URL(address);u.port=String(outer.address().port);super(u,{...options,...(trustOuter?{ca}:{}),lookup:(_hostname,opts,callback)=>opts.all?callback(null,[{address:'127.0.0.1',family:4}]):callback(null,'127.0.0.1',4)});}
 }
 return{node:{...node},ca,body,requests,destinations,WebSocketClass:LocalWebSocket,get connections(){return connections;},get activeWebSockets(){return wss?.clients.size||0;},async close(){for(const ws of wss?.clients||[])ws.terminate();for(const s of sockets)s.destroy();await Promise.all([new Promise(r=>origin.close(r)),new Promise(r=>outer.close(r))]);}};
}
async function connect(proxyRules,hostname='api.github.com',signal){
 const proxy=new URL(proxyRules);const socket=net.connect({host:proxy.hostname,port:Number(proxy.port)});socket.on('error',()=>{});
 if(signal?.aborted){socket.destroy();throw Object.assign(new Error('aborted'),{name:'AbortError'});}
 const abort=()=>socket.destroy(Object.assign(new Error('aborted'),{name:'AbortError'}));signal?.addEventListener('abort',abort,{once:true});socket.once('close',()=>signal?.removeEventListener('abort',abort));
 await once(socket,'connect');socket.write(`CONNECT ${hostname}:443 HTTP/1.1\r\nHost: ${hostname}:443\r\n\r\n`);
 await new Promise((resolve,reject)=>{let bytes=Buffer.alloc(0);const done=error=>{socket.removeListener('data',data);socket.removeListener('close',closed);socket.removeListener('error',done);error?reject(error):resolve();};const closed=()=>done(new Error('CONNECT closed'));const data=chunk=>{bytes=Buffer.concat([bytes,chunk]);const end=bytes.indexOf('\r\n\r\n');if(bytes.length>8192){done(new Error('CONNECT header too large'));return;}if(end<0)return;socket.pause();const header=bytes.subarray(0,end).toString('ascii');if(!header.startsWith('HTTP/1.1 200 ')){done(new Error('CONNECT denied'));return;}if(bytes.length>end+4)socket.unshift(bytes.subarray(end+4));done();};socket.on('data',data);socket.once('close',closed);socket.once('error',done);});
 return socket;
}
async function request(proxyRules,{hostname='api.github.com',servername=hostname,trust=ca,method='GET',signal}={}){
 const agent=new https.Agent({keepAlive:false});
 agent.createConnection=(_opts,callback)=>{connect(proxyRules,hostname,signal).then(socket=>{const secure=tls.connect({socket,servername,ca:trust,rejectUnauthorized:true});secure.on('error',()=>{});secure.once('secureConnect',()=>callback(null,secure));secure.once('error',error=>callback(error));},callback);};
 try{return await new Promise((resolve,reject)=>{const req=https.request({hostname,port:443,path:'/repos/Brclio/Brclio/releases/latest',method,agent,signal},res=>{const chunks=[];res.on('data',c=>chunks.push(c));res.once('error',reject);res.once('end',()=>resolve({status:res.statusCode,body:Buffer.concat(chunks)}));});req.once('error',reject);req.end();});}finally{agent.destroy();}
}
module.exports={startRelay,request,connect,node,ca};
