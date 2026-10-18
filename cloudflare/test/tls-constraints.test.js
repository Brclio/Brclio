import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';import {join} from 'node:path';
import {execFileSync} from 'node:child_process';import net from 'node:net';import tls from 'node:tls';
import {SocketReadQueue} from 'subtls/index.js';
import {startVerifiedTls,validateCertificateExtensions} from '../src/verified-tls.js';
let dir,root;
const run=(...args)=>execFileSync('openssl',args,{cwd:dir,stdio:'ignore'});
before(async()=>{
 dir=await mkdtemp(join(tmpdir(),'brclio-tls-constraints-'));
 run('req','-x509','-newkey','rsa:2048','-nodes','-keyout','root.key','-out','root.pem','-days','2','-sha256','-subj','/CN=Local-Test-Root','-addext','keyUsage=critical,digitalSignature,keyCertSign','-addext','basicConstraints=critical,CA:TRUE');
 root=await readFile(join(dir,'root.pem'),'utf8');
 for(const [name,extra,keyUsage] of [['constrained','nameConstraints=critical,permitted;DNS:allowed.example\n','digitalSignature,keyCertSign'],['noncritical-constraints','nameConstraints=permitted;DNS:allowed.example\n','digitalSignature,keyCertSign'],['no-cert-sign','','digitalSignature'],['client-only','extendedKeyUsage=clientAuth\n','digitalSignature,keyCertSign'],['standard-ca','','keyCertSign,cRLSign']]){
  run('req','-newkey','rsa:2048','-nodes','-keyout',name+'.key','-out',name+'.csr','-subj','/CN=Local-Intermediate');
  await writeFile(join(dir,name+'.ext'),'basicConstraints=critical,CA:TRUE,pathlen:0\nkeyUsage=critical,'+keyUsage+'\nsubjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid,issuer\n'+extra);
  run('x509','-req','-in',name+'.csr','-CA','root.pem','-CAkey','root.key','-CAcreateserial','-out',name+'.pem','-days','2','-sha256','-extfile',name+'.ext');
  await leaf(name,name,'');
 }
 await leaf('unknown-critical','root','1.2.3.4=critical,DER:05:00\n');
 await leaf('unknown-noncritical','root','1.2.3.4=DER:05:00\n');
 await leaf('no-digital-signature','root','', 'keyEncipherment');
});
async function leaf(name,issuer,extra,keyUsage='digitalSignature'){
 run('req','-newkey','rsa:2048','-nodes','-keyout',name+'-leaf.key','-out',name+'-leaf.csr','-subj','/CN=localhost');
 await writeFile(join(dir,name+'-leaf.ext'),'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,'+keyUsage+'\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:localhost\nsubjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid,issuer\n'+extra);
 run('x509','-req','-in',name+'-leaf.csr','-CA',issuer+'.pem','-CAkey',issuer+'.key','-CAcreateserial','-out',name+'-leaf.pem','-days','2','-sha256','-extfile',name+'-leaf.ext');
}
after(()=>rm(dir,{recursive:true,force:true}));
async function connect(name,intermediate=true){
 const cert=await readFile(join(dir,name+'-leaf.pem'),'utf8')+(intermediate?await readFile(join(dir,name+'.pem'),'utf8'):'');
 const key=await readFile(join(dir,name+'-leaf.key'),'utf8');
 const server=tls.createServer({cert,key,minVersion:'TLSv1.3',maxVersion:'TLSv1.3',ciphers:'TLS_AES_128_GCM_SHA256'},socket=>socket.end('verified'));
 server.on('tlsClientError',()=>{});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const socket=net.connect(server.address().port,'127.0.0.1');socket.on('error',()=>{});await new Promise((resolve,reject)=>{socket.once('connect',resolve);socket.once('error',reject);});
 const queue=new SocketReadQueue(socket);
 try{const connection=await startVerifiedTls('localhost',root,queue.read.bind(queue),bytes=>socket.write(bytes));return new TextDecoder().decode(await connection.read());}
 finally{socket.destroy();await new Promise(resolve=>server.close(resolve));}
}
test('actual TLS handshake rejects a trusted intermediate with unsupported name constraints',async()=>{
 await assert.rejects(connect('constrained'),/name constraints/i);
 await assert.rejects(connect('noncritical-constraints'),/name constraints/i);
});
test('actual TLS handshake rejects an unknown critical certificate extension',async()=>{
 await assert.rejects(connect('unknown-critical',false),/critical certificate extension/i);
});
test('actual TLS handshake rejects a CA whose key usage cannot sign certificates',async()=>{
 await assert.rejects(connect('no-cert-sign'),/cannot sign certificates/i);
});
test('actual TLS handshake rejects a CA restricted to client authentication',async()=>{
 await assert.rejects(connect('client-only'),/does not permit TLS server authentication/i);
});
test('actual TLS handshake accepts a standard CA with certificate-signing usage and no digitalSignature bit',async()=>{
 assert.equal(await connect('standard-ca'),'verified');
});
test('actual TLS handshake rejects a server leaf whose key usage cannot make digital signatures',async()=>{
 await assert.rejects(connect('no-digital-signature',false),/cannot make digital signatures/i);
});
test('actual TLS handshake permits unrelated noncritical extensions after normal chain validation',async()=>{
 assert.equal(await connect('unknown-noncritical',false),'verified');
});
test('certificate extension guard rejects malformed DER instead of skipping an unknown shape',()=>{
 for(const bytes of [new Uint8Array(),new Uint8Array([48,128,0,0]),new Uint8Array([48,3,48,2,1])])assert.throws(()=>validateCertificateExtensions(bytes));
});
