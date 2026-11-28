'use strict';
const {_electron:electron,expect} = require('@playwright/test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

async function main() {
  const {liveFixture} = await import('../cloudflare/test/terminal-live-fixture.js');
  const f = await liveFixture(), root = path.join(__dirname,'..'), apps = [];
  const temp = await fs.mkdtemp(path.join(os.tmpdir(),'brclio-watch-'));
  async function desktop(id) {
    const directory = path.join(temp,id); await fs.mkdir(directory);
    const env = {...process.env,BRCLIO_USER_DATA:directory,BRCLIO_TERMINAL_LIVE_BETA:'1',
      BRCLIO_TERMINAL_LIVE_TEST_PORT:f.url.port,ZDOTDIR:directory,HISTFILE:path.join(directory,'history')};
    if (process.platform === 'win32') delete env.PSModulePath;
    const app = await electron.launch({args:[root],cwd:root,env}); apps.push(app);
    const home = await app.firstWindow(); await home.waitForURL('file://**/web/index.html');
    await app.evaluate(({net},{origin,id,token}) => {
      const original = net.fetch.bind(net);
      net.fetch = (target,options={}) => {
        const pathname = new URL(target).pathname;
        if (pathname === '/api/account/login') return Promise.resolve(Response.json({user:{id,email:id+'@example.test'},token}));
        return pathname.startsWith('/api/account/') ? original(new URL(pathname,origin).href,options) : Promise.resolve(new Response(null,{status:404}));
      };
    },{origin:f.url.origin,id,token:f.tokens[id]});
    await home.evaluate(id => window.brclio.accountRequest({path:'/api/account/login',method:'POST',body:{identifier:id,password:'isolated-fixture'}}),id);
    await home.evaluate(() => window.brclio.openTerminal('window'));
    const find = () => app.windows().find(p => p.url().includes('/desktop/terminal/index.html'));
    await expect.poll(() => Boolean(find())).toBe(true);
    const term = find();
    term.on('pageerror',error => console.error('Terminal renderer fixture',error.message));
    await expect.poll(() => term.evaluate(() => window.BrclioTerminalPartitions.owner),{timeout:15000}).toBe(id);
    await expect(term.locator('.pane.active')).toHaveAttribute('data-state','running');
    return term;
  }
  async function dialog(term) {
    await term.locator('#connection-center').click();
    await term.getByRole('button',{name:'实时观看',exact:true}).click();
    return term.locator('#live-view-dialog');
  }
  const write = (term,command) => term.evaluate(value => window.brclioTerminal.write(document.querySelector('.pane.active').dataset.id,value+'\r'),command);
  try {
    const owner = await desktop(f.ref.ownerId), observer = await desktop(f.viewerId);
    await write(owner,'echo PRIVATE_BEFORE_CONSENT');
    const share = await dialog(owner);
    await expect(share.getByLabel('受邀成员')).toHaveValue(f.viewerId);
    await share.getByRole('button',{name:'邀请观看此窗格'}).click();
    await expect(share.getByLabel('本次邀请码')).toHaveValue(/\./);
    const code = await share.getByLabel('本次邀请码').inputValue();
    const watch = await dialog(observer);
    await watch.getByLabel('观看邀请码').fill(code);
    await watch.getByRole('button',{name:'同意观看'}).click();
    await expect(share.getByText('成员已同意，正在分享所选窗格。')).toBeVisible();
    const output = watch.getByLabel('共享窗格文字');
    assert.equal(await output.innerText(),'');
    const source = path.join(temp,'message.cjs');
    await fs.writeFile(source,'process.stdout.write("VISIBLE_AFTER_CONSENT\\n\\u001b[8mCONCEALED_CELL\\u001b[0m\\n\\u001b]0;PRIVATE_TITLE\\u0007")');
    await write(owner,'node "' + source + '"');
    try {await expect(output).toContainText('VISIBLE_AFTER_CONSENT',{timeout:12000});}
    catch (error) {
      console.error('Publisher status',await share.getByRole('status').textContent(),await share.locator('[data-live=note]').textContent());
      console.error('Viewer status',await watch.getByRole('status').textContent(),await watch.locator('[data-live=note]').textContent());
      throw error;
    }
    for (const marker of ['PRIVATE_BEFORE_CONSENT','CONCEALED_CELL','PRIVATE_TITLE']) assert.equal((await output.innerText()).includes(marker),false);
    // After both initial proofs expire, the relay must obtain new, independently
    // signed membership checks from the two actual desktop clients.
    await new Promise(resolve => setTimeout(resolve,15500));
    await fs.writeFile(source,'process.stdout.write("VISIBLE_AFTER_RENEWAL\\n")');
    await write(owner,'node "' + source + '"');
    await expect(output).toContainText('VISIBLE_AFTER_RENEWAL',{timeout:12000});
    const reviewed = path.join(temp,'approved-command-ran'), proposal = path.join(temp,'proposal.cjs');
    await fs.writeFile(proposal,'require("node:fs").writeFileSync(' + JSON.stringify(reviewed) + ',"ok")');
    const command = 'node "' + proposal + '"';
    await watch.getByLabel('给主持人的单行草稿').fill(command);
    await watch.getByRole('button',{name:'发送草稿'}).click();
    await expect(share.getByLabel('成员提交的草稿')).toHaveValue(command);
    await assert.rejects(fs.stat(reviewed),{code:'ENOENT'});
    await share.getByRole('button',{name:'填入当前窗格'}).click();
    await expect(share).not.toBeVisible();
    await assert.rejects(fs.stat(reviewed),{code:'ENOENT'});
    await owner.locator('.pane.active:visible .xterm-helper-textarea').focus();
    await owner.keyboard.press('Enter');
    await expect.poll(() => fs.readFile(reviewed,'utf8').catch(() => '')).toBe('ok');
    await owner.getByRole('button',{name:'实时观看中'}).click();
    await watch.getByRole('button',{name:'结束实时观看'}).click();
    await expect(share.getByRole('status')).toContainText('观看已结束');
    console.log('Two isolated desktop apps and a local Workers Durable Object streamed only new, visible cells after bilateral consent and stopped on withdrawal.');
  } finally {
    await Promise.allSettled(apps.map(app => app.close()));
    await f.mf.dispose(); await fs.rm(temp,{recursive:true,force:true});
  }
}
main().catch(error => {console.error(error);process.exitCode=1;});
