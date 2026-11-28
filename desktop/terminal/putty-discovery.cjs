'use strict';
const fs = require('node:fs/promises');
const {constants} = require('node:fs');
const path = require('node:path');
const {execFile} = require('node:child_process');
const {promisify} = require('node:util');
const {named} = require('./connection.js');
const {limit} = require('./host-import.js');

const sessionsPath = 'Software\\SimonTatham\\PuTTY\\Sessions';
const powershell = () => path.join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe');
const execute = promisify(execFile);

async function registrySessions(key = sessionsPath) {
  // The renderer cannot supply a path. Native tests get a separate disposable HKCU key.
  if (key !== sessionsPath && !/^Software\\BrclioTerminalTest-[0-9a-f-]{36}$/i.test(key)) throw new Error('PuTTY 会话路径无效。');
  const script = `
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$rows=[System.Collections.ArrayList]::new()
$root=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('${key}',$false)
if ($root) {
  try {
    if ($root.SubKeyCount -gt 2048) { throw 'Too many sessions' }
    foreach ($name in $root.GetSubKeyNames()) {
      $session = $root.OpenSubKey($name,$false)
      if (!$session) { continue }
      try {
        $options = [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames
        $row = @{name=$name}
        foreach ($field in 'HostName','UserName','Protocol','PortNumber') {
          $value=$session.GetValue($field,$null,$options)
          if (($value -is [string] -and $value.Length -le 512) -or $value -is [int]) { $row[$field]=$value }
        }
        [void]$rows.Add($row)
      } finally { $session.Dispose() }
    }
  } finally { $root.Dispose() }
}
ConvertTo-Json -InputObject @($rows.ToArray()) -Compress`;
  const {stdout} = await execute(powershell(),['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],
    {windowsHide:true,timeout:15000,maxBuffer:3*1024*1024,encoding:'utf8'});
  return JSON.parse(stdout.trim());
}

function records(rows) {
  const hosts = [], seen = new Set();
  let skipped = 0;
  for (const row of rows) {
    try {
      const name = decodeURIComponent(row.name);
      if (name === 'Default Settings' || row.Protocol && row.Protocol.toLowerCase() !== 'ssh' || !row.HostName) { skipped++; continue; }
      const host = named({name,host:row.HostName,user:row.UserName,port:row.PortNumber});
      if (seen.has(host.name)) { skipped++; continue; }
      seen.add(host.name);
      hosts.push(host);
    } catch { skipped++; }
  }
  return {hosts, skipped, notices:skipped ? ['已略过默认模板、非 SSH、重复或无法读取的会话。'] : []};
}

async function sessionFiles(files) {
  if (files.length > 128) throw new Error('一次最多选择 128 个 PuTTY 会话文件。');
  const rows = [];
  let total = 0;
  for (const file of files) {
    const canonical = await fs.realpath(file);
    if (/(?:^|[\\/])\.ssh(?:[\\/]|$)|\.(?:pem|ppk|key|pfx|p12)$/i.test(canonical)) throw new Error('请选择 PuTTY 会话文件。');
    const info = await fs.lstat(file);
    if (!info.isFile() || info.size > limit || (total += info.size) > 8*limit) throw new Error('请选择不超过 1 MiB 的普通会话文件，总大小不超过 8 MiB。');
    // Only these four PuTTY options enter the result. All other lines are discarded here.
    const row = {name:path.basename(file)};
    const handle = await fs.open(canonical,constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.ino !== info.ino || opened.dev !== info.dev || opened.size !== info.size) throw new Error('会话文件已变更，请重新选择。');
      if (opened.size) {
        const chunks = [];
        for await (const chunk of handle.createReadStream({start:0,end:opened.size - 1,autoClose:false})) chunks.push(chunk);
        for (const line of Buffer.concat(chunks).toString('utf8').split(/\r?\n/)) {
          const match = /^(HostName|UserName|Protocol|PortNumber)=(.*)$/.exec(line);
          if (match) row[match[1]] = match[2];
        }
      }
    } finally {
      await handle.close();
    }
    rows.push(row);
  }
  return records(rows);
}

function register({handle,dialog,owner,view,home}) {
  handle('putty-discovery',async mode => {
    const current = view();
    if (mode === 'registry' && process.platform === 'win32') {
      const choice = await dialog.showMessageBox(owner(),{type:'question',message:'读取当前 Windows 用户的 PuTTY 会话？',
        detail:'仅读取会话名称、协议、主机、端口及 SSH 用户名。你可以在预览中选择要保存的主机。',
        buttons:['取消','读取会话'],cancelId:0,defaultId:0,noLink:true});
      if (choice.response !== 1 || current !== view()) return null;
      const result = records(await registrySessions());
      return current === view() ? result : null;
    }
    if (mode !== 'files') throw new Error('该 PuTTY 导入来源不可用。');
    const options = {title:'选择 PuTTY 会话文件',properties:['openFile','multiSelections','showHiddenFiles']};
    if (process.platform !== 'win32') {
      const unix = [process.env.XDG_CONFIG_HOME && path.join(process.env.XDG_CONFIG_HOME,'putty','sessions'),
        path.join(home,'.putty','sessions'),path.join(home,'.config','putty','sessions')].filter(Boolean);
      for (const directory of unix) {
        if (await fs.stat(directory).then(s => s.isDirectory(),() => false)) {options.defaultPath=directory;break;}
      }
    }
    if (current !== view()) return null;
    const choice = await dialog.showOpenDialog(owner(),options);
    if (choice.canceled || !choice.filePaths.length || current !== view()) return null;
    const result = await sessionFiles(choice.filePaths);
    return current === view() ? result : null;
  });
}
module.exports = {register, sessionFiles, registrySessions, records, powershell};
