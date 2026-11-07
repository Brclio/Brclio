'use strict';

// This module also runs from a physical copy in the private update job, alongside
// the shared install.cjs. The client and downloader can both exit before the swap.
const nativeFS = process.versions.electron ? require('original-fs') : require('node:fs');
const path = require('node:path');

async function checkMacBrclioProcesses(target, run, quit = false) {
  const script = `ObjC.import('AppKit'); function run(argv) {
    const target = $.NSURL.fileURLWithPath(argv[0]).URLByResolvingSymlinksInPath.path.js;
    const running = () => $.NSRunningApplication.runningApplicationsWithBundleIdentifier('com.brclio.toolbox').js;
    const apps = running();
    const outsideTarget = app => app.bundleURL.URLByResolvingSymlinksInPath.path.js !== target;
    const other = apps.find(outsideTarget);
    if (other) return other.bundleURL.path.js;
    if (argv[1] === 'quit') {
      apps.forEach(app => app.terminate);
      for (let n = 0; n < 300 && apps.some(app => !app.terminated); n++) delay(0.1);
      const remaining = running().filter(app => !app.terminated);
      const appeared = remaining.find(outsideTarget);
      if (appeared) return appeared.bundleURL.path.js;
      if (remaining.length) throw Error('请退出正在运行的 Brclio 后重试。');
    }
    return '';
  }`;
  const { stdout } = await run('/usr/bin/osascript', ['-l', 'JavaScript', '-e', script, target, quit ? 'quit' : 'check'], { timeout: 40000 });
  if (stdout.trim()) throw new Error(`另一份 Brclio 正在运行（${stdout.trim()}），请先退出该副本，再重试。`);
}

function spawnMacClientHelper(target, spawnChild) {
  return (program, [helperPath, configPath], options) => {
    const wrapper = path.join(path.dirname(helperPath), 'bootstrap-install.cjs');
    // Electron's normal fs can read our ASAR. Use native fs for the private job file.
    nativeFS.writeFileSync(wrapper, require('node:fs').readFileSync(__filename), { flag: 'wx', mode: 0o700 });
    return spawnChild(program, [wrapper, helperPath, configPath, target], options);
  };
}

async function runMacClientHelper(helperPath, configPath, target, deps = {}) {
  const { runHelper, defaultRun } = require(helperPath);
  const run = deps.run || defaultRun;
  const fileSystem = deps.fs || nativeFS.promises;
  return runHelper(configPath, {
    ...deps,
    fs: {
      ...fileSystem,
      async rename(from, to) {
        // The first forward rename uniquely targets previous-bundle. A rollback
        // must still restore the original even if a different client is running.
        if (path.basename(to) === 'previous-bundle') {
          if (from !== target) throw new Error('更新目标与下载器选定的客户端路径不一致。');
          await checkMacBrclioProcesses(target, run, true);
        }
        return fileSystem.rename(from, to);
      },
    },
    async run(program, args, options) {
      if (program === '/usr/bin/open') {
        if (args[0] !== '-n' || args[1] !== '-a' || args[2] !== target) throw new Error('启动目标与下载器选定的客户端路径不一致。');
        await checkMacBrclioProcesses(target, run);
      }
      return run(program, args, options);
    },
  });
}

if (require.main === module) {
  runMacClientHelper(...process.argv.slice(2)).then(result => {
    if (result.status === 'error') process.exitCode = 1;
  }).catch(error => { console.error(error); process.exitCode = 1; });
}

module.exports = { checkMacBrclioProcesses, spawnMacClientHelper, runMacClientHelper };
