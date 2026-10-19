'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');
const { electronUpdateFetch } = require('./electron-update-fetch.cjs');
function fixture() {
  const native = new EventEmitter(); let aborted = 0, started = 0, options;
  native.end = () => started++;
  native.abort = () => { aborted++; native.emit('error', Error('Redirect was cancelled')); native.emit('close'); };
  return { native, request: value => { options = value; return native; }, get options() { return options; }, get aborted() { return aborted; }, get started() { return started; } };
}
test('manual Electron redirect exposes headers once and aborts without following or leaking credentials', async () => {
  const f = fixture(), session = {};
  const pending = electronUpdateFetch(f.request, session, 'https://github.com/official', { headers: { Accept: 'text/plain' } });
  f.native.emit('redirect', 302, 'GET', 'https://objects.githubusercontent.com/signed', { location: ['https://objects.githubusercontent.com/signed'] });
  const response = await pending;
  assert.equal(response.status, 302); assert.equal(response.headers.get('location'), 'https://objects.githubusercontent.com/signed');
  assert.equal(response.url, 'https://github.com/official'); assert.equal(response.body, null); assert.equal(f.aborted, 1);
  assert.equal(f.options.session, session); assert.equal(f.options.redirect, 'manual'); assert.equal(f.options.credentials, 'omit'); assert.equal(f.options.cache, 'no-store'); assert.equal(f.options.bypassCustomProtocolHandlers, true);
});
test('native streaming preserves bytes with backpressure and abort remains active after headers', async () => {
  const f = fixture(), controller = new AbortController();
  const pending = electronUpdateFetch(f.request, {}, 'https://github.com/official', { signal: controller.signal });
  const incoming = new Readable({ read() {} }); Object.assign(incoming, { statusCode: 200, statusMessage: 'OK', headers: { 'content-length': '6' } });
  f.native.emit('response', incoming); const response = await pending;
  f.native.emit('close'); // Native completion can precede draining the response.
  assert.equal(incoming.isPaused(), true);
  const reader = response.body.getReader(); const reading = reader.read(); incoming.push(Buffer.from('abc'));
  assert.equal(Buffer.from((await reading).value).toString(), 'abc'); assert.equal(incoming.isPaused(), true);
  controller.abort(); await assert.rejects(reader.read(), { name: 'AbortError' }); assert.equal(f.aborted, 1);
});
test('body cancellation aborts native request and premature close fails rather than accepting truncated EOF', async () => {
  for (const cancel of [false, true]) {
    const f = fixture(), pending = electronUpdateFetch(f.request, {}, 'https://github.com/official');
    const incoming = new Readable({ read() {} }); Object.assign(incoming, { statusCode: 200, headers: {} });
    f.native.emit('response', incoming); const response = await pending;
    if (cancel) { await response.body.cancel(); assert.equal(f.aborted, 1); }
    else { incoming.emit('close'); await assert.rejects(response.text(), /提前关闭/); }
  }
});
test('HEAD/bodyless responses are valid, preaborted requests never start, and native TLS errors reject', async () => {
  const f = fixture(), pending = electronUpdateFetch(f.request, {}, 'https://github.com/official', { method: 'HEAD' });
  f.native.emit('close'); // Writable completion is not network completion.
  const incoming = Readable.from([]); Object.assign(incoming, { statusCode: 200, headers: {} }); f.native.emit('response', incoming);
  assert.equal((await pending).body, null); await new Promise(resolve => incoming.once('end', resolve));
  const stopped = new AbortController(); stopped.abort(); await assert.rejects(electronUpdateFetch(() => { throw Error('started'); }, {}, 'https://github.com/official', { signal: stopped.signal }), { name: 'AbortError' });
  const bad = fixture(), failed = electronUpdateFetch(bad.request, {}, 'https://github.com/official'); bad.native.emit('error', Object.assign(Error('certificate rejected'), { code: 'ERR_CERT_AUTHORITY_INVALID' }));
  await assert.rejects(failed, { code: 'ERR_CERT_AUTHORITY_INVALID' });
});
