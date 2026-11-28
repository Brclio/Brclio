'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const {once} = require('node:events');
const {execFile,spawn} = require('node:child_process');
const run = require('node:util').promisify(execFile);
const pq = require('./terminal/post-quantum.cjs');
const ssh = require('./terminal/remote-launch.cjs');
const forwards = require('./terminal/forward-model.js');
const connections = require('./terminal/connection.js');
const sync = require('./terminal/sync-model.js');
const target = {host:'127.0.0.1',requirePostQuantum:true};
const rule = {name:'test',type:'dynamic',connection:target,listenPort:4500};

test('strict KEX only permits exact recognized hybrids, blocks multiplex reuse, and fails closed when unsupported',() => {
  const pretend = output => () => ({status:0,stdout:output});
  assert.deepEqual(pq.supported('x-mlkem768x25519-sha256\ncurve25519-sha256\nsntrup761x25519-sha512@openssh.com\n'),
    ['sntrup761x25519-sha512@openssh.com']);
  assert.throws(() => pq.required('fixture',pretend('curve25519-sha256')),/后量子/);
  assert.throws(() => pq.required('fixture',() => ({status:255})),/未建立连接/);
  const args = pq.required('fixture',pretend('mlkem768x25519-sha256\ncurve25519-sha256'));
  assert.deepEqual(args,['-o','KexAlgorithms=mlkem768x25519-sha256','-o','ControlMaster=no','-o','ControlPath=none']);
  assert.throws(() => connections.endpoint({host:'example',requirePostQuantum:'yes'}),/无效/);
  assert.deepEqual(ssh.argumentsFor('ssh',{host:'example'}),['-a','--','example']);
});
test('native probes and SSH, CLI SFTP, graphical subsystem and forwarding arguments use the same available hybrids',async t => {
  const file = ssh.program('ssh');
  if (!file) return t.skip('System OpenSSH client is unavailable.');
  const {algorithms} = await pq.capabilities(file);
  t.diagnostic('Local ssh -Q kex reports: ' + (algorithms.join(', ') || 'no supported hybrid KEX'));
  const calls = [() => ssh.argumentsFor('ssh',target,true,{file}), () => ssh.argumentsFor('sftp',target,false),
    () => ssh.argumentsFor('ssh',target,false,{file}), () => forwards.argumentsFor(rule,{file})];
  if (!algorithms.length) { for (const call of calls) assert.throws(call,/后量子/);return; }
  for (const call of calls) {
    const args = call();
    assert.ok(args.includes('KexAlgorithms='+algorithms.join(',')));
    assert.ok(args.includes('ControlPath=none'));
  }
  const sftp = calls[1](); assert.equal(sftp[sftp.indexOf('-S')+1],file);
  // ssh -G evaluates the effective policy without opening sockets.
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(),'brclio-pq-config-'));
  t.after(() => fs.rm(scratch,{recursive:true,force:true}));
  const config = path.join(scratch,'empty_config'); await fs.writeFile(config,'');
  const {stdout} = await run(file,['-G','-F',config,...calls[0]()],{encoding:'utf8',timeout:3000});
  assert.ok(stdout.split(/\r?\n/).includes('kexalgorithms '+algorithms.join(',')));
});
test('saved tunnels follow the explicitly selected matching host and local policy survives a same-endpoint sync',() => {
  const values = new Map(), storage = {getItem:k => values.get(k) || null,setItem:(k,v) => values.set(k,v),removeItem:k => values.delete(k)};
  const hosts = connections.store(storage), tunnels = forwards.store(storage);
  hosts.save({name:'fixture',...target});hosts.save({name:'duplicate',host:target.host});
  const chosen = {...rule,kexHostName:'fixture',connection:{host:target.host}};
  tunnels.save(chosen);
  assert.equal(forwards.forLaunch(chosen,hosts).connection.requirePostQuantum,true);
  assert.equal(forwards.forLaunch({...chosen,kexHostName:'duplicate'},hosts).connection.requirePostQuantum,undefined);
  const client = sync.localLibraries(storage), next = client.read();
  assert.ok(!JSON.stringify(next).includes('requirePostQuantum'));assert.ok(!JSON.stringify(next).includes('kexHostName'));
  next.hosts.find(h => h.name === 'fixture').favorite=true;
  client.apply(next);
  assert.equal(hosts.all().find(h => h.name === 'fixture').requirePostQuantum,true);
  assert.equal(tunnels.all()[0].kexHostName,'fixture');
  const updated = client.read(); updated.hosts.find(h => h.name === 'fixture').host='other.example';
  client.apply(updated); assert.equal(hosts.all().find(h => h.name === 'fixture').requirePostQuantum,true);
});

