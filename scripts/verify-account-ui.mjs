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
const expectedNetworkErrorURLs = new Set();
page.on('pageerror', error => errors.push(error.message));
page.on('console', message => { if (message.type() === 'error' && !expectedNetworkErrorURLs.has(message.location().url)) errors.push(message.text()); });
let user = null;
let passwordEnabled = false;
let mockPassword = 'test-password-123';
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
  async function reject(status, error, code) {
    expectedNetworkErrorURLs.add(request.url());
    await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify({ error, ...(code ? { code } : {}) }) });
  }
  if (pathname.endsWith('/google/start')) {
    googleStartURL = request.url();
    await route.fulfill({ status: 200, contentType: 'text/html', body: '<p>Google OAuth provider handoff</p>' });
    return;
  }
  if ((pathname.endsWith('/code') || pathname.endsWith('/register')) && body?.email === 'exists@example.com') {
    await reject(409, '该邮箱已注册，请登录后在账号设置中设置昵称、账号和密码', pathname.endsWith('/code') ? 'EMAIL_EXISTS' : undefined); return;
  }
  if (pathname.endsWith('/session')) result = { user, csrf: 'test-csrf', googleEnabled: true, passwordEnabled };
  else if (pathname.endsWith('/register') || pathname.endsWith('/login')) { user = { id: 'test-user', nickname: '', username: 'brclio_test', email: 'test@example.com', providers: ['password'] }; passwordEnabled = true; result = { user }; }
  else if (pathname.endsWith('/profile')) {
    if (body.username === 'occupied_account') { await reject(409, '该账号已被使用，请换一个账号'); return; }
    user = { ...user, nickname: body.nickname, username: body.username }; result = { user };
  }
  else if (pathname.endsWith('/password')) {
    if (passwordEnabled && body.currentPassword !== mockPassword) { await reject(400, '当前密码不正确，请重试'); return; }
    mockPassword = body.newPassword; passwordEnabled = true; result = { ok: true, passwordEnabled: true };
  }
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
  const beforeFailedApply = await page.evaluate(async () => ({
    portable: await window.BrclioPreferences.read(), persisted: await window.BrclioHost.getSettings(),
  }));
  const beforeFailedApplyPreview = await page.locator('#path-preview').innerText();
  await page.evaluate(() => {
    window.__accountSavedPreferences = [];
    window.__accountFailNextSave = true;
    window.__accountOriginalSaveSettings = window.BrclioHost.saveSettings;
    window.__accountOriginalCopyText = window.BrclioHost.copyText;
    window.BrclioHost.saveSettings = async settings => {
      window.__accountSavedPreferences.push({ ...settings });
      if (window.__accountFailNextSave) {
        window.__accountFailNextSave = false;
        throw new Error('fixture local preference write failed');
      }
      if (window.__accountDeferNextSave) {
        window.__accountDeferNextSave = false;
        await new Promise(resolve => { window.__accountFinishDeferredSave = resolve; });
      }
      return window.__accountOriginalSaveSettings(settings);
    };
    window.BrclioHost.copyText = async text => { window.__accountCopiedText = text; };
  });
  cloud.preferences.quoteMode = 'double';
  await page.locator('#account-apply').click();
  await page.locator('#account-message').filter({ hasText: 'fixture local preference write failed' }).waitFor();
  assert.equal(await page.locator('#account-message').getAttribute('data-error'), 'true');
  assert.deepEqual(await page.evaluate(() => window.BrclioPreferences.read()), beforeFailedApply.portable, 'a failed cloud apply must leave the in-memory local format intact');
  assert.deepEqual(await page.evaluate(() => window.BrclioHost.getSettings()), beforeFailedApply.persisted, 'a failed cloud apply must leave persisted local settings intact');
  assert.equal(await page.locator('#quote-mode').inputValue(), 'single', 'a failed cloud apply must keep the existing control value');
  assert.equal(await page.locator('#path-preview').innerText(), beforeFailedApplyPreview, 'a failed cloud apply must keep the existing preview');
  const rejectedApplyCalls = await page.evaluate(() => window.__accountSavedPreferences);
  assert.equal(rejectedApplyCalls.length, 1);
  assert.equal(rejectedApplyCalls[0].quoteMode, 'double', 'the fixture must fail the attempted cloud-format write');
  await page.locator('.account-close').click();
  await page.locator('#copy-preview').click();
  assert.equal(await page.evaluate(() => window.__accountCopiedText), beforeFailedApplyPreview, 'copying after the failed apply must still use the old local format');
  const ordinaryJoinWith = beforeFailedApply.portable.joinWith === 'space' ? 'newline' : 'space';
  await page.locator('#join-with').selectOption(ordinaryJoinWith);
  await page.waitForFunction(() => window.__accountSavedPreferences.length === 2 && document.querySelector('#save-status span').textContent === '设置已保存');
  const afterOrdinarySave = await page.evaluate(async () => ({
    portable: await window.BrclioPreferences.read(), persisted: await window.BrclioHost.getSettings(),
    saved: window.__accountSavedPreferences.at(-1),
  }));
  assert.deepEqual(afterOrdinarySave.portable, { ...beforeFailedApply.portable, joinWith: ordinaryJoinWith }, 'a later ordinary save must not adopt values from the failed cloud apply');
  assert.deepEqual(afterOrdinarySave.persisted, { ...beforeFailedApply.persisted, joinWith: ordinaryJoinWith });
  assert.equal(afterOrdinarySave.saved.quoteMode, 'single');
  await page.locator('#account-button').click();
  await page.locator('#account-apply:not(:disabled)').waitFor();
  await page.evaluate(() => { window.__accountDeferNextSave = true; });
  await page.locator('#account-apply').click();
  await page.waitForFunction(() => typeof window.__accountFinishDeferredSave === 'function');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.getElementById('account-dialog').open);
  await page.locator('#quote-mode').selectOption('auto');
  assert.equal(await page.locator('#quote-mode').inputValue(), 'auto', 'a later local edit can occur after Escape while the cloud write remains pending');
  await page.evaluate(() => { window.__accountFinishDeferredSave(); });
  await page.waitForFunction(() => window.__accountSavedPreferences.length === 4 && document.querySelector('#save-status span').textContent === '设置已保存' && document.querySelector('.account-root').getAttribute('aria-busy') === 'false');
  const afterPendingApplyEdit = await page.evaluate(async () => ({
    portable: await window.BrclioPreferences.read(), persisted: await window.BrclioHost.getSettings(),
    saved: window.__accountSavedPreferences,
  }));
  assert.equal(afterPendingApplyEdit.saved[2].quoteMode, 'double', 'the deferred write must be the cloud candidate');
  assert.equal(afterPendingApplyEdit.saved[3].quoteMode, 'auto', 'the later local edit must queue after the pending cloud candidate');
  assert.deepEqual(afterPendingApplyEdit.portable, { ...afterOrdinarySave.portable, quoteMode: 'auto' }, 'a completed older cloud apply must not replace a newer local edit in memory');
  assert.deepEqual(afterPendingApplyEdit.persisted, { ...afterOrdinarySave.persisted, quoteMode: 'auto' }, 'the newer local edit must be the final persisted format');
  assert.equal(await page.locator('#quote-mode').inputValue(), 'auto', 'the control must agree with the newer persisted local format');
  await page.locator('#copy-preview').click();
  assert.equal(await page.evaluate(() => window.__accountCopiedText), await page.locator('#path-preview').innerText(), 'copying must use the current local preview after the deferred apply completes');
  await page.locator('#quote-mode').selectOption('single');
  await page.waitForFunction(() => window.__accountSavedPreferences.length === 5 && document.querySelector('#save-status span').textContent === '设置已保存');
  await page.evaluate(() => {
    window.BrclioHost.saveSettings = window.__accountOriginalSaveSettings;
    window.BrclioHost.copyText = window.__accountOriginalCopyText;
    delete window.__accountOriginalSaveSettings;
    delete window.__accountOriginalCopyText;
    delete window.__accountSavedPreferences;
    delete window.__accountCopiedText;
    delete window.__accountFailNextSave;
    delete window.__accountDeferNextSave;
    delete window.__accountFinishDeferredSave;
  });
  cloud.preferences.quoteMode = 'single';
  await page.locator('#account-button').click();
  await page.locator('#account-profile-name').filter({ hasText: 'brclio_test' }).waitFor();
  await page.locator('#account-apply:not(:disabled)').waitFor();
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
  user = { id: 'google-user', nickname: 'Google 用户', username: 'google_user', email: 'google@example.com', providers: ['google'] }; passwordEnabled = false;
  await page.goto(url + '/account?device=' + device);
  await page.locator('#account-profile-name').filter({ hasText: 'Google 用户' }).waitFor();
  assert.equal(new URL(page.url()).searchParams.get('device'), device, 'Google callback must retain device approval context');
  assert.equal(await page.locator('#account-device-approve').isVisible(), true, 'Google callback must still require explicit device approval');
  assert.equal(await page.locator('#account-google-onboarding').isVisible(), true);
  assert.equal(await page.locator('#account-settings').evaluate(element => element.open), true);
  assert.equal(await page.locator('#account-current-password-field').isVisible(), false);
  await page.locator('#account-nickname').fill('我的新昵称');
  await page.locator('#account-edit-username').fill('my_google_account');
  await page.locator('#account-refresh').click();
  await page.locator('#account-message').filter({ hasText: '账号与云端偏好已刷新' }).waitFor();
  assert.equal(await page.locator('#account-nickname').inputValue(), '我的新昵称', 'session refresh must preserve a profile draft');
  assert.equal(await page.locator('#account-edit-username').inputValue(), 'my_google_account');
  await page.locator('#account-edit-username').fill('occupied_account');
  await page.locator('#account-profile-form button[type="submit"]').click();
  await page.locator('#account-message').filter({ hasText: '该账号已被使用' }).waitFor();
  assert.equal(await page.locator('#account-nickname').inputValue(), '我的新昵称', 'failed saves must preserve profile edits');
  assert.equal(await page.locator('#account-edit-username').inputValue(), 'occupied_account');
  await page.locator('#account-edit-username').fill('my_google_account');
  await page.locator('#account-profile-form button[type="submit"]').click();
  await page.locator('#account-message').filter({ hasText: '个人资料已更新' }).waitFor();
  assert.equal(await page.locator('#account-profile-name').innerText(), '我的新昵称');
  assert.equal(await page.locator('#account-profile-username').innerText(), '账号：my_google_account');
  assert.equal(calls.findLast(call => call.pathname.endsWith('/profile')).csrf, 'test-csrf');
  await page.locator('#account-new-password').fill('google-first-password-123');
  await page.locator('#account-confirm-password').fill('different-password');
  const beforeMismatch = calls.filter(call => call.pathname.endsWith('/password')).length;
  await page.locator('#account-save-password').click();
  assert.equal(await page.locator('#account-confirm-password').evaluate(element => element.validity.valid), false);
  assert.equal(calls.filter(call => call.pathname.endsWith('/password')).length, beforeMismatch, 'mismatched passwords must not reach the API');
  await page.locator('#account-confirm-password').fill('google-first-password-123');
  await page.locator('#account-save-password').click();
  await page.locator('#account-message').filter({ hasText: '密码已设置' }).waitFor();
  assert.deepEqual(calls.findLast(call => call.pathname.endsWith('/password')).body, { newPassword: 'google-first-password-123' });
  assert.equal(await page.locator('#account-google-onboarding').isVisible(), false);
  assert.equal(await page.locator('#account-current-password').getAttribute('required'), '');
  assert.equal(await page.locator('#account-current-password-field').isVisible(), true);
  for (const id of ['current-password', 'new-password', 'confirm-password']) assert.equal(await page.locator('#account-' + id).inputValue(), '');
  await page.locator('#account-current-password').fill('wrong-current-password');
  await page.locator('#account-new-password').fill('google-updated-password-456');
  await page.locator('#account-confirm-password').fill('google-updated-password-456');
  await page.locator('#account-save-password').click();
  await page.locator('#account-message').filter({ hasText: '当前密码不正确' }).waitFor();
  for (const id of ['current-password', 'new-password', 'confirm-password']) assert.equal(await page.locator('#account-' + id).inputValue(), '', 'password fields must clear after failed mutation');
  await page.locator('#account-current-password').fill('google-first-password-123');
  await page.locator('#account-new-password').fill('google-updated-password-456');
  await page.locator('#account-confirm-password').fill('google-updated-password-456');
  await page.locator('#account-save-password').click();
  await page.locator('#account-message').filter({ hasText: '密码已修改' }).waitFor();
  assert.deepEqual(calls.findLast(call => call.pathname.endsWith('/password')).body, { currentPassword: 'google-first-password-123', newPassword: 'google-updated-password-456' });
  for (const width of [1440, 900, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), false, `account settings page overflow at ${width}`);
  }
  await page.screenshot({ path: path.resolve('artifacts/account-settings-320.png'), fullPage: true });
  const googleProfile = user;
  await page.locator('#account-nickname').fill('不能写入其他账号的草稿');
  await page.locator('#account-edit-username').fill('wrong_user_draft');
  const beforeSwitch = calls.filter(call => call.pathname.endsWith('/profile')).length;
  user = { id: 'second-user', nickname: '第二位用户', username: 'second_user', email: 'second@example.com', providers: ['password'] };
  await page.locator('#account-profile-form button[type="submit"]').click();
  await page.locator('#account-message').filter({ hasText: '账号状态已变化' }).waitFor();
  assert.equal(calls.filter(call => call.pathname.endsWith('/profile')).length, beforeSwitch, 'cross-tab account changes must abort profile writes');
  assert.equal(await page.locator('#account-nickname').inputValue(), '第二位用户');
  assert.equal(await page.locator('#account-edit-username').inputValue(), 'second_user');
  user = googleProfile;
  await page.goto(url);
  await page.locator('body[data-ready="true"]').waitFor();
  await page.locator('#account-button').click();
  await page.locator('#account-profile-name').filter({ hasText: '我的新昵称' }).waitFor();
  assert.equal(await page.locator('#account-button span').innerText(), '我的新昵称', 'app header must prefer the saved nickname');
  await page.locator('#account-settings summary').click();
  await page.locator('#account-new-password').fill('cleared-on-close');
  await page.locator('.account-close').click();
  await page.waitForFunction(() => document.getElementById('account-new-password').value === '');
  assert.equal(await page.locator('#account-new-password').inputValue(), '');
  for (const width of [1440, 900, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.locator('#account-button').click();
    await page.locator('#account-profile-name').filter({ hasText: '我的新昵称' }).waitFor();
    assert.equal(await page.locator('#account-dialog').evaluate(element => element.scrollWidth > element.clientWidth), false, `account settings dialog overflow at ${width}`);
    await page.locator('.account-close').click();
  }
  user = null; passwordEnabled = false;
  await page.goto(url + '/account?device=' + device);
  await page.locator('#account-google:not(:disabled)').waitFor();
  await page.locator('#account-register-tab').click();
  await page.locator('#account-email').fill('exists@example.com');
  await page.locator('#account-send-code').click();
  await page.locator('#account-message').filter({ hasText: '该邮箱已注册' }).waitFor();
  await page.locator('#account-existing-login').click();
  assert.equal(await page.locator('#account-identifier').inputValue(), 'exists@example.com');
  assert.equal(await page.locator('#account-login-tab').getAttribute('aria-selected'), 'true');
  await page.locator('#account-register-tab').click();
  await page.locator('#account-username').fill('exists_account');
  await page.locator('#account-code').fill('123456');
  await page.locator('#account-register-password').fill('test-password-123');
  await page.locator('#account-register-form button[type="submit"]').click();
  await page.locator('#account-message').filter({ hasText: '该邮箱已注册' }).waitFor();
  await page.locator('#account-existing-login').click();
  assert.equal(await page.locator('#account-identifier').inputValue(), 'exists@example.com', 'duplicate registration fallback must work even when native errors have no code');
  assert.equal(await page.locator('#account-register-password').inputValue(), '');
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
  console.log(JSON.stringify({ passed: ['email code and registration', 'password fields cleared after login', 'email password login and logout', 'portable preference upload and apply preserve local base folder', 'failed cloud apply preserves local memory, controls, preview, copied text and subsequent ordinary saves', 'a local edit after Escape wins over an older pending cloud apply in memory, persisted settings and controls', 'cross-tab account changes and in-flight response identity cannot silently apply another account data', 'CSRF protected mutations', 'standalone account preference editor', 'explicit authenticated device approval', 'Google browser handoff and callback retain device context', 'Google accounts can edit nickname and username with draft preservation', 'first password setup, current password validation, password confirmation and secret field clearing', 'cross-tab identity changes abort profile edits and clear drafts', 'duplicate email gives a prefilled login action', 'nickname preferred in shared app header', 'canceled Google flow can complete client login with password fallback', '1440 / 900 / 390 / 320 settings layout'], consoleErrors: errors }, null, 2));
} finally { await context.close(); await browser.close(); }
