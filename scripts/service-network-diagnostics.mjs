import {mkdir, writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';

const ORIGIN = 'https://tools.brclio.com';
const METADATA = '/api/update?url=' + encodeURIComponent('https://api.github.com/repos/Brclio/Brclio/releases/latest');
const MAX_BODY_BYTES = 4096;
const HEADER_NAMES = ['cf-ray', 'cf-mitigated', 'server', 'content-type', 'x-brclio-route', 'x-ratelimit-remaining', 'x-ratelimit-reset'];

async function boundedBody(response) {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks = []; let length = 0;
  try {
    while (length < MAX_BODY_BYTES) {
      const {done, value} = await reader.read();
      if (done) break;
      const part = value.subarray(0, MAX_BODY_BYTES - length);
      chunks.push(part); length += part.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const bytes = new Uint8Array(length); let offset = 0;
  for (const part of chunks) { bytes.set(part, offset); offset += part.byteLength; }
  return new TextDecoder().decode(bytes);
}

export function normalizeBody(body, status, mitigated) {
  // Return fixed enums only: never retain a page title, message, IP or URL.
  const title = /<title[^>]*>([^<]*)<\/title>/i.exec(body)?.[1] || '';
  const titleEnum = /just a moment|attention required|checking your browser/i.test(title) ? 'cloudflare_challenge'
    : /worker exceeded resource limits/i.test(title) ? 'worker_resource_limit'
    : /access denied|forbidden/i.test(title) ? 'access_denied'
    : title ? 'other_html_title' : null;
  let errorEnum = mitigated === 'challenge' ? 'cloudflare_challenge'
    : /worker exceeded resource limits|error\s*1102/i.test(body) ? 'worker_resource_limit'
    : /api rate limit exceeded|secondary rate limit|rate limit exceeded/i.test(body) ? 'github_rate_limit'
    : titleEnum === 'cloudflare_challenge' ? 'cloudflare_challenge'
    : titleEnum === 'access_denied' ? 'access_denied'
    : null;
  if (!errorEnum) {
    try {
      const data = JSON.parse(body);
      errorEnum = typeof data.error === 'string' || typeof data.message === 'string' ? 'json_error'
        : status === 200 ? 'json_success' : 'unrecognized_json';
    } catch {
      errorEnum = !body ? 'empty_body' : /<html|<!doctype/i.test(body) ? 'html_response'
        : status === 200 ? 'successful_body_prefix' : 'unrecognized_body_prefix';
    }
  }
  return {titleEnum, errorEnum};
}

export async function diagnose(fetchImpl = fetch) {
  const results = [];
  // Exactly four GETs; redirects and automatic retries are deliberately off.
  for (const customUA of [false, true]) for (const metadata of [false, true]) {
    const result = {probe: `${metadata ? 'metadata' : 'health'}-${customUA ? 'brclio-ua' : 'default-ua'}`, status: null};
    for (const name of HEADER_NAMES) result[name] = null;
    try {
      const response = await fetchImpl(ORIGIN + (metadata ? METADATA : '/api/health'), {
        method: 'GET', redirect: 'manual', credentials: 'omit', signal: AbortSignal.timeout(20000),
        ...(customUA ? {headers: {'User-Agent': 'Brclio-Updater/1.0'}} : {}),
      });
      result.status = response.status;
      for (const name of HEADER_NAMES) {
        const value = response.headers.get(name);
        result[name] = value === null ? null : value.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 256);
      }
      Object.assign(result, normalizeBody(await boundedBody(response), response.status, result['cf-mitigated']));
    } catch (error) {
      result.titleEnum = null;
      result.errorEnum = ['TimeoutError', 'AbortError'].includes(error?.name) ? 'request_timeout' : 'network_or_body_error';
    }
    results.push(result);
  }
  return {results};
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = await diagnose();
  await mkdir('artifacts', {recursive: true});
  await writeFile('artifacts/service-network-diagnostics.json', JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
}
