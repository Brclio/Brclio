import {test} from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate} from 'node:timers/promises';
import {readSubscription} from '../src/config.js';

const url = 'https://subscription.example/sub?token=private-test-marker';
const subscription = JSON.stringify({proxies: [{type: 'vless', uuid: '00000000-0000-4000-8000-000000000001', server: 'route.example.com', servername: 'route.example.com', port: 443, tls: true, network: 'ws'}]});
function clock(t) {
  t.mock.timers.enable({apis: ['Date', 'setTimeout'], now: 50000});
  t.after(() => t.mock.timers.reset());
  return async milliseconds => {t.mock.timers.tick(milliseconds); await setImmediate();};
}
const failure = (status, headers, cancel = () => {}) => new Response(new ReadableStream({cancel}, {highWaterMark: 0}), {status, headers});
function delayedResponse(delay, result = () => new Response(subscription)) {
  return async () => new Promise(resolve => setTimeout(() => resolve(result()), delay));
}
function observe(promise) {
  let result;
  const done = promise.then(value => {result = {value};}, error => {result = {error};});
  return {done, get result() {return result;}};
}

test('a cold first attempt can still take 5.5 seconds within the original ten-second budget', async t => {
  const tick = clock(t), pending = observe(readSubscription(url, delayedResponse(5500)));
  await tick(5499);assert.equal(pending.result, undefined);
  await tick(1);await pending.done;
  assert.equal(pending.result.value.length, 1);assert.equal(Date.now(), 55500);
});

test('a timed-out first fetch fails at ten seconds without another GET or private diagnostics', async t => {
  const tick = clock(t), logs = [];t.mock.method(console, 'warn', value => logs.push(value));let calls = 0;
  const pending = observe(readSubscription(url, (...args) => {calls++;return delayedResponse(30000)(...args);}));
  await tick(9999);assert.equal(pending.result, undefined);
  await tick(1);await pending.done;
  assert.match(pending.result.error.message, /无法读取代理订阅/);assert.equal(calls, 1);
  assert.equal(Date.now(), 60000);
  assert.ok(!JSON.stringify({logs,error:pending.result.error.message}).includes('private-test-marker'));
  assert.ok(!JSON.stringify(logs).includes('subscription.example'));
});

test('temporary HTTP failures retry only once with identical URL, headers and deadline after canceling the failed body', async t => {
  const tick = clock(t);
  for (const status of [400, 408, 429, 500, 502, 503, 504]) {
    const calls = [];let canceled = 0;
    const pending = observe(readSubscription(url, async (target, options) => {
      calls.push({target, options});
      if (calls.length === 1) return failure(status, undefined, () => {canceled++;});
      assert.equal(canceled, 1);return new Response(subscription);
    }));
    await tick(0);assert.equal(calls.length, 1);assert.equal(canceled, 1);
    await tick(99);assert.equal(calls.length, 1);
    await tick(1);await pending.done;assert.equal(pending.result.value.length, 1);
    assert.equal(calls.length, 2);assert.equal(calls[0].target, url);assert.equal(calls[1].target, url);
    assert.deepEqual(calls[0].options.headers, {'User-Agent':'clash.meta',Accept:'text/yaml, text/plain, */*','Cache-Control':'no-cache, no-store',Pragma:'no-cache'});
    assert.deepEqual(calls[1].options.headers, calls[0].options.headers);
    assert.equal(calls[1].options.redirect, 'manual');assert.equal(calls[1].options.signal, calls[0].options.signal);
    assert.equal(new Headers(calls[1].options.headers).has('authorization'), false);
  }
});

test('fetch and interrupted response-body network failures may retry from the beginning', async t => {
  const tick = clock(t);
  for (const stage of ['fetch', 'body']) {
    let calls = 0;
    const pending = observe(readSubscription(url, async () => {
      if (++calls === 2) return new Response(subscription);
      if (stage === 'fetch') throw new TypeError('private-test-marker');
      return new Response(new ReadableStream({
        start(controller) {controller.enqueue(new TextEncoder().encode('discard-partial-prefix'));},
        pull(controller) {controller.error(new Error('private-test-marker'));},
      }, {highWaterMark: 0}));
    }));
    await tick(0);await tick(100);await pending.done;
    assert.equal(pending.result.value.length, 1);assert.equal(calls, 2);
  }
});

