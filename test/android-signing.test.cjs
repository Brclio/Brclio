'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, writeFile, readdir, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { createHash } = require('node:crypto');
const helper = import('../scripts/verify-android-signing.mjs');
const fingerprint = 'a'.repeat(64), otherFingerprint = 'b'.repeat(64);
const bytes = Buffer.from('offline APK fixture; never executed');
function release() {
  return { id: 10, url: 'https://api.github.com/repos/Brclio/Brclio/releases/10', html_url: 'https://github.com/Brclio/Brclio/releases/tag/v0.1.10',
    tag_name: 'v0.1.10', draft: false, prerelease: false, published_at: '2026-10-19T14:05:11Z', assets: [{ id: 20, name: 'Brclio-0.1.10-android.apk', state: 'uploaded',
      url: 'https://api.github.com/repos/Brclio/Brclio/releases/assets/20', browser_download_url: 'https://github.com/Brclio/Brclio/releases/download/v0.1.10/Brclio-0.1.10-android.apk',
      size: bytes.length, digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}` }] };
}
test('baseline accepts only an older official stable release with one exact official APK', async () => {
  const { baselineRelease } = await helper;
  assert.equal(baselineRelease(release(), '0.1.11').id, 20);
  for (const mutate of [
    r => { r.draft = true; }, r => { r.prerelease = true; }, r => { r.tag_name = 'v0.1.10-rc1'; }, r => { r.published_at = null; },
    r => { r.url = 'https://api.github.com/repos/other/repo/releases/10'; }, r => { r.html_url += '?redirect=elsewhere'; },
    r => { r.assets.push({ ...r.assets[0], id: 21 }); }, r => { r.assets = []; }, r => { r.assets[0].name = 'debug.apk'; },
    r => { r.assets[0].browser_download_url = 'https://untrusted.example/app.apk'; }, r => { r.assets[0].url = 'https://api.github.com/repos/other/repo/releases/assets/20'; },
    r => { r.assets[0].size = 0; }, r => { r.assets[0].state = 'new'; }, r => { r.assets[0].digest = 'unrecognized'; }
  ]) { const value = release(); mutate(value); assert.throws(() => baselineRelease(value, '0.1.11')); }
  for (const version of ['0.1.10', '0.1.9', '0.1.11-rc1']) assert.throws(() => baselineRelease(release(), version));
});
test('certificate parsing requires one complete SHA-256 fingerprint and rejects ambiguous signers', async () => {
  const { certificateFingerprint } = await helper;
  assert.equal(certificateFingerprint(`Signer #1 certificate DN: public certificate\nSigner #1 certificate SHA-256 digest: ${fingerprint.toUpperCase()}\n`), fingerprint);
  assert.equal(certificateFingerprint(`Signer #1 certificate SHA-256 digest: ${fingerprint.match(/../g).join(':')}\r\n`), fingerprint);
  for (const value of ['', `Signer #1 certificate SHA-256 digest: ${fingerprint.slice(1)}`, `Signer #2 certificate SHA-256 digest: ${fingerprint}`,
    `Signer #1 certificate SHA-256 digest: ${fingerprint}\nSigner #2 certificate SHA-256 digest: invalid`]) assert.throws(() => certificateFingerprint(value));
});
async function fixture(context, { metadata = release(), download = bytes, candidateFingerprint = fingerprint, signerFailure = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'brclio-signing-test-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const apk = join(root, 'candidate.apk'); await writeFile(apk, 'new APK fixture');
  const calls = [];
  const run = async (command, args, options) => {
    calls.push({ command, args, options });
    if (command === 'gh') {
      assert.deepEqual(args.slice(0, 5), ['api', '--hostname', 'github.com', '--method', 'GET']);
      if (args[5] === 'repos/Brclio/Brclio/releases/latest') return { stdout: JSON.stringify(metadata) };
      assert.equal(args[5], 'repos/Brclio/Brclio/releases/assets/20');
      assert.equal(options.encoding, 'buffer'); return { stdout: download };
    }
    assert.equal(command, join(root, 'apksigner'));
    assert.deepEqual(args.slice(0, 2), ['verify', '--print-certs']);
    assert.equal(options.env.GH_TOKEN, undefined); assert.equal(options.env.GITHUB_TOKEN, undefined);
    if (signerFailure) throw new Error('untrusted tool error containing sensitive fixture content');
    return { stdout: `Signer #1 certificate SHA-256 digest: ${args[2] === apk ? candidateFingerprint : fingerprint}\n` };
  };
  return { root, calls, options: { apk, apksigner: join(root, 'apksigner'), version: '0.1.11', tempDir: root }, run };
}
test('offline end-to-end verification pins the official asset ID, verifies both APKs and cleans only its temporary baseline', async context => {
  const { verifyAndroidSigning } = await helper;
  const f = await fixture(context);
  assert.deepEqual(await verifyAndroidSigning(f.options, { run: f.run }), { baselineCertificateSha256: fingerprint, candidateCertificateSha256: fingerprint, match: true });
  assert.equal(f.calls.filter(call => call.command === 'gh').length, 2);
  assert.equal(f.calls.filter(call => call.command !== 'gh').length, 2);
  assert.deepEqual(await readdir(f.root), ['candidate.apk']);
});
test('a different signing certificate blocks publication and still removes the downloaded baseline', async context => {
  const { verifyAndroidSigning } = await helper;
  const f = await fixture(context, { candidateFingerprint: otherFingerprint });
  await assert.rejects(verifyAndroidSigning(f.options, { run: f.run }), error => error.code === 'ANDROID_SIGNING_CERTIFICATE_CHANGED' && error.fingerprints.candidateCertificateSha256 === otherFingerprint);
  assert.deepEqual(await readdir(f.root), ['candidate.apk']);
});
test('truncated or wrong-digest baseline bytes fail before invoking apksigner', async context => {
  const { verifyAndroidSigning } = await helper;
  for (const download of [bytes.subarray(1), Buffer.alloc(bytes.length)]) {
    const f = await fixture(context, { download });
    await assert.rejects(verifyAndroidSigning(f.options, { run: f.run }), /BASELINE_APK_(?:SIZE|DIGEST)_MISMATCH/);
    assert.equal(f.calls.filter(call => call.command !== 'gh').length, 0);
    assert.deepEqual(await readdir(f.root), ['candidate.apk']);
  }
});
test('apksigner nonzero exit fails with a fixed safe error and never leaks tool diagnostics', async context => {
  const { verifyAndroidSigning } = await helper;
  const f = await fixture(context, { signerFailure: true });
  await assert.rejects(verifyAndroidSigning(f.options, { run: f.run }), error => error.code === 'BASELINE_APK_SIGNATURE_INVALID' && !error.message.includes('sensitive'));
  assert.deepEqual(await readdir(f.root), ['candidate.apk']);
});
