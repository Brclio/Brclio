import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const url = process.env.BRCLIO_TEST_URL || 'http://127.0.0.1:4173';
const browser = await chromium.launch({ executablePath: process.env.BRCLIO_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1060 } });
const page = await context.newPage();
page.setDefaultTimeout(15000);
const errors = [];
page.on('pageerror', error => errors.push(error.message));
page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
let user = null;
let cloud = { preferences: {}, updatedAt: '2026-10-19T05:00:00Z' };
const calls = [];
let googleStartURL;
let switchOnData;
await context.route('**/api/account/**', async route => {
  const request = route.request();
  const pathname = new URL(request.url()).pathname;
  const body = request.postDataJSON();
  calls.push({ pathname, method: request.method(), body, csrf: request.headers()['x-csrf-token'] });
  let result = {};
  if (pathname.endsWith('/google/start')) {
    googleStartURL = request.url();
    await route.fulfill({ status: 200, contentType: 'text/html', body: '<p>Google OAuth provider handoff</p>' });
    return;
  }
  if (pathname.endsWith('/session')) result = { user, csrf: 'test-csrf', googleEnabled: true };
  else if (pathname.endsWith('/register') || pathname.endsWith('/login')) { user = { id: 'test-user', username: 'brclio_test', email: 'test@example.com' }; result = { user }; }
  else if (pathname.endsWith('/logout')) user = null;
  else if (pathname.endsWith('/data')) {
    if (switchOnData) { user = switchOnData; switchOnData = null; }
    if (request.method() === 'PUT') cloud = { ...body, updatedAt: '2026-10-19T06:00:00Z' };
    result = { ...cloud, userId: user?.id };
  }
  await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(result) });
});

