'use strict';

const {_electron:electron,expect} = require('@playwright/test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');

async function main() {
  const root = path.join(__dirname,'..'), temp = await fs.mkdtemp(path.join(os.tmpdir(),'brclio-layout-destinations-'));
  const sockets = [];
  const service = net.createServer(socket => {sockets.push(socket);socket.on('error',() => {});});
  let app;
  try {
    await new Promise((resolve,reject) => {service.once('error',reject);service.listen(0,'127.0.0.1',resolve);});
    const port = service.address().port;
    const env = {...process.env,BRCLIO_USER_DATA:temp,ZDOTDIR:temp,HISTFILE:path.join(temp,'history')};
    if (process.platform === 'win32') delete env.PSModulePath;
    app = await electron.launch({args:[root],cwd:root,env});
    const home = await app.firstWindow(); await home.waitForURL('file://**/web/index.html');
    await app.evaluate(({net}) => {net.fetch = async () => Response.json({user:null});});
    await home.evaluate(() => window.brclio.openTerminal('window'));
    const find = () => app.windows().find(page => page.url().includes('/desktop/terminal/index.html'));
    await expect.poll(() => Boolean(find())).toBe(true);
    const page = find();
    await expect.poll(() => page.evaluate(() => window.BrclioTerminalPartitions.ready)).toBe(true);
    await page.evaluate(port => {
      const hosts = window.BrclioConnection.store(localStorage);
      for (const name of ['layout-ssh','layout-sftp']) hosts.save({name,host:'127.0.0.1',port,user:'operator'});
    },port);
    async function launch(protocol) {
      await page.locator('#connection-center').click();
      await page.locator('[data-center=hosts]').click();
      await page.locator('#workspace-hosts [data-host="advanced-library"]').click();
      await page.locator('#remote-library').getByText('layout-'+protocol,{exact:true}).first().click();
      await page.locator('#remote-'+protocol).click();
    }
    await launch('ssh'); await launch('sftp'); await expect.poll(() => sockets.length).toBe(2);
    await page.locator('#terminal-actions').click();
    await page.locator('#arrangement-name').fill('恢复远程窗格');
    await page.locator('#arrangement-hosts').check();
    await page.locator('#arrangement-save').click();
    await expect(page.locator('#arrangement-status')).toContainText('已保存布局');
    await page.locator('#arrangement-restore').click(); await page.locator('#actions-close').click();
    await expect(page.locator('.pane[data-state=waiting]')).toHaveCount(2);
    assert.equal(sockets.length,2);
    const active = page.locator('.panel:not([hidden]) .pending-layout-host');
    await expect(active).toContainText('SFTP · layout-sftp'); await expect(active).toContainText(String(port));
    await active.getByRole('button',{name:'连接此窗格'}).click();
    await expect.poll(() => sockets.length).toBe(3);
    await expect(page.locator('.pane[data-state=waiting]')).toHaveCount(1);
    const waiting = page.locator('.pane[data-state=waiting]');
    const panel = await waiting.evaluate(node => node.closest('.panel').id);
    await page.locator('[aria-controls="'+panel+'"]').click();
    await page.evaluate(() => {
      const hosts = window.BrclioConnection.store(localStorage), source = hosts.all().find(h => h.name === 'layout-ssh');
      hosts.save({...source,user:'changed-user'});
    });
    await expect(active).toContainText('changed-user');
    await active.getByRole('button',{name:'核对连接目标'}).click();
    assert.equal(sockets.length,3);
    await page.evaluate(() => window.BrclioConnection.store(localStorage).remove('layout-ssh'));
    await expect(active).toContainText('已删除或更名');
    await active.getByLabel('重新选择本机主机').selectOption('layout-sftp');
    await active.getByRole('button',{name:'核对连接目标'}).click();
    await active.getByRole('button',{name:'确认连接此目标'}).click();
    await expect.poll(() => sockets.length).toBe(4);
    console.log('Saved SSH/SFTP references restore in place without a connection; each verified pane connects only after explicit confirmation, including changed or removed hosts.');
  } finally {
    for (const socket of sockets) socket.destroy();
    await app?.close();
    await new Promise(resolve => service.close(resolve));
    await fs.rm(temp,{recursive:true,force:true});
  }
}
main().catch(error => {console.error(error);process.exitCode=1;});
