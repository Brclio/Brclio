'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { _electron: electron, expect } = require('@playwright/test');

async function main() {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'brclio-terminal-logins-'));
  const root = path.join(__dirname, '..');
  let app;
  try {
    app = await electron.launch({ args: [root], cwd:root,
      env:{...process.env, BRCLIO_USER_DATA:temp, ZDOTDIR:temp, HISTFILE:path.join(temp, 'history')} });
    const home = await app.firstWindow();
    await home.waitForURL('file://**/web/index.html');
    await app.evaluate(({net}) => {
      // Drive the normal account client, token file, IPC sender checks and
      // WebContents lifecycle. Provide only synthetic responses for this test.
      const users = new Map();
      const reply = (value, status = 200) => new Response(JSON.stringify(value), {status, headers:{'Content-Type':'application/json'}});
      net.fetch = async (url, options = {}) => {
        const route = new URL(url).pathname;
        if (route === '/api/account/login') {
          const {username} = JSON.parse(options.body);
          const token = 'synthetic-login-token-' + username;
          const user = {id:username,email:username + '@example.test'};
          users.set(token,user);
          return reply({token,user});
        }
        const token = options.headers?.Authorization?.slice(7);
        if (route === '/api/account/logout') { users.delete(token); return reply({ok:true}); }
        if (route === '/api/account/session') return reply({user:users.get(token) || null});
        return reply({error:'No fixture for this request'},404);
      };
    });
    const account = input => home.evaluate(input => window.brclio.accountRequest(input),input);
    const login = username => account({path:'/api/account/login',method:'POST',body:{username,password:'synthetic-only'}});
    async function openTerminal(owner) {
      const next = app.waitForEvent('window');
      await home.evaluate(() => window.brclio.openTerminal('window'));
      // The native shell and its separate terminal document register as
      // Playwright pages. Locate the trusted document by URL.
      await next;
      const document = () => app.windows().find(page => page.url().includes('/desktop/terminal/index.html'));
      await expect.poll(() => Boolean(document())).toBe(true);
      const terminal = document();
      await expect.poll(() => terminal.evaluate(() => window.BrclioTerminalPartitions.owner)).toBe(owner);
      await expect(terminal.locator('.pane.active')).toHaveAttribute('data-state','running');
      return terminal;
    }
    await login('fixture-a');
    let terminal = await openTerminal('fixture-a');
    await terminal.evaluate(() => {
      localStorage.setItem('terminal-isolation-fixture','only-account-a');
      window.BrclioConnection.store(localStorage).save({name:'A private fixture',host:'a.example.test'});
    });
    const previous = terminal.waitForEvent('close');
    await account({path:'/api/account/logout',method:'POST',body:{}});
    await previous;
    await login('fixture-b');
    terminal = await openTerminal('fixture-b');
    assert.deepEqual(await terminal.evaluate(() => window.BrclioConnection.store(localStorage).all()),[]);
    assert.equal(await terminal.evaluate(() => localStorage.getItem('terminal-isolation-fixture')), null);
    await terminal.evaluate(() => window.BrclioConnection.store(localStorage).save({name:'B private fixture',host:'b.example.test'}));
    const closed = terminal.waitForEvent('close');
    await login('fixture-a');
    await closed;
    terminal = await openTerminal('fixture-a');
    assert.equal(await terminal.evaluate(() => localStorage.getItem('terminal-isolation-fixture')), 'only-account-a');
    assert.deepEqual(await terminal.evaluate(() => window.BrclioConnection.store(localStorage).all().map(h => h.name)),['A private fixture']);
    await require('./verify-terminal-unbound-transfer.cjs').verifyUnboundTransfer(app, terminal);
    console.log('Native account login, logout, PTY teardown, local-only A/B separation and return to A passed.');
  } finally {
    await app?.close();
    await fs.rm(temp,{recursive:true,force:true});
  }
}
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
