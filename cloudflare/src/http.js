export const securityHeaders = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains'
};

export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {...securityHeaders, 'Content-Type': 'application/json; charset=utf-8', ...headers}
  });
}

export async function readJSON(request) {
  if (!(request.headers.get('content-type') || '').startsWith('application/json')) throw new Error('invalid');
  if (Number(request.headers.get('content-length')) > 16384) throw new Error('invalid');
  const reader = request.body?.getReader();
  if (!reader) throw new Error('invalid');
  let text = '', size = 0;
  const decoder = new TextDecoder();
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.length;
      if (size > 16384) throw new Error('invalid');
      text += decoder.decode(next.value, {stream: true});
    }
    return JSON.parse(text + decoder.decode());
  } finally {
    await reader.cancel().catch(() => {});
  }
}

const localLimits = new Map();
export async function rateLimit(env, name, key, limit) {
  if (env[name]) return (await env[name].limit({key})).success;
  // Local fallback is only for development and tests. Deploy the native bindings.
  const now = Date.now();
  for (const [id, bucket] of localLimits) if (bucket.until < now) localLimits.delete(id);
  const id = name + ':' + key;
  const bucket = localLimits.get(id) || {count: 0, until: now + 60000};
  bucket.count++;
  localLimits.set(id, bucket);
  return bucket.count <= limit;
}
