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

test('Ansible import follows nested and referenced groups, resolves literal SSH fields and discards other variables', () => {
  const input = {
    all:{vars:{ansible_user:'default'},children:{lab:{vars:{ansible_port:2222},children:{web:null}},oncall:{hosts:['app']}}},
    web:{hosts:{app:{ansible_user:'inline'},templated:{ansible_host:'{{ input }}'},windows:{ansible_connection:'winrm'}}},
    _meta:{hostvars:{app:{ansible_user:'deployer',ansible_host:'app.example',ansible_password:'private',ansible_ssh_private_key_file:'/keys/private',
      ansible_ssh_common_args:'credential material',ansible_ssh_executable:'/program'},plain:{ansible_host:'plain.example'}}},
  };
  const parsed = parse('ansible',JSON.stringify(input));
  assert.deepEqual(parsed.hosts,[{name:'app',host:'app.example',user:'deployer',port:2222,group:'oncall',tags:['web']},
    {name:'plain',host:'plain.example',user:'default',port:null}]);
  assert.equal(JSON.stringify(parsed).includes('private'),false);
  assert.equal(JSON.stringify(parsed).includes('/program'),false);
  assert.ok(parsed.notices.some(item => item.includes('非 SSH')));
  assert.ok(parsed.notices.some(item => item.includes('模板')));
  const basic = parse('ansible',JSON.stringify({all:{children:['lab']},lab:{children:['web']},web:{hosts:['router']},
    _meta:{hostvars:{router:{ansible_port:2022,ansible_host:'router.example'}}}}));
  assert.deepEqual(basic.hosts,[{name:'router',host:'router.example',user:'',port:2022,group:'lab/web'}]);
  const exported = {all:{hosts:{My_Router:{ansible_host:'router.example',brclio_label:'My Router',brclio_group:'Lab/QA'}}}};
  assert.deepEqual(parse('ansible',JSON.stringify(exported)).hosts,[{name:'My Router',host:'router.example',user:'',port:null,group:'Lab/QA'}]);
  assert.throws(() => parse('ansible',JSON.stringify({all:{children:['a']},a:{children:['b']},b:{children:['a'],hosts:['bad']}})),/循环/);
  assert.throws(() => parse('ansible','{"plugin":"aws_ec2"}'),/Ansible/);
});

test('MobaXterm plaintext SSH bookmarks retain their folder and login without touching credentials or tunnel sections', () => {
  const result = parse('mobaxterm', [
    '[Passwords]','secret=#109#0%excluded.example.test%22%hidden',
    '[Bookmarks]','SubRep=','ImgNum=42','Gateway=#109#0%first.example.test%22%<default>%%-1#MobaFont%10',
    '[Bookmarks_1]','Gateway=#109#0%second.example.test%2200%tester%%-1#MobaFont%10',
    'SubRep=Region\\Lab','ImgNum=41','Old=#109#1%telnet.example.test%23%login',
    '[Tunnels]','Tunnel=#109#0%ignored.example.test%22%ignored',
  ].join('\r\n'));
  assert.deepEqual(result.hosts, [
    {name:'Gateway',host:'first.example.test',user:'',port:22},
    {name:'Gateway · Region/Lab',host:'second.example.test',user:'tester',port:2200,group:'Region/Lab'},
  ]);
  assert.equal(result.notices.length,1);
  assert.equal(parse('mobaxterm','Local=#109#0%one.example.test%22%operator%%#', 'local.moba').hosts.length,1);
  assert.throws(() => parse('mobaxterm','[Passwords]\nany=foo'), /Bookmarks/);
});

test('SecureCRT single exported INI reads only public SSH fields and hex port', () => {
  const result = parse('securecrt', [
    '# $language = "English"', 'S:"Hostname"=appliance.example.test', 'S:"Protocol Name"=SSH2',
    'S:"Username"=operator', 'D:"[SSH2] Port"=000008ae','S:"Password V2"=ignored-test-placeholder',
  ].join('\r\n'), 'Lab appliance.ini');
  assert.deepEqual(result.hosts, [{name:'Lab appliance',host:'appliance.example.test',port:2222,user:'operator'}]);
  assert.throws(() => parse('securecrt','[encrypted]\nsample=fixture'), /未找到/);
  assert.throws(() => parse('securecrt','<!DOCTYPE x [<!ENTITY y "unused">]><VanDyke/>'), /DTD/);
});
