// Offline integration check of the exact release launcher and Chromium network
// stack. The loopback fixture cannot send mail or access any real user data.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {execFile} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const launcher = fileURLToPath(new URL('../desktop/account-service-live.cjs', import.meta.url));
const sensitive = 'FIXTURE_BODY_AND_COOKIE_MUST_NOT_APPEAR_IN_REPORT';
const statuses = {session: 200, anonymous_data: 401, foreign_origin: 403, native_with_foreign_origin: 403, private_repository_read: 401};
const cases = [];
for (const mode of ['ready', 'challenge', 'invalid-json', 'redirect']) {
  const requests = [];
  const server = createServer(async (request, response) => {
    let body = ''; for await (const bytes of request) body += bytes;
    const value = body ? JSON.parse(body) : null;
    requests.push({path: request.url, method: request.method, origin: request.headers.origin, native: request.headers['x-brclio-client'], value});
    response.setHeader('cf-ray', '0123456789abcdef-SJC');
    if (request.headers.origin === 'https://invalid.example') {
      if (mode === 'challenge') {
        response.writeHead(403, {'content-type': 'text/html', 'cf-mitigated': 'challenge', 'set-cookie': 'fixture=' + sensitive});
        response.end('<title>Just a moment...</title>' + sensitive); return;
      }
      if (mode === 'redirect') {response.writeHead(302, {location: '/must-not-follow'}); response.end(); return;}
      response.writeHead(403, {'content-type': 'application/json'});
      response.end(mode === 'invalid-json' ? sensitive : JSON.stringify({error: 'invalid origin'})); return;
    }
    response.setHeader('content-type', 'application/json');
    if (request.url === '/api/account/session') response.end(JSON.stringify({user: null, csrf: null, googleEnabled: true, emailEnabled: true}));
    else if (request.url === '/api/account/data') {response.writeHead(401); response.end(JSON.stringify({error: 'login required'}));}
    else if (request.url === '/api/account/login' && request.method === 'POST' && request.headers['x-brclio-client'] === 'native'
      && value?.identifier === '__brclio_readiness_invalid__' && value.password === 'not-a-real-password') {
      response.writeHead(401); response.end(JSON.stringify({error: 'invalid credentials'}));
    } else {response.writeHead(500); response.end(JSON.stringify({error: sensitive}));}
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const origin = 'http://127.0.0.1:' + server.address().port;
    const result = await new Promise(resolve => execFile(process.execPath, [launcher, '--origin=' + origin], {timeout: 450000, maxBuffer: 262144},
      (error, stdout, stderr) => resolve({code: error?.code || 0, stdout, stderr})));
    assert.ok(!(result.stdout + result.stderr).includes(sensitive));
    const report = JSON.parse(result.stdout);
    assert.equal(report.actualElectron, true); assert.equal(report.normalClientSession.passed, true);
    assert.equal(report.temporaryFilesCleaned, true);
    assert.equal(report.securitySettingsModified, false); assert.equal(report.systemSettingsModified, false);
    assert.equal(requests[0].native, 'native'); assert.equal(requests[0].origin, undefined);
    if (mode === 'ready') {
      assert.equal(result.code, 0); assert.equal(report.passed, true);
      assert.deepEqual(Object.fromEntries(Object.entries(report.verifier.results).map(([name, value]) => [name, value.status])), statuses);
      assert.equal(requests.length, 6);
      assert.deepEqual(requests.map(value => [value.method, value.path]), [
        ['GET', '/api/account/session'], ['GET', '/api/account/session'], ['GET', '/api/account/data'],
        ['POST', '/api/account/login'], ['POST', '/api/account/code'], ['POST', '/api/account/login'],
      ]);
      assert.ok(requests.slice(3, 5).every(value => value.origin === 'https://invalid.example' && value.method === 'POST'));
      assert.deepEqual(requests[3].value, {identifier: 'test', password: 'not-a-real-password'});
      assert.deepEqual(requests[4].value, {email: 'nobody@example.com'});
      assert.equal(requests[4].native, 'native');
      assert.equal(requests[5].origin, undefined); assert.equal(requests[5].native, 'native');
    } else {
      assert.equal(result.code, 1); assert.equal(report.passed, false); assert.equal(report.verifier.ok, false);
      assert.equal(report.verifier.stage, 'foreign_origin'); assert.equal(requests.length, 4);
      if (mode === 'challenge') assert.equal(report.verifier.errorEnum, 'edge_challenge');
      if (mode === 'redirect') assert.equal(report.verifier.results.foreign_origin.status, 302);
    }
    cases.push({mode, passed: true});
  } finally {server.closeAllConnections(); await new Promise(resolve => server.close(resolve));}
}
console.log(JSON.stringify({passed: true, actualElectron: true, externalNetworkRequests: false, cases}, null, 2));
