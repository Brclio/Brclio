'use strict';

const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const {_electron:electron, expect} = require('@playwright/test');

// Both the signed account API and the vault API run locally. Only the private
// Git record adapter is replaced, so no fixture can reach a deployed Worker.
async function accountServer() {
  const {handleAccount} = await import('../cloudflare/src/accounts.js');
  const {hashPassword} = await import('../cloudflare/src/accounts-crypto.js');
  const password = await hashPassword('local-fixture-password');
  const index = {version:1, usernames:{}, emails:{}};
  const records = new Map([['users/_index.json',index]]);
  for (const id of ['fixture-alice','fixture-bob']) {
    index.usernames[id] = id;
    records.set('users/' + id + '/profile.json', {version:1,id,username:id,email:id+'@example.test'});
    records.set('users/' + id + '/credentials.json', {version:1,password,sessions:{}});
  }
  const read = (files,key,fallback=null) => structuredClone(files.has(key) ? files.get(key) : fallback);
  let queue = Promise.resolve();
  const store = {
    async snapshot() {
      const snapshot = new Map(records);
      return {read:(key,fallback) => read(snapshot,key,fallback)};
    },
    transaction(fn) {
      const work = queue.then(async () => {
        const staged = new Map(records);
        const result = await fn({read:(key,fallback) => read(staged,key,fallback),write:(key,value) => staged.set(key,structuredClone(value))});
        for (const [key,value] of staged) records.set(key,value);
        return result;
      });
      queue = work.catch(() => {});
      return work;
    },
  };
  const env = {SESSION_SECRET:'local fixture signing key for native shared vaults',ACCOUNT_LIMITER:{limit:async () => ({success:true})}};
  const server = http.createServer(async (req,res) => {
    try {
      if (!req.url.startsWith('/api/account/')) {res.writeHead(404); res.end(); return;}
      const buffers = [];
      for await (const chunk of req) buffers.push(chunk);
      const body = Buffer.concat(buffers);
      const response = await handleAccount(new Request('https://tools.brclio.com' + req.url,{method:req.method,
        headers:req.headers,...(body.length ? {body} : {})}),env,{accountStore:store});
      res.writeHead(response.status,Object.fromEntries(response.headers)); res.end(await response.text());
    } catch {res.writeHead(500); res.end();}
  });
  await new Promise((resolve,reject) => {server.once('error',reject); server.listen(0,'127.0.0.1',resolve);});
  return server;
}
async function main() {
  const root = path.join(__dirname,'..');
  const temp = await fs.mkdtemp(path.join(os.tmpdir(),'brclio-shared-vault-ui-'));
  let app, server;
  try {
    server = await accountServer();
    app = await electron.launch({args:[root],cwd:root,env:{...process.env,BRCLIO_USER_DATA:temp,ZDOTDIR:temp,HISTFILE:path.join(temp,'history')}});
    const home = await app.firstWindow();
    await home.waitForURL('file://**/web/index.html');
    await app.evaluate(({net},port) => {
      const original = net.fetch.bind(net);
      net.fetch = (url,options) => {
        const target = new URL(url);
        if (!target.pathname.startsWith('/api/account/')) return Promise.resolve(new Response(null,{status:404}));
        return original('http://127.0.0.1:' + port + target.pathname,options);
      };
    },server.address().port);
    let terminal;
    async function login(id) {
      const closed = terminal?.waitForEvent('close');
      await home.evaluate(id => window.brclio.accountRequest({path:'/api/account/login',method:'POST',
        body:{identifier:id,password:'local-fixture-password'}}),id);
      if (closed) await closed;
      await home.evaluate(() => window.brclio.openTerminal('window'));
      const find = () => app.windows().find(page => page.url().includes('/desktop/terminal/index.html'));
      await expect.poll(() => Boolean(find())).toBe(true);
      terminal = find();
      await expect.poll(() => terminal.evaluate(() => window.BrclioTerminalPartitions.owner)).toBe(id);
      await terminal.locator('#connection-center').click();
      await terminal.getByRole('button',{name:'共享主机库',exact:true}).click();
      return terminal.locator('#shared-vault-dialog');
    }
    let view = await login('fixture-alice');
    await view.getByLabel('主机库名称').fill('维护组');
    await view.getByRole('button',{name:'创建主机库'}).click();
    await expect(view.getByRole('heading',{name:'维护组'})).toBeVisible();
    await terminal.evaluate(() => window.BrclioConnection.store(localStorage).save({name:'共享测试',host:'shared.example.test',
      user:'ops',identityFile:'/home/test/fixture-key',jump:'private.example.test'}));
    const local = view.getByLabel('从本机主机库填入');
    await local.focus(); await local.selectOption('共享测试');
    await view.getByRole('button',{name:'保存到共享主机库'}).click();
    await expect(view.getByText('共享测试 · ops@shared.example.test')).toBeVisible();
    await terminal.evaluate(() => {
      window.BrclioSnippetModel.store(window.BrclioTerminalPartitions.storage,[
        {id:'local-alice-1',kind:'snippet',name:'团队模板',package:'维护',text:'echo {{TEAM_SAMPLE}}',template:true},
        {id:'local-alice-2',kind:'snippet',name:'个人命令',text:'private snippet'},
        {id:'local-alice-3',kind:'note',name:'个人笔记',text:'private note'},
      ]);
    });
    const choose = view.getByLabel('选择要共享的个人剪藏');
    await choose.focus();
    assert.equal(await choose.locator('option').count(),3);
    await choose.selectOption('local-alice-1');
    await expect(view.locator('pre')).toHaveText('echo {{TEAM_SAMPLE}}');
    await expect(view.getByText(/当前可读成员/)).toContainText('fixture-alice');
    await expect(view.getByText(/当前可读成员/)).toContainText('BrclioData/BrclioUserData');
    await view.getByRole('button',{name:'确认共享此剪藏'}).click();
    await expect(view.getByRole('button',{name:'查看正文'})).toHaveCount(1);
    const readRef = await terminal.evaluate(async () => {
      const {vaults:[{vaultId,ownerId}]} = await window.brclioTerminal.sharedVault('list',{});
      const {vault} = await window.brclioTerminal.sharedVault('open',{vaultId,ownerId});
      return {vaultId,ownerId,snippetId:vault.snippets[0].id,revision:vault.revision};
    });
    assert.notEqual(readRef.snippetId,'local-alice-1');
    await view.getByLabel('Brclio 用户名').fill('fixture-bob');
    await view.getByRole('button',{name:'发送邀请'}).click();
    await expect(view.getByText('fixture-bob · 待接受')).toBeVisible();
    view = await login('fixture-bob');
    await view.getByRole('button',{name:'查看',exact:true}).click();
    await expect(view.getByRole('button',{name:'接受邀请',exact:true})).toBeVisible();
    await expect(view.getByText('共享测试 · ops@shared.example.test')).toHaveCount(0);
    await expect(view.getByRole('button',{name:'查看正文'})).toHaveCount(0);
    await assert.rejects(terminal.evaluate(ref => window.brclioTerminal.sharedVault('read-snippet',ref),readRef),/权限/);
    await view.getByRole('button',{name:'接受邀请',exact:true}).click();
    await expect(view.getByText('共享测试 · ops@shared.example.test')).toBeVisible();
    await expect(view.getByRole('button',{name:'保存到共享主机库'})).toHaveCount(0);
    await expect(view.getByLabel('选择要共享的个人剪藏')).toHaveCount(0);
    await expect(view.getByText('团队模板 · 模板')).toBeVisible();
    await expect(view.getByText('个人命令')).toHaveCount(0);
    await expect(view.locator('pre')).toHaveCount(0);
    await view.getByRole('button',{name:'查看正文'}).click();
    await expect(view.locator('pre')).toHaveText('echo {{TEAM_SAMPLE}}');
    await view.getByRole('button',{name:'存入个人剪藏'}).click();
    await expect(view.getByRole('status')).toContainText('已存入个人剪藏');
    const [copy] = await terminal.evaluate(() => window.BrclioSnippetModel.read(window.BrclioTerminalPartitions.storage));
    assert.notEqual(copy.id,readRef.snippetId);
    assert.equal(copy.text,'echo {{TEAM_SAMPLE}}');
    assert.equal(copy.package,'维护');
    assert.equal(copy.template,true);
    await view.getByRole('button',{name:'存入本机主机库'}).click();
    await expect(view.getByRole('status')).toContainText('已存入');
    const copied = await terminal.evaluate(() => window.BrclioConnection.store(localStorage).all());
    assert.equal(copied.length,1);
    assert.equal(copied[0].host,'shared.example.test');
    for (const key of ['identityFile','jump']) assert.equal(Object.hasOwn(copied[0],key),false);
    view = await login('fixture-alice');
    await view.getByRole('button',{name:'查看',exact:true}).click();
    await view.getByRole('button',{name:'移除成员',exact:true}).click();
    await view.getByRole('button',{name:'确认移除成员',exact:true}).click();
    await expect(view.getByText('fixture-bob',{exact:true})).toHaveCount(0);
    view = await login('fixture-bob');
    await expect(view.getByText('当前账号还没有共享主机库或邀请。')).toBeVisible();
    await assert.rejects(terminal.evaluate(ref => window.brclioTerminal.sharedVault('read-snippet',ref),readRef),/访问权限/);
    console.log('Two signed desktop accounts shared one host and one selected snippet, copied as a reader and denied further reads after revocation.');
  } finally {
    await app?.close();
    if (server) {
      const closed = new Promise(resolve => server.close(resolve));
      server.closeAllConnections(); await closed;
    }
    await fs.rm(temp,{recursive:true,force:true});
  }
}
module.exports = {accountServer};
if (require.main === module) main().catch(error => {console.error(error);process.exitCode = 1;});
