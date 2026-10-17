'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { manifestVersion, renderManifest } = require('../../scripts/windows-build-shell.cjs');
const afterPack = require('../../scripts/windows-after-pack.cjs');

test('Windows packaging hook rejects unsupported architectures before compiling', async () => {
  await afterPack({ electronPlatformName: 'darwin' });
  for (const arch of [0, 3, undefined, 'ia32', 'arm64']) {
    await assert.rejects(afterPack({ electronPlatformName: 'win32', arch }), /x64 application build/);
  }
});

test('manifest supports native x64 packaged COM and all three Explorer contexts', () => {
  const manifest = renderManifest('0.1.6', 'CN=Brclio');
  assert.match(manifest, /<Identity Name="Brclio.Toolbox.Shell" Publisher="CN=Brclio"\s+Version="0\.1\.6\.0" ProcessorArchitecture="x64"/);
  assert.match(manifest, /<uap10:AllowExternalContent>true<\/uap10:AllowExternalContent>/);
  assert.match(manifest, /Executable="Brclio\.exe"/);
  assert.match(manifest, /<com:SurrogateServer/);
  assert.match(manifest, /Path="resources\\windows-shell\\0\.1\.6\.0\\BrclioExplorerCommand\.dll" ThreadingModel="STA"/);
  for (const type of ['*', 'Directory', 'Directory\\Background']) {
    assert.ok(manifest.includes(`<desktop5:ItemType Type="${type}">`));
  }
  assert.equal((manifest.match(/Clsid="CFD1E4D4-3973-45D3-8542-45A77E6C58C9"/g) || []).length, 3);
  assert.equal((manifest.match(/<desktop5:Verb/g) || []).length, 3);
  assert.doesNotMatch(manifest, /__VERSION__/);
});

test('manifest publisher is escaped and Appx version components are bounded', () => {
  assert.equal(manifestVersion('65535.0.42'), '65535.0.42.0');
  for (const version of ['1.2', '1.2.3.4', '1.2.3-beta', '65536.1.2', '01.2.3', '<bad>']) {
    assert.throws(() => manifestVersion(version));
  }
  assert.ok(renderManifest('1.2.3', 'CN=A&B, O="Tools"').includes('Publisher="CN=A&amp;B, O=&quot;Tools&quot;"'));
  assert.throws(() => renderManifest('1.2.3', 'CN=A\nB'));
});

test('sparse package logo assets have the Windows manifest dimensions', () => {
  for (const [name, size] of [['StoreLogo', 50], ['Square44x44Logo', 44], ['Square150x150Logo', 150]]) {
    const bytes = fs.readFileSync(path.join(__dirname, 'Assets', `${name}.png`));
    assert.equal(bytes.toString('hex', 0, 8), '89504e470d0a1a0a');
    assert.equal(bytes.readUInt32BE(16), size);
    assert.equal(bytes.readUInt32BE(20), size);
  }
});