try {
  await page.goto(url);
  await page.locator('body[data-ready="true"]').waitFor();
  await page.locator('input[name="pathMode"][value="relative"]').locator('..').click();
  await page.locator('#base-path').fill('/private/local-only');
  await page.locator('#quote-mode').selectOption('double');
  await page.locator('#account-button').click();
  await page.locator('#account-google:not(:disabled)').waitFor();
  await page.locator('#account-register-tab').click();
  await page.locator('#account-username').fill('brclio_test');
  await page.locator('#account-email').fill('test@example.com');
  await page.locator('#account-send-code').click();
  await page.locator('#account-message').filter({ hasText: '验证码已发送' }).waitFor();
  assert.equal(calls.filter(call => call.pathname.endsWith('/code')).length, 1);
  assert.equal(await page.locator('#account-send-code').isDisabled(), true);
  await page.locator('#account-code').fill('123456');
  await page.locator('#account-register-password').fill('test-password-123');
  await page.locator('#account-register-form button[type="submit"]').click();
  await page.locator('#account-profile-name').filter({ hasText: 'brclio_test' }).waitFor();
  assert.equal(await page.locator('#account-apply').isDisabled(), true);
  assert.equal(await page.locator('#account-cloud-state').innerText(), '尚无云端偏好');
  assert.equal(await page.locator('#account-register-password').inputValue(), '');
  await page.locator('#account-upload').click();
  await page.locator('#account-message').filter({ hasText: '已保存到你的账号' }).waitFor();
  assert.equal(cloud.preferences.quoteMode, 'double');
  assert.deepEqual(Object.keys(cloud.preferences).sort(), ['joinWith', 'pathMode', 'quoteMode', 'separator', 'trailingSlash']);
  assert.equal(calls.find(call => call.method === 'PUT').csrf, 'test-csrf');
  cloud.preferences.quoteMode = 'single';
  await page.locator('#account-apply').click();
  await page.locator('#account-message').filter({ hasText: '已应用云端偏好' }).waitFor();
  assert.equal(await page.locator('#quote-mode').inputValue(), 'single');
  assert.equal(await page.locator('#base-path').inputValue(), '/private/local-only');
  const firstUser = user;
  user = { id: 'second-user', username: 'second_user', email: 'second@example.com' };
  cloud.preferences.quoteMode = 'double';
  await page.locator('#account-apply').click();
  await page.locator('#account-message').filter({ hasText: '账号状态已变化' }).waitFor();
  assert.equal(await page.locator('#account-profile-name').innerText(), 'second_user');
  assert.equal(await page.locator('#quote-mode').inputValue(), 'single', 'another browser tab account switch must not apply a different account silently');
  user = firstUser;
  await page.locator('#account-refresh').click();
  await page.locator('#account-message').filter({ hasText: '账号与云端偏好已刷新' }).waitFor();
  switchOnData = { id: 'second-user', username: 'second_user', email: 'second@example.com' };
  await page.locator('#account-apply').click();
  await page.locator('#account-message').filter({ hasText: '账号状态已变化' }).waitFor();
  assert.equal(await page.locator('#quote-mode').inputValue(), 'single', 'an account switch during data fetch must discard the result');
  user = firstUser;
  await page.locator('#account-refresh').click();
  await page.locator('#account-message').filter({ hasText: '账号与云端偏好已刷新' }).waitFor();
  await page.locator('#account-logout').click();
  await page.locator('#account-message').filter({ hasText: '已退出登录' }).waitFor();
  await page.locator('#account-login-tab').click();
  await page.locator('#account-identifier').fill('test@example.com');
  await page.locator('#account-login-password').fill('test-password-123');
  await page.locator('#account-login-form button[type="submit"]').click();
  await page.locator('#account-profile-name').filter({ hasText: 'brclio_test' }).waitFor();
  assert.equal(calls.find(call => call.pathname.endsWith('/login')).body.identifier, 'test@example.com');
  await mkdir('artifacts', { recursive: true });
  for (const width of [1440, 900, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), false, `account app overflow at ${width}`);
    assert.equal(await page.locator('#account-dialog').evaluate(element => element.scrollWidth > element.clientWidth), false, `account dialog overflow at ${width}`);
    await page.screenshot({ path: path.resolve(`artifacts/account-${width}.png`), fullPage: true });
  }
  const standaloneHTML = await readFile(new URL('../cloudflare/src/account.html', import.meta.url), 'utf8');
  await context.route(target => target.pathname === '/account', route => route.fulfill({ status: 200, contentType: 'text/html', body: standaloneHTML }));
  const device = 'device_fixture_' + 'a'.repeat(32);
  await page.goto(url + '/account?device=' + device);
  await page.locator('#account-device-approve:not(:disabled)').waitFor();
  await page.locator('#account-pref-quoteMode').selectOption('auto');
  await page.locator('#account-cloud-form button[type="submit"]').click();
  await page.locator('#account-message').filter({ hasText: '云端偏好已保存' }).waitFor();
  assert.equal(cloud.preferences.quoteMode, 'auto');
  assert.equal(await page.locator('#account-local-sync').isVisible(), false);
  await page.locator('#account-device-approve').click();
  await page.locator('#account-device-detail').filter({ hasText: '已确认客户端登录' }).waitFor();
  assert.deepEqual(calls.find(call => call.pathname.endsWith('/device/approve')).body, { id: device });
  assert.equal(calls.find(call => call.pathname.endsWith('/device/approve')).csrf, 'test-csrf');
  for (const width of [1440, 900, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), false, `account page overflow at ${width}`);
  }
  user = null;
  await page.goto(url + '/account?device=' + device);
  await page.locator('#account-google:not(:disabled)').waitFor();
  await page.locator('#account-google').click();
  await page.waitForURL('**/api/account/google/start?device=*');
  assert.equal(new URL(googleStartURL).searchParams.get('device'), device, 'Google handoff must retain device approval context');
  user = { id: 'google-user', username: 'Google 用户', email: 'google@example.com', providers: ['google'] };
  await page.goto(url + '/account?device=' + device);
  await page.locator('#account-profile-name').filter({ hasText: 'Google 用户' }).waitFor();
  assert.equal(new URL(page.url()).searchParams.get('device'), device, 'Google callback must retain device approval context');
  assert.equal(await page.locator('#account-device-approve').isVisible(), true, 'Google callback must still require explicit device approval');
  user = null;
  await page.goto(url + '/account?error=google&device=' + device);
  await page.locator('#account-message').filter({ hasText: 'Google 登录未完成' }).waitFor();
  await page.locator('#account-identifier').fill('test@example.com');
  await page.locator('#account-login-password').fill('test-password-123');
  await page.locator('#account-login-form button[type="submit"]').click();
  await page.locator('#account-device-approve:not(:disabled)').waitFor();
  await page.locator('#account-device-approve').click();
  await page.locator('#account-device-detail').filter({ hasText: '已确认客户端登录' }).waitFor();
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: ['email code and registration', 'password fields cleared after login', 'email password login and logout', 'portable preference upload and apply preserve local base folder', 'cross-tab account changes and in-flight response identity cannot silently apply another account data', 'CSRF protected mutations', 'standalone account preference editor', 'explicit authenticated device approval', 'Google browser handoff and callback retain device context', 'canceled Google flow can complete client login with password fallback', '1440 / 900 / 390 / 320 layout'], consoleErrors: errors }, null, 2));
} finally { await context.close(); await browser.close(); }
