import {build} from 'esbuild';
import {mkdir, writeFile, readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
const root = fileURLToPath(new URL('..', import.meta.url));
const output = new URL('../dist/browser/', import.meta.url);
await mkdir(output, {recursive: true});
const result = await build({
  absWorkingDir: root,
  entryPoints: ['src/worker.js'],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  minify: true,
  legalComments: 'inline',
  loader: {'.html': 'text', '.txt': 'text'},
  plugins: [{name: 'workers-node-builtins', setup(builder) {
    builder.onResolve({filter: /^crypto$/}, () => ({path: 'node:crypto', external: true}));
  }}]
});
const bundle = result.outputFiles[0].contents;
const filename = 'brclio-client-services.mjs';
await writeFile(new URL(filename, output), bundle);
const packageJSON = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const manifest = {
  worker: packageJSON.name,
  accountId: 'cacceff607775c81f667b7a951d4639f',
  displayName: 'Brclio客户端服务',
  generatedAt: new Date().toISOString(),
  filename,
  format: 'esm',
  bytes: bundle.length,
  sha256: createHash('sha256').update(bundle).digest('hex'),
  compatibilityDate: '2026-10-18',
  compatibilityFlags: ['nodejs_compat', 'global_fetch_strictly_public'],
  secrets: ['ADMIN_EMAIL', 'ADMIN_PASSWORD', 'SESSION_SECRET', 'GITHUB_TOKEN', 'GITHUB_DATA_REPOSITORY', 'PROXY_SUBSCRIPTION_URL'],
  rateLimits: [
    {name: 'LOGIN_LIMITER', namespaceId: '1001', limit: 8, period: 60},
    {name: 'LOGIN_GLOBAL_LIMITER', namespaceId: '1002', limit: 30, period: 60},
    {name: 'UPDATE_LIMITER', namespaceId: '1003', limit: 120, period: 60}
  ]
};
await writeFile(new URL('manifest.json', output), JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify({bundle: fileURLToPath(new URL(filename, output)), ...manifest}, null, 2));
