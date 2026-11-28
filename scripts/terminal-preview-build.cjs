'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const {createHash} = require('node:crypto');
const {Arch, Platform, build} = require('electron-builder');
const {extractFile} = require('@electron/asar');
const root = path.join(__dirname,'..');
const product = 'Brclio Terminal Preview';
const bundle = 'com.brclio.toolbox.terminal-preview';
const entry = 'terminal-preview-main.cjs';

function previewSource(source) {
  // Git for Windows may check out the same entry point with CRLF.
  source = source.replace(/\r\n/g,'\n');
  function change(from, to) {
    assert.equal(source.split(from).length,2,'Preview patch missing or ambiguous: ' + from);
    source = source.replace(from,() => to);
  }
  change(`app.setName('Brclio');
app.setPath('userData', process.env.BRCLIO_USER_DATA
  ? path.resolve(process.env.BRCLIO_USER_DATA)
  : path.join(app.getPath('appData'), 'com.brclio.toolbox'));
if (process.platform === 'win32') app.setAppUserModelId('com.brclio.toolbox');`,
    `app.setName('${product}');
app.setPath('userData', path.join(process.env.BRCLIO_PREVIEW_DATA_ROOT || app.getPath('appData'), '${bundle}'));
if (process.platform === 'win32') app.setAppUserModelId('${bundle}');`);
  change('let launchIntoTerminal = terminalLaunchRequested(process.argv);','let launchIntoTerminal = true;');
  change('const shortcuts = createShortcutManager({ globalShortcut, onActivate:',"const shortcuts = createShortcutManager({ platform: 'preview', globalShortcut, onActivate:");
  change(`const integration = createIntegration({ launch: {
  executable: process.execPath, appPath: app.getAppPath(), packaged: app.isPackaged,
} });`,`const previewUnavailable = () => { throw new Error('终端预览版使用独立目录，不管理系统集成和正式版更新。'); };
const integration = {
  status: async () => ({installed:false, supported:false, description:'终端预览版不管理系统右键菜单。'}),
  set: previewUnavailable, repairWindows: async () => {},
};`);
  change(`const installer = process.platform === 'darwin' ? createMacInstaller(installerOptions)
  : process.platform === 'win32' ? createWindowsInstaller(installerOptions) : null;`,'const installer = null;');
  change('function handle(channel, callback) {',`function handle(channel, callback) {
  if (['brclio:update:check','brclio:update:download','brclio:update:install'].includes(channel)) callback = previewUnavailable;`);
  change('storage: preferenceFile(app.getPath(\'userData\')), globalShortcut, serialize: withPreferences,',
    "storage: preferenceFile(app.getPath('userData')), globalShortcut: {isRegistered:() => false, register:() => false, unregister:() => {}}, serialize: withPreferences,");
  change("systemIntegration: ['darwin', 'win32'].includes(process.platform), globalShortcut:",'systemIntegration: false, globalShortcut:');
  change("if (!app.isPackaged) throw new Error('请在安装版中设置开机启动。');\n        app.setLoginItemSettings({ openAtLogin: next.launchAtLogin });",
    'previewUnavailable();');
  change("if (next.launchAtLogin !== previous.launchAtLogin) app.setLoginItemSettings({ openAtLogin: previous.launchAtLogin });", '');
  return source;
}

