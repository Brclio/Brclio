'use strict';

// Real macOS package replacement in a private temporary directory. Network
// metadata is mocked; the DMG, native installer, detached helper and new GUI are
// real. The old fixture uses current source with an older version number; it is
// deliberately not described as an historical release's update capability.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { _electron: electron, expect } = require('@playwright/test');
const { bundleInfo, verifyBundle, identity } = require('./mac-installer-helper.cjs');

const run = promisify(execFile);
const root = path.join(__dirname, '..');
const argument = name => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; };
const targetVersion = argument('--version') || require('../package.json').version;
const oldVersion = argument('--old-version') || '0.1.2';
const architecture = process.arch;
const oldSource = path.resolve(argument('--old-app') || process.env.BRCLIO_UPDATE_OLD_APP || path.join(root, 'artifacts', 'update-old', architecture === 'arm64' ? 'mac-arm64' : 'mac', 'Brclio.app'));
const dmg = path.resolve(argument('--dmg') || path.join(root, 'release', `Brclio-${targetVersion}-mac-${architecture}.dmg`));
const reportPath = path.resolve(argument('--report') || path.join(root, 'artifacts', 'mac-update-smoke.json'));
const report = { platform: process.platform, architecture, targetVersion, oldVersion,
  actualNativePackage: true, networkMetadataMocked: true, historicalOldReleaseTested: false,
  applicationsFolderModified: false, gatekeeperFirstOpenTested: false, checks: [], passed: false };
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const LSREGISTER = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';

async function poll(callback, timeout = 180000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await callback();
    if (result) return result;
    await pause(100);
  }
  throw new Error('Timed out waiting for the real macOS update transaction.');
}

