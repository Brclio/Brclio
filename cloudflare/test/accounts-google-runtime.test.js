import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {Miniflare, convertV4MiniflareOptions} from 'miniflare';
import {fileURLToPath} from 'node:url';
import {encode64} from '../src/accounts-crypto.js';

// Exercise the real workerd fetch implementation. A JavaScript fetch stub would
// accept redirect:'error' even though workerd rejects that RequestInit value.
test('actual workerd completes Google token and JWKS fetches and refuses redirects without forwarding credentials', async t => {
  const pair = await crypto.subtle.generateKey({name:'RSASSA-PKCS1-v1_5',modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['sign','verify']);
  const jwk = {...await crypto.subtle.exportKey('jwk',pair.publicKey),kid:'google-runtime-test-key',alg:'RS256',use:'sig'};
  const now = Math.floor(Date.now()/1000), encoder = new TextEncoder();
  const header = encode64(encoder.encode(JSON.stringify({alg:'RS256',kid:jwk.kid})));
  const claims = encode64(encoder.encode(JSON.stringify({iss:'https://accounts.google.com',aud:'runtime-client',azp:'runtime-client',sub:'123456789012345678901',email:'runtime@example.com',email_verified:true,nonce:'runtime-nonce',iat:now,exp:now+3600})));
  const payload = header + '.' + claims;
  const token = payload + '.' + encode64(new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5',pair.privateKey,encoder.encode(payload))));
  const bundled = await build({stdin:{contents:`
    import {googleIdentity} from './src/accounts-google.js';
    export default {async fetch() {
      const redirectModes = [];
      const transport = (url, options) => {const request = new Request(url, options); redirectModes.push(request.redirect); return fetch(request);};
      try {
        const identity = await googleIdentity('runtime-code','runtime-verifier','runtime-nonce','https://tools.brclio.com/api/account/google/callback',{GOOGLE_CLIENT_ID:'runtime-client',GOOGLE_CLIENT_SECRET:'runtime-secret'},transport);
        return Response.json({accepted:true,email:identity.email,redirectModes});
      } catch {return Response.json({accepted:false,redirectModes});}
    }};
  `,resolveDir:fileURLToPath(new URL('..',import.meta.url)),sourcefile:'google-runtime-fixture.js'},bundle:true,write:false,format:'esm',platform:'browser'});
  for (const scenario of ['valid','token-redirect','keys-redirect']) await t.test(scenario, async () => {
    const calls = [];
    const mf = new Miniflare(convertV4MiniflareOptions({modules:true,compatibilityDate:'2026-10-18',compatibilityFlags:['nodejs_compat','global_fetch_strictly_public'],script:bundled.outputFiles[0].text,outboundService:async request => {
      const url = new URL(request.url);
      calls.push({origin:url.origin,path:url.pathname});
      if (url.origin === 'https://oauth2.googleapis.com' && url.pathname === '/token') {
        const body = new URLSearchParams(await request.text());
        assert.equal(body.get('client_secret'),'runtime-secret');
        assert.equal(body.get('code_verifier'),'runtime-verifier');
        if (scenario === 'token-redirect') return new Response(null,{status:302,headers:{Location:'https://unexpected.example/credentials'}});
        return Response.json({id_token:token});
      }
      if (url.origin === 'https://www.googleapis.com' && url.pathname === '/oauth2/v3/certs') {
        if (scenario === 'keys-redirect') return new Response(null,{status:307,headers:{Location:'https://unexpected.example/keys'}});
        return Response.json({keys:[jwk]});
      }
      assert.fail('Google request followed an unexpected redirect');
    }}));
    try {
      const response = await mf.dispatchFetch('https://runtime-test.example/');
      const result = await response.json();
      assert.equal(result.accepted,scenario === 'valid');
      if (scenario === 'valid') assert.equal(result.email,'runtime@example.com');
      assert.deepEqual(calls.map(({origin,path}) => origin+path),scenario === 'token-redirect' ? ['https://oauth2.googleapis.com/token'] : ['https://oauth2.googleapis.com/token','https://www.googleapis.com/oauth2/v3/certs']);
      assert.deepEqual(result.redirectModes,scenario === 'token-redirect' ? ['manual'] : ['manual','manual']);
    } finally {await mf.dispose();}
  });
});
