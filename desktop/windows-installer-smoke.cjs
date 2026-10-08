'use strict';

// This intentionally installs real NSIS packages and writes real HKCU keys.
// Run only on an explicitly opted-in disposable Windows CI runner.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { _electron: electron } = require('@playwright/test');
const { createWindowsInstaller } = require('./windows-installer.cjs');
const { parseRelease, checksumFor, compareVersions } = require('./updater.cjs');
const { createIntegration, REGISTRY_KEYS, OWNER } = require('./integration.cjs');
const { createSettingsStore } = require('./settings.cjs');
const { readWindowsEntries } = require('./windows-registry.cjs');

const run = promisify(execFile);
const root = path.join(__dirname, '..');
const reportPath = path.join(root, 'artifacts', 'windows-update-smoke.json');
const report = { platform: process.platform, realNSIS: true, physicalDevice: false, checks: [], passed: false };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

async function poll(callback, timeout = 180000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await callback();
    if (value) return value;
    await wait(100);
  }
  throw new Error('Timed out waiting for the real Windows update flow.');
}

async function downloadBaseline(version, directory) {
  const tag = `v${version}`;
  const release = await fetch(`https://api.github.com/repos/Brclio/Brclio/releases/tags/${tag}`, { headers: { 'User-Agent': 'Brclio-Windows-update-CI' } });
  assert.equal(release.ok, true, `Official baseline release ${tag} is required.`);
  const parsed = parseRelease(await release.json(), 'win32', 'x64');
  assert.equal(parsed.version, version);
  const checksum = await fetch(parsed.checksumURL);
  assert.equal(checksum.ok, true);
  const expected = checksumFor(await checksum.text(), parsed.assetName);
  if (parsed.digest) assert.equal(parsed.digest, expected);
  const response = await fetch(parsed.downloadURL);
  assert.equal(response.ok, true);
  assert.ok(['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(new URL(response.url).hostname));
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(bytes.length, parsed.size);
  assert.equal(hash(bytes), expected, 'Baseline SHA256 must match the official release manifest.');
  const filename = path.join(directory, parsed.assetName);
  await fs.writeFile(filename, bytes);
  report.baseline = { version, assetName: parsed.assetName, sha256: expected };
  return filename;
}

function nsis(executable, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { windowsVerbatimArguments: true, windowsHide: true, stdio: 'ignore' });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`NSIS exited with ${code}.`)));
  });
}

