import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {verifyDeployment, runCLI, createCLITransport} from '../scripts/verify-deployment.mjs';

const paths = ['/', '/api/health', '/api/account/session', '/api/client/update-proxy', '/api/releases/latest'];
const node = {uuid: '00112233-4455-6677-8899-aabbccddeeff', host: 'vpn.example.com', port: 443, path: '/tunnel', servername: 'vpn.example.com', wsHost: 'vpn.example.com', dialAddress: '104.17.1.1'};
const release = {version: '0.1.15', tag: 'v0.1.15', publishedAt: '2026-10-22T00:00:00.000Z', releaseURL: 'https://github.com/Brclio/Brclio/releases/tag/v0.1.15', assets: [
  {platform: 'android', name: 'Brclio-0.1.15-android.apk', size: 123, url: 'https://github.com/Brclio/Brclio/releases/download/v0.1.15/Brclio-0.1.15-android.apk', checksumURL: 'https://github.com/Brclio/Brclio/releases/download/v0.1.15/SHA256SUMS.txt'}
]};
const homepage = '<!doctype html><html><head><title>Brclio · 首页</title></head><body><div id="download-grid"></div><div id="release-fallback"></div></body></html>';
function documentFor(path) {
  return path === '/api/health' ? {ok: true, service: 'brclio-client-services', proxyProtocol: 'vless-tls-websocket'}
    : path === '/api/account/session' ? {user: null, csrf: null, passwordEnabled: false, googleEnabled: true, emailEnabled: true}
    : path === '/api/client/update-proxy' ? {version: 1, ttlSeconds: 600, nodes: [structuredClone(node)]} : structuredClone(release);
}
const responseFor = path => path === '/' ? new Response(homepage, {headers: {'Content-Type': 'text/html; charset=utf-8'}}) : Response.json(documentFor(path));
const fixture = (override = () => undefined) => async (url, options) => override(new URL(url).pathname, options) || responseFor(new URL(url).pathname);
const fast = {attempts: 3, retryDelayMs: 0};
const check = (report, endpoint) => report.checks.find(value => value.endpoint === endpoint);
function safeOutput(report) {
  const text = JSON.stringify(report);
  for (const forbidden of ['vpn.example.com', node.uuid, '104.17.1.1', '/tunnel', 'private-secret', 'private.example', '<html>', 'Authorization', 'Cookie', 'github.com', 'tools.brclio.com']) assert.ok(!text.includes(forbidden), forbidden);
}

test('all five fixed GET gates validate contracts without credentials and expose only safe evidence', async () => {
  const calls = [];
  const report = await verifyDeployment({fetchImpl: fixture((path, options) => {
    calls.push(path); assert.equal(options.method, 'GET'); assert.equal(options.credentials, 'omit'); assert.equal(options.redirect, 'manual'); assert.equal(options.cache, 'no-store');
    assert.deepEqual(Object.keys(options.headers).sort(), ['Accept', 'User-Agent']); assert.ok(options.signal instanceof AbortSignal);
  }), ...fast});
  assert.equal(report.ok, true); assert.deepEqual(calls, paths); assert.equal(report.checks.length, 5);
  assert.deepEqual(check(report, 'anonymous_session'), {endpoint: 'anonymous_session', status: 200, ok: true, errorEnum: null, googleEnabled: true, emailEnabled: true});
  assert.equal(check(report, 'latest_release').version, '0.1.15'); safeOutput(report);
});

test('temporary failures retry within the finite budget and never omit a required failed gate', async () => {
  const attempts = new Map();
  const recovered = await verifyDeployment({fetchImpl: fixture(path => {const n=(attempts.get(path)||0)+1;attempts.set(path,n);return n<3?new Response('private-secret',{status:503}):undefined;}), ...fast});
  assert.equal(recovered.ok, true); assert.deepEqual([...attempts.values()], [3,3,3,3,3]);
  const calls = [];
  const failed = await verifyDeployment({fetchImpl: fixture(path => {if(path==='/api/releases/latest'){calls.push(path);return new Response('private-secret',{status:502});}}), ...fast});
  assert.equal(failed.ok, false); assert.equal(calls.length, 3); assert.equal(failed.checks.filter(item=>item.ok).length, 4);
  assert.deepEqual(check(failed,'latest_release'), {endpoint:'latest_release',status:502,ok:false,errorEnum:'http_status'}); safeOutput(failed);
});

