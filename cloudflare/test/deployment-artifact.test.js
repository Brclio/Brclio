import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile, mkdtemp, rm} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {tmpdir} from 'node:os';
import path from 'node:path';

test('the actual Wrangler upload is one executable module with inlined pages and no auxiliary parts', async () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const temporary = await mkdtemp(path.join(tmpdir(), 'brclio-upload-contract-'));
  const formFile = path.join(temporary, 'upload.bin');
  let runtime;
  try {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
      !/^(?:CLOUDFLARE_|CF_|GITHUB_|GH_|DEBUG$|NODE_DEBUG|NODE_OPTIONS$|SSLKEYLOGFILE$)/.test(key)));
    env.WRANGLER_SEND_METRICS = 'false';
    execFileSync(process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'deploy', '--dry-run', '--outfile', formFile],
      {cwd: root, env, stdio: 'pipe', timeout: 45000});
    const bytes = await readFile(formFile);
    const boundary = bytes.subarray(0, bytes.indexOf('\r\n')).toString().slice(2);
    const form = await new Response(bytes, {headers: {'Content-Type': 'multipart/form-data; boundary=' + boundary}}).formData();
    const metadata = JSON.parse(form.get('metadata'));
    const modules = [];
    for (const [name, file] of form) {
      if (name === 'metadata') continue;
      assert.notEqual(file.type, 'application/source-map', 'A source-map upload can invalidate the running Worker.');
      assert.ok(!name.endsWith('.map'), 'No source-map auxiliary part may enter a deployment.');
      assert.ok(path.resolve(temporary, name).startsWith(temporary + path.sep) && !name.includes('\\'), 'Unexpected module filename.');
      const type = file.type === 'text/plain' ? 'Text' : file.type === 'application/javascript+module' ? 'ESModule' : null;
      assert.ok(type, 'Only the existing script and text modules are expected.');
      modules.push({type, path: path.join(temporary, name), contents: await file.text()});
    }
    assert.equal(metadata.main_module, 'brclio-client-services.mjs');
    assert.equal(modules.filter(item => item.type === 'ESModule').length, 1);
    assert.equal(modules.length, 1, 'Only the prebuilt module may enter an upload.');
    const require = createRequire(new URL('../package.json', import.meta.url));
    const {Miniflare, convertV4MiniflareOptions, Log, LogLevel} = require('miniflare');
    let outbound = 0;
    runtime = new Miniflare(convertV4MiniflareOptions({
      modules, modulesRoot: temporary,
      compatibilityDate: metadata.compatibility_date, compatibilityFlags: metadata.compatibility_flags,
      bindings: {...Object.fromEntries(metadata.bindings.filter(item => item.type === 'plain_text').map(item => [item.name,item.text])),
        SESSION_SECRET: 'synthetic-deployment-test-session-secret'},
      ratelimits: Object.fromEntries(metadata.bindings.filter(item => item.type === 'ratelimit').map(item => [item.name,
        {namespace_id:item.namespace_id,simple:item.simple}])),
      cf: false, log: new Log(LogLevel.NONE),
      outboundService: async () => {outbound++; throw new Error('Unexpected external request');}
    }));
    for (const host of ['tools.brclio.com', 'brclio-client-services.aiyuechuang.workers.dev']) {
      const response = await runtime.dispatchFetch(`https://${host}/api/health`);
      assert.equal(response.status, 200);
      assert.equal((await response.json()).service, 'brclio-client-services');
    }
    const home = await runtime.dispatchFetch('https://tools.brclio.com/');
    assert.equal(home.status, 200); assert.match(await home.text(), /Brclio/);
    const account = await runtime.dispatchFetch('https://tools.brclio.com/api/account/session');
    assert.equal(account.status, 200); assert.equal((await account.json()).user, null);
    assert.equal(outbound, 0);
  } finally {if (runtime) await runtime.dispose(); await rm(temporary, {recursive:true,force:true});}
});
