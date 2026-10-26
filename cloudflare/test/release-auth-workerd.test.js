import {test} from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {Log, LogLevel, Miniflare, convertV4MiniflareOptions} from 'miniflare';

const repository = 'https://github.com/Brclio/Brclio';
const installationURL = 'https://api.github.com/app/installations/456/access_tokens';
const releaseURL = 'https://api.github.com/repos/Brclio/Brclio/releases/latest';
const installationToken = 'ghs_' + 'a'.repeat(40);
const fixture = {
  tag_name: 'v0.1.8', draft: false, prerelease: false,
  published_at: '2026-10-17T00:00:00Z',
  html_url: repository + '/releases/tag/v0.1.8',
  body: 'upstream-private-marker',
  assets: ['SHA256SUMS.txt', 'Brclio-0.1.8-mac-arm64.dmg'].map(name => ({
    name, size: 4096,
    browser_download_url: repository + '/releases/download/v0.1.8/' + name
  }))
};

test('real workerd authenticates public releases with only the program App token', async t => {
  const pair = await webcrypto.subtle.generateKey({
    name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256'
  }, true, ['sign', 'verify']);
  const keyBytes = await webcrypto.subtle.exportKey('pkcs8', pair.privateKey);
  const privateKey = '-----BEGIN PRIVATE KEY-----\n' +
    Buffer.from(keyBytes).toString('base64').match(/.{1,64}/g).join('\n') +
    '\n-----END PRIVATE KEY-----';
  const bindings = {
    GITHUB_APP_ID: '123', GITHUB_APP_INSTALLATION_ID: '456',
    GITHUB_APP_PRIVATE_KEY: privateKey,
    GITHUB_PROGRAM_DATA_REPOSITORY: 'Fixture/Program',
    GITHUB_DATA_REPOSITORY: 'Fixture/Accounts',
    GITHUB_TOKEN: 'legacy-private-token-not-allowed'
  };
  const bundled = await build({
    stdin: {contents: `
      import {getOfficialRelease, clearReleaseCache, releaseFailureDetails} from './src/releases.js';
      export default {async fetch(request, env) {
        if (new URL(request.url).searchParams.has('fresh')) clearReleaseCache();
        const redirects = [];
        const transport = (url, options) => {
          const outgoing = new Request(url, options);
          redirects.push(outgoing.redirect);
          return fetch(outgoing);
        };
        try {
          const {summary} = await getOfficialRelease(env, transport);
          return Response.json(summary, {headers: {'x-fixture-redirects': redirects.join(',')}});
        } catch (error) {
          console.warn('release.metadata_failed', releaseFailureDetails(error));
          return Response.json({error: 'release_unavailable'}, {
            status: 502, headers: {'x-fixture-redirects': redirects.join(',')}
          });
        }
      }};
    `, resolveDir: fileURLToPath(new URL('..', import.meta.url)), sourcefile: 'release-auth-runtime-fixture.js'},
    bundle: true, write: false, format: 'esm', platform: 'browser'
  });

  for (const scenario of ['valid', 'authentication-failure', 'release-redirect']) await t.test(scenario, async () => {
    const calls = [], logs = [], credentials = [privateKey, installationToken, bindings.GITHUB_TOKEN];
    const mf = new Miniflare(convertV4MiniflareOptions({
      modules: true, cf: false, log: new Log(LogLevel.NONE), bindings,
      handleStructuredLogs: ({message}) => logs.push(message),
      compatibilityDate: '2026-10-18',
      compatibilityFlags: ['nodejs_compat', 'global_fetch_strictly_public'],
      script: bundled.outputFiles[0].text,
      outboundService: async request => {
        if (request.url === installationURL) {
          calls.push('installation');
          assert.equal(request.method, 'POST');
          assert.deepEqual(await request.json(), {repositories: ['Program'], permissions: {contents: 'write'}});
          const authorization = request.headers.get('Authorization') || '';
          credentials.push(authorization);
          const parts = authorization.replace(/^Bearer /, '').split('.');
          assert.ok(authorization.startsWith('Bearer ') && parts.length === 3, 'installation issuance must use a signed App JWT');
          const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
          const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
          assert.deepEqual(header, {alg: 'RS256', typ: 'JWT'});
          assert.equal(claims.iss, '123');
          const now = Math.floor(Date.now() / 1000);
          assert.ok(claims.iat <= now && claims.iat >= now - 120 && claims.exp > now && claims.exp <= now + 600,
            'App JWT must have a short valid lifetime');
          assert.ok(await webcrypto.subtle.verify('RSASSA-PKCS1-v1_5', pair.publicKey,
            Buffer.from(parts[2], 'base64url'), new TextEncoder().encode(parts[0] + '.' + parts[1])),
          'App JWT must have a valid RSA signature');
          if (scenario === 'authentication-failure') return Response.json({message: 'upstream-private-marker'}, {status: 403});
          return Response.json({
            token: installationToken, expires_at: new Date(Date.now() + 3600000).toISOString(),
            permissions: {contents: 'write', metadata: 'read'}, repository_selection: 'selected',
            repositories: [{full_name: 'Fixture/Program'}]
          });
        }
        if (request.url === releaseURL) {
          calls.push('release');
          assert.equal(request.method, 'GET');
          assert.ok(request.headers.get('Authorization') === 'Bearer ' + installationToken,
            'public release request must use only the derived program installation token');
          assert.equal(request.headers.get('Cookie'), null);
          if (scenario === 'release-redirect') return new Response(null, {
            status: 302, headers: {Location: 'https://unexpected.example/credential-target'}
          });
          return Response.json(fixture);
        }
        assert.fail('release authentication must not contact any additional endpoint or follow redirects');
      }
    }));
    try {
      const response = await mf.dispatchFetch('https://runtime-test.example/');
      const value = await response.json();
      // Workerd may also emit its own startup/compatibility diagnostics. Only
      // application diagnostics participate in the release failure contract.
      const diagnostics = () => logs.filter(message => message.includes('release.metadata_failed'));
      if (scenario === 'valid') {
        assert.equal(response.status, 200);
        assert.equal(value.version, '0.1.8');
        assert.deepEqual(Object.keys(value).sort(), ['assets', 'publishedAt', 'releaseURL', 'tag', 'version']);
        assert.equal(value.assets[0].platform, 'mac-arm64');
        assert.equal(value.assets[0].checksumURL, repository + '/releases/download/v0.1.8/SHA256SUMS.txt');
        assert.equal(response.headers.get('x-fixture-redirects'), 'manual,manual');
        const cached = await mf.dispatchFetch('https://runtime-test.example/');
        assert.equal(cached.status, 200);
        assert.equal(cached.headers.get('x-fixture-redirects'), '');
        await cached.body.cancel();
        assert.deepEqual(calls, ['installation', 'release']);
        const refreshed = await mf.dispatchFetch('https://runtime-test.example/?fresh=1');
        assert.equal(refreshed.status, 200);
        assert.equal(refreshed.headers.get('x-fixture-redirects'), 'manual');
        await refreshed.body.cancel();
        assert.deepEqual(calls, ['installation', 'release', 'release']);
        assert.equal(diagnostics().length, 0);
      } else {
        assert.equal(response.status, 502);
        assert.deepEqual(value, {error: 'release_unavailable'});
        assert.deepEqual(calls, scenario === 'authentication-failure' ? ['installation'] : ['installation', 'release']);
        assert.equal(response.headers.get('x-fixture-redirects'), scenario === 'authentication-failure' ? 'manual' : 'manual,manual');
        assert.equal(diagnostics().length, 1);
        assert.ok(diagnostics()[0].includes(scenario === 'authentication-failure' ? 'release_auth_unavailable' : 'release_upstream_status'),
          'failure diagnostics must contain the fixed error classification');
        if (scenario === 'release-redirect') assert.ok(diagnostics()[0].includes('302'), 'redirect failure must retain only its safe status');
        assert.ok(diagnostics().every(message =>
          !/https?:\/\/|Authorization|PRIVATE KEY|ghs_/.test(message)),
        'application failure diagnostics must not contain credentials or URLs');
      }
      assert.ok(logs.every(message => !message.includes('upstream-private-marker') &&
        !credentials.some(credential => message.includes(credential))),
      'all captured diagnostics must omit credentials and upstream messages');
    } finally {await mf.dispose();}
  });
});