test('wrong health identity, authenticated session and missing existing providers cannot pass', async () => {
  for (const [path, endpoint, mutate, code] of [
    ['/api/health','health',d=>{d.service='private-secret'},'invalid_schema'],
    ['/api/account/session','anonymous_session',d=>{d.user={email:'private-secret'}},'invalid_schema'],
    ['/api/account/session','anonymous_session',d=>{d.csrf='private-secret'},'invalid_schema'],
    ['/api/account/session','anonymous_session',d=>{d.googleEnabled=false},'provider_unavailable'],
    ['/api/account/session','anonymous_session',d=>{delete d.emailEnabled},'invalid_schema']
  ]) {
    const report=await verifyDeployment({fetchImpl:fixture(value=>{if(value===path){const d=documentFor(value);mutate(d);return Response.json(d)}}),...fast});
    assert.equal(report.ok,false);assert.equal(check(report,endpoint).errorEnum,code);safeOutput(report);
  }
});

test('real native configuration validation rejects private or inconsistent node identities without leaking values', async () => {
  for(const mutate of [d=>{d.nodes[0].host='127.0.0.1'},d=>{d.nodes[0].servername='private.example'},d=>{d.nodes.push(...Array(16).fill(node))}]){
    const d=documentFor('/api/client/update-proxy');mutate(d);
    const report=await verifyDeployment({fetchImpl:fixture(path=>path==='/api/client/update-proxy'?Response.json(d):undefined),...fast});
    assert.equal(check(report,'client_configuration').errorEnum,'invalid_schema');safeOutput(report);
  }
});

test('release summary requires stable version, official exact URLs, unique platform and bounded sizes', async () => {
  for(const mutate of [d=>{d.tag='v0.2.0'},d=>{d.assets[0].url='https://private.example/private-secret'},d=>{d.assets[0].checksumURL+='?private-secret'},d=>{d.assets.push(d.assets[0])},d=>{d.assets[0].size=0},d=>{d.publishedAt='invalid'},d=>{d.publishedAt='2026'}]){
    const d=structuredClone(release);mutate(d);
    const report=await verifyDeployment({fetchImpl:fixture(path=>path==='/api/releases/latest'?Response.json(d):undefined),...fast});
    assert.equal(check(report,'latest_release').errorEnum,'invalid_schema');safeOutput(report);
  }
});

test('redirects, Cloudflare challenge pages and wrong homepage are terminal failures', async () => {
  for(const [replacement,code]of [
    [()=>new Response(null,{status:302,headers:{Location:'https://private.example/private-secret'}}),'unexpected_redirect'],
    [()=>new Response('private-secret',{status:403,headers:{'cf-mitigated':'challenge'}}),'cloudflare_challenge'],
    [()=>new Response('<html><title>Brclio account</title></html>',{headers:{'Content-Type':'text/html'}}),'invalid_schema']
  ]){
    let calls=0;const report=await verifyDeployment({fetchImpl:fixture(path=>{if(path==='/'){calls++;return replacement()}}),...fast});
    assert.equal(check(report,'homepage').errorEnum,code);assert.equal(calls,1);safeOutput(report);
  }
});

test('invalid JSON, type, UTF-8 and oversized bodies are bounded failures and streams are cancelled', async () => {
  let cancelled=0;
  const cases=[
    [()=>new Response('private-secret',{headers:{'Content-Type':'text/html'}}),'content_type'],
    [()=>new Response('{private-secret',{headers:{'Content-Type':'application/json'}}),'invalid_json'],
    [()=>new Response(new Uint8Array([255]),{headers:{'Content-Type':'application/json'}}),'invalid_utf8'],
    [()=>new Response('private-secret',{headers:{'Content-Type':'application/json','Content-Length':'9999999'}}),'body_too_large'],
    [()=>new Response(new ReadableStream({pull(c){c.enqueue(new Uint8Array(5000));},cancel(){cancelled++;}}),{headers:{'Content-Type':'application/json'}}),'body_too_large']
  ];
  for(const [replacement,code]of cases){const report=await verifyDeployment({fetchImpl:fixture(path=>path==='/api/health'?replacement():undefined),...fast});assert.equal(check(report,'health').errorEnum,code);safeOutput(report)}
  assert.equal(cancelled,1);
});

