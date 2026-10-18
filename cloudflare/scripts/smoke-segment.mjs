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
  return {status: 503, cfRay: response.headers.get('cf-ray')?.slice(0,128) || null, contentType: response.headers.get('content-type')?.split(';')[0].slice(0,128) || null,
    server: response.headers.get('server')?.slice(0,64) || null, contentLength: /^\d{1,12}$/.test(response.headers.get('content-length') || '') ? response.headers.get('content-length') : null, sampledBytes: size, title, errorCode};
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
