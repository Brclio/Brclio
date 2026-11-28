'use strict';

const assert = require('node:assert/strict');
const {execFile,spawn} = require('node:child_process');
const {once} = require('node:events');
const fs = require('node:fs/promises');
const net = require('node:net');
const path = require('node:path');
const readline = require('node:readline');
const run = require('node:util').promisify(execFile);
const ssh = require('../desktop/terminal/remote-launch.cjs');
const pq = require('../desktop/terminal/post-quantum.cjs');

// The WSL process owns the disposable host key. The parent closes stdin when
// the client finishes; a separate timeout also terminates an abandoned fixture.
const fixture = `
set -eu
dir=$(mktemp -d /tmp/brclio-pq-XXXXXXXX)
pid=
cleanup() {
  if [ -n "$pid" ]; then kill "$pid" 2>/dev/null || true; wait "$pid" 2>/dev/null || true; fi
  rm -rf "$dir"
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM
ssh-keygen -q -t ed25519 -N '' -f "$dir/host"
/usr/sbin/sshd -D -e -f /dev/null -h "$dir/host" -p "$1" -o ListenAddress=127.0.0.1 \\
  -o "PidFile=$dir/sshd.pid" -o "KexAlgorithms=$2" -o LoginGraceTime=5 \\
  -o AuthorizedKeysFile=none -o PasswordAuthentication=no -o KbdInteractiveAuthentication=no </dev/null &
pid=$!
cat "$dir/host.pub"
read -r stop || true
`;
async function negotiate(client, directory, serverKex) {
  const listener = net.createServer();
  listener.listen(0,'127.0.0.1');
  await once(listener,'listening');
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const wsl = path.join(process.env.SystemRoot,'System32','wsl.exe');
  const script = path.join(directory,'pq-server.sh');
  await fs.writeFile(script,fixture);
  const {stdout} = await run(wsl,['--exec','wslpath','-a',script],{encoding:'utf8',timeout:12000,windowsHide:true});
  const server = spawn(wsl,['--user','root','--exec','timeout','25','sh',stdout.trim(),String(port),serverKex],
    {stdio:['pipe','pipe','pipe'],windowsHide:true});
  const closed = once(server,'close');
  let logs = '';
  server.stderr.on('data', chunk => {logs=(logs+chunk).slice(-3000);});
  const lines = readline.createInterface({input:server.stdout});
  try {
    const [hostKey] = await once(lines,'line',{signal:AbortSignal.timeout(12000)});
    assert.match(hostKey,/^ssh-ed25519 [A-Za-z0-9+/=]+ /);
    const known = path.join(directory,'known_hosts'), config = path.join(directory,'ssh_config');
    await fs.writeFile(known,'[127.0.0.1]:'+port+' '+hostKey+'\n');
    await fs.writeFile(config,'');
    for (let i=0;i<100;i++) {
      if (logs.includes('Server listening on 127.0.0.1 port ' + port)) break;
      await new Promise(resolve => setTimeout(resolve,40));
    }
    assert.match(logs,/Server listening on 127\.0\.0\.1 port /,'WSL foreground sshd failed to listen: '+logs);
    const options = ['-vv','-F',config,'-o','User=brclio-kex-fixture','-o','BatchMode=yes','-o','IdentitiesOnly=yes',
      '-o','IdentityFile=none','-o','CertificateFile=none','-o','IdentityAgent=none','-o','PubkeyAuthentication=no',
      '-o','PasswordAuthentication=no','-o','KbdInteractiveAuthentication=no','-o','StrictHostKeyChecking=yes',
      '-o','GlobalKnownHostsFile=none','-o','UserKnownHostsFile="'+known.replaceAll('\\','/')+'"'];
    const args = ssh.argumentsFor('ssh',{host:'127.0.0.1',port,requirePostQuantum:true},false,client);
    try {
      await run(client.file,[...options,...args],{encoding:'utf8',timeout:8000,windowsHide:true});
      throw new Error('The fixture must never authorize a user.');
    } catch (error) {if (typeof error.stderr!=='string') throw error;return error.stderr;}
  } finally {
    lines.close();
    server.stdin.end();
    await closed;
  }
}
async function main() {
  const directory = process.argv[2];
  assert.equal(process.platform,'win32');
  assert.ok(directory && path.isAbsolute(directory));
  // Simulate the trusted installation layout inside the CI temporary directory.
  // Do not replace, install, or reconfigure either system OpenSSH installation.
  const env = {...process.env,ProgramFiles:directory};
  const target = {requirePostQuantum:true};
  const candidate = path.join(directory,'OpenSSH','ssh.exe');
  const offline = await pq.capabilities(candidate);
  assert.ok(offline.algorithms.includes('mlkem768x25519-sha256'));
  const system = pq.candidates('win32',env)[0];
  const systemClient = await pq.capabilities(system).catch(() => ({algorithms:[]}));
  if (!systemClient.algorithms.length) assert.equal(ssh.clientFor('ssh',target,'win32',env).file,candidate);
  // Exercise this exact release even if a later runner upgrades its in-box SSH.
  env.SystemRoot = path.join(directory,'fixture-Windows');
  const client = ssh.clientFor('ssh',target,'win32',env);
  const sftp = ssh.clientFor('sftp',target,'win32',env);
  assert.equal(client.file,candidate);
  assert.equal(sftp.file,path.join(directory,'OpenSSH','sftp.exe'));
  const args = ssh.argumentsFor('sftp',{...target,host:'127.0.0.1'},false,sftp);
  assert.equal(args[args.indexOf('-S')+1],candidate);
  const good = await negotiate(client,directory,'mlkem768x25519-sha256');
  assert.match(good,/kex: algorithm: mlkem768x25519-sha256/);
  assert.match(good,/SSH2_MSG_NEWKEYS received/);
  const rejected = await negotiate(client,directory,'curve25519-sha256');
  assert.match(rejected,/no matching key exchange method/i);
  assert.doesNotMatch(rejected,/SSH2_MSG_NEWKEYS received/);
  console.log('Verified Microsoft Win32-OpenSSH 10.4 native Windows client negotiated mlkem768x25519-sha256 over TCP loopback and refused a classical-only server.');
}
main().catch(error => {console.error(error);process.exitCode=1;});
