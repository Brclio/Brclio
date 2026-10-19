'use strict';

// Electron session.fetch rejects manual redirects instead of exposing their
// headers. Keep Chromium's TLS/proxy/session handling, but surface each redirect
// without following it so update-proxy can validate every official destination.
function electronUpdateFetch(request, session, url, init = {}) {
  const signal = init.signal;
  const aborted = () => Object.assign(new Error('更新请求已取消。'), { name: 'AbortError' });
  if (signal?.aborted) return Promise.reject(aborted());
  return new Promise((resolve, reject) => {
    let native, incoming, controller, settled = false, complete = false;
    const cleanup = () => signal?.removeEventListener('abort', abort);
    const fail = error => {
      if (complete) return;
      complete = true; cleanup();
      if (!settled) { settled = true; reject(error); }
      else controller?.error(error);
    };
    const abort = () => { fail(aborted()); native?.abort(); };
    const headersFor = values => {
      const headers = new Headers();
      for (const [name, value] of Object.entries(values)) for (const item of Array.isArray(value) ? value : [value]) headers.append(name, item);
      return headers;
    };
    const response = (body, status, statusText, headers) => {
      const value = new Response(body, { status, statusText, headers: headersFor(headers) });
      Object.defineProperty(value, 'url', { value: url });
      settled = true; resolve(value);
    };
    try {
      const method = init.method || 'GET';
      if (!['GET', 'HEAD'].includes(method) || init.body != null) throw new TypeError('更新请求方法无效。');
      native = request({ url, session, method, headers: Object.fromEntries(new Headers(init.headers)),
        redirect: 'manual', credentials: 'omit', cache: init.cache || 'no-store', bypassCustomProtocolHandlers: true });
      native.on('error', fail);
      // ClientRequest is a Writable: its close can follow end() while Chromium
      // is still receiving. Native errors and IncomingMessage own termination.
      native.once('redirect', (status, _method, _location, headers) => {
        if (complete) return;
        // Never call followRedirect: the router must authorize the next request.
        try { complete = true; cleanup(); response(null, status, '', headers); }
        catch (error) { complete = false; fail(error); }
        finally { native.abort(); }
      });
      native.once('response', value => {
        if (complete) { native.abort(); return; }
        incoming = value; incoming.pause();
        const empty = method === 'HEAD' || [204, 205, 304].includes(incoming.statusCode);
        incoming.once('end', () => { if (!complete) { complete = true; cleanup(); controller?.close(); } });
        incoming.once('aborted', () => fail(signal?.aborted ? aborted() : new Error('更新连接提前关闭。')));
        incoming.once('close', () => { if (!complete) fail(new Error('更新连接提前关闭。')); });
        incoming.on('error', fail);
        try {
          const body = empty ? null : new ReadableStream({
            start(value) { controller = value; },
            pull() { incoming.resume(); },
            cancel() { if (!complete) { complete = true; cleanup(); native.abort(); } },
          }, { highWaterMark: 0 });
          if (!empty) incoming.on('data', bytes => { incoming.pause(); if (!complete) controller.enqueue(bytes); });
          response(body, incoming.statusCode, incoming.statusMessage || '', incoming.headers);
          if (empty) incoming.resume();
        } catch (error) { fail(error); native.abort(); }
      });
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort(); else native.end();
    } catch (error) { fail(error); native?.abort(); }
  });
}

module.exports = { electronUpdateFetch };