test('two HTTP400 responses stop after exactly two GETs and return a sanitized failure', async t => {
  const tick = clock(t);let calls = 0, canceled = 0;
  const pending = observe(readSubscription(url, async () => {calls++;return failure(400, undefined, () => {canceled++;});}));
  await tick(0);await tick(100);await pending.done;
  assert.equal(calls, 2);assert.equal(canceled, 2);assert.match(pending.result.error.message, /无法读取代理订阅/);
  await tick(10000);assert.equal(calls, 2);
});

test('the second GET and its body receive only the remainder of the same ten-second budget', async t => {
  const tick = clock(t), signals = [];let calls = 0;
  const pending = observe(readSubscription(url, async (_target, {signal}) => {
    signals.push(signal);
    if (++calls === 1) return delayedResponse(9000, () => failure(400))();
    return new Response(new ReadableStream({pull() {return new Promise(() => {});}}, {highWaterMark: 0}));
  }));
  await tick(9000);assert.equal(calls, 1);await tick(100);assert.equal(calls, 2);
  assert.equal(signals[0], signals[1]);await tick(899);assert.equal(pending.result, undefined);
  await tick(1);await pending.done;
  assert.equal(Date.now(), 60000);assert.equal(signals[1].aborted, true);assert.match(pending.result.error.message, /无法读取代理订阅/);
});

test('an error-body cancellation that never settles cannot extend the shared deadline or start a retry', async t => {
  const tick = clock(t);let calls = 0, canceled = 0;
  const pending = observe(readSubscription(url, async () => {calls++;return failure(400, undefined, () => {canceled++;return new Promise(() => {});});}));
  await tick(0);assert.equal(canceled, 1);await tick(10000);await pending.done;
  assert.equal(calls, 1);assert.match(pending.result.error.message, /无法读取代理订阅/);
});

test('Retry-After seconds and HTTP dates are respected for both 429 and 503 within the remaining budget', async t => {
  const tick = clock(t);
  for (const [status, date] of [[429,false],[429,true],[503,false],[503,true]]) {
    const retryAfter = date ? new Date(Date.now() + 1000).toUTCString() : '1';
    let calls = 0;
    const pending = observe(readSubscription(url, async () => ++calls === 1 ? failure(status, {'Retry-After':retryAfter}) : new Response(subscription)));
    await tick(0);await tick(999);assert.equal(calls, 1);
    await tick(1);await pending.done;assert.equal(calls, 2);assert.equal(pending.result.value.length, 1);
  }
});

test('long or invalid Retry-After and permanent HTTP errors fail closed after one GET', async t => {
  clock(t);
  for (const [status, headers] of [[429, {'Retry-After':'60'}], [503, {'Retry-After':'60'}], ...['invalid','-1','1.5'].map(value=>[429,{'Retry-After':value}]), ...[301,302,307,308,401,403,404,410,501,505].map(status => [status])]) {
    let calls = 0, canceled = 0;
    await assert.rejects(readSubscription(url, async () => {calls++;return failure(status, headers, () => {canceled++;});}), /无法读取代理订阅/);
    assert.equal(calls, 1);assert.equal(canceled, 1);
  }
});

test('invalid syntax, unsupported nodes and oversized bodies are never retried', async t => {
  clock(t);
  for (const response of [new Response('{"proxies": ['), new Response('{"proxies":[]}'), new Response(new Uint8Array(1024 * 1024 + 1)), failure(200, {'Content-Length':String(1024 * 1024 + 1)})]) {
    let calls = 0;
    await assert.rejects(readSubscription(url, async () => {calls++;return response;}));assert.equal(calls, 1);
  }
});
