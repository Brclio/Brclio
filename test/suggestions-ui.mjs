import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {test} from 'node:test';
import {chromium} from '@playwright/test';
import {handleAccount} from '../cloudflare/src/accounts.js';
import {digest, seal} from '../cloudflare/src/accounts-crypto.js';
import {repositoryFixture} from '../cloudflare/test/fixtures/private-record-store.js';
import accountClient from '../desktop/account.cjs';

const origin = 'https://brclio-suggestions.test';
const endpoint = '/api/account/suggestions';
const env = {
  SESSION_SECRET: 'isolated-suggestions-browser-test-secret',
  ACCOUNT_LIMITER: {limit: async () => ({success: true})}
};

async function fixtureAccount(id, mode, nickname) {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const sid = id + '-test-session';
  const token = await seal({typ: 'account', id, sid, csrf: id + '-csrf', mode, exp}, env.SESSION_SECRET);
  return {token, records: {
    [`users/${id}/credentials.json`]: {sessions: {[await digest(sid)]: {mode, exp}}},
    [`users/${id}/profile.json`]: {id, username: id, nickname, email: id + '@example.test'}
  }};
}

test('browser and desktop users share a suggestion, half-star ratings and comments', async t => {
  const alice = await fixtureAccount('alice', 'web', '阿梨');
  const bob = await fixtureAccount('bob', 'native', '小波');
  const accounts = repositoryFixture({...alice.records, ...bob.records});
  const suggestions = repositoryFixture({}, undefined, 'suggestions');
  const deps = {accountStore: accounts.store, suggestionStore: suggestions.store};
  const dispatch = request => handleAccount(request, env, deps);
  const desktop = accountClient.createAccountClient({
    store: {read: async () => bob.token, write: async () => assert.fail('suggestions must preserve the session')},
    fetch: (url, init) => dispatch(new Request(url, init))
  });

  const browser = await chromium.launch({
    executablePath: process.env.BRCLIO_CHROME || (process.platform === 'darwin'
      ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined)
  });
  t.after(() => browser.close());
  const page = await browser.newPage();
  page.setDefaultTimeout(10000);
  const errors = [], boardCalls = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', async route => {
    const input = route.request(), url = new URL(input.url());
    if (url.origin !== origin) return route.abort();
    if (url.pathname.startsWith('/api/account/')) {
      const result = await dispatch(new Request(url, {
        headers: await input.allHeaders(), method: input.method(), body: input.postData()
      }));
      if (url.pathname.startsWith(endpoint)) boardCalls.push({path: url.pathname, method: input.method()});
      return route.fulfill({status: result.status, headers: Object.fromEntries(result.headers), body: await result.text()});
    }
    const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    const contentTypes = {html: 'text/html', js: 'text/javascript', css: 'text/css', png: 'image/png', svg: 'image/svg+xml'};
    try {
      await route.fulfill({contentType: contentTypes[file.split('.').pop()], body: await readFile(new URL('../web/' + file, import.meta.url))});
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await route.fulfill({status: 404, body: ''});
    }
  });
  const openBoard = () => page.locator('[data-view="suggestions"]:visible').first().click();
  await page.goto(origin);
  await page.locator('body[data-ready=true]').waitFor();
  await page.locator('#manual-paths').fill('/tmp/suggestion-test.txt');
  assert.deepEqual(boardCalls, []);
  await openBoard();
  const board = page.locator('#view-suggestions');
  await board.getByRole('button', {name: '登录账号'}).waitFor();
  assert.equal(await board.getByRole('button', {name: '发布建议'}).isVisible(), false);

  await page.context().addCookies([{url: origin, name: '__Host-brclio_user', value: alice.token, secure: true, httpOnly: true}]);
  await page.locator('[data-view="copy"]:visible').first().click();
  assert.equal(await page.locator('#manual-paths').inputValue(), '/tmp/suggestion-test.txt');
  await page.locator('#open-search').click();
  await page.locator('#global-search').fill('评分');
  await page.locator('#global-search').press('Enter');
  await board.getByRole('button', {name: '写建议'}).click();
  await board.getByLabel('建议名称').fill('导出自选格式');
  await board.getByLabel('描述', {exact: true}).fill('保留 <draft> 的换行和空格。');
  await board.getByRole('button', {name: '发布建议'}).click();
  const article = board.getByRole('article').filter({hasText: '导出自选格式'});
  await article.getByText('保留 <draft> 的换行和空格。', {exact: true}).waitFor();
  await article.getByRole('button', {name: /评分与讨论/}).click();

  const radio = stars => article.getByRole('radio', {name: stars + ' 星', exact: true});
  async function rate(stars) {
    const receipt = page.waitForResponse(response => response.url().endsWith('/rating') && response.request().method() === 'PUT');
    await radio(stars).click();
    const response = await receipt;
    assert.equal(response.status(), 200);
    return (await response.json()).suggestion;
  }
  const first = await rate(0.5);
  assert.equal(first.ratingCount, 1);
  assert.equal(first.averageRating, 0.5);
  const {items} = await desktop.request({path: endpoint});
  assert.equal(items.length, 1);
  assert.equal(items[0].id, first.id);
  assert.equal(items[0].author, '阿梨');
  const detail = endpoint + '/' + first.id;
  const second = await desktop.request({path: detail + '/rating', method: 'PUT', body: {rating: 5}});
  assert.equal(second.suggestion.ratingCount, 2);
  assert.equal(second.suggestion.averageRating, 2.75);
  await board.getByRole('button', {name: '刷新', exact: true}).click();
  await article.getByText('2.75 / 5', {exact: true}).waitFor();
  const changed = await rate(4);
  assert.equal(changed.averageRating, 4.5);
  assert.equal(changed.ratingCount, 2);
  assert.equal(changed.myRating, 4);
  await article.getByText(/^4\.50? \/ 5$/).waitFor();
  await article.getByText('2 人评分', {exact: true}).waitFor();
  const draft = '我也需要这个功能。';
  await article.getByLabel('写评论').fill(draft);
  await desktop.request({path: detail + '/comments', method: 'POST',
    body: {requestId: crypto.randomUUID(), text: '希望支持合并导出。'}});
  await board.getByRole('button', {name: '刷新', exact: true}).click();
  await article.getByText('希望支持合并导出。', {exact: true}).waitFor();
  assert.equal(await article.getByLabel('写评论').inputValue(), draft);
  assert.equal(await article.getByRole('radio').count(), 10);
  assert.equal(await radio(4).isChecked(), true);
  await article.getByRole('button', {name: '发表评论'}).click();
  await article.getByText(draft, {exact: true}).waitFor();
  const saved = await desktop.request({path: detail});
  assert.equal(saved.suggestion.commentCount, 2);
  assert.equal(saved.suggestion.myRating, 5);
  assert.deepEqual(saved.comments.map(comment => [comment.author, comment.text]), [
    ['阿梨', '我也需要这个功能。'], ['小波', '希望支持合并导出。']
  ]);
  assert.equal(JSON.stringify(saved).includes('@example.test'), false);
  const invalidRequests = [
    {path: endpoint, method: 'DELETE'},
    {path: detail + '/rating', method: 'POST'},
    {path: detail + '/comments', method: 'GET'},
    {path: endpoint + '?cursor=0'},
    {path: endpoint + '?limit=10'},
    {path: endpoint + '/unregistered'}
  ];
  const callCount = boardCalls.length;
  for (const input of invalidRequests) {
    await assert.rejects(desktop.request(input), /路径或方法/);
    const rejected = await page.evaluate(input => window.BrclioHost.accountRequest(input)
      .then(() => false, error => /路径或方法/.test(error.message)), input);
    assert.equal(rejected, true);
  }
  assert.equal(boardCalls.length, callCount);
  assert.equal(accounts.updates.length, 0);
  await page.locator('#account-button').click();
  await page.locator('#account-logout').click();
  await page.locator('#account-login-form').waitFor();
  await page.keyboard.press('Escape');
  await board.getByRole('button', {name: '登录账号'}).waitFor();
  assert.equal(await board.getByRole('article').count(), 0);
  assert.deepEqual(errors, []);
});
