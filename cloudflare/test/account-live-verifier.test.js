import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {spawn} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';

const verifier = fileURLToPath(new URL('../scripts/verify-account-live.mjs', import.meta.url));
const {version} = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
const userAgent = `Brclio/${version}`;
const ray = '0123456789abcdef-SJC';
const sensitive = 'DO_NOT_LOG_FIXTURE_COOKIE_OR_BODY_TOKEN';

async function fixture(t, challengePath) {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push({path: request.url, method: request.method, userAgent: request.headers['user-agent'],
      origin: request.headers.origin, native: request.headers['x-brclio-client']});
    response.setHeader('cf-ray', ray);
    if (request.headers['user-agent'] !== userAgent || request.url === challengePath) {
      response.writeHead(403, {'Content-Type': 'text/html', 'cf-mitigated': 'challenge', 'Set-Cookie': 'fixture=' + sensitive});
      response.end('<title>Just a moment...</title>' + sensitive);
      return;
    }
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    if (request.url === '/api/account/session') {
      response.end(JSON.stringify({user: null, csrf: null, googleEnabled: true, emailEnabled: true, passwordEnabled: false}));
    } else if (request.url === '/api/account/data') {
      response.writeHead(401); response.end(JSON.stringify({error: '请先登录'}));
    } else if (request.headers.origin === 'https://invalid.example') {
      response.writeHead(403); response.end(JSON.stringify({error: '请求来源无效'}));
    } else if (request.url === '/api/account/login' && request.method === 'POST' && request.headers['x-brclio-client'] === 'native') {
      response.writeHead(401); response.end(JSON.stringify({error: '账号、邮箱或密码不正确'}));
    } else {
      response.writeHead(404); response.end(JSON.stringify({error: 'Unexpected fixture request'}));
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {server.closeAllConnections(); await new Promise(resolve => server.close(resolve));});
  return {origin: 'http://127.0.0.1:' + server.address().port, requests};
}

async function run(origin) {
  const child = spawn(process.execPath, [verifier, origin, '--ready'], {stdio: ['ignore', 'pipe', 'pipe']});
  let stdout = '', stderr = '';
  child.stdout.setEncoding('utf8').on('data', chunk => {stdout += chunk;});
  child.stderr.setEncoding('utf8').on('data', chunk => {stderr += chunk;});
  const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
  try {
    const [code] = await once(child, 'close');
    return {code, stdout, stderr, value: JSON.parse(code === 0 ? stdout : stderr)};
  } finally {clearTimeout(timer);}
}

test('the real ready verifier identifies its package version and checks every account boundary', async t => {
  const f = await fixture(t);
  const unnamed = await fetch(f.origin + '/api/account/session');
  assert.equal(unnamed.status, 403, 'the fixture challenges a generic Node client');
  assert.equal(unnamed.headers.get('cf-mitigated'), 'challenge');
  await unnamed.body.cancel();
  const result = await run(f.origin);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.value.ok, true);
  assert.deepEqual(Object.fromEntries(Object.entries(result.value.results).map(([key, value]) => [key, value.status])),
    {session: 200, anonymous_data: 401, foreign_origin: 403, native_with_foreign_origin: 403, private_repository_read: 401});
  assert.equal(f.requests.length, 6);
  assert.ok(f.requests.slice(1).every(request => request.userAgent === userAgent));
  assert.equal(f.requests.at(-1).path, '/api/account/login');
  assert.equal(f.requests.at(-1).method, 'POST');
  assert.equal(f.requests.at(-1).native, 'native');
  assert.equal(f.requests.at(-1).origin, undefined);
  assert.ok(Object.values(result.value.results).every(value => value.contentType === 'application/json' && value.cfRay === ray && value.cfMitigated === null));
});

test('the verifier reports bounded edge diagnostics without printing challenge bodies or cookies', async t => {
  const f = await fixture(t, '/api/account/session');
  const result = await run(f.origin);
  assert.equal(result.code, 1);
  assert.equal(result.value.stage, 'session');
  assert.equal(result.value.errorEnum, 'edge_challenge');
  assert.deepEqual(result.value.results.session, {status: 403, contentType: 'text/html', cfMitigated: 'challenge', cfRay: ray});
  assert.ok(!(result.stdout + result.stderr).includes(sensitive));
  assert.equal(f.requests.length, 1);
});

test('an edge challenge cannot satisfy an expected application 403 boundary check', async t => {
  const f = await fixture(t, '/api/account/login');
  const result = await run(f.origin);
  assert.equal(result.code, 1);
  assert.equal(result.value.stage, 'foreign_origin');
  assert.equal(result.value.errorEnum, 'edge_challenge');
  assert.equal(result.value.results.foreign_origin.status, 403);
  assert.ok(!(result.stdout + result.stderr).includes(sensitive));
  assert.equal(f.requests.length, 3);
});
