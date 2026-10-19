'use strict';
// Deliberate network mock for UI/native-install tests; production uses net.request.
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');
function mockElectronRequest(fetch) {
  return options => {
    const request = new EventEmitter(), controller = new AbortController(); let stopped = false, incoming;
    request.abort = () => { if (stopped) return; stopped = true; controller.abort(); incoming?.destroy(); request.emit('abort'); request.emit('close'); };
    request.end = () => { void (async () => {
      try {
        const response = await fetch(options.url, { ...options, signal: controller.signal });
        if (stopped) { await response.body?.cancel(); return; }
        const headers = Object.fromEntries(response.headers);
        if ([301,302,303,307,308].includes(response.status)) { request.emit('redirect', response.status, options.method, headers.location, headers); return; }
        incoming = response.body ? Readable.fromWeb(response.body) : Readable.from([]);
        Object.assign(incoming, { statusCode: response.status, statusMessage: response.statusText, headers });
        incoming.once('end', () => { stopped = true; queueMicrotask(() => request.emit('close')); });
        incoming.on('error', () => {});
        request.emit('response', incoming);
      } catch (error) { if (!stopped) { request.emit('error', error); request.emit('close'); } }
    })(); };
    return request;
  };
}
module.exports = { mockElectronRequest };
