import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile);
const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const options = { dir: 'release', smoke: false, requireNotarized: false };
const valued = new Set(['dir', 'app', 'dmg', 'zip', 'version', 'arch', 'report']);
for (let index = 2; index < process.argv.length; index++) {
  const argument = process.argv[index];
  if (argument === '--smoke') options.smoke = true;
  else if (argument === '--require-notarized') options.requireNotarized = true;
  else if (argument.startsWith('--') && valued.has(argument.slice(2))) {
    const value = process.argv[++index];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${argument}.`);
    options[argument.slice(2)] = value;
  } else throw new Error(`Unknown argument: ${argument}`);
}
if (process.platform !== 'darwin') throw new Error('macOS package verification must run on macOS.');
if (!/^\d+\.\d+\.\d+$/.test(options.version || '')) throw new Error('--version X.Y.Z is required.');
if (!['arm64', 'x64'].includes(options.arch)) throw new Error('--arch arm64|x64 is required.');
options.dir = path.resolve(options.dir);
const defaultApp = path.join(options.dir, options.arch === 'arm64' ? 'mac-arm64' : 'mac', 'Brclio.app');
const inputs = {
  app: path.resolve(options.app || defaultApp),
  dmg: path.resolve(options.dmg || path.join(options.dir, `Brclio-${options.version}-mac-${options.arch}.dmg`)),
  zip: path.resolve(options.zip || path.join(options.dir, `Brclio-${options.version}-mac-${options.arch}.zip`)),
};
const architecture = options.arch === 'x64' ? 'x86_64' : 'arm64';
const report = { verifiedAt: new Date().toISOString(), version: options.version, architecture: options.arch,
  requireNotarized: options.requireNotarized, gatekeeperLaunchTested: false,
  finderExtensionRegistrationTested: false, finderMenuTested: false, inputs, packages: [], errors: [] };

async function command(executable, args, configuration = {}) {
  try {
    const result = await execute(executable, args, { maxBuffer: 4 * 1024 * 1024, timeout: 120000, ...configuration });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return { code: typeof error.code === 'number' ? error.code : 1, stdout: error.stdout || '', stderr: error.stderr || error.message };
  }
}
async function required(executable, args, label) {
  const result = await command(executable, args);
  if (result.code !== 0) throw new Error(`${label}: ${(result.stderr || result.stdout).trim()}`);
  return result;
}
function ensure(condition, message) { if (!condition) throw new Error(message); }

async function inspectFinderExtension(app, item) {
  const extension = path.join(app, 'Contents', 'PlugIns', 'BrclioFinderSync.appex');
  const result = await required('/usr/bin/plutil', ['-convert', 'json', '-o', '-', path.join(extension, 'Contents', 'Info.plist')], 'Read FinderSync Info.plist');
  const info = JSON.parse(result.stdout);
  const details = { bundleId: info.CFBundleIdentifier, version: info.CFBundleShortVersionString,
    buildVersion: info.CFBundleVersion, extensionPoint: info.NSExtension?.NSExtensionPointIdentifier,
    principalClass: info.NSExtension?.NSExtensionPrincipalClass };
  item.finderExtension = details;
  ensure(details.bundleId === 'com.brclio.toolbox.finder-sync', `Wrong FinderSync bundle ID: ${details.bundleId}`);
  ensure(details.version === options.version && details.buildVersion === item.buildVersion,
    `FinderSync version ${details.version} (${details.buildVersion}) differs from containing app ${item.version} (${item.buildVersion}).`);
  ensure(info.CFBundlePackageType === 'XPC!', `Invalid FinderSync package type: ${info.CFBundlePackageType}`);
  ensure(info.CFBundleExecutable === 'BrclioFinderSync', `Invalid FinderSync executable: ${info.CFBundleExecutable}`);
  ensure(details.extensionPoint === 'com.apple.FinderSync', `Wrong FinderSync extension point: ${details.extensionPoint}`);
  ensure(details.principalClass === 'BrclioFinderSync.FinderSync', `Wrong FinderSync principal class: ${details.principalClass}`);
  const executable = path.join(extension, 'Contents', 'MacOS', info.CFBundleExecutable);
  const architectures = (await required('/usr/bin/lipo', ['-archs', executable], 'Read FinderSync architecture')).stdout.trim().split(/\s+/);
  details.architectures = architectures;
  ensure(architectures.length === 1 && architectures[0] === architecture, `Wrong FinderSync architecture: ${architectures.join(', ')}`);
  details.signatureVerification = await command('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=4', extension]);
  ensure(details.signatureVerification.code === 0, `FinderSync signature verification failed: ${(details.signatureVerification.stderr || details.signatureVerification.stdout).trim()}`);
  const description = (await required('/usr/bin/codesign', ['-d', '--verbose=4', extension], 'Read FinderSync signature')).stderr;
  details.signatureDescription = description;
  ensure(/^Identifier=com\.brclio\.toolbox\.finder-sync$/m.test(description), 'Wrong FinderSync signing identifier.');
  ensure(!description.includes('Info.plist=not bound') && !description.includes('Sealed Resources=none'), 'FinderSync bundle resources and Info.plist must be sealed.');
  const parentAdhoc = /^Signature=adhoc$/m.test(item.signatureDescription);
  const childAdhoc = /^Signature=adhoc$/m.test(description);
  details.teamIdentifier = /^TeamIdentifier=(.+)$/m.exec(description)?.[1];
  const parentTeam = /^TeamIdentifier=(.+)$/m.exec(item.signatureDescription)?.[1];
  ensure(parentAdhoc === childAdhoc && details.teamIdentifier === parentTeam, 'FinderSync and its containing app must use the same signing approach and team.');
  const entitlements = await required('/usr/bin/codesign', ['-d', '--entitlements', '-', '--xml', extension], 'Read FinderSync sandbox entitlements');
  const entitlementFile = path.join(temporary, `finder-entitlements-${item.kind}.plist`);
  await fs.writeFile(entitlementFile, entitlements.stdout);
  details.entitlements = JSON.parse((await required('/usr/bin/plutil', ['-convert', 'json', '-o', '-', entitlementFile], 'Parse FinderSync sandbox entitlements')).stdout);
  ensure(details.entitlements['com.apple.security.app-sandbox'] === true, 'FinderSync must retain its own App Sandbox entitlement after parent signing.');
  ensure(details.entitlements['com.apple.security.files.user-selected.read-only'] === true, 'FinderSync must retain user-selected read-only access.');
  ensure(details.entitlements['com.apple.security.inherit'] !== true, 'FinderSync must not inherit the non-sandboxed Electron app entitlements.');
  details.signatureIntegrityPassed = true;
  console.log(`PASS ${item.kind} FinderSync: ${details.bundleId} ${details.version} ${architecture}; strict signature and independent sandbox valid.`);
}

async function inspectApp(app, item) {
  const infoResult = await required('/usr/bin/plutil', ['-convert', 'json', '-o', '-', path.join(app, 'Contents', 'Info.plist')], 'Read Info.plist');
  const info = JSON.parse(infoResult.stdout);
  item.bundleId = info.CFBundleIdentifier;
  item.version = info.CFBundleShortVersionString;
  item.buildVersion = info.CFBundleVersion;
  ensure(item.bundleId === 'com.brclio.toolbox', `Wrong bundle ID: ${item.bundleId}`);
  ensure(item.version === options.version, `Wrong app version: ${item.version}, expected ${options.version}`);
  ensure(typeof info.CFBundleExecutable === 'string' && path.basename(info.CFBundleExecutable) === info.CFBundleExecutable, 'Invalid bundle executable.');
  const schemes = (info.CFBundleURLTypes || []).flatMap(entry => entry.CFBundleURLSchemes || []);
  ensure(schemes.includes('brclio'), 'The containing app must declare the brclio URL scheme used by FinderSync.');

  const executable = path.join(app, 'Contents', 'MacOS', info.CFBundleExecutable);
  const framework = path.join(app, 'Contents', 'Frameworks', 'Electron Framework.framework', 'Electron Framework');
  for (const [label, filename] of [['main', executable], ['framework', framework]]) {
    const result = await required('/usr/bin/lipo', ['-archs', filename], `Read ${label} architecture`);
    const architectures = result.stdout.trim().split(/\s+/);
    item[`${label}Architectures`] = architectures;
    ensure(architectures.length === 1 && architectures[0] === architecture, `Wrong ${label} architecture: ${architectures.join(', ')}`);
  }

  const verify = await command('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=4', app]);
  item.signatureVerification = verify;
  ensure(verify.code === 0, `Strict code-signature verification failed: ${(verify.stderr || verify.stdout).trim()}`);
  const description = await required('/usr/bin/codesign', ['-d', '--verbose=4', app], 'Read code signature');
  item.signatureDescription = description.stderr;
  item.signatureIdentifier = /^Identifier=(.+)$/m.exec(description.stderr)?.[1];
  ensure(item.signatureIdentifier === 'com.brclio.toolbox', `Wrong signing identifier: ${item.signatureIdentifier}`);
  ensure(!description.stderr.includes('Info.plist=not bound') && !description.stderr.includes('Sealed Resources=none'), 'The app has only a linker signature; bundle resources and Info.plist must be sealed.');
  item.signatureIntegrityPassed = true;
  await inspectFinderExtension(app, item);

  const assessment = await command('/usr/sbin/spctl', ['--assess', '--type', 'execute', '--verbose=4', app]);
  item.gatekeeperAssessment = assessment;
  item.gatekeeperAccepted = assessment.code === 0;
  if (options.requireNotarized) {
    ensure(item.gatekeeperAccepted, `Gatekeeper rejected the release: ${(assessment.stderr || assessment.stdout).trim()}`);
    const stapler = await command('/usr/bin/xcrun', ['stapler', 'validate', app]);
    item.staplerValidation = stapler;
    ensure(stapler.code === 0, `A valid stapled notarization ticket is required: ${(stapler.stderr || stapler.stdout).trim()}`);
  }
  console.log(`PASS ${item.kind}: ${item.bundleId} ${item.version} ${architecture}; strict signature valid; Gatekeeper ${item.gatekeeperAccepted ? 'accepted' : 'not trusted'}.`);
}

async function inspect(kind, callback) {
  const item = { kind, source: inputs[kind], signatureIntegrityPassed: false };
  report.packages.push(item);
  try { await callback(item); }
  catch (error) { item.error = error.message; report.errors.push(`${kind}: ${error.message}`); console.error(`FAIL ${kind}: ${error.message}`); }
}

const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'brclio-verify-mac-'));
let mounted = false;
const mount = path.join(temporary, 'disk-image');
const extracted = path.join(temporary, 'zip');
try {
  await inspect('app', item => inspectApp(inputs.app, item));
  await inspect('dmg', async item => {
    item.diskImageVerification = await required('/usr/bin/hdiutil', ['verify', inputs.dmg], 'Verify disk image');
    await fs.mkdir(mount);
    await required('/usr/bin/hdiutil', ['attach', inputs.dmg, '-readonly', '-nobrowse', '-noautoopen', '-mountpoint', mount], 'Mount read-only disk image');
    mounted = true;
    await inspectApp(path.join(mount, 'Brclio.app'), item);
  });
  await inspect('zip', async item => {
    await fs.mkdir(extracted);
    await required('/usr/bin/ditto', ['-x', '-k', inputs.zip, extracted], 'Extract ZIP into temporary directory');
    await inspectApp(path.join(extracted, 'Brclio.app'), item);
    if (options.smoke && !report.errors.length) {
      const smoke = await command(process.execPath, [path.join(project, 'desktop', 'smoke.cjs')], {
        cwd: project, env: { ...process.env, BRCLIO_SMOKE_EXECUTABLE: path.join(extracted, 'Brclio.app', 'Contents', 'MacOS', 'Brclio'), BRCLIO_SMOKE_VERSION: options.version }, timeout: 180000,
      });
      item.nativeSmoke = smoke;
      ensure(smoke.code === 0, `Packaged native smoke failed: ${(smoke.stderr || smoke.stdout).trim()}`);
      item.nativeSmokePassed = true;
      console.log(smoke.stdout.trim());
    }
  });
} finally {
  if (mounted) {
    const detached = await command('/usr/bin/hdiutil', ['detach', mount]);
    if (detached.code !== 0) {
      report.errors.push(`Could not detach temporary disk image: ${detached.stderr}`);
      console.error(`FAIL cleanup: ${detached.stderr}`);
    } else mounted = false;
  }
  // Never recursively delete a directory while its read-only image is mounted.
  if (!mounted) await fs.rm(temporary, { recursive: true, force: true });
  report.passed = report.errors.length === 0;
  if (options.report) {
    const filename = path.resolve(options.report);
    await fs.mkdir(path.dirname(filename), { recursive: true });
    await fs.writeFile(filename, JSON.stringify(report, null, 2) + '\n');
    console.log(`Verification report: ${filename}`);
  }
}
if (!report.passed) process.exitCode = 1;
else console.log(`PASS all macOS package and FinderSync integrity checks${options.smoke ? ' and isolated native smoke' : ''}. This does not claim Finder menu availability or Gatekeeper launch approval.`);
