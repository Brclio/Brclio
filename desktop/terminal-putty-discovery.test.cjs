'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const {randomUUID} = require('node:crypto');
const {execFileSync} = require('node:child_process');
const {records,registrySessions,sessionFiles,powershell,register} = require('./terminal/putty-discovery.cjs');

test('selected PuTTY files preserve literal SSH fields; other options, default settings and Telnet sessions are excluded',async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(),'brclio-putty-files-'));
  try {
    const paths = ['Test%20session','Default%20Settings','telnet','bad.pem'].map(f => path.join(dir,f));
    const content = 'HostName=local.example.test\nUserName=user\nProtocol=ssh\nPortNumber=2222\nPublicKeyFile=secret-key\nProxyTelnetCommand=fixture\nProxyPassword=fixture';
    await Promise.all(paths.map((file,i) => fs.writeFile(file,i === 2 ? content.replace('Protocol=ssh','Protocol=telnet') : content)));
    const result = await sessionFiles(paths.slice(0,3));
    assert.deepEqual(result.hosts,[{name:'Test session',host:'local.example.test',user:'user',port:2222}]);
    assert.equal(result.skipped,2);
    assert.deepEqual(JSON.parse(JSON.stringify(result)),result);
    await assert.rejects(sessionFiles([paths[3]]),/PuTTY/);
    await assert.rejects(registrySessions('Software\\OtherUser'),/路径/);
    let invoke, current = {}, mode='cancel';
    register({handle:(_,fn) => {invoke=fn;},dialog:{showOpenDialog:async () => {
      if (mode === 'switch') current = {};
      return {canceled:mode === 'cancel',filePaths:[paths[0]]};
    }},owner:() => ({}),view:() => current,home:dir});
    assert.equal(await invoke('files'),null);
    mode='switch'; assert.equal(await invoke('files'),null);
    mode='accept'; assert.deepEqual((await invoke('files')).hosts,result.hosts);
  } finally { await fs.rm(dir,{recursive:true,force:true}); }
});

test('Windows native discovery queries four named values on an isolated current-user registry fixture',{skip:process.platform !== 'win32'},async () => {
  const key = 'Software\\BrclioTerminalTest-' + randomUUID();
  const run = script => execFileSync(powershell(),['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')]);
  try {
    run(`$ErrorActionPreference='Stop'
$root=[Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('${key}')
$s=$root.CreateSubKey('Fixture%20session')
$s.SetValue('HostName','ssh.example.test'); $s.SetValue('UserName','qa'); $s.SetValue('Protocol','ssh');
$s.SetValue('PortNumber',2222,[Microsoft.Win32.RegistryValueKind]::DWord)
$s.SetValue('ProxyPassword','never-return');$s.SetValue('ProxyTelnetCommand','never-return');$s.SetValue('PublicKeyFile','never-return')
$s.Dispose();$root.Dispose()`);
    const raw = await registrySessions(key);
    assert.deepEqual(raw,[{name:'Fixture%20session',HostName:'ssh.example.test',UserName:'qa',Protocol:'ssh',PortNumber:2222}]);
    assert.deepEqual(records(raw).hosts,[{name:'Fixture session',host:'ssh.example.test',user:'qa',port:2222}]);
    let invoke;
    register({handle:(_,fn) => {invoke=fn;},dialog:{showMessageBox:async () => ({response:0})},owner:() => ({}),view:() => ({}),home:''});
    assert.equal(await invoke('registry'),null);
  } finally {
    run(`[Microsoft.Win32.Registry]::CurrentUser.DeleteSubKeyTree('${key}',$false)`);
  }
});
