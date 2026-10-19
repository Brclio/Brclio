'use strict';

// Release verification only. Main-process net.request exposes the application's
// rejected-Origin responses; renderer/fetch CORS rejections are not HTTP evidence.
// Keep the updater's separate GET-only transport unchanged.
function electronAccountVerifierFetch(request, session, url, init = {}) {
  const signal = init.signal || AbortSignal.timeout(45000);
  const aborted = () => Object.assign(new Error('account_verifier_aborted'), { name: 'AbortError' });
  if (signal.aborted) return Promise.reject(aborted());
  return new Promise((resolve, reject) => {
    let native, incoming, controller, settled = false, complete = false, received = 0;
    const cleanup = () => signal.removeEventListener('abort', abort);
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
      const destination = new URL(url), method = init.method || 'GET', headers = new Headers(init.headers);
      const local = destination.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(destination.hostname);
      if ((!local && destination.origin !== 'https://tools.brclio.com') || destination.username || destination.password || destination.search || destination.hash
        || !['/api/account/session', '/api/account/data', '/api/account/login', '/api/account/code'].includes(destination.pathname)) throw new TypeError('invalid_verifier_destination');
      if (!['GET', 'POST'].includes(method) || (init.redirect && init.redirect !== 'manual') || (init.credentials && init.credentials !== 'omit')
        || (method === 'GET' && init.body != null) || (init.body != null && (typeof init.body !== 'string' || Buffer.byteLength(init.body) > 16384))
        || ['authorization', 'cookie', 'proxy-authorization'].some(name => headers.has(name))) throw new TypeError('invalid_verifier_request');
      native = request({ url, session, method, headers: Object.fromEntries(headers), redirect: 'manual', credentials: 'omit', cache: 'no-store', bypassCustomProtocolHandlers: true });
      native.on('error', fail);
      native.once('redirect', (status, _method, _location, values) => {
        if (complete) return;
        try { complete = true; cleanup(); response(null, status, '', values); }
        catch (error) { complete = false; fail(error); }
        finally { native.abort(); }
      });
      native.once('response', value => {
        if (complete) { native.abort(); return; }
        incoming = value; incoming.pause();
        const empty = [204, 205, 304].includes(incoming.statusCode);
        incoming.once('end', () => { if (!complete) { complete = true; cleanup(); controller?.close(); } });
        incoming.once('aborted', () => fail(signal.aborted ? aborted() : new Error('account_response_incomplete')));
        incoming.once('close', () => { if (!complete) fail(new Error('account_response_incomplete')); });
        incoming.on('error', fail);
        try {
          const body = empty ? null : new ReadableStream({
            start(value) { controller = value; },
            pull() { incoming.resume(); },
            cancel() { if (!complete) { complete = true; cleanup(); native.abort(); } },
          }, { highWaterMark: 0 });
          if (!empty) incoming.on('data', bytes => {
            incoming.pause(); received += bytes.length;
            if (received > 16384) { fail(new Error('account_response_too_large')); native.abort(); }
            else if (!complete) controller.enqueue(bytes);
          });
          response(body, incoming.statusCode, incoming.statusMessage || '', incoming.headers);
          if (empty) incoming.resume();
        } catch (error) { fail(error); native.abort(); }
      });
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort(); else native.end(init.body);
    } catch (error) { fail(error); native?.abort(); }
  });
}

module.exports = { electronAccountVerifierFetch };
