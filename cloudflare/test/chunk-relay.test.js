import {test, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {MAX_CHUNK_BYTES, parseChunkRequest, relayChunk} from '../src/chunk-relay.js';
const official = 'https://github.com/Brclio/Brclio/releases/download/v0.1.9/Brclio-0.1.9-windows-x64.exe';
const signed = 'https://release-assets.githubusercontent.com/github-production-release-asset/123/abcdef?signature=test';
let nodes;
beforeEach(() => {nodes = [{id: 0}, {id: 1}, {id: 2}];});
function response(body, status = 206, headers = {}) {
  const r = new Response(body, {status, headers});
  return {status: r.status, headers: r.headers, body: r.body, close() {}};
}
function part(bytes, start = 0, total = bytes.byteLength, etag = '"same"') {
  return response(bytes, 206, {'content-range': `bytes ${start}-${start + bytes.byteLength - 1}/${total}`, 'content-length': String(bytes.byteLength), etag, 'content-type': 'application/octet-stream'});
}
test('single-range parser limits official stable installers to explicit safe integers and128KiB', () => {
  assert.deepEqual(parseChunkRequest(official, 'bytes=0-131071', null), {start: 0, end: 131071, ifRange: undefined});
  assert.deepEqual(parseChunkRequest(official, 'bytes=1048576-1048580', '"same"'), {start: 1048576, end: 1048580, ifRange: '"same"'});
  for (const range of ['bytes=0-131072', 'bytes=1-0', 'bytes=0-', 'bytes=-10', 'bytes=0-1,3-4', 'bytes=00-1', 'bytes=0-9007199254740992']) assert.throws(() => parseChunkRequest(official, range));
  assert.equal(parseChunkRequest(official,'bytes=0-1','"'+'a'.repeat(256)+'"').ifRange.length,258);
  for (const etag of ['W/"weak"', 'Wed, 21 Oct 2015 07:28:00 GMT', '"a", "b"', '"bad\r\nheader"', '""', '"é"', '"'+'a'.repeat(257)+'"']) assert.throws(() => parseChunkRequest(official, 'bytes=0-1', etag));
  for (const target of ['https://api.github.com/repos/Brclio/Brclio/releases/latest', official.replace(/Brclio-0\.1\.9-windows-x64.exe$/, 'SHA256SUMS.txt'), official.replace('Brclio-0.1.9-', 'Brclio-0.1.8-')]) assert.throws(() => parseChunkRequest(target, 'bytes=0-1'));
});
test('buffered segment follows validated redirect, forwards If-Range and clamps only at artifact end', async () => {
  const calls = [], bytes = new Uint8Array([7, 8, 9]);
  const result = await relayChunk(official, nodes, {range: {start: 4, end: 7, ifRange: '"same"'}, transport: async (target, node, options) => {
    calls.push({host: target.hostname, node: node.id, range: options.range, ifRange: options.ifRange});
    return target.hostname === 'github.com' ? response('', 302, {location: signed}) : part(bytes, 4, 7);
  }});
  assert.equal(result.status, 206); assert.equal(result.headers.get('content-range'), 'bytes 4-6/7');
  assert.equal(result.headers.get('content-length'), '3'); assert.equal(result.headers.get('etag'), '"same"');
  assert.equal(result.headers.get('x-brclio-route'), 'subscription-vless'); assert.equal(result.headers.get('accept-ranges'), 'bytes');
  assert.deepEqual(new Uint8Array(await result.arrayBuffer()), bytes);
  assert.deepEqual(calls, [{host: 'github.com', node: 0, range: 'bytes=4-7', ifRange: '"same"'}, {host: 'release-assets.githubusercontent.com', node: 0, range: 'bytes=4-7', ifRange: '"same"'}]);
});
test('a segment never returns before all bounded bytes have been verified', async () => {
  let controller, settled = false;
  const body = new ReadableStream({start(c) {controller = c; c.enqueue(new Uint8Array([1]));}});
  const pending = relayChunk(official, nodes, {range: {start: 0, end: 1}, transport: async () => ({status: 206, headers: new Headers({'content-range': 'bytes 0-1/2', 'content-length': '2', etag: '"same"'}), body, close() {}})}).then(result => {settled = true; return result;});
  await new Promise(resolve => setImmediate(resolve)); assert.equal(settled, false);
  controller.enqueue(new Uint8Array([2])); controller.close();
  const result = await pending; assert.deepEqual(new Uint8Array(await result.arrayBuffer()), new Uint8Array([1, 2]));
});
test('200 fallback, weak or changed ETag and inconsistent range metadata fail closed without retry', async () => {
  const invalid = [
    [200, {'content-range': 'bytes 0-1/2', 'content-length': '2', etag: '"same"'}],
    [206, {'content-range': 'bytes 0-1/2', 'content-length': '2', etag: 'W/"same"'}],
    [206, {'content-range': 'bytes 0-1/2', 'content-length': '2', etag: '"changed"'}],
    [206, {'content-range': 'bytes 1-2/3', 'content-length': '2', etag: '"same"'}],
    [206, {'content-range': 'bytes 0-1/2', 'content-length': '1', etag: '"same"'}],
    [206, {'content-range': 'bytes 0-1/9007199254740992', 'content-length': '2', etag: '"same"'}],
    [206, {'content-range': 'bytes 0-1/2', etag: '"same"'}]
  ];
  for (const [status, headers] of invalid) {
    let calls = 0;
    await assert.rejects(() => relayChunk(official, nodes, {range: {start: 0, end: 1, ifRange: '"same"'}, transport: async () => {calls++; return response(new Uint8Array(2), status, headers);}}));
    assert.equal(calls, 1);
  }
});
test('a truncated segment retries a different node at most once before emitting any bytes', async () => {
  const seen = [];
  const output = await relayChunk(official, nodes, {range: {start: 0, end: 2}, transport: async (target, node) => {
    seen.push(node.id);
    return node.id === 0 ? response(new Uint8Array([1]), 206, {'content-range': 'bytes 0-2/3', 'content-length': '3', etag: '"same"'}) : part(new Uint8Array([2, 3, 4]));
  }});
  assert.deepEqual(seen, [0, 1]); assert.deepEqual(new Uint8Array(await output.arrayBuffer()), new Uint8Array([2, 3, 4]));
  let failures = 0;
  await assert.rejects(() => relayChunk(official, nodes, {range: {start: 0, end: 0}, transport: async () => {failures++; throw new Error('private-upstream-detail');}}));
  assert.equal(failures, 2);
});
test('successful redirect node remains preferred while a failed asset node is replaced within the invocation', async () => {
  const calls = [];
  await relayChunk(official, nodes, {range: {start: 0, end: 0}, transport: async (target, node) => {
    calls.push([target.hostname, node.id]);
    if (target.hostname === 'github.com') return response('', 302, {location: signed});
    if (node.id === 0) throw new Error('temporary');
    return part(new Uint8Array([1]));
  }});
  assert.deepEqual(calls, [['github.com', 0], ['release-assets.githubusercontent.com', 0], ['github.com', 0], ['release-assets.githubusercontent.com', 1]]);
});
test('healthy CDN nodes are reused across segments only for the same subscription array', async () => {
  const calls = [];
  const transport = async (target, node) => {
    calls.push([target.hostname, node.id]);
    if (target.hostname === 'github.com') return response('', 302, {location: signed});
    if (node.id === 0) throw new Error('unavailable');
    return part(new Uint8Array([1]));
  };
  await relayChunk(official, nodes, {range: {start: 0, end: 0}, transport});
  assert.deepEqual(calls, [['github.com', 0], ['release-assets.githubusercontent.com', 0], ['github.com', 0], ['release-assets.githubusercontent.com', 1]]);
  calls.length = 0;
  const cached=await relayChunk(official, nodes, {range: {start: 0, end: 0}, transport});
  assert.equal(cached.headers.get('x-brclio-redirect-cache'),'hit');
  assert.deepEqual(calls, [['release-assets.githubusercontent.com', 1]]);
  calls.length = 0;
  await relayChunk(official, [...nodes], {range: {start: 0, end: 0}, transport});
  assert.deepEqual(calls, [['github.com', 0], ['release-assets.githubusercontent.com', 0], ['github.com', 0], ['release-assets.githubusercontent.com', 1]]);
});
test('signed redirect TTL is fixed at60seconds and cache hits cannot extend it',async t=>{
  t.mock.timers.enable({apis:['Date'],now:Date.now()});const calls=[];
  const transport=async target=>{calls.push(target.hostname);return target.hostname==='github.com'?response('',302,{location:signed}):part(new Uint8Array([1]));};
  try{
    const first=await relayChunk(official,nodes,{range:{start:0,end:0},transport});assert.equal(first.headers.get('x-brclio-redirect-cache'),'miss');
    t.mock.timers.tick(59999);calls.length=0;await relayChunk(official,nodes,{range:{start:0,end:0},transport});assert.deepEqual(calls,['release-assets.githubusercontent.com']);
    t.mock.timers.tick(2);calls.length=0;await relayChunk(official,nodes,{range:{start:0,end:0},transport});assert.deepEqual(calls,['github.com','release-assets.githubusercontent.com']);
  }finally{t.mock.timers.reset();}
});
test('cached403 refreshes via canonical URL within the original two-attempt budget',async()=>{
  let rejectCached=false;const calls=[];
  const transport=async(target,node)=>{calls.push([target.hostname,node.id]);if(target.hostname==='github.com')return response('',302,{location:signed});if(rejectCached){rejectCached=false;return response('',403);}return part(new Uint8Array([1]));};
  await relayChunk(official,nodes,{range:{start:0,end:0},transport});rejectCached=true;calls.length=0;
  const result=await relayChunk(official,nodes,{range:{start:0,end:0,ifRange:'"same"'},transport});
  assert.equal(result.status,206);assert.equal(result.headers.get('x-brclio-redirect-cache'),'refreshed');
  assert.deepEqual(calls,[['release-assets.githubusercontent.com',0],['github.com',0],['release-assets.githubusercontent.com',0]]);
  calls.length=0;
  await assert.rejects(()=>relayChunk(official,nodes,{range:{start:0,end:0},transport:async target=>{calls.push(target.hostname);return target.hostname==='github.com'?response('',302,{location:signed}):response('',403);}}));
  assert.deepEqual(calls,['release-assets.githubusercontent.com','github.com','release-assets.githubusercontent.com']);
});
test('signed redirect cache stores only complete verified responses and cannot hide validation failures',async()=>{
  const calls=[];let valid=false;
  const transport=async target=>{calls.push(target.hostname);if(target.hostname==='github.com')return response('',302,{location:signed});return part(new Uint8Array([1]),0,1,valid?'"same"':'W/"weak"');};
  await assert.rejects(()=>relayChunk(official,nodes,{range:{start:0,end:0},transport}));valid=true;calls.length=0;
  await relayChunk(official,nodes,{range:{start:0,end:0},transport});assert.deepEqual(calls,['github.com','release-assets.githubusercontent.com']);
  calls.length=0;
  await assert.rejects(()=>relayChunk(official,nodes,{range:{start:0,end:0,ifRange:'"changed"'},transport}));assert.deepEqual(calls,['release-assets.githubusercontent.com']);
});
test('signed redirect cache is bounded to sixteen canonical assets per subscription array',async()=>{
  const calls=[];const transport=async target=>{calls.push(target.hostname);return target.hostname==='github.com'?response('',302,{location:signed}):part(new Uint8Array([1]));};
  const asset=index=>official.replaceAll('0.1.9',`0.2.${index}`);
  for(let index=0;index<17;index++)await relayChunk(asset(index),nodes,{range:{start:0,end:0},transport});
  calls.length=0;await relayChunk(asset(16),nodes,{range:{start:0,end:0},transport});assert.deepEqual(calls,['release-assets.githubusercontent.com']);
  calls.length=0;await relayChunk(asset(0),nodes,{range:{start:0,end:0},transport});assert.deepEqual(calls,['github.com','release-assets.githubusercontent.com']);
});
test('hostile redirect and excess body bytes are rejected before delivery', async () => {
  let calls = 0;
  await assert.rejects(() => relayChunk(official, nodes, {range: {start: 0, end: 0}, transport: async () => {calls++; return response('', 302, {location: 'https://untrusted.example/file'});}}));
  assert.equal(calls, 1);
  await assert.rejects(() => relayChunk(official, nodes, {range: {start: 0, end: 0}, transport: async () => response(new Uint8Array(2), 206, {'content-range': 'bytes 0-0/1', 'content-length': '1', etag: '"same"'})}));
});
test('chunk deadline bounds a stalled body and an already canceled request opens no tunnel', async () => {
  let transportSignal, calls = 0;
  await assert.rejects(() => relayChunk(official, nodes, {range: {start: 0, end: 0}, headerDeadlineMs: 20, transport: async (_target, _node, {signal}) => {
    calls++; transportSignal = signal;
    return {status: 206, headers: new Headers({'content-range': 'bytes 0-0/1', 'content-length': '1', etag: '"same"'}), body: new ReadableStream(), close() {}};
  }}));
  assert.equal(calls, 1); assert.equal(transportSignal.aborted, true);
  const abort = new AbortController(); abort.abort();
  await assert.rejects(() => relayChunk(official, nodes, {range: {start: 0, end: 0}, signal: abort.signal, transport: async () => {throw new Error('must not open');}}));
  assert.equal(MAX_CHUNK_BYTES, 131072);
});
test('final chunk failures expose only fixed enums and numeric attempt diagnostics',async t=>{
  const messages=[];t.mock.method(console,'warn',value=>messages.push(JSON.parse(value)));
  await assert.rejects(()=>relayChunk(official,nodes,{range:{start:0,end:0},transport:async()=>{throw new Error('https://private-node.example/?token=private-credential');}}));
  assert.deepEqual(messages.map(item=>item.event),['proxy_chunk_retry','proxy_chunk_failed']);
  assert.deepEqual(messages.map(item=>item.nodeIndex),[0,1]);assert.deepEqual(messages.map(item=>item.attempt),[1,2]);
  assert.ok(messages.every(item=>item.stage==='relay'&&item.code==='upstream_failed'&&Number.isInteger(item.elapsedMs)));
  assert.ok(!JSON.stringify(messages).includes('private'));
});
