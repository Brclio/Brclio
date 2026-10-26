'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { validatePublicCABundle, verifyPackageSecrets } = require('../scripts/windows-verify-package.cjs');

const bundlePath = 'resources/xhs-python/_internal/certifi/cacert.pem';
const roots = require('node:tls').rootCertificates;
const publicCA = Buffer.from(`# Public CA fixture\n${roots[0]}\n`);

test('Windows package permits only the exact certifi public CA bundle path', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'brclio-package-secrets-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filename = path.join(directory, bundlePath);
  await fs.mkdir(path.dirname(filename), { recursive: true });
  await fs.writeFile(filename, publicCA);
  const permitted = verifyPackageSecrets(directory, [bundlePath, 'Brclio.exe'], ['/desktop/main.cjs']);
  assert.equal(permitted[0].filename, bundlePath);
  assert.equal(permitted[0].certificates, 1);
  assert.match(permitted[0].sha256, /^[a-f0-9]{64}$/);
  for (const name of ['resources/cacert.pem', 'resources/xhs-python/cacert.pem',
    'resources/xhs-python/_internal/certifi/other.pem', 'resources/xhs-python/_internal/certifi/CACERT.PEM',
    'resources/key.pem', 'resources/signing.key', 'resources/private.pfx', 'resources/private.p12',
    'resources/private.jks', 'resources/private.keystore']) {
    assert.throws(() => verifyPackageSecrets(directory, [name], []), /possible private key/);
  }
  assert.throws(() => verifyPackageSecrets(directory, [], ['/' + bundlePath]), /possible private key/);
});

test('certifi path cannot disguise a private key, malformed certificate, or mixed data', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'brclio-ca-content-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filename = path.join(directory, bundlePath); await fs.mkdir(path.dirname(filename), { recursive: true });
  for (const value of [
    '-----BEGIN PRIVATE KEY-----\nZmFrZQ==\n-----END PRIVATE KEY-----\n',
    publicCA.toString() + '\n-----BEGIN RSA PRIVATE KEY-----\nZmFrZQ==\n-----END RSA PRIVATE KEY-----\n',
    '-----BEGIN CERTIFICATE-----\nZmFrZQ==\n-----END CERTIFICATE-----\n',
    publicCA.toString() + '\nnot a certificate\n',
    publicCA.toString() + '\n\0', '', '# no certificates\n',
  ]) {
    await fs.writeFile(filename, value);
    assert.throws(() => verifyPackageSecrets(directory, [bundlePath], []));
  }
  assert.equal(validatePublicCABundle(Buffer.from(roots.join('\n') + '\n')).certificates, roots.length);
});
