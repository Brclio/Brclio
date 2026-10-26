'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const check = require('../scripts/check-xhs-runtime.cjs');

test('packaging rejects missing, wrong-architecture, and stale Python workers', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'brclio-xhs-package-'));
  // Choose a different host platform: foreign binaries must not be executed.
  const platform = process.platform === 'win32' ? 'darwin' : 'win32';
  const target = platform === 'win32' ? 'win' : 'mac';
  const runtime = path.join(root, 'runtime', `${target}-x64`);
  const context = { electronPlatformName: platform, arch: 'x64', packager: { projectDir: root } };
  try {
    await assert.rejects(check(context), /缺少/);
    await fs.mkdir(path.join(runtime, 'python'), { recursive: true });
    await fs.writeFile(path.join(runtime, 'python', platform === 'win32' ? 'xhs-python.exe' : 'xhs-python'), 'fixture');
    const hash = createHash('sha256');
    for (const filename of ['python-worker.py', 'api/python_parse.py', 'api/python_image.py', 'api/python_video.py']) {
      const absolute = path.join(root, 'desktop/xhs', filename);
      await fs.mkdir(path.dirname(absolute), { recursive: true });
      await fs.writeFile(absolute, filename);
      hash.update(filename); hash.update(filename);
    }
    const info = { platform, arch: 'arm64', sourceSha256: hash.digest('hex') };
    const writeInfo = () => fs.writeFile(path.join(runtime, 'build-info.json'), JSON.stringify(info));
    await writeInfo();
    await assert.rejects(check(context), /架构/);
    info.arch = 'x64'; await writeInfo();
    await check(context);
    await fs.appendFile(path.join(root, 'desktop/xhs/api/python_parse.py'), '# changed');
    await assert.rejects(check(context), /源码已更新/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