async function main() {
  assert.equal(process.platform, 'win32', 'This smoke requires Windows.');
  assert.equal(process.env.BRCLIO_ALLOW_INSTALL_SMOKE, '1', 'An explicit disposable-runner opt-in is required.');
  assert.ok(process.env.CI, 'Never install this smoke fixture on a normal user computer.');
  const targetVersion = require('../package.json').version;
  const baselineVersion = process.env.BRCLIO_WINDOWS_BASELINE_VERSION || '0.1.2';
  assert.ok(compareVersions(targetVersion, baselineVersion) > 0, 'The target must be newer than the released baseline.');
  const targetInstaller = path.resolve(process.env.BRCLIO_WINDOWS_INSTALLER || path.join(root, 'release', `Brclio-${targetVersion}-windows-x64.exe`));
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'Brclio update 中文 space & '));
  let installDirectory = path.join(temporary, 'Installed Brclio 中文 & path');
  let executable = path.join(installDirectory, 'Brclio.exe');
  const userData = path.join(temporary, 'user-data');
  const reg = path.join(process.env.SystemRoot, 'System32', 'reg.exe');
  const powershell = path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const sentinel = 'HKCU\\Software\\Classes\\*\\shell\\Brclio.UpdateSmokeOtherTool';
  let application;
  let activeJobDirectory;
  const previousData = process.env.BRCLIO_USER_DATA;
  let helper;
  try {
    process.env.BRCLIO_USER_DATA = userData;
    const baselineInstaller = process.env.BRCLIO_WINDOWS_BASELINE_INSTALLER
      ? path.resolve(process.env.BRCLIO_WINDOWS_BASELINE_INSTALLER) : await downloadBaseline(baselineVersion, temporary);
    for (const entry of REGISTRY_KEYS) {
      let exists = false;
      try { await run(reg, ['query', entry.key]); exists = true; } catch (error) { assert.equal(error.code, 1); }
      assert.equal(exists, false, 'The disposable runner must not already contain Brclio context menus.');
    }
    await nsis(baselineInstaller, ['/S', '/currentuser', `/D=${installDirectory}`]);
    report.checks.push('Official old NSIS installed into a Unicode/space/metacharacter directory.');
    await run(reg, ['add', sentinel, '/ve', '/t', 'REG_SZ', '/d', 'unowned sentinel', '/f']);

    async function openClient() {
      application = await electron.launch({ executablePath: executable, args: [], env: { ...process.env, BRCLIO_USER_DATA: userData } });
      const page = await application.firstWindow();
      await page.waitForFunction(() => document.body.dataset.ready === 'true');
      return page;
    }
    await openClient();
    assert.equal(await application.evaluate(({ app }) => app.getVersion()), baselineVersion);
    report.baseline ||= { version: baselineVersion, localFixture: true };
    report.baseline.trustDiagnostics = await application.evaluate(({ app, BrowserWindow }) => {
      const pathname = process.getBuiltinModule('node:path');
      const { pathToFileURL } = process.getBuiltinModule('node:url');
      const window = BrowserWindow.getAllWindows()[0];
      return { appPath: app.getAppPath(), actualURL: window.webContents.getURL(), frameURL: window.webContents.mainFrame.url,
        expectedURL: pathToFileURL(pathname.join(app.getAppPath(), 'web', 'index.html')).href };
    });
    // Seed the legacy installation directly. Its published IPC trust check is
    // known to fail on this Windows path; do not silently patch the old app.
    // The new app still has to render and ACK through its real native bridge.
    const store = createSettingsStore(userData);
    const current = await store.read();
    await store.write({ ...current, quoteMode: 'double', separator: 'forward', trailingSlash: true });
    const baselineIntegration = createIntegration({ launch: { executable, appPath: installDirectory, packaged: true } });
    const seeded = await baselineIntegration.set(true);
    report.baseline.integration = { status: seeded, unicodeValues: await readWindowsEntries(run, powershell) };
    assert.equal(seeded.installed, true, 'The fixture must have actual owned HKCU context menus before upgrading.');
    report.checks.push('Legacy configuration and real owned menu keys were seeded directly; the released baseline IPC bug was not bypassed in the new client.');
    const settingsBefore = await fs.readFile(path.join(userData, 'settings.json'), 'utf8');
    await fs.writeFile(path.join(userData, 'user-sentinel.txt'), 'preserve user files');
    let menuBefore = await readWindowsEntries(run, powershell);
    async function assertPreserved() {
      assert.equal(await fs.readFile(path.join(userData, 'settings.json'), 'utf8'), settingsBefore);
      assert.equal(await fs.readFile(path.join(userData, 'user-sentinel.txt'), 'utf8'), 'preserve user files');
      const menus = await readWindowsEntries(run, powershell);
      assert.deepEqual(menus, menuBefore, 'Exact Unicode menu values must survive the installer and uninstaller.');
      assert.match((await run(reg, ['query', sentinel])).stdout, /unowned sentinel/);
      for (const entry of menus) assert.equal(entry.owner, OWNER);
    }

    async function updateWith(installerFile, requestedVersion) {
      const bytes = await fs.readFile(installerFile);
      const downloadDirectory = path.join(userData, 'updates');
      await fs.mkdir(downloadDirectory, { recursive: true });
      const filename = path.join(downloadDirectory, `Brclio-${requestedVersion}-windows-x64.exe`);
      await fs.writeFile(filename, bytes);
      helper = createWindowsInstaller({ executable, userData, parentPid: application.process().pid, showErrors: false });
      let handoff;
      try {
        handoff = await helper.start({ filename, version: requestedVersion, expected: hash(bytes), size: bytes.length });
      } catch (error) {
        activeJobDirectory = error.jobDirectory;
        report.helperStartup = { error: error.message, result: error.helperResult, output: error.helperOutput };
        throw error;
      }
      const newJob = handoff.jobDirectory;
      activeJobDirectory = newJob;
      await application.close(); application = null;
      const result = await poll(async () => {
        const durable = await fs.readFile(path.join(newJob, 'result.json'), 'utf8').then(JSON.parse, () => null);
        return durable || await helper.readResult();
      }, 240000);
      if (result.status === 'installed') {
        assert.equal(result.launchedVersion, requestedVersion);
        assert.equal(path.win32.resolve(result.launchedExecutable).toLowerCase(), path.win32.resolve(executable).toLowerCase());
        assert.ok(Number.isSafeInteger(result.launchedPid) && result.launchedPid > 0);
        const ack = JSON.parse(await fs.readFile(path.join(newJob, 'launch-ack.json'), 'utf8'));
        assert.equal(ack.pid, result.launchedPid);
        assert.equal(ack.version, result.launchedVersion);
        assert.equal(ack.executable.toLowerCase(), result.launchedExecutable.toLowerCase());
      }
      return result;
    }

    const success = await updateWith(targetInstaller, targetVersion);
    assert.equal(success.status, 'installed', JSON.stringify(success));
    assert.equal(success.version, targetVersion);
    assert.equal(success.launchAcknowledged, true, 'The real packaged client must acknowledge after its renderer/bridge is ready.');
    report.upgrade = success;
    await assertPreserved();
    report.checks.push('Real newer NSIS silently replaced the old install at exactly the same path; packaged client acknowledged readiness.');
    report.checks.push('Settings, user files, owned context-menu commands and unrelated menu keys survived the old uninstaller.');

    // Locate and stop only this fixture's newly launched application, then attach
    // Playwright to another launch of the exact installed executable for failure.
    const stop = path.join(temporary, 'stop-fixture.ps1');
    await fs.writeFile(stop, 'param([string]$Executable)\nGet-Process | Where-Object { $_.Path -eq $Executable } | ForEach-Object { Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue }\n');
    await run(powershell, ['-NoProfile', '-NonInteractive', '-File', stop, executable]);
    await wait(1000);
    await openClient();
    assert.equal(await application.evaluate(({ app }) => app.getVersion()), targetVersion);
    // Negative real-NSIS fixture: a genuine older installer intentionally labeled
    // as the target is hash-verified locally. It must fail version verification,
    // restore the newer app/files/registration, and never report success.
    const failure = await updateWith(baselineInstaller, targetVersion);
    assert.equal(failure.status, 'error', JSON.stringify(failure));
    assert.equal(failure.phase, 'verifying-install');
    assert.equal(failure.rollbackSucceeded, true);
    report.rollback = failure;
    await assertPreserved();
    await run(powershell, ['-NoProfile', '-NonInteractive', '-File', stop, executable]);
    await wait(1000);
    await openClient();
    assert.equal(await application.evaluate(({ app }) => app.getVersion()), targetVersion, 'Rollback must restore the exact previous working version.');
    report.checks.push('Real wrong-version NSIS was rejected after installation; old files/registration were restored and the previous client reopened.');

    // The newly built installer/uninstaller must also handle a legitimate
    // apostrophe. The old released uninstaller embeds paths in script source,
    // so this case intentionally uses only the fixed current NSIS package.
    await application.close(); application = null;
    await nsis(path.join(installDirectory, 'Uninstall Brclio.exe'), ['/S', '/currentuser']);
    installDirectory = path.join(temporary, "A user's Brclio 中文 & path");
    executable = path.join(installDirectory, 'Brclio.exe');
    await nsis(targetInstaller, ['/S', '/currentuser', `/D=${installDirectory}`]);
    const quotedPage = await openClient();
    assert.equal(await application.evaluate(({ app }) => app.getVersion()), targetVersion);
    await quotedPage.evaluate(() => window.brclio.setIntegration(true));
    menuBefore = await readWindowsEntries(run, powershell);
    const reinstall = await updateWith(targetInstaller, targetVersion);
    assert.equal(reinstall.status, 'installed', JSON.stringify(reinstall));
    assert.equal(reinstall.launchAcknowledged, true);
    report.sameVersionReinstall = reinstall;
    await assertPreserved();
    report.checks.push('The fixed NSIS installer and uninstaller performed a real same-version replacement in an apostrophe/Unicode/space/metacharacter path.');
    report.passed = true;
    console.log('PASS real Windows NSIS upgrade, packaged launch ACK, settings/menus preservation, and actual installation rollback (GitHub Windows runner; not a physical-device test).');
  } finally {
    await helper?.cancelPending().catch(() => {});
    if (application) await application.close().catch(() => {});
    // A failed assertion can happen while the detached installer is working.
    // Request cancellation before quitting, then wait for its receipt before
    // uninstalling; never run two NSIS processes against the same directory.
    let safeToClean = true;
    if (activeJobDirectory) {
      const finalResult = await poll(async () => fs.readFile(path.join(activeJobDirectory, 'result.json'), 'utf8').then(JSON.parse, () => null), 120000).catch(() => null);
      report.helperDiagnostics ||= [];
      report.helperDiagnostics.push({
        result: finalResult,
        ready: await fs.readFile(path.join(activeJobDirectory, 'ready.json'), 'utf8').then(JSON.parse, () => null),
        output: (await fs.readFile(path.join(activeJobDirectory, 'helper-output.log'), 'utf8').catch(() => '')).slice(-16 * 1024),
      });
      safeToClean = Boolean(finalResult && !finalResult.installerStillRunning);
      if (!safeToClean) report.cleanupWarning = 'Installer completion was not confirmed; the isolated runner fixture was retained to avoid concurrent uninstall.';
    }
    const stop = path.join(temporary, 'cleanup.ps1');
    await fs.writeFile(stop, 'param([string]$Executable)\nGet-Process | Where-Object { $_.Path -eq $Executable } | ForEach-Object { Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue }\n').catch(() => {});
    if (safeToClean) {
      await run(powershell, ['-NoProfile', '-NonInteractive', '-File', stop, executable]).catch(() => {});
      const uninstaller = path.join(installDirectory, 'Uninstall Brclio.exe');
      await nsis(uninstaller, ['/S', '/currentuser']).catch(() => {});
      await run(reg, ['delete', sentinel, '/f']).catch(() => {});
      await fs.rm(temporary, { recursive: true, force: true }).catch(() => {});
    }
    if (previousData === undefined) delete process.env.BRCLIO_USER_DATA; else process.env.BRCLIO_USER_DATA = previousData;
  }
}

main().catch(error => { report.error = error.stack; console.error(error.stack); process.exitCode = 1; }).finally(async () => {
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2));
});
