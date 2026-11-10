import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {chromium} from '@playwright/test';
import {handleAccount} from '../cloudflare/src/accounts.js';
import {handleAdmin} from '../cloudflare/src/admin.js';
import {digest, seal} from '../cloudflare/src/accounts-crypto.js';
import {repositoryFixture} from '../cloudflare/test/fixtures/private-record-store.js';

const origin = 'https://brclio-feedback.test';
const allow = {limit: async () => ({success: true})};
const env = {SESSION_SECRET:'isolated-feedback-smoke-session-secret', ADMIN_EMAIL:'admin@example.test', ADMIN_PASSWORD:'fixture-password',
  LOGIN_LIMITER:allow, LOGIN_GLOBAL_LIMITER:allow, ACCOUNT_LIMITER:allow, ACCOUNT_AUTH_LIMITER:allow};
const repo = repositoryFixture({}, undefined, 'feedback');
const exp = Math.floor(Date.now()/1000) + 3600, userId = 'fixture-account', sid = 'fixture-browser';
const credentials = {sessions:{[await digest(sid)]:{mode:'web', exp}}};
const token = await seal({typ:'account', id:userId, sid, csrf:'fixture-csrf', mode:'web', exp}, env.SESSION_SECRET);
const deps = {feedbackStore:repo.store, accountStore:{snapshot: async () => ({read: async path => {
  if (path.endsWith('/credentials.json')) return credentials;
  if (path.endsWith('/profile.json')) return {id:userId, username:'fixture', email:'fixture@example.test'};
  throw new Error('Unexpected account read');
}}), transaction: async () => { throw new Error('Unexpected account write'); }}, readConfig: async () => ({subscriptionUrl:'', updatedAt:null})};
const browser = await chromium.launch({executablePath:process.env.BRCLIO_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
try {
  const context = await browser.newContext({permissions:['clipboard-read','clipboard-write']});
  const errors = [], submittedIds = [];
  let loseFirstReceipt = true;
  await context.route(origin + '/**', async route => {
    const input = route.request(), path = new URL(input.url()).pathname;
    if (path.startsWith('/api/')) {
      const request = new Request(input.url(), {method:input.method(), headers:await input.allHeaders(), body:input.postData()});
      const result = path.startsWith('/api/account/') ? await handleAccount(request, env, deps) : await handleAdmin(request, env, deps);
      if (path === '/api/account/feedback' && result.ok) {
        submittedIds.push(input.postDataJSON().requestId);
        if (loseFirstReceipt) {
          loseFirstReceipt = false;
          return route.fulfill({status:503, contentType:'application/json', body:JSON.stringify({error:'回执暂不可用'})});
        }
      }
      return route.fulfill({status:result.status, headers:Object.fromEntries(result.headers), body:await result.text()});
    }
    const filename = path === '/admin' ? '../cloudflare/src/admin.html' : path === '/admin.js' ? '../cloudflare/src/admin-client.txt' :
      '../web/' + (path === '/' ? 'index.html' : path.slice(1));
    const contentType = path === '/' || path === '/admin' ? 'text/html' : path.endsWith('.js') ? 'text/javascript' : path.endsWith('.css') ? 'text/css' : 'image/png';
    await route.fulfill({body:await readFile(new URL(filename, import.meta.url)), contentType});
  });
  const page = await context.newPage(); page.on('pageerror', err => errors.push(err.message));
  await page.goto(origin); await page.locator('body[data-ready=true]').waitFor();
  await page.locator('.nav-item[data-view=settings]').click();
  await page.locator('[data-view=feedback]').filter({hasText:'查看日志与反馈'}).click();
  const preview = page.locator('#feedback-preview');
  await preview.filter({hasText:'app.start'}).waitFor();
  assert.ok(await page.locator('#feedback-submit').isDisabled());
  await page.locator('#feedback-copy').click();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), await preview.innerText());
  await context.addCookies([{url:origin,name:'__Host-brclio_user',value:token,secure:true,httpOnly:true}]);
  await page.locator('#feedback-back').click();
  await page.locator('#view-settings [data-view=feedback]').click();
  await page.locator('#feedback-submit:enabled').waitFor();
  await page.locator('#feedback-title').fill('界面与日志回归');
  await page.locator('#feedback-category').selectOption('download');
  await page.locator('#feedback-description').fill('诊断测试 https://example.test/post?xsec_token=fixture-secret');
  await page.locator('#feedback-submit').click();
  await page.locator('#feedback-status').filter({hasText:'回执暂不可用'}).waitFor();
  await page.locator('#feedback-submit').click();
  await page.locator('#feedback-status').filter({hasText:'已提交。'}).waitFor();
  assert.deepEqual(submittedIds, [submittedIds[0], submittedIds[0]]);
  const [,id] = (await page.locator('#feedback-status').innerText()).match(/编号 ([a-f0-9-]+)/);
  const link = origin + '/admin?feedback=' + id;
  assert.equal(repo.updates.length, 1);
  await page.locator('#feedback-title').fill('仅提交建议');
  await page.locator('#feedback-description').fill('无需日志的改进建议。');
  await page.locator('#feedback-attach').uncheck(); await page.locator('#feedback-submit').click();
  await page.locator('#feedback-status').filter({hasText:'已提交。'}).waitFor();
  const second = submittedIds.at(-1);
  assert.notEqual(second, id);
  assert.equal(repo.read('feedback/v1/reports/' + second.slice(0, 2) + '/' + second + '/report.json').logCount, 0);
  await page.goto(link); await page.locator('#email').fill(env.ADMIN_EMAIL); await page.locator('#password').fill(env.ADMIN_PASSWORD);
  await page.locator('#login-form button').click();
  await page.locator('#report-title').filter({hasText:'界面与日志回归'}).waitFor();
  assert.ok((await page.locator('#report-logs').textContent()).includes('app.start'));
  assert.ok(!(await page.locator('#report-card').textContent()).includes('fixture-secret'));
  for (const [button, expected] of [['report-link', link], ['report-skill','$brclio-feedback-repair ' + id]]) {
    await page.locator('#' + button).click(); assert.equal(await page.evaluate(() => navigator.clipboard.readText()),expected);
  }
  await page.locator('#report-ai').click();
  const packet = await page.evaluate(() => navigator.clipboard.readText());
  for (const value of [id,'app.start','界面与日志回归','BrclioData/BrclioLogData']) assert.ok(packet.includes(value));
  assert.ok(!packet.includes('fixture-secret'));
  await page.locator('#report-state').selectOption('resolved');
  await page.locator('#report-note').fill('验收通过');
  await page.locator('#report-save').click(); await page.locator('#report-history').filter({hasText:'验收通过'}).waitFor();
  await page.reload(); await page.locator('#report-history').filter({hasText:'验收通过'}).waitFor();
  assert.equal(await page.locator('#report-state').inputValue(),'resolved');
  await page.setViewportSize({width:375,height:780});
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.locator('#logout').click(); await page.locator('#login-section').waitFor();
  assert.equal(await page.locator('#report-logs').textContent(),'');
  assert.deepEqual(errors, []);
  console.log('反馈端到端通过：匿名复制、登录提交、原子分文件存储、管理员深链、三种复制、处理记录和退出清理。');
} finally { await browser.close(); }
