'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const asar = require('@electron/asar');
const { _electron } = require('playwright');
const metadata = require('../package.json');

async function main() {
  const directory = path.resolve(process.argv[2]);
  const mac = process.platform === 'darwin';
  const resources = path.join(directory, mac ? 'Contents/Resources' : 'resources');
  const executablePath = path.join(directory, mac ? 'Contents/MacOS/Brclio Downloader' : 'Brclio Downloader.exe');
  const archive = path.join(resources, 'app.asar');
  const files = asar.listPackage(archive).map(name => name.replaceAll('\\', '/'));
  assert(!files.includes('/desktop/main.cjs'));
  assert(files.includes('/node_modules/ws/index.js'));
  const sourceFiles = (await fs.readdir('bootstrap')).filter(name =>
    /\.(cjs|js|css|html|json)$/.test(name) && !name.endsWith('.test.cjs') && name !== 'electron-builder.cjs');
  sourceFiles.push('replace-mac.sh', 'replace-win.ps1');
  const sharedFiles = files.filter(name => name.startsWith('/desktop/')).map(name => name.slice(1));
  for (const name of [...sourceFiles.map(file => 'bootstrap/' + file), ...sharedFiles]) {
    const bytes = await fs.readFile(path.resolve(name));
    assert.deepEqual(asar.extractFile(archive, name), bytes, `Packaged source mismatch: ${name}`);
  }
  assert.equal(JSON.parse(asar.extractFile(archive, 'package.json')).version, metadata.version);

  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'brclio-downloader-smoke-'));
  const proxy = http.createServer((_request, response) => {
    response.writeHead(403);
    response.end();
  });
  proxy.on('connect', (_request, socket) => socket.destroy());
  let application;
  try {
    await new Promise((resolve, reject) => {
      proxy.once('error', reject);
      proxy.listen(0, '127.0.0.1', resolve);
    });
    // Route Electron's update requests to a local rejecting proxy even when
    // the host already has a working system proxy.
    application = await _electron.launch({ executablePath, cwd: profile,
      env: { ...process.env, HOME: profile, CFFIXED_USER_HOME: profile, APPDATA: profile },
      args: [`--proxy-server=http://127.0.0.1:${proxy.address().port}`,
        '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1', `--user-data-dir=${profile}`], timeout: 120000 });
    const window = await application.firstWindow({timeout: 30000});
    await window.waitForFunction(expected => document.querySelector('#version')?.textContent === expected, metadata.version);
    const state = await window.evaluate(() => window.downloader.read());
    assert.equal(state.version, metadata.version);
    assert.equal(await window.title(), 'Brclio 下载器');
    console.log(`Packaged downloader ${state.version} opened and preload IPC returned its state.`);
  } finally {
    try { await application?.close(); }
    finally {
      proxy.close();
      await fs.rm(profile, {recursive: true, force: true, maxRetries: 5});
    }
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