async function main() {
  assert.equal(process.platform, 'darwin', 'This test requires macOS.');
  assert.match(targetVersion, /^\d+\.\d+\.\d+$/);
  assert.notEqual(oldVersion, targetVersion, 'A newer real package is required.');
  const sourceInfo = await bundleInfo(oldSource);
  assert.equal(sourceInfo.CFBundleShortVersionString, oldVersion, 'Build a private current-source fixture with the requested older extraMetadata.version.');
  const temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'Brclio 更新验收 space ')));
  const installation = path.join(temporary, "安装位置 中文 & ' space");
  const applicationPath = path.join(installation, 'Brclio.app');
  const executable = path.join(applicationPath, 'Contents', 'MacOS', 'Brclio');
  const userData = path.join(temporary, '独立用户资料 space');
  let application;
  let job;
  let newPid;
  let safeToClean = true;
  try {
    await fs.mkdir(installation, { mode: 0o700 });
    await fs.mkdir(userData, { mode: 0o700 });
    await run('/usr/bin/ditto', ['--rsrc', '--extattr', '--acl', oldSource, applicationPath], { timeout: 300000 });
    await verifyBundle(applicationPath, { version: oldVersion, architecture, job: temporary });
    const oldIdentity = identity(await fs.lstat(applicationPath));
    const oldExecutableIdentity = identity(await fs.lstat(executable));
    const size = (await fs.stat(dmg)).size;
    const hash = crypto.createHash('sha256');
    for await (const chunk of require('node:fs').createReadStream(dmg)) hash.update(chunk);
    const expected = hash.digest('hex');
    report.package = { path: dmg, size, sha256: expected };
    application = await electron.launch({ executablePath: executable, args: [], cwd: root, timeout: 45000,
      env: { ...process.env, BRCLIO_USER_DATA: userData } });
    const oldPid = application.process().pid;
    const page = await application.firstWindow();
    await page.waitForURL('file://**/web/index.html');
    await page.waitForFunction(() => document.body.dataset.initialized === 'true');
    assert.equal(await application.evaluate(({ app }) => app.getVersion()), oldVersion);
    await page.evaluate(async () => {
      const current = await window.brclio.getSettings();
      await window.brclio.saveSettings({ ...current, quoteMode: 'double', separator: 'forward', trailingSlash: true });
    });
    const settingsFile = path.join(userData, 'settings.json');
    const settingsBefore = await fs.readFile(settingsFile);
    await fs.writeFile(path.join(userData, 'keep-user-file.txt'), 'preserve user files exactly');
    report.checks.push('Real signed old fixture launched from a private Unicode/space/metacharacter application path; native renderer initialized.');

    await application.evaluate(({ net }, fixture) => {
      const assetName = `Brclio-${fixture.version}-mac-${fixture.architecture}.dmg`;
      const prefix = `https://github.com/Brclio/Brclio/releases/download/v${fixture.version}/`;
      const release = { tag_name: `v${fixture.version}`, draft: false, prerelease: false, body: '真实 macOS 更新验收。', assets: [
        { name: assetName, size: fixture.size, browser_download_url: prefix + assetName, digest: `sha256:${fixture.expected}` },
        { name: 'SHA256SUMS.txt', size: 128, browser_download_url: prefix + 'SHA256SUMS.txt' },
      ] };
      globalThis.__macInstallSmokeRequests = [];
      net.fetch = async url => {
        globalThis.__macInstallSmokeRequests.push(url);
        if (url === 'https://api.github.com/repos/Brclio/Brclio/releases/latest') return new Response(JSON.stringify(release));
        if (url === prefix + 'SHA256SUMS.txt') return new Response(`${fixture.expected}  ${assetName}\n`);
        if (url === prefix + assetName) return new Response(require('node:stream').Readable.toWeb(require('node:fs').createReadStream(fixture.dmg)));
        throw new Error('Unexpected update request: ' + url);
      };
    }, { version: targetVersion, architecture, dmg, size, expected });
    await page.click('[data-view="settings"]');
    await page.click('#check-update');
    await expect(page.locator('#update-status-title')).toHaveText(`v${targetVersion} 已经准备好。`);
    assert.equal(await application.evaluate(() => globalThis.__macInstallSmokeRequests.length), 1);
    await page.click('#download-update');
    const jobsDirectory = path.join(userData, 'updates', 'install-jobs');
    job = await poll(async () => {
      const entries = await fs.readdir(jobsDirectory, { withFileTypes: true }).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
      for (const entry of entries) {
        if (!entry.isDirectory() || !/^mac-[a-f0-9-]{36}$/.test(entry.name)) continue;
        const location = path.join(jobsDirectory, entry.name);
        const cfg = await fs.readFile(path.join(location, 'configuration.json'), 'utf8').then(JSON.parse, () => null);
        if (cfg?.version === targetVersion) return location;
      }
      if (!page.isClosed() && await page.locator('#update-status-title').textContent().catch(() => '') === '这次更新未完成，可以重试。') {
        throw new Error(await page.locator('#update-status-detail').textContent());
      }
      if (application.process().exitCode !== null) throw new Error('Old fixture exited without preparing an update job.');
      return null;
    });
    const configuration = JSON.parse(await fs.readFile(path.join(job, 'configuration.json'), 'utf8'));
    assert.equal(configuration.guiUserData, userData, 'LaunchServices must explicitly forward the isolated profile.');
    const result = await poll(async () => fs.readFile(path.join(job, 'result.json'), 'utf8').then(JSON.parse, () => null), 240000);
    assert.equal(result.status, 'installed', JSON.stringify(result));
    assert.equal(result.launchAcknowledged, true);
    assert.equal(result.version, targetVersion);
    const ack = JSON.parse(await fs.readFile(path.join(job, 'launch-ack.json'), 'utf8'));
    assert.equal(ack.token, configuration.token); assert.equal(ack.version, targetVersion); assert.equal(ack.executable, executable);
    newPid = ack.pid;
    assert.ok(Number.isSafeInteger(newPid) && newPid > 1 && newPid !== oldPid);
    process.kill(newPid, 0);
    assert.equal((await run('/bin/ps', ['-p', String(newPid), '-o', 'comm='])).stdout.trim(), executable);
    await poll(async () => { try { process.kill(oldPid, 0); return null; } catch (error) { if (error.code === 'ESRCH') return true; throw error; } }, 10000);
    assert.notEqual(identity(await fs.lstat(applicationPath)), oldIdentity);
    assert.notEqual(identity(await fs.lstat(executable)), oldExecutableIdentity, 'Signed executable must have a new inode.');
    await verifyBundle(applicationPath, { version: targetVersion, architecture, job: temporary });
    assert.deepEqual(await fs.readFile(settingsFile), settingsBefore);
    assert.equal(await fs.readFile(path.join(userData, 'keep-user-file.txt'), 'utf8'), 'preserve user files exactly');
    if (!result.warning) await assert.rejects(fs.lstat(configuration.backup), { code: 'ENOENT' });
    report.transaction = { result, oldPid, newPid, oldIdentity, newIdentity: identity(await fs.lstat(applicationPath)),
      oldExecutableIdentity, newExecutableIdentity: identity(await fs.lstat(executable)), settingsSHA256: crypto.createHash('sha256').update(settingsBefore).digest('hex'),
      healthyRendererAcknowledged: true, installedVersion: (await bundleInfo(applicationPath)).CFBundleShortVersionString };
    report.checks.push('UI downloaded the real DMG through the mocked official metadata/manifest URLs and verified the real SHA256.');
    report.checks.push('Detached helper waited for old client exit, atomically replaced the whole bundle, then open launched a distinct real new GUI process.');
    report.checks.push('New packaged native renderer/bridge emitted authenticated version/PID/path ACK; helper reported installed after observing it.');
    report.checks.push('Main executable inode changed, installed main/extension strict signatures remained valid, settings bytes and unrelated user file were preserved.');
    report.passed = true;
    console.log('PASS real macOS DMG UI update, whole-bundle replacement, automatic new GUI launch, native health ACK and byte-for-byte settings preservation.');
  } finally {
    // The Playwright connection belongs only to the old fixture; replacement
    // deliberately creates a separate GUI process through LaunchServices.
    if (application && application.process().exitCode === null) await application.close().catch(() => {});
    if (job) {
      const completed = await poll(async () => fs.readFile(path.join(job, 'result.json'), 'utf8').then(JSON.parse, () => null), 180000).catch(() => null);
      safeToClean = Boolean(completed);
      if (!safeToClean) report.cleanupWarning = 'No terminal helper receipt; isolated files retained to avoid deleting an active transaction.';
    }
    const listing = (await run('/bin/ps', ['-axo', 'pid=,comm='])).stdout;
    const owned = listing.split('\n').flatMap(line => {
      const match = /^\s*(\d+)\s+(.+)$/.exec(line); const pid = Number(match?.[1]);
      return pid > 1 && match?.[2]?.startsWith(installation + path.sep) ? [pid] : [];
    });
    if (safeToClean) {
      for (const pid of owned) { try { process.kill(pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; } }
      await pause(700);
      for (const pid of owned) {
        const current = await run('/bin/ps', ['-p', String(pid), '-o', 'comm=']).then(result => result.stdout.trim(), () => '');
        if (current.startsWith(installation + path.sep)) { try { process.kill(pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; } }
      }
      // Remove only fixture paths. Never change the identifier-wide election or
      // unregister the user's real /Applications/Brclio.app extension.
      const registrations = await run('/usr/bin/pluginkit', ['-m', '-A', '-D', '-v', '-i', 'com.brclio.toolbox.finder-sync']).then(result => result.stdout, () => '');
      for (const line of registrations.split('\n')) {
        const location = line.split('\t').at(-1);
        if (location?.startsWith(installation + path.sep)) await run('/usr/bin/pluginkit', ['-r', location], { timeout: 10000 }).catch(() => {});
      }
      await run(LSREGISTER, ['-u', applicationPath], { timeout: 10000 }).catch(() => {});
      await fs.rm(temporary, { recursive: true, force: true });
      report.fixtureCleaned = true;
    } else report.retainedFixture = temporary;
  }
}

main().catch(error => { report.error = error.stack; console.error(error.stack); process.exitCode = 1; }).finally(async () => {
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2));
});
