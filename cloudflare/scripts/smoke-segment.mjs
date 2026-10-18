// Logs contain only fixed enums and a syntactically valid public request ID.
export function smokeResponseDiagnostic(response) {
  const ray = response.headers.get('cf-ray') || '';
  const server = response.headers.get('server')?.toLowerCase();
  const route = response.headers.get('x-brclio-route');
  return {
    status: response.status,
    cfRay: /^[a-f0-9]{16,32}-[a-z]{3}$/i.test(ray) ? ray : null,
    cfMitigatedEnum: response.headers.get('cf-mitigated') === 'challenge' ? 'challenge' : null,
    serverEnum: !server ? 'missing' : server === 'cloudflare' ? 'cloudflare' : /^(?:github|github\.com)$/.test(server) ? 'github' : 'other',
    routeEnum: !route ? 'missing' : route === 'subscription-vless' ? 'subscription-vless' : 'other',
  };
}

async function diagnostic503(response) {
  const reader = response.body?.getReader();
  let text = '', size = 0;
  try {
    while (reader && size < 2048) {
      const next = await reader.read();
      if (next.done) break;
      const bytes = next.value.subarray(0, 2048 - size);
      size += bytes.byteLength; text += new TextDecoder().decode(bytes);
    }
  } catch {} finally { await reader?.cancel().catch(() => {}); }
  const rawTitle = /<title[^>]*>([^<]*)<\/title>/i.exec(text)?.[1] || '';
  const title = /Worker exceeded resource limits/i.test(rawTitle) ? 'Worker exceeded resource limits'
    : /Worker threw exception/i.test(rawTitle) ? 'Worker threw exception'
    : /Service (?:Temporarily )?Unavailable/i.test(rawTitle) ? 'Service Unavailable'
    : rawTitle ? 'other' : 'missing';
  const errorCode = /\b(?:Error\s*(?:code\s*)?[:#]?\s*)(\d{3,5})\b/i.exec(text)?.[1] || null;
  const safe = smokeResponseDiagnostic(response);
  const contentType = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
  return {...safe, contentType: !contentType ? null : ['text/html', 'text/plain', 'application/json', 'application/octet-stream'].includes(contentType) ? contentType : 'other',
    server: safe.serverEnum, contentLength: /^\d{1,12}$/.test(response.headers.get('content-length') || '') ? response.headers.get('content-length') : null, sampledBytes: size, title, errorCode};
}

export async function smokeSegment(url, {headers, signal, fetchImpl = fetch, delay = ms => new Promise(resolve => setTimeout(resolve, ms))}) {
  let retryCount = 0;
  const diagnostics = [];
  try { for (let attempt = 0; ; attempt++) {
    const response = await fetchImpl(url, {headers, signal});
    if (response.status !== 503) return {response, retryCount, diagnostics};
    diagnostics.push({...await diagnostic503(response), attempt: attempt + 1});
    if (attempt === 1 || signal?.aborted) return {response, retryCount, diagnostics};
    await delay(500);
    signal?.throwIfAborted();
    retryCount++;
  }} catch (error) { error.segmentRetryCount = retryCount; error.http503Diagnostics = diagnostics; throw error; }
}
