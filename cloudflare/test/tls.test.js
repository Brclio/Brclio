import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import net from 'node:net';
import tls from 'node:tls';
import {SocketReadQueue} from 'subtls/index.js';
import {startVerifiedTls as startTls} from '../src/verified-tls.js';
import {rootCerts} from '../src/roots.js';
let dir,cert,key,server,port;
before(async()=>{
  dir=await mkdtemp(join(tmpdir(),'brclio-tls-cert-test-'));
  // A disposable local-only key is created at test time; no private key is checked in.
  execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',join(dir,'key.pem'),'-out',join(dir,'cert.pem'),'-days','30','-sha256','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost','-addext','keyUsage=digitalSignature,keyCertSign','-addext','extendedKeyUsage=serverAuth','-addext','basicConstraints=critical,CA:TRUE'],{stdio:'ignore'});
  cert=await readFile(join(dir,'cert.pem'),'utf8');key=await readFile(join(dir,'key.pem'),'utf8');
  server=tls.createServer({cert,key,minVersion:'TLSv1.3',maxVersion:'TLSv1.3',ciphers:'TLS_AES_128_GCM_SHA256'},socket=>{socket.end('verified');});
  server.on('tlsClientError',()=>{});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));port=server.address().port;
});
after(async()=>{await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true});});
async function connect(host,roots){
  const socket=net.connect(port,'127.0.0.1');const queue=new SocketReadQueue(socket);
  socket.on('error',()=>{});await new Promise((resolve,reject)=>{socket.once('connect',resolve);socket.once('error',reject);});
  try{return await startTls(host,roots,queue.read.bind(queue),bytes=>socket.write(bytes));}catch(e){socket.destroy();throw e;}
}
test('TLS client verifies the actual server chain and reads encrypted application data',async()=>{
  const connection=await connect('localhost',cert);const bytes=await connection.read();assert.equal(new TextDecoder().decode(bytes),'verified');
});
test('TLS client rejects a correctly signed certificate for the wrong hostname',async()=>{
  await assert.rejects(()=>connect('different.example',cert),/host|subject|name|match/i);
});
test('TLS client rejects an untrusted local CA against bundled Mozilla roots',async()=>{
  await assert.rejects(()=>connect('localhost',rootCerts),/trust|root|issuer|certificate/i);
});
test('TLS client rejects a certificate outside its validity period',async t=>{
  t.mock.timers.enable({apis:['Date'],now:Date.now()+60*24*60*60*1000});
  try{await assert.rejects(()=>connect('localhost',cert),/valid|expir|date/i);}finally{t.mock.timers.reset();}
});
