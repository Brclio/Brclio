'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {EventEmitter} = require('node:events');
const {Readable} = require('node:stream');
const {electronAccountVerifierFetch} = require('./account-verifier-fetch.cjs');
const url = 'https://tools.brclio.com/api/account/login';
function fixture() {
  const native = new EventEmitter(); let options, body, started = 0, aborted = 0;
  native.end = value => {body = value; started++;};
  native.abort = () => {aborted++; native.emit('error', Error('request canceled'));};
  return {native, request(value) {options = value; return native;},
    get options() {return options;}, get body() {return body;}, get started() {return started;}, get aborted() {return aborted;}};
}
function respond(f, status, chunks = ['{"error":"denied"}']) {
  const incoming = Readable.from(chunks.map(value => Buffer.from(value)));
  Object.assign(incoming, {statusCode: status, statusMessage: 'Fixture', headers: {'content-type': 'application/json'}});
  f.native.emit('response', incoming); return incoming;
}
test('negative-Origin POST preserves its JSON body and exposes the real application 403', async () => {
  const f = fixture(), session = {}, body = JSON.stringify({identifier: 'fixture', password: 'not-a-real-password'});
  const pending = electronAccountVerifierFetch(f.request, session, url, {method: 'POST', body,
    headers: {'Content-Type': 'application/json', Origin: 'https://invalid.example', 'X-Brclio-Client': 'native'}, redirect: 'manual', credentials: 'omit'});
  respond(f, 403); const response = await pending;
  assert.equal(response.status, 403); assert.deepEqual(await response.json(), {error: 'denied'});
  assert.equal(f.body, body); assert.equal(f.options.headers.origin, 'https://invalid.example');
  assert.equal(f.options.session, session); assert.equal(f.options.credentials, 'omit'); assert.equal(f.options.redirect, 'manual');
  assert.equal(f.options.bypassCustomProtocolHandlers, true); assert.equal(f.options.cache, 'no-store');
});
test('redirect remains a redirect and cannot follow to another origin', async () => {
  const f = fixture(), pending = electronAccountVerifierFetch(f.request, {}, url);
  f.native.emit('redirect', 302, 'GET', 'https://invalid.example/', {location: ['https://invalid.example/']});
  const response = await pending;
  assert.equal(response.status, 302); assert.equal(response.headers.get('location'), 'https://invalid.example/');
  assert.equal(response.body, null); assert.equal(f.aborted, 1);
});
test('request guard rejects other destinations, credentials, methods and oversized bodies before transport', async () => {
  for (const [target, init] of [
    ['https://invalid.example/api/account/login', {}], ['http://tools.brclio.com/api/account/login', {}],
    [url + '?token=fixture', {}], [url, {method: 'PUT'}], [url, {redirect: 'follow'}],
    [url, {credentials: 'include'}], [url, {body: '{}'}], [url, {method: 'POST', body: 'a'.repeat(16385)}],
    [url, {headers: {Authorization: 'Bearer fixture'}}], [url, {headers: {Cookie: 'fixture=1'}}],
  ]) {
    const f = fixture(); await assert.rejects(electronAccountVerifierFetch(f.request, {}, target, init), TypeError);
    assert.equal(f.started, 0); assert.equal(f.options, undefined);
  }
});
test('preaborted and timed-out requests never turn into an HTTP result', async () => {
  const controller = new AbortController(); controller.abort(); const stopped = fixture();
  await assert.rejects(electronAccountVerifierFetch(stopped.request, {}, url, {signal: controller.signal}), {name: 'AbortError'});
  assert.equal(stopped.started, 0);
  const f = fixture(), keepAlive = setTimeout(() => {}, 1000);
  try {await assert.rejects(electronAccountVerifierFetch(f.request, {}, url, {signal: AbortSignal.timeout(5)}), {name: 'AbortError'});}
  finally {clearTimeout(keepAlive);}
  assert.equal(f.aborted, 1);
});
test('abort after headers rejects body consumption; body cancellation aborts native IO', async () => {
  for (const cancel of [false, true]) {
    const f = fixture(), controller = new AbortController();
    const pending = electronAccountVerifierFetch(f.request, {}, url, {signal: controller.signal});
    const incoming = new Readable({read() {}}); Object.assign(incoming, {statusCode: 200, headers: {}});
    f.native.emit('response', incoming); const response = await pending;
    if (cancel) await response.body.cancel();
    else {controller.abort(); await assert.rejects(response.text(), {name: 'AbortError'});}
    assert.equal(f.aborted, 1);
  }
});
test('truncated or oversized responses and TLS errors fail explicitly', async () => {
  const f = fixture(), pending = electronAccountVerifierFetch(f.request, {}, url);
  const incoming = new Readable({read() {}}); Object.assign(incoming, {statusCode: 200, headers: {}});
  f.native.emit('response', incoming); const response = await pending;
  incoming.emit('close'); await assert.rejects(response.text(), /incomplete/);
  const large = fixture(), growing = electronAccountVerifierFetch(large.request, {}, url);
  respond(large, 200, ['x'.repeat(16385)]); await assert.rejects((await growing).text(), /too_large/);
  assert.equal(large.aborted, 1);
  const tls = fixture(), failed = electronAccountVerifierFetch(tls.request, {}, url);
  tls.native.emit('error', Object.assign(Error('certificate rejected'), {code: 'ERR_CERT_AUTHORITY_INVALID'}));
  await assert.rejects(failed, {code: 'ERR_CERT_AUTHORITY_INVALID'});
});