test('headers and body stalls obey one shared deadline even if injected fetch or stream ignores abort', async () => {
  for(const stalled of ['headers','body']){
    let calls=0,cancelled=0;const started=performance.now();
    const report=await verifyDeployment({fetchImpl:fixture(path=>{if(path!=='/api/health')return;calls++;return stalled==='headers'?new Promise(()=>{}):new Response(new ReadableStream({cancel(){cancelled++;}}),{headers:{'Content-Type':'application/json'}})}),requestTimeoutMs:45,totalTimeoutMs:110,retryDelayMs:0});
    assert.equal(report.ok,false);assert.equal(check(report,'health').errorEnum,'deadline_exceeded');assert.ok(calls<=3);assert.ok(performance.now()-started<1000);
    if(stalled==='body')assert.equal(cancelled,calls);
  }
});

test('late transport responses are discarded and raw exception messages or injected codes never enter evidence', async () => {
  let cancelled=0,finish;
  const pending=verifyDeployment({fetchImpl:fixture(path=>path==='/api/health'?new Promise(resolve=>{finish=resolve}):undefined),attempts:1,requestTimeoutMs:15,totalTimeoutMs:100});
  const report=await pending;assert.equal(check(report,'health').errorEnum,'request_timeout');
  finish(new Response(new ReadableStream({cancel(){cancelled++}})));await new Promise(resolve=>setImmediate(resolve));assert.equal(cancelled,1);
  const raw=await verifyDeployment({fetchImpl:async()=>{throw Object.assign(Error('https://private.example/private-secret'),{gateCode:'private-secret'})},...fast});
  assert.equal(raw.ok,false);assert.ok(raw.checks.every(item=>item.errorEnum==='network_failed'));safeOutput(raw);
});

test('pre-cancelled checks and invalid budgets fail without starting network requests', async () => {
  let calls=0;const fetchImpl=async()=>{calls++;throw Error('private-secret')},controller=new AbortController();controller.abort('private-secret');
  const cancelled=await verifyDeployment({fetchImpl,signal:controller.signal});assert.ok(cancelled.checks.every(item=>item.errorEnum==='cancelled'));
  for(const options of [{attempts:4},{totalTimeoutMs:0},{requestTimeoutMs:Infinity},{retryDelayMs:-1},{signal:{}}])assert.equal((await verifyDeployment({fetchImpl,...options})).errorEnum,'invalid_options');
  assert.equal(calls,0);safeOutput(cancelled);
});

test('CLI returns nonzero for required gate failures and module import never starts network activity', async () => {
  let printed;const code=await runCLI({args:[],fetchImpl:fixture(path=>path==='/api/health'?new Response('private-secret',{status:403}):undefined),print:value=>{printed=JSON.parse(value)}});
  assert.equal(code,1);assert.equal(printed.ok,false);safeOutput(printed);
  const moduleURL=new URL('../scripts/verify-deployment.mjs',import.meta.url).href;
  const imported=spawnSync(process.execPath,['--input-type=module','-e',`globalThis.fetch=()=>{throw Error('Unexpected import network')};await import(${JSON.stringify(moduleURL)});`],{encoding:'utf8',timeout:5000});
  assert.equal(imported.status,0);assert.equal(imported.stdout,'');assert.equal(imported.stderr,'');
  const preload='globalThis.fetch=async()=>new Response("private-secret",{status:503});';
  const child=spawnSync(process.execPath,['--import','data:text/javascript,'+encodeURIComponent(preload),new URL('../scripts/verify-deployment.mjs',import.meta.url).pathname],{encoding:'utf8',timeout:5000,env:{...process.env,https_proxy:'',HTTPS_PROXY:'',http_proxy:'',HTTP_PROXY:'',all_proxy:'',ALL_PROXY:''}});
  assert.equal(child.status,1);assert.equal(child.stderr,'');safeOutput(JSON.parse(child.stdout));
});


test('CLI transport honors each existing proxy spelling, keeps credentials private, and closes its dispatcher', async () => {
  for (const variable of ['https_proxy','HTTPS_PROXY','http_proxy','HTTP_PROXY','all_proxy','ALL_PROXY']) {
    let loaded=0,closed=0,agent,captured;
    const proxy='http://private-secret:private-secret@127.0.0.1:7897';
    const transport=createCLITransport({env:{[variable]:proxy},fetchImpl:()=>assert.fail('must use proxy transport'),loadProxyTransport:()=>{loaded++;return {
      ProxyAgent:class {constructor(value){assert.equal(value,proxy+'/');agent=this;}async close(){closed++;}},
      fetch:async(target,options)=>{captured=options;assert.equal(options.dispatcher,agent);return Response.json({ok:true});}
    }}});
    const response=await transport.fetchImpl('https://tools.brclio.com/api/health',{method:'GET',headers:{Accept:'application/json'}});
    assert.equal(response.status,200);assert.equal(captured.method,'GET');assert.deepEqual(captured.headers,{Accept:'application/json'});assert.equal(loaded,1);
    await transport.close();await transport.close();assert.equal(closed,1);
  }
});

