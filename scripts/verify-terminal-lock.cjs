'use strict';

const { _electron:electron, expect } = require('@playwright/test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const {randomBytes} = require('node:crypto');

async function main() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(),'brclio-terminal-pin-'));
  const root = path.join(__dirname,'..'), key = randomBytes(32).toString('hex');
  let app,home;
  async function launch() {
    const env = {...process.env, BRCLIO_USER_DATA:directory,ZDOTDIR:directory,HISTFILE:path.join(directory,'history')};
    if (process.platform === 'win32') delete env.PSModulePath;
    app = await electron.launch({args:[root],cwd:root,env});
    home = await app.firstWindow();
    await home.waitForURL('file://**/web/index.html');
    await app.evaluate(({net,safeStorage},key) => {
      // Avoid a real Keychain consent prompt on CI Macs. Windows exercises DPAPI.
      if (process.platform === 'darwin') {
        const crypto = process.getBuiltinModule('crypto'), secret = Buffer.from(key,'hex');
        const set = (name,value) => Object.defineProperty(safeStorage,name,{configurable:true,value});
        set('isAsyncEncryptionAvailable',async () => true);
        set('encryptStringAsync',async value => {
          const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm',secret,iv);
          const encrypted = Buffer.concat([cipher.update(value,'utf8'),cipher.final()]);
          return Buffer.concat([iv,cipher.getAuthTag(),encrypted]);
        });
        set('decryptStringAsync',async value => {
          const cipher = crypto.createDecipheriv('aes-256-gcm',secret,value.subarray(0,12));
          cipher.setAuthTag(value.subarray(12,28));
          return {result:Buffer.concat([cipher.update(value.subarray(28)),cipher.final()]).toString('utf8')};
        });
      }
      net.fetch = async (url,options={}) => {
        const route = new URL(url).pathname;
        const user = {id:'fixture-owner',email:'fixture@example.test'};
        const authenticated = options.headers?.Authorization === 'Bearer fixture-terminal-lock-account';
        const data = route === '/api/account/login' ? {token:'fixture-terminal-lock-account',user} :
          route === '/api/account/session' ? {user:authenticated ? user : null} : {};
        return Response.json(data);
      };
    },key);
  }
  async function document(name) {
    const find = () => app.windows().find(page => page.url().includes('/desktop/terminal/' + name));
    await expect.poll(() => Boolean(find()),{timeout:10000}).toBe(true);
    return find();
  }
  async function open(name) {
    await home.evaluate(() => window.brclio.openTerminal('window'));
    return document(name);
  }
  async function lockSettings(terminal) {
    await terminal.locator('#connection-center').click();
    await terminal.getByRole('button',{name:'终端锁',exact:true}).click();
    return terminal.locator('#terminal-lock-dialog');
  }
  async function unlock(gate,pin='195306') {
    await app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows().find(win => win.getTitle() === 'Brclio 终端')?.focus());
    await gate.getByLabel('本机终端 PIN').fill(pin);
    await gate.getByRole('button',{name:'解锁',exact:true}).click();
  }
  try {
    await launch();
    let term = await open('index.html'), settings = await lockSettings(term);
    await settings.getByLabel('本机终端 PIN').fill('195306');
    await settings.getByLabel('再次输入 PIN').fill('195306');
    await settings.getByRole('button',{name:'开启终端锁'}).click();
    await expect(settings.getByRole('status')).toContainText('已启用');
    await expect(term.locator('.pane.active')).toHaveAttribute('data-state','running');
    await term.evaluate(async () => {
      const pane = document.querySelector('.pane.active').dataset.id;
      window.lockTestOutput = '';
      window.brclioTerminal.onData(({data}) => {window.lockTestOutput += data;});
      await window.brclioTerminal.write(pane, 'node -e "setTimeout(()=>console.log(\'LOCKED\'+\'_PENDING\'),1800)"\r');
    });
    await settings.getByRole('button',{name:'立即锁定'}).click();
    let gate = await document('terminal-lock-screen.html');
    assert.equal(await gate.evaluate(() => typeof window.brclioTerminal),'undefined');
    for (const action of ['profiles','paste','listPasswords']) {
      await assert.rejects(term.evaluate(action => window.brclioTerminal[action](),action),/锁定/);
    }
    await assert.rejects(term.evaluate(() => window.brclioTerminal.write(document.querySelector('.pane.active').dataset.id,'x')),/锁定/);
    await unlock(gate,'111111');
    await expect(gate.getByRole('status')).toContainText('PIN 不正确');
    // The child shell's timed output must wait in the main process while locked.
    await new Promise(resolve => setTimeout(resolve,2300));
    assert.equal(await term.evaluate(() => window.lockTestOutput.includes('LOCKED_PENDING')),false);
    await unlock(gate);
    await expect.poll(() => term.evaluate(() => window.lockTestOutput.includes('LOCKED_PENDING')),{timeout:15000}).toBe(true);
    await app.close(); app = undefined;
    await launch(); gate = await open('terminal-lock-screen.html');
    assert.equal(app.windows().some(page => page.url().includes('/desktop/terminal/index.html')),false);
    const closed = gate.waitForEvent('close');
    await home.evaluate(() => window.brclio.accountRequest({path:'/api/account/login',method:'POST',
      body:{identifier:'fixture-owner',password:'local-fixture'}}));
    await closed;
    gate = await open('terminal-lock-screen.html');
    await unlock(gate); term = await document('index.html');
    await expect.poll(() => term.evaluate(() => window.BrclioTerminalPartitions.owner)).toBe('fixture-owner');
    settings = await lockSettings(term);
    await settings.getByLabel('本机终端 PIN').fill('195306');
    await settings.getByRole('button',{name:'关闭终端锁'}).click();
    await expect(settings.getByRole('status')).toContainText('已关闭');
    console.log('Terminal-only PIN gate verified across PTY output, sensitive IPC, wrong PIN, live session resume, app restart, account switch and disabling.');
  } finally {
    await app?.close();
    await fs.rm(directory,{recursive:true,force:true});
  }
}
main().catch(error => {console.error(error);process.exitCode=1;});
