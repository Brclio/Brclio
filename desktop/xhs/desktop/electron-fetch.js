// Copied unchanged from brclio-xhs-media-downloader desktop/update-manager.js.
// Keep the source function intact; the XHS service supplies its own direct session.
// Electron net.fetch rejects manual redirects instead of exposing their response.
// Adapt net.request so the manager can validate every Location before following it.
export function createElectronUpdateFetch(net, { session } = {}) {
  return (url, options = {}) => new Promise((resolve, reject) => {
    const signal = options.signal;
    if (signal?.aborted) { reject(signal.reason); return; }
    let request, bodyController;
    let settled = false, finished = false;
    const cleanup = () => signal?.removeEventListener('abort', abort);
    const failure = error => {
      if (finished) return;
      finished = true;
      cleanup();
      if (!settled) { settled = true; reject(error); }
      else bodyController?.error(error);
    };
    const abort = () => {
      failure(signal.reason || new Error('Update request aborted'));
      request?.abort();
    };
    try {
      request = net.request({ url, method: options.method || 'GET', session, cache: options.cache, redirect: 'manual', credentials: 'omit',
        useSessionCookies: false, bypassCustomProtocolHandlers: true,
        headers: Object.fromEntries(new Headers(options.headers)) });
      request.on('error', failure);
      request.once('redirect', (status, _method, location) => {
        if (settled) return;
        try {
          const response = new Response(null, { status, headers: { location } });
          settled = true;
          finished = true;
          cleanup();
          resolve(response);
          request.abort();
        } catch (error) { failure(error); request.abort(); }
      });
      request.once('response', incoming => {
        if (settled) { request.abort(); return; }
        try {
        incoming.pause();
        const headers = new Headers();
        for (const [name, values] of Object.entries(incoming.headers)) {
          for (const value of Array.isArray(values) ? values : [values]) {
            if (value != null) headers.append(name, String(value));
          }
        }
        if ([204, 205, 304].includes(incoming.statusCode)) {
          const response = new Response(null, { status: incoming.statusCode, headers });
          settled = true;
          finished = true;
          cleanup();
          resolve(response);
          request.abort();
          return;
        }
        const body = new ReadableStream({
          start(controller) {
            bodyController = controller;
            incoming.on('data', chunk => {
              if (finished) return;
              controller.enqueue(chunk);
              if (controller.desiredSize <= 0) incoming.pause();
            });
            incoming.once('end', () => {
              if (finished) return;
              finished = true;
              cleanup();
              controller.close();
            });
            incoming.on('error', failure);
            incoming.once('aborted', () => failure(new Error('Update response aborted')));
          },
          pull() { incoming.resume(); },
          cancel() { finished = true; cleanup(); request.abort(); }
        });
        const response = new Response(body, { status: incoming.statusCode, headers });
        settled = true;
        resolve(response);
        } catch (error) { failure(error); request.abort(); }
      });
      signal?.addEventListener('abort', abort, { once: true });
      request.end(options.body);
    } catch (error) { failure(error); request?.abort(); }
  });
}
