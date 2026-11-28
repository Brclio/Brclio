'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parse } = require('./terminal/host-import.js');

test('OpenSSH import resolves concrete aliases with first-match precedence, fallbacks and explicit exclusions', () => {
  const result = parse('openssh', [
    'Host workstation laptop','  Port=2222', '  User "operator"', '  IdentityFile "~/example key"',
    'Host workstation','  Hostname desk.example.test','  ProxyJump jump.example.test',
    'Host * !laptop','  CertificateFile ~/test-cert.pub','  User global',
    'Match exec "ignored"','  Hostname wrong.example.test', 'Include other.conf',
  ].join('\n'));
  assert.deepEqual(result.hosts, [
    { name:'workstation',host:'desk.example.test',user:'operator',port:2222,jump:'jump.example.test',identityFile:'~/example key',certificateFile:'~/test-cert.pub' },
    { name:'laptop',host:'laptop',user:'operator',port:2222,identityFile:'~/example key' },
  ]);
  assert.equal(result.notices.length,2);
});

test('CSV import validates fields and handles quoted delimiters, escaped quotes, BOM, and duplicate entries', () => {
  const result = parse('csv','\uFEFFLabel,Hostname,Username,Port,Group,Subgroup,Tags,Password\r\n"Dev, ""1""",host.example,dev,22,work,dev,"a,b",discard\r\nbad,-bad,,,,,,\r\n"Dev, ""1""",duplicate.example,,,,,,');
  assert.deepEqual(result.hosts,[{ name:'Dev, "1"',host:'host.example',port:22,user:'dev',group:'work/dev',tags:['a','b'] }]);
  assert.equal(result.skipped,2);
  assert.throws(() => parse('csv','Host\n"broken'));
  assert.throws(() => parse('csv','random\nexample'));
});

test('PuTTY import extracts user-selected SSH sessions from registry exports, preserving native port and decoded name', () => {
  const prefix = '[HKEY_CURRENT_USER\\Software\\SimonTatham\\PuTTY\\Sessions\\';
  const result = parse('putty',[prefix+'Example%20Host]','"HostName"="example.test"','"UserName"="dev"','"PortNumber"=dword:000008ae','"Protocol"="ssh"','"PublicKeyFile"="C:\\\\keys\\\\key.ppk"',prefix+'other]','"Protocol"="telnet"','"HostName"="other.test"'].join('\r\n'));
  assert.deepEqual(result.hosts,[{ name:'Example Host',host:'example.test',user:'dev',port:2222 }]);
  assert.equal(result.notices.length,2);
  assert.throws(() => parse('__proto__','text'));
  assert.throws(() => parse('csv','a'.repeat(1024*1024+1)));
});