test('native loopback completes hybrid SSH key exchange and rejects a classical-only endpoint', {timeout:30000},async t => {
  const file = ssh.program('ssh');
  if (!file) return t.skip('No system OpenSSH client.');
  const {algorithms} = await pq.capabilities(file);
  if (!algorithms.length) return t.skip('Native OpenSSH advertised no hybrid KEX; rejection is verified separately.');
  const windows = process.platform === 'win32';
  const daemon = windows ? path.join(path.dirname(file),'sshd.exe') : '/usr/sbin/sshd';
  const keygen = path.join(path.dirname(file),windows ? 'ssh-keygen.exe' : 'ssh-keygen');
  try {await fs.access(daemon);await fs.access(keygen);} catch {return t.skip('System OpenSSH server/keygen is unavailable for isolated negotiation.');}
  const directory = await fs.mkdtemp(path.join(os.tmpdir(),'brclio-pq-'));
  t.after(() => fs.rm(directory,{recursive:true,force:true}));
  const hostKey = path.join(directory,'host-key'), clientConfig = path.join(directory,'ssh_config');
  await fs.writeFile(clientConfig,'');
  await run(keygen,['-q','-t','ed25519','-N','','-f',hostKey],{timeout:5000,windowsHide:true});
  const publicKey = (await fs.readFile(hostKey+'.pub','utf8')).trim().split(/\s+/).slice(0,2).join(' ');
  const quote = value => '"' + value.replaceAll('\\','/').replaceAll('"','\\"') + '"';
  async function negotiate(kex) {
    const available = net.createServer(); available.listen(0,'127.0.0.1'); await once(available,'listening');
    const port = available.address().port; await new Promise(r => available.close(r));
    const config = path.join(directory,'sshd_config'), known = path.join(directory,'known_hosts');
    await fs.writeFile(known,'[127.0.0.1]:'+port+' '+publicKey+'\n');
    await fs.writeFile(config,['Port '+port,'ListenAddress 127.0.0.1','HostKey '+quote(hostKey),'PidFile '+quote(path.join(directory,'pid')),
      'LoginGraceTime 5','PasswordAuthentication no','AuthorizedKeysFile none','KexAlgorithms '+kex,'LogLevel ERROR'].join('\n')+'\n');
    const server = spawn(daemon,['-D','-e','-f',config],{stdio:['ignore','ignore','pipe'],windowsHide:true});
    const closed = once(server,'close'); let serverError='';
    server.stderr.on('data',v => {serverError=(serverError+v).slice(-2048);});
    try {
      let listening=false;
      for (let n=0;n<80 && !listening && server.exitCode===null;n++) {
        const socket=net.connect(port,'127.0.0.1');
        try {await once(socket,'connect');listening=true;}
        catch {await new Promise(r=>setTimeout(r,30));} finally {socket.destroy();}
      }
      if (!listening && windows && /permission|privilege|administrator|bad owner|no hostkeys|could not load host key|unsupported|unknown key exchange/i.test(serverError))
        return null;
      assert.ok(listening,'Isolated sshd did not listen: '+serverError);
      try {
        await run(file,['-vv','-F',clientConfig,'-o','User=brclio-kex-fixture','-o','BatchMode=yes','-o','IdentitiesOnly=yes',
          '-o','IdentityFile=none','-o','CertificateFile=none','-o','IdentityAgent=none','-o','KbdInteractiveAuthentication=no',
          '-o','PubkeyAuthentication=no','-o','PasswordAuthentication=no','-o','StrictHostKeyChecking=yes',
          '-o','GlobalKnownHostsFile=none','-o','UserKnownHostsFile='+quote(known),...ssh.argumentsFor('ssh',{...target,port},true,{file})],
          {encoding:'utf8',timeout:6000,windowsHide:true});
        throw new Error('The isolated server should not authorize any account.');
      } catch(error) {if (typeof error.stderr!=='string') throw error;return error.stderr;}
    } finally {
      if(server.exitCode===null) server.kill();
      const force = setTimeout(() => {if(server.exitCode===null) server.kill('SIGKILL');server.stderr.destroy();},1000);
      try {await closed;} finally {clearTimeout(force);}
    }
  }
  const good = await negotiate(algorithms.join(','));
  if (good===null) return t.skip('The installed Windows sshd cannot run this isolated hybrid configuration with current host-key permissions or server capabilities.');
  const chosen = /kex: algorithm: ([^\s]+)/.exec(good)?.[1];
  assert.ok(algorithms.includes(chosen),'The client/server did not negotiate a recognized hybrid KEX.');
  assert.match(good,/SSH2_MSG_NEWKEYS received/); t.diagnostic('Actual loopback KEX: '+chosen);
  const refused=await negotiate('curve25519-sha256');
  assert.match(refused,/no matching key exchange method/i);assert.doesNotMatch(refused,/SSH2_MSG_NEWKEYS received/);
});
