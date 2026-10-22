import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { lstat, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const REPOSITORY = 'Brclio/Brclio';
const API = `https://api.github.com/repos/${REPOSITORY}`;
const WEB = `https://github.com/${REPOSITORY}`;
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const MAX_APK_BYTES = 256 * 1024 * 1024;
const execute = promisify(execFile);

export class AndroidSigningError extends Error {
  constructor(code, fingerprints) { super(code); this.code = code; this.fingerprints = fingerprints; }
}
function requireValue(value, code) { if (!value) throw new AndroidSigningError(code); }
function validVersion(value) { return typeof value === 'string' && value.length <= 40 && VERSION.test(value); }
function older(left, right) {
  const a = left.split('.').map(BigInt), b = right.split('.').map(BigInt);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i];
  return false;
}
export function baselineRelease(release, candidateVersion) {
  requireValue(validVersion(candidateVersion), 'INVALID_CANDIDATE_VERSION');
  const version = typeof release?.tag_name === 'string' && release.tag_name.startsWith('v') ? release.tag_name.slice(1) : '';
  requireValue(validVersion(version) && release.draft === false && release.prerelease === false &&
    typeof release.published_at === 'string' && Number.isFinite(Date.parse(release.published_at)), 'BASELINE_NOT_A_PUBLISHED_STABLE_RELEASE');
  requireValue(older(version, candidateVersion), 'BASELINE_MUST_PRECEDE_CANDIDATE');
  requireValue(Number.isSafeInteger(release.id) && release.id > 0 && release.url === `${API}/releases/${release.id}` &&
    release.html_url === `${WEB}/releases/tag/v${version}`, 'BASELINE_REPOSITORY_MISMATCH');
  requireValue(Array.isArray(release.assets), 'BASELINE_ASSETS_MISSING');
  const apks = release.assets.filter(asset => typeof asset?.name === 'string' && /\.apk$/i.test(asset.name));
  requireValue(apks.length === 1, 'BASELINE_REQUIRES_EXACTLY_ONE_APK');
  const asset = apks[0];
  requireValue(Number.isSafeInteger(asset.id) && asset.id > 0 && asset.state === 'uploaded' &&
    Number.isSafeInteger(asset.size) && asset.size > 0 && asset.size <= MAX_APK_BYTES &&
    asset.name === `Brclio-${version}-android.apk` && asset.url === `${API}/releases/assets/${asset.id}` &&
    asset.browser_download_url === `${WEB}/releases/download/v${version}/${asset.name}`, 'BASELINE_APK_METADATA_INVALID');
  requireValue(asset.digest == null || typeof asset.digest === 'string' && /^sha256:[a-f0-9]{64}$/.test(asset.digest), 'BASELINE_APK_DIGEST_INVALID');
  return asset;
}
export function certificateFingerprint(output) {
  requireValue(typeof output === 'string' && output.length <= 256 * 1024, 'SIGNER_OUTPUT_INVALID');
  const lines = output.split(/\r?\n/).filter(line => /^Signer #\d+ certificate SHA-256 digest:/.test(line));
  requireValue(lines.length === 1, 'EXACTLY_ONE_ANDROID_SIGNER_REQUIRED');
  const match = /^Signer #1 certificate SHA-256 digest:\s*([a-fA-F0-9:]+)\s*$/.exec(lines[0]);
  const fingerprint = match?.[1].replaceAll(':', '').toLowerCase();
  requireValue(fingerprint && /^[a-f0-9]{64}$/.test(fingerprint), 'SIGNER_SHA256_INVALID');
  return fingerprint;
}
async function runCommand(command, args, options) {
  return execute(command, args, { ...options, windowsHide: true });
}
function childEnvironment(github) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^ANDROID_(?:KEYSTORE|SIGNING)_/.test(key) || /^(?:DEBUG|GH_DEBUG|NODE_DEBUG|NODE_OPTIONS|SSLKEYLOGFILE)$/.test(key) ||
      !github && /^(?:GH_TOKEN|GITHUB_TOKEN|GH_ENTERPRISE_TOKEN|GITHUB_ENTERPRISE_TOKEN)$/.test(key)) delete env[key];
  }
  return env;
}
async function commandOutput(run, command, args, options, code) {
  try { return (await run(command, args, options)).stdout; }
  catch { throw new AndroidSigningError(code); }
}
export async function verifyAndroidSigning({ apk, apksigner, version, tempDir }, { run = runCommand } = {}) {
  requireValue(validVersion(version) && typeof apk === 'string' && typeof apksigner === 'string' &&
    typeof tempDir === 'string' && tempDir.length > 0, 'INVALID_VERIFICATION_ARGUMENTS');
  const candidate = resolve(apk), signer = resolve(apksigner);
  const info = await lstat(candidate);
  requireValue(info.isFile() && !info.isSymbolicLink() && info.size > 0, 'CANDIDATE_APK_MISSING');
  const ghOptions = { encoding: 'utf8', timeout: 120000, maxBuffer: 1024 * 1024, env: childEnvironment(true) };
  const apiArgs = ['api', '--hostname', 'github.com', '--method', 'GET'];
  const raw = await commandOutput(run, 'gh', [...apiArgs, `repos/${REPOSITORY}/releases/latest`, '--header', 'Accept: application/vnd.github+json'], ghOptions, 'BASELINE_METADATA_READ_FAILED');
  let metadata;
  try { metadata = JSON.parse(raw); } catch { throw new AndroidSigningError('BASELINE_METADATA_INVALID_JSON'); }
  const asset = baselineRelease(metadata, version);
  // Pin the asset ID from the validated official release; never use an arbitrary URL.
  const bytes = await commandOutput(run, 'gh', [...apiArgs, `repos/${REPOSITORY}/releases/assets/${asset.id}`, '--header', 'Accept: application/octet-stream'],
    { ...ghOptions, encoding: 'buffer', maxBuffer: asset.size + 1 }, 'BASELINE_APK_DOWNLOAD_FAILED');
  requireValue(Buffer.isBuffer(bytes) && bytes.length === asset.size, 'BASELINE_APK_SIZE_MISMATCH');
  if (asset.digest) requireValue(`sha256:${createHash('sha256').update(bytes).digest('hex')}` === asset.digest, 'BASELINE_APK_DIGEST_MISMATCH');
  const folder = await mkdtemp(join(resolve(tempDir), 'brclio-android-signing-'));
  try {
    const baseline = join(folder, 'baseline.apk');
    await writeFile(baseline, bytes, { mode: 0o600, flag: 'wx' });
    const signerOptions = { encoding: 'utf8', timeout: 60000, maxBuffer: 256 * 1024, env: childEnvironment(false) };
    const baselineCertificateSha256 = certificateFingerprint(await commandOutput(run, signer, ['verify', '--print-certs', baseline], signerOptions, 'BASELINE_APK_SIGNATURE_INVALID'));
    const candidateCertificateSha256 = certificateFingerprint(await commandOutput(run, signer, ['verify', '--print-certs', candidate], signerOptions, 'CANDIDATE_APK_SIGNATURE_INVALID'));
    const fingerprints = { baselineCertificateSha256, candidateCertificateSha256 };
    if (baselineCertificateSha256 !== candidateCertificateSha256) throw new AndroidSigningError('ANDROID_SIGNING_CERTIFICATE_CHANGED', fingerprints);
    return { ...fingerprints, match: true };
  } finally { await rm(folder, { recursive: true, force: true }); }
}
export async function main(argv = process.argv.slice(2)) {
  try {
    const flags = new Map([['--apk', 'apk'], ['--apksigner', 'apksigner'], ['--version', 'version'], ['--temp-dir', 'tempDir']]);
    const options = {};
    for (let i = 0; i < argv.length; i += 2) {
      const key = flags.get(argv[i]);
      requireValue(key && !Object.hasOwn(options, key) && typeof argv[i + 1] === 'string' && !argv[i + 1].startsWith('--'), 'INVALID_VERIFICATION_ARGUMENTS');
      options[key] = argv[i + 1];
    }
    requireValue(Object.keys(options).length === flags.size, 'INVALID_VERIFICATION_ARGUMENTS');
    console.log(JSON.stringify(await verifyAndroidSigning(options)));
    return 0;
  } catch (error) {
    console.error(JSON.stringify({ ok: false, code: error instanceof AndroidSigningError ? error.code : 'ANDROID_SIGNING_VERIFICATION_FAILED',
      ...(error instanceof AndroidSigningError && error.fingerprints ? error.fingerprints : {}) }));
    return 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exitCode = await main();
