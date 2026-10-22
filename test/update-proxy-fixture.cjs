'use strict';
// Offline-only fixture. Its public test credentials are never application files.
const fs=require('node:fs'),path=require('node:path'),https=require('node:https'),net=require('node:net'),tls=require('node:tls');
const {Readable}=require('node:stream');
const {once}=require('node:events');const WebSocket=require('ws');
const dir=path.join(__dirname,'fixtures/update-proxy-tls');
const ca=fs.readFileSync(path.join(dir,'ca.pem'));
const credential=name=>({key:fs.readFileSync(path.join(dir,name+'.key')),cert:fs.readFileSync(path.join(dir,name+'.pem'))});
const node={uuid:'12345678-1234-1234-1234-123456789abc',host:'relay.example.com',dialAddress:'1.1.1.1',port:443,path:'/tunnel',servername:'relay.example.com',wsHost:'relay.example.com'};
async function startRelay({body=Buffer.from('official fixture'),originCertificate='origin',trustOuter=true,redirect=false,slow=false,respond,http2=false,wsMessageBytes=0,wsFragmentBytes=0,wsPrefixBytes=0}={}){
 const sockets=new Set(),requests=[],destinations=[],responseTransports=new Map(),wsMessages=[],wsFrames=[],wsErrorCodes=[];let connections=0;
 const makeOrigin=http2?require('node:http2').createSecureServer:https.createServer;
 const origin=makeOrigin({...credential(originCertificate),...(http2?{allowHTTP1:true}:{})},(req,res)=>{
  const transport=responseTransports.get(req.socket.remotePort);if(transport)transport.responding=true;
  requests.push({method:req.method,url:req.url,range:req.headers.range,httpVersion:req.httpVersion});if(respond){respond(req,res);return;}res.writeHead(200,{'Content-Length':body.length});
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
    const transport={responding:false,prefix:0,chunks:[],bytes:0};
    upstream.once('connect',()=>{const port=upstream.localPort;responseTransports.set(port,transport);upstream.once('close',()=>responseTransports.delete(port));});
    const send=(bytes,callback)=>{
     wsMessages.push(bytes.length);
     const fragment=wsFragmentBytes||bytes.length;
     for(let offset=0;offset<bytes.length;offset+=fragment){const part=bytes.subarray(offset,offset+fragment),last=offset+part.length===bytes.length;wsFrames.push(part.length);ws.send(part,{binary:true,fin:last},last?callback:undefined);}
    };
    upstream.on('data',data=>{
     upstream.pause();
     if(!wsMessageBytes||!transport.responding||transport.prefix<wsPrefixBytes){if(transport.responding)transport.prefix+=data.length;send(data,()=>upstream.resume());return;}
     transport.chunks.push(data);transport.bytes+=data.length;
     if(transport.bytes>=wsMessageBytes){const bytes=Buffer.concat(transport.chunks,transport.bytes);transport.chunks=[];transport.bytes=0;send(bytes,()=>upstream.resume());}else upstream.resume();
    });
    upstream.on('end',()=>{if(transport.bytes)send(Buffer.concat(transport.chunks,transport.bytes),()=>ws.close());else ws.close();});
    ws.send(Buffer.from([0]),{binary:true});ws.send(Buffer.from([0]),{binary:true});
    ws.on('message',(data,isBinary)=>{if(!isBinary){ws.terminate();return;}if(!upstream.write(data)){ws.pause();upstream.once('drain',()=>ws.resume());}});
   });
  });
 }
 outer.listen(0,'127.0.0.1');await once(outer,'listening');
 class LocalWebSocket extends WebSocket{
  constructor(address,options){const u=new URL(address);u.port=String(outer.address().port);super(u,{...options,...(trustOuter?{ca}:{}),lookup:(_hostname,opts,callback)=>opts.all?callback(null,[{address:'127.0.0.1',family:4}]):callback(null,'127.0.0.1',4)});this.on('error',error=>{if(typeof error.code==='string'&&/^[A-Z0-9_]+$/.test(error.code))wsErrorCodes.push(error.code);});}
 }
 return{node:{...node},ca,body,requests,destinations,wsMessages,wsFrames,wsErrorCodes,WebSocketClass:LocalWebSocket,get connections(){return connections;},get activeWebSockets(){return wss?.clients.size||0;},async close(){for(const ws of wss?.clients||[])ws.terminate();for(const s of sockets)s.destroy();await Promise.all([new Promise(r=>origin.close(r)),new Promise(r=>outer.close(r))]);}};
}
async function connect(proxyRules,hostname='api.github.com',signal){
 const proxy=new URL(proxyRules);const socket=net.connect({host:proxy.hostname,port:Number(proxy.port)});socket.on('error',()=>{});
 if(signal?.aborted){socket.destroy();throw Object.assign(new Error('aborted'),{name:'AbortError'});}
 const abort=()=>socket.destroy(Object.assign(new Error('aborted'),{name:'AbortError'}));signal?.addEventListener('abort',abort,{once:true});socket.once('close',()=>signal?.removeEventListener('abort',abort));
 await once(socket,'connect');socket.write(`CONNECT ${hostname}:443 HTTP/1.1\r\nHost: ${hostname}:443\r\n\r\n`);
 await new Promise((resolve,reject)=>{let bytes=Buffer.alloc(0);const done=error=>{socket.removeListener('data',data);socket.removeListener('close',closed);socket.removeListener('error',done);error?reject(error):resolve();};const closed=()=>done(new Error('CONNECT closed'));const data=chunk=>{bytes=Buffer.concat([bytes,chunk]);const end=bytes.indexOf('\r\n\r\n');if(bytes.length>8192){done(new Error('CONNECT header too large'));return;}if(end<0)return;socket.pause();const header=bytes.subarray(0,end).toString('ascii');if(!header.startsWith('HTTP/1.1 200 ')){done(new Error('CONNECT denied'));return;}if(bytes.length>end+4)socket.unshift(bytes.subarray(end+4));done();};socket.on('data',data);socket.once('close',closed);socket.once('error',done);});
 return socket;
}
async function request(proxyRules,{hostname='api.github.com',servername=hostname,trust=ca,method='GET',signal,stream=false}={}){
 const agent=new https.Agent({keepAlive:false});
 let streaming=false;
 agent.createConnection=(_opts,callback)=>{connect(proxyRules,hostname,signal).then(socket=>{const secure=tls.connect({socket,servername,ca:trust,rejectUnauthorized:true});secure.on('error',()=>{});secure.once('secureConnect',()=>callback(null,secure));secure.once('error',error=>callback(error));},callback);};
 try{return await new Promise((resolve,reject)=>{const req=https.request({hostname,port:443,path:'/repos/Brclio/Brclio/releases/latest',method,agent,signal},res=>{if(stream){streaming=true;res.once('close',()=>agent.destroy());resolve(new Response(Readable.toWeb(res),{status:res.statusCode,headers:res.headers}));return;}const chunks=[];res.on('data',c=>chunks.push(c));res.once('error',reject);res.once('end',()=>resolve({status:res.statusCode,body:Buffer.concat(chunks)}));});req.once('error',reject);req.end();});}finally{if(!streaming)agent.destroy();}
}
module.exports={startRelay,request,connect,node,ca};