test('CLI direct transport uses global/injected fetch without loading Wrangler transport; proxy precedence matches Wrangler', async () => {
  const direct=async()=>Response.json({ok:true}),transport=createCLITransport({env:{},fetchImpl:direct,loadProxyTransport:()=>assert.fail('no proxy module needed')});
  assert.equal(transport.fetchImpl,direct);await transport.close();
  let selected;
  const proxy=createCLITransport({env:{https_proxy:'http://127.0.0.1:1234',HTTPS_PROXY:'http://127.0.0.1:2345',all_proxy:'http://127.0.0.1:3456'},loadProxyTransport:()=>({ProxyAgent:class {constructor(value){selected=value;}async close(){}},fetch:direct})});
  assert.equal(selected,'http://127.0.0.1:1234/');await proxy.close();
});

test('malformed proxy settings and unavailable proxy dependencies fail closed with fixed safe CLI enums', async () => {
  for (const value of ['private-secret','socks5://private-secret@127.0.0.1:7897','http://127.0.0.1:7897/private-secret','https://127.0.0.1/?private-secret',42]) {
    let printed;
    const code=await runCLI({args:[],env:{HTTPS_PROXY:value},print:text=>{printed=JSON.parse(text)},transportFactory:options=>createCLITransport({...options,loadProxyTransport:()=>assert.fail('invalid proxy must not load transport')})});
    assert.equal(code,1);assert.equal(printed.errorEnum,'invalid_proxy_configuration');safeOutput(printed);
  }
  let printed;
  const code=await runCLI({args:[],env:{HTTPS_PROXY:'http://private-secret@127.0.0.1:7897'},transportFactory:options=>createCLITransport({...options,loadProxyTransport:()=>{throw Error('private-secret https://private.example')}}),print:text=>{printed=JSON.parse(text)}});
  assert.equal(code,1);assert.equal(printed.errorEnum,'proxy_transport_unavailable');safeOutput(printed);
});

test('CLI closes the proxy on verification failure and fails safely if dispatcher cleanup fails', async () => {
  let closed=0,printed;
  const factory=()=>createCLITransport({env:{HTTPS_PROXY:'http://127.0.0.1:7897'},loadProxyTransport:()=>({ProxyAgent:class {async close(){closed++;}},fetch:fixture(path=>path==='/api/health'?new Response('private-secret',{status:403}):undefined)})});
  const failed=await runCLI({args:[],transportFactory:factory,print:text=>{printed=JSON.parse(text)}});
  assert.equal(failed,1);assert.equal(closed,1);safeOutput(printed);
  let destroyed=0;
  const cleanup=await runCLI({args:[],transportFactory:()=>createCLITransport({env:{HTTPS_PROXY:'http://127.0.0.1:7897'},loadProxyTransport:()=>({ProxyAgent:class {async close(){throw Error('private-secret')}async destroy(){destroyed++;}},fetch:fixture()})}),print:text=>{printed=JSON.parse(text)}});
  assert.equal(cleanup,1);assert.equal(destroyed,1);assert.equal(printed.errorEnum,'proxy_transport_failed');safeOutput(printed);
});

test('explicit CLI fetch injection bypasses ambient proxy configuration', async () => {
  let printed;
  const code=await runCLI({args:[],fetchImpl:fixture(),env:{HTTPS_PROXY:'private-secret'},transportFactory:()=>assert.fail('injected fetch owns transport'),print:text=>{printed=JSON.parse(text)}});
  assert.equal(code,0);assert.equal(printed.ok,true);safeOutput(printed);
});


test('locked Wrangler undici transport can be constructed and closed without opening a request', async () => {
  const transport=createCLITransport({env:{HTTPS_PROXY:'http://127.0.0.1:1'}});
  assert.equal(typeof transport.fetchImpl,'function');await transport.close();
});
