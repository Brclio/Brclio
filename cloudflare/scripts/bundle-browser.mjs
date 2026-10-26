import {build} from 'esbuild';
import {mkdir, writeFile, readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
const root = fileURLToPath(new URL('..', import.meta.url));
const output = new URL('../dist/browser/', import.meta.url);
await mkdir(output, {recursive: true});
const result = await build({
  absWorkingDir: root,
  entryPoints: ['src/entry.js'],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  minify: true,
  legalComments: 'inline',
  metafile: true,
  loader: {'.html': 'text', '.txt': 'text'},
  plugins: [{name: 'workers-node-builtins', setup(builder) {
    builder.onResolve({filter: /^crypto$/}, () => ({path: 'node:crypto', external: true}));
    builder.onResolve({filter: /^cloudflare:/}, args => ({path: args.path, external: true}));
  }}]
});
const outputs = Object.values(result.metafile.outputs);
assert.equal(result.outputFiles.length, 1, 'Cloudflare deployments require one self-contained module.');
assert.equal(outputs.length, 1, 'Cloudflare deployments must not emit extra chunks.');
assert.deepEqual(outputs[0].exports, ['default'], 'Only the default Worker entry may be exported.');
assert.ok(outputs[0].imports.every(item => item.external && /^(?:cloudflare:|node:)/.test(item.path)),
  'HTML, scripts and styles must be inlined before upload.');
const bundle = result.outputFiles[0].contents;
const filename = 'brclio-client-services.mjs';
await writeFile(new URL(filename, output), bundle);
const packageJSON = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const manifest = {
  worker: packageJSON.name,
  accountId: 'cacceff607775c81f667b7a951d4639f',
  displayName: 'Brclio客户端服务',
  publicOrigin: 'https://tools.brclio.com',
  bootstrapOrigin: 'https://brclio-client-services.aiyuechuang.workers.dev',
  bootstrapPaths: ['/api/client/update-proxy', '/api/health'],
  workersDev: true,
  routes: [{pattern: 'tools.brclio.com', customDomain: true}],
  generatedAt: new Date().toISOString(),
  filename,
  format: 'esm',
  moduleCount: 1,
  exports: outputs[0].exports,
  externalImports: outputs[0].imports.map(({path}) => path),
  bytes: bundle.length,
  sha256: createHash('sha256').update(bundle).digest('hex'),
  compatibilityDate: '2026-10-18',
  compatibilityFlags: ['nodejs_compat', 'global_fetch_strictly_public'],
  keepVars: true,
  dashboardVariableType: 'plain_text',
  environmentVariables: ['ADMIN_EMAIL', 'ADMIN_PASSWORD', 'SESSION_SECRET', 'GITHUB_APP_ID', 'GITHUB_APP_INSTALLATION_ID', 'GITHUB_DATA_REPOSITORY', 'GITHUB_PROGRAM_DATA_REPOSITORY', 'PROXY_SUBSCRIPTION_URL'],
  secretEnvironmentVariables: ['GITHUB_APP_PRIVATE_KEY'],
  accountEnvironmentVariables: ['SMTP_EMAIL', 'SMTP_APP_PASSWORD', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'],
  rateLimits: [
    {name: 'LOGIN_LIMITER', namespaceId: '1001', limit: 8, period: 60},
    {name: 'LOGIN_GLOBAL_LIMITER', namespaceId: '1002', limit: 30, period: 60},
    {name: 'UPDATE_LIMITER', namespaceId: '1003', limit: 120, period: 60},
    {name: 'CLIENT_CONFIG_LIMITER', namespaceId: '1005', limit: 30, period: 60},
    {name: 'ACCOUNT_LIMITER', namespaceId: '1006', limit: 120, period: 60},
    {name: 'ACCOUNT_AUTH_LIMITER', namespaceId: '1007', limit: 10, period: 60},
    {name: 'ACCOUNT_EMAIL_LIMITER', namespaceId: '1008', limit: 5, period: 60},
    {name: 'ACCOUNT_EMAIL_GLOBAL_LIMITER', namespaceId: '1009', limit: 30, period: 60}
  ]
};
await writeFile(new URL('manifest.json', output), JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify({bundle: fileURLToPath(new URL(filename, output)), ...manifest}, null, 2));
