'use strict';

// This module also runs from a physical copy in the private update job, alongside
// the shared install.cjs. The client and downloader can both exit before the swap.
const nativeFS = process.versions.electron ? require('original-fs') : require('node:fs');
const path = require('node:path');

// NSRunningApplication state can stay stale inside a blocking JXA run. Send a
// single graceful quit to the initial snapshot, then observe fresh processes.
const processSnapshot = `ObjC.import('AppKit'); function run(argv) {
  function bundlePaths(getURL) {
    // AppKit may give us nil for either URL while an app is exiting.
    try {
      const url = getURL();
      const original = url && url.path;
      const resolved = url && url.URLByResolvingSymlinksInPath;
      const path = resolved && resolved.path;
      if (!path || typeof path.js !== 'string' || !path.js) return null;
      return {resolved: path.js, display: original && original.js || path.js};
    } catch (_) { return null; }
  }
  const target = bundlePaths(() => $.NSURL.fileURLWithPath(argv[2]));
  if (!target) throw Error('无法解析目标应用路径。');
  const original = JSON.parse(argv[1]);
  const apps = $.NSRunningApplication.runningApplicationsWithBundleIdentifier(argv[0]).js;
  const canonical = [], unknown = [];
  for (const app of apps) {
    if (app.terminated) continue;
    const identifier = app.processIdentifier;
    const pid = Number.isInteger(identifier) && identifier > 0 ? identifier : null;
    const bundle = bundlePaths(() => app.bundleURL);
    if (app.terminated) continue;
    if (bundle && bundle.resolved !== target.resolved) return JSON.stringify({other: bundle.display});
    if (!bundle || !pid) unknown.push(pid);
    else canonical.push({app, pid});
  }
  const pids = canonical.map(record => record.pid);
  if (argv[3] === 'quit' && !unknown.length) {
    if (original && pids.some(pid => !original.includes(pid))) return JSON.stringify({restarted: true});
    canonical.forEach(record => record.app.terminate);
  }
  return JSON.stringify({pids, unknown});
}`;

function hasExited(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); } catch (error) { return error.code === 'ESRCH'; }
  return false;
}

async function checkMacBrclioProcesses(target, run, quit = false) {
  const deadline = performance.now() + 30000;
  const quitHint = `请退出正在运行的 Brclio（${target}）后重试。`;
  const pause = () => new Promise(resolve => setTimeout(resolve, Math.min(250, Math.max(0, deadline - performance.now()))));
  async function snapshot(action) {
    let initialPids = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      const remaining = Math.ceil(deadline - performance.now());
      if (remaining <= 0) throw new Error(quitHint);
      let state;
      try {
        const args = ['-l', 'JavaScript', '-e', processSnapshot, 'com.brclio.toolbox', JSON.stringify(initialPids), target, action];
        const { stdout } = await run('/usr/bin/osascript', args, { timeout: Math.min(5000, remaining) });
        state = JSON.parse(stdout);
        if (!state.other && !state.restarted && !(Array.isArray(state.pids) && state.pids.every(pid => Number.isInteger(pid) && pid > 0)
            && Array.isArray(state.unknown) && state.unknown.every(pid => pid === null || (Number.isInteger(pid) && pid > 0)))) {
          throw new Error('Invalid process snapshot');
        }
      } catch (error) {
        throw new Error(`无法确认 Brclio 的运行状态。${quitHint}`, { cause: error });
      }
      if (state.other) throw new Error(`另一份 Brclio 正在运行（${state.other}），请先退出该副本，再重试。`);
      if (state.restarted) throw new Error(quitHint);
      if (!state.unknown.length) return state.pids;
      const live = state.unknown.filter(pid => !hasExited(pid));
      // A quit request with an unknown path never sends any termination requests.
      // If a known target remains, obtain a complete snapshot before asking it to exit.
      if (!live.length && (action === 'check' || !state.pids.length)) return state.pids;
      if (attempt === 4) {
        const ids = live.filter(Boolean);
        throw new Error(`无法确认 Brclio 进程${ids.length ? '（PID ' + ids.join('、') + '）' : ''}的应用路径。${quitHint}`);
      }
      initialPids ||= [...state.pids, ...live];
      await pause();
    }
  }

  const original = await snapshot(quit ? 'quit' : 'check');
  if (!quit || !original.length) return;
  while (performance.now() < deadline) {
    const current = await snapshot('check');
    if (!current.length) return;
    if (current.some(pid => !original.includes(pid))) throw new Error(quitHint);
    await pause();
  }
  throw new Error(quitHint);
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
