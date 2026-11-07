'use strict';

// Run on the disposable hosted runner. The starting registry checks also keep a
// developer's own Brclio installations out of this native installation test.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { createReadStream } = require('node:fs');
const { createHash } = require('node:crypto');
const path = require('node:path');
const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');
const { getInstalled, installAndOpen } = require('../install.cjs');
const { version } = require('../package.json');

const execute = promisify(execFile);
const ps = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const powershell = (script, values = {}) => execute(ps, [
  '-NoProfile', '-NonInteractive', '-Command', "$ErrorActionPreference='Stop'\n" + script,
], { windowsHide:true, timeout:60000, env:{...process.env, ...values} });

async function descriptor(product, filename, version) {
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(filename)) hash.update(bytes);
  return { product, filename, version, expected:hash.digest('hex'), size:(await fs.stat(filename)).size };
}
async function visibleApplication(product, wantedVersion) {
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    // NSIS can remove the old exe before replacing its registration. The
    // normal lookup stays strict; only this bounded observer waits through
    // that intermediate state.
    const installed = await getInstalled(product).catch(error => {
      if (/PathNotFound,Microsoft\.PowerShell\.Commands\.GetItemCommand/.test(error.stderr || '')) return null;
      throw error;
    });
    if (installed?.version === wantedVersion) {
      const { stdout } = await powershell(`
        $p = Get-Process -Name ([IO.Path]::GetFileNameWithoutExtension($env:SMOKE_EXE)) -ErrorAction SilentlyContinue |
          Where-Object { $_.Path -ieq $env:SMOKE_EXE -and $_.MainWindowHandle -ne 0 } | Select-Object -First 1
        if ($p) { Write-Output $p.Id }
      `, {SMOKE_EXE:installed.path});
      if (Number(stdout.trim()) > 0) return installed;
    }
    await new Promise(resolve => setTimeout(resolve, 800));
  }
  throw new Error(`${product} ${wantedVersion} did not open an installed window`);
}
async function stopInstalled(exe) {
  await powershell(`
    $name = [IO.Path]::GetFileNameWithoutExtension($env:SMOKE_EXE)
    foreach ($process in @(Get-Process -Name $name -ErrorAction SilentlyContinue | Where-Object { $_.Path -ieq $env:SMOKE_EXE })) {
      try { if (-not $process.HasExited) { $process.Kill(); [void]$process.WaitForExit(10000) } }
      catch { if (-not $process.HasExited) { throw } }
    }
  `, {SMOKE_EXE:exe});
}

async function main() {
  assert.equal(process.platform, 'win32');
  assert.equal(process.env.GITHUB_ACTIONS, 'true');
  assert.equal(process.env.RUNNER_OS, 'Windows');
  const target = path.resolve('release/downloader', `Brclio-Downloader-${version}-windows-x64.exe`);
  if (process.argv[2] === '--handoff') {
    const result = await installAndOpen(await descriptor('downloader', target, version));
    assert.equal(result.handoff, true);
    console.log('Verified helper readiness; exiting the old downloader process.');
    return; // The detached installer waits for this exact parent PID to exit.
  }
  assert.equal(await getInstalled('downloader'), null, 'Existing downloader installation');
  assert.equal(await getInstalled('brclio'), null, 'Existing Brclio installation');
  const baseline = path.resolve('release/downloader-smoke-old/Brclio-Downloader-0.0.1-windows-x64.exe');
  const brclio = await descriptor('brclio', path.resolve(process.argv[2]), '0.2.8');
  assert.equal(brclio.size, 124620572);
  assert.equal(brclio.expected, '01ada97eefc4b7b0972f35ec4fa1deb6b904e22a436cefbba27f99b590a2f3c5');
  const rule = 'Brclio Downloader native smoke ' + process.pid;
  let firewall = false;
  try {
    await execute(baseline, ['/S','/currentuser'], {timeout:300000});
    const old = await getInstalled('downloader');
    assert.equal(old?.version, '0.0.1');
    // The replacement is opened automatically. Keep that installed executable
    // from contacting public feeds, without altering the runner's proxy or blocking other jobs.
    await powershell('New-NetFirewallRule -DisplayName $env:SMOKE_RULE -Program $env:SMOKE_EXE -Direction Outbound -Action Block -Profile Any | Out-Null',
      {SMOKE_RULE:rule, SMOKE_EXE:old.path});
    firewall = true;
    // Measure the old process's actual exit. A relaunched application may
    // still hold inherited handles, so do not wait for captured pipes to close.
    await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [__filename, '--handoff'], {stdio:'inherit', timeout:90000});
      child.once('error', reject);
      child.once('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`Handoff process exited: ${code ?? signal}`)));
    });
    const updated = await visibleApplication('downloader', version);
    assert.equal(updated.path, old.path);
    console.log(`NSIS downloader 0.0.1 -> ${version} installed and opened its window at the existing path`);
    await stopInstalled(updated.path);
    await execute(process.execPath, [path.join(__dirname, 'smoke.cjs'), path.dirname(updated.path)], {timeout:180000});
    const result = await installAndOpen(brclio);
    assert.equal(result.handoff, false);
    await visibleApplication('brclio', brclio.version);
    console.log('Production installer verified, installed and opened official Brclio 0.2.8 on Windows.');
  } finally {
    for (const [product, name] of [['brclio','Brclio'], ['downloader','Brclio Downloader']]) {
      const installed = await getInstalled(product).catch(() => null);
      if (!installed) continue;
      await stopInstalled(installed.path).catch(() => {});
      const uninstall = path.join(path.dirname(installed.path), 'Uninstall ' + name + '.exe');
      await execute(uninstall, ['/S','/currentuser'], {timeout:180000}).catch(() => {});
    }
    if (firewall) await powershell('Remove-NetFirewallRule -DisplayName $env:SMOKE_RULE', {SMOKE_RULE:rule});
  }
}

main().catch(error => { console.error(error); process.exitCode=1; });
