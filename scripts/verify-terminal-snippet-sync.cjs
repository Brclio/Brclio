'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const {_electron:electron,expect} = require('@playwright/test');
const {accountServer} = require('./verify-terminal-shared-vaults.cjs');

async function main() {
  const root = path.resolve(__dirname,'..'), temp = await fs.mkdtemp(path.join(os.tmpdir(),'brclio-snippet-sync-'));
  const server = await accountServer(), apps = [];
  try {
    async function device(name) {
      const directory = path.join(temp,name);
      await fs.mkdir(directory);
      const app = await electron.launch({args:[root],cwd:root,env:{...process.env,BRCLIO_USER_DATA:directory,ZDOTDIR:directory,HISTFILE:path.join(directory,'history')}});
      apps.push(app);
      const home = await app.firstWindow();
      await home.waitForURL('file://**/web/index.html');
      await app.evaluate(({net},port) => {
        const fetch = net.fetch.bind(net);
        net.fetch = (url,options) => {
          const pathname = new URL(url).pathname;
          return pathname.startsWith('/api/account/') ? fetch('http://127.0.0.1:' + port + pathname,options) : Promise.resolve(new Response(null,{status:404}));
        };
      },server.address().port);
      await home.evaluate(() => window.brclio.accountRequest({path:'/api/account/login',method:'POST',body:{identifier:'fixture-alice',password:'local-fixture-password'}}));
      await home.evaluate(() => window.brclio.openTerminal('window'));
      const find = () => app.windows().find(p => p.url().endsWith('/desktop/terminal/index.html'));
      await expect.poll(() => Boolean(find())).toBe(true);
      const page = find();
      await page.locator('#connection-center').click();
      await page.locator('[data-center=snippetSync]').click();
      await expect(page.locator('#snippet-sync-enable')).toBeEnabled();
      await expect(page.locator('#snippet-sync-enable')).not.toBeChecked();
      return page;
    }
    const a = await device('a');
    await a.evaluate(() => {
      const model = window.BrclioSnippetModel;
      window.BrclioTerminalPartitions.storage.setItem(model.key,JSON.stringify([
        {id:'p',kind:'snippet',name:'Directory',text:'pwd',package:'tools'},
        {id:'private',kind:'note',name:'Local note',text:'device-only'},
      ]));
    });
    await a.locator('#snippet-sync-enable').check();
    await expect(a.locator('#snippet-sync-status')).toHaveText('剪藏已同步。');
    const b = await device('b');
    await b.locator('#snippet-sync-enable').check();
    await expect(b.locator('#snippet-sync-status')).toHaveText('剪藏已同步。');
    const read = page => page.evaluate(() => window.BrclioSnippetModel.read(window.BrclioTerminalPartitions.storage));
    assert.deepEqual((await read(b)).map(s => [s.id,s.package]),[['p','tools']]);
    await b.locator('#snippet-sync-enable').uncheck();
    await b.evaluate(() => {
      const m = window.BrclioSnippetModel;
      window.BrclioTerminalPartitions.storage.setItem(m.key,JSON.stringify([{id:'p',kind:'snippet',name:'Directory',text:'dir'}]));
    });
    await a.locator('#snippet-sync-now').click();
    await expect(a.locator('#snippet-sync-now')).toBeEnabled();
    assert.equal((await read(a)).find(s => s.id === 'p').text,'pwd');
    console.log('Two isolated desktop profiles synchronized an opted-in snippet package, kept private notes local and respected the device switch.');
  } finally {
    await Promise.allSettled(apps.map(app => app.close()));
    const close = new Promise(resolve => server.close(resolve)); server.closeAllConnections(); await close;
    await fs.rm(temp,{recursive:true,force:true});
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
