// Read-only by default. --send-code EMAIL explicitly requests one test message.
// Never prints response bodies, cookies, OAuth states, credentials or tokens.
const args = process.argv.slice(2);
const originArgument = args.find(value => /^https?:\/\//.test(value)) || 'https://tools.brclio.com';
const sendIndex = args.indexOf('--send-code');
let stage = 'setup';
const results = {};
function serviceOrigin(value) {
  const url = new URL(value);
  const local = url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if ((!local && url.protocol !== 'https:') || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('invalid_origin');
  return url.origin;
}
try {
  const origin = serviceOrigin(originArgument);
  async function check(name, path, {method = 'GET', headers = {}, body, expected = 200, inspect} = {}) {
    stage = name;
    const response = await fetch(origin + path, {method, headers: {Accept: 'application/json', ...headers}, ...(body ? {body: JSON.stringify(body)} : {}), redirect: 'manual', credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(45000)});
    results[name] = {status: response.status};
    if (response.status !== expected) { await response.body?.cancel(); throw new Error('unexpected_http_status'); }
    if (inspect) {
      const content = await response.text();
      if (content.length > 16384) throw new Error('unexpected_response_size');
      inspect(JSON.parse(content), response);
    } else await response.body?.cancel();
  }
  await check('session', '/api/account/session', {inspect(value, response) {
    if (value.user !== null || value.csrf !== null || typeof value.googleEnabled !== 'boolean' || response.headers.get('Access-Control-Allow-Origin')) throw new Error('invalid_anonymous_session');
    results.session.googleEnabled = value.googleEnabled;
    if (typeof value.emailEnabled === 'boolean') results.session.emailEnabled = value.emailEnabled;
    if (args.includes('--ready') && (!value.googleEnabled || !value.emailEnabled)) throw new Error('providers_not_configured');
  }});
  await check('anonymous_data', '/api/account/data', {expected: 401});
  await check('foreign_origin', '/api/account/login', {method: 'POST', headers: {'Content-Type': 'application/json', Origin: 'https://invalid.example'}, body: {identifier: 'test', password: 'not-a-real-password'}, expected: 403});
  await check('native_with_foreign_origin', '/api/account/code', {method: 'POST', headers: {'Content-Type': 'application/json', Origin: 'https://invalid.example', 'X-Brclio-Client': 'native'}, body: {email: 'nobody@example.com'}, expected: 403});
  if (sendIndex >= 0) {
    const email = args[sendIndex + 1];
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('invalid_test_recipient');
    await check('verification_email', '/api/account/code', {method: 'POST', headers: {'Content-Type': 'application/json', 'X-Brclio-Client': 'native'}, body: {email}, inspect(value) { if (value.ok !== true) throw new Error('email_not_accepted'); }});
  }
  console.log(JSON.stringify({ok: true, results}, null, 2));
} catch (error) {
  const allowed = ['invalid_origin', 'unexpected_http_status', 'unexpected_response_size', 'invalid_anonymous_session', 'invalid_test_recipient', 'email_not_accepted', 'providers_not_configured'];
  const errorEnum = allowed.includes(error?.message) ? error.message : ['TimeoutError', 'AbortError'].includes(error?.name) ? 'timeout' : 'network_or_response_failure';
  console.error(JSON.stringify({ok: false, stage, errorEnum, results}, null, 2));
  process.exitCode = 1;
}