async function main() {
  const mac = process.platform === 'darwin', arch = process.arch;
  assert.ok(mac ? ['x64','arm64'].includes(arch) : process.platform === 'win32' && arch === 'x64','Build on the target macOS or Windows x64 host.');
  const options = process.argv.slice(2);
  assert.ok(!options.some(s => s !== '--unpacked'),'Only --unpacked is supported.');
  const raw = await fs.readFile(path.join(root,'desktop/main.cjs'),'utf8');
  const hash = text => createHash('sha256').update(text).digest('hex');
  const stamp = hash(raw);
  const patched = previewSource(raw);
  const platform = mac ? 'mac' : 'win';
  const destination = path.join(root,'release','terminal-preview');
  await fs.mkdir(destination,{recursive:true});
  const output = await fs.mkdtemp(path.join(destination,platform + '-' + arch + '-'));
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(),'brclio-preview-entry-'));
  try {
    await fs.writeFile(path.join(temporary,entry),patched);
    await build({projectDir:root,targets:(mac ? Platform.MAC : Platform.WINDOWS).createTarget(['dir'],Arch[arch]),
      // electron-builder merges these overrides with the package.json build section.
      // Repeating the base extraResources makes two tasks copy/sign the same Windows executable.
      publish:'never',config:{extends:null,appId:bundle,productName:product,npmRebuild:false,
        extraMetadata:{main:'desktop/' + entry,productName:product},
        directories:{output},
        files:[{from:temporary,to:'desktop',filter:[entry]}],
        afterPack:async context => {
          if (mac) {
            const contents = path.join(context.appOutDir,product + '.app','Contents');
            const plist = path.join(contents,'Info.plist');
            const info = JSON.parse(execFileSync('/usr/bin/plutil',['-convert','json','-o','-',plist],{encoding:'utf8'}));
            if (info.CFBundleURLTypes) execFileSync('/usr/bin/plutil',['-remove','CFBundleURLTypes',plist]);
            const moduleRoot = path.join(contents,'Resources','app.asar.unpacked','node_modules','node-pty');
            require('./terminal-helper-mode.cjs').enableMacPtyHelper(moduleRoot,arch);
          } else {
            await require('./windows-after-pack.cjs')(context);
            await fs.rm(path.join(context.appOutDir,'resources','windows-shell'),{recursive:true,force:true});
          }
        },
      }});
    const built = path.join(output,mac ? (arch === 'arm64' ? 'mac-arm64' : 'mac') : 'win-unpacked');
    const name = 'Brclio-Terminal-Preview-' + platform + '-' + arch;
    const folder = path.join(output,name);
    await fs.mkdir(folder);
    const application = path.join(folder,mac ? product + '.app' : 'app');
    await fs.rename(mac ? path.join(built,product + '.app') : built,application);
    if (mac) {
      const plist = path.join(application,'Contents','Info.plist');
      const value = key => execFileSync('/usr/bin/plutil',['-extract',key,'raw','-o','-',plist],{encoding:'utf8'}).trim();
      assert.equal(value('CFBundleIdentifier'),bundle);
      const info = JSON.parse(execFileSync('/usr/bin/plutil',['-convert','json','-o','-',plist],{encoding:'utf8'}));
      assert.equal(info.CFBundleURLTypes?.length || 0,0,'Preview registered a URL scheme.');
      assert.equal(await fs.stat(path.join(application,'Contents','PlugIns','BrclioFinderSync.appex')).then(() => true,() => false),false);
      execFileSync('/usr/bin/codesign',['--verify','--deep','--strict',application],{stdio:'inherit'});
    }
    const resources = path.join(application,mac ? 'Contents/Resources' : 'resources');
    const archive = path.join(resources,'app.asar');
    assert.equal(JSON.parse(extractFile(archive,'package.json')).main,'desktop/' + entry);
    assert.equal(hash(extractFile(archive,'desktop/' + entry)),hash(patched));
    assert.equal(hash(extractFile(archive,'desktop/main.cjs')),stamp);
    const executable = mac ? path.join(application,'Contents','MacOS',product) : path.join(application,product + '.exe');
    await fs.access(executable);
    const launcher = mac ? '#!/bin/sh\nexec "$(dirname "$0")/' + product + '.app/Contents/MacOS/' + product + '" --brclio-terminal\n' :
      '@echo off\r\nstart "" "%~dp0app\\' + product + '.exe" --brclio-terminal\r\n';
    await fs.writeFile(path.join(folder,mac ? 'Open Brclio Terminal.command' : 'Open Brclio Terminal.cmd'),launcher,{mode:0o755});
    await require('./verify-terminal-preview.cjs').verify(executable);
    if (!options.includes('--unpacked')) {
      const zip = path.join(output,name + '.zip');
      if (mac) execFileSync('/usr/bin/ditto',['-c','-k','--keepParent',folder,zip],{stdio:'inherit'});
      else execFileSync(path.join(process.env.SystemRoot,'System32','tar.exe'),['-a','-c','-f',zip,'-C',output,name],{stdio:'inherit'});
      assert.ok((await fs.stat(zip)).size > 0,'Preview archive is empty.');
      if (process.env.GITHUB_OUTPUT) {
        const artifact = 'release/terminal-preview/artifacts/' + name + '.zip';
        await fs.mkdir(path.dirname(path.join(root,artifact)),{recursive:true});
        await fs.copyFile(zip,path.join(root,artifact));
        await fs.appendFile(process.env.GITHUB_OUTPUT,'archive=' + artifact + '\n');
      }
      console.log(zip);
    }
    console.log('Preview application: ' + application);
    return application;
  } finally {
    assert.equal(hash(await fs.readFile(path.join(root,'desktop/main.cjs'))),stamp,'Release main changed during preview build.');
    await fs.rm(temporary,{recursive:true,force:true});
  }
}
module.exports = {previewSource};
if (require.main === module) main().catch(error => {console.error(error);process.exit(1);});
