'use strict';

const { execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { promisify } = require('node:util');
const { named } = require('./connection.js');

const run = promisify(execFile);
const providers = new Map([
  ['aws', {command:'aws', args:['ec2','describe-instances','--output','json']}],
  ['digitalocean', {command:'doctl', args:['compute','droplet','list','--output','json']}],
  ['azure', {command:'az', args:['vm','list','--show-details','--output','json','--only-show-errors']}],
]);

function inventory(provider, json) {
  let rows;
  if (provider === 'aws' && Array.isArray(json?.Reservations)) {
    rows = json.Reservations.flatMap(res => (res.Instances || []).map(vm => ({
      name:vm.Tags?.find(tag => tag.Key === 'Name')?.Value || vm.InstanceId,
      host:vm.PublicDnsName || vm.PublicIpAddress || vm.PrivateIpAddress,
      group:'AWS/' + (vm.Placement?.AvailabilityZone || 'EC2'),
    })));
  } else if (provider === 'digitalocean' && Array.isArray(json)) {
    rows = json.map(vm => {
      const ips = [...(vm.networks?.v4 || []),...(vm.networks?.v6 || [])];
      return {name:vm.name,host:(ips.find(ip => ip.type === 'public') || ips[0])?.ip_address,
        group:'DigitalOcean/' + (vm.region?.slug || 'Droplets')};
    });
  } else if (provider === 'azure' && Array.isArray(json)) {
    rows = json.map(vm => ({name:vm.name,host:(vm.publicIps || vm.privateIps || '').split(',')[0].trim(),
      group:'Azure/' + (vm.resourceGroup || vm.location || 'VM')}));
  } else throw new Error('云服务返回的资产清单格式无效。');
  if (rows.length > 2048) throw new Error('单次清单最多支持 2048 个实例。');
  const hosts = [], names = new Set();
  let skipped = 0;
  for (const row of rows) {
    if (!row.host || !row.name) { skipped++; continue; }
    let name = row.name;
    if (names.has(name)) name = (row.name + ' · ' + row.host).slice(0,64);
    if (names.has(name)) { skipped++; continue; }
    try {
      const item = named({...row,name});
      names.add(item.name); hosts.push(item);
    } catch { skipped++; }
  }
  return {hosts, skipped, notices:[]};
}

function executable(provider, platform = process.platform, env = process.env) {
  const spec = providers.get(provider);
  if (!spec) throw new Error('请选择支持的云服务。');
  const windows = platform === 'win32', paths = windows ? path.win32 : path.posix;
  const directories = (env.PATH || env.Path || '').split(windows ? ';' : ':').filter(dir => paths.isAbsolute(dir));
  if (windows) {
    if (env.ProgramFiles) directories.push(paths.join(env.ProgramFiles,'Amazon','AWSCLIV2'));
  } else directories.push('/opt/homebrew/bin','/usr/local/bin');
  for (const dir of directories) {
    const file = paths.join(dir, spec.command + (windows ? '.exe' : ''));
    try {
      if (fs.statSync(file).isFile()) {
        fs.accessSync(file,fs.constants.X_OK);
        return {file, args:spec.args};
      }
    } catch { /* Try the next installation directory. */ }
  }
  if (windows && provider === 'azure') {
    for (const base of [env.ProgramFiles,env['ProgramFiles(x86)']].filter(Boolean)) {
      const file = paths.join(base,'Microsoft SDKs','Azure','CLI2','python.exe');
      if (fs.statSync(file,{throwIfNoEntry:false})?.isFile()) return {file,args:['-I','-m','azure.cli',...spec.args]};
    }
  }
  throw new Error('未找到 ' + spec.command + '。请先安装云服务官方 CLI 并登录当前账号。');
}

async function fetchInventory(provider) {
  const {file,args} = executable(provider);
  let stdout;
  try {
    ({stdout} = await run(file,args,{timeout:45000,maxBuffer:6*1024*1024,windowsHide:true,
      env:{...process.env,AWS_PAGER:'',AWS_CLI_AUTO_PROMPT:'off',AZURE_CORE_NO_COLOR:'true'}}));
  } catch {
    throw new Error('读取云主机清单失败。请确认官方 CLI 已登录、配置了区域或订阅，并有读取实例的权限。');
  }
  try { return inventory(provider,JSON.parse(stdout)); }
  catch (error) { if (error instanceof SyntaxError) throw new Error('云服务没有返回有效的 JSON 清单。'); throw error; }
}

module.exports = {fetchInventory,inventory};
