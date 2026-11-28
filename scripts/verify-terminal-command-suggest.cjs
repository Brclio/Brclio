'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {_electron:electron,expect} = require('@playwright/test');

async function main() {
  const root = path.resolve(__dirname,'..'), temp = await fs.mkdtemp(path.join(os.tmpdir(),'brclio-cmd-completion-'));
  const env = {...process.env,BRCLIO_USER_DATA:temp};
  if (process.platform === 'win32') delete env.PSModulePath;
  else {
    Object.assign(env,{SHELL:'/bin/zsh',ZDOTDIR:temp,HISTFILE:path.join(temp,'history')});
    await fs.writeFile(path.join(temp,'.zshrc'),"PROMPT='smoke$ '\n");
  }
  let app;
  try {
    app = await electron.launch({args:[root],cwd:root,env});
    const home = await app.firstWindow();
    await home.waitForURL('file://**/web/index.html');
    await home.evaluate(() => window.brclio.openTerminal('window'));
    const find = () => app.windows().find(p => p.url().endsWith('/desktop/terminal/index.html'));
    await expect.poll(() => Boolean(find())).toBe(true);
    const page = find();
    const pane = page.locator('.pane.active:visible');
    await page.locator('#connection-center').click();
    await page.locator('[data-center=commands]').click();
    await page.locator('#command-library-enable').check();
    await page.locator('#command-library-suggest').check();
    await page.locator('#command-library-close').click();
    await page.locator('#terminal-actions').click();
    await page.locator('#shell-integration').check();
    await page.locator('#actions-close').click();
    await app.evaluate(({dialog},folder) => { dialog.showOpenDialog = async () => ({canceled:false,filePaths:[folder]}); },temp);
    await page.locator('#directory').click();
    await expect(page.locator('#directory-label')).toHaveText(temp);
    await page.locator('#new-tab').click();
    await expect(pane).toHaveAttribute('data-state','running',{timeout:15000});
    await expect(pane.locator('.xterm-rows')).toContainText(process.platform === 'win32' ? /PS [^>]*>/ : /[%#$]/,{timeout:20000});
    await pane.locator('.xterm-helper-textarea').focus();
    await page.keyboard.type('pw');
    await expect(pane.locator('.command-completion')).toHaveText('pwd');
    await pane.locator('.command-completion').click();
    await expect(pane.locator('.command-completion')).toBeHidden();
    await expect(pane.locator('.xterm-rows')).toContainText('pwd');
    await pane.locator('.xterm-helper-textarea').press('Enter');
    await expect.poll(() => page.evaluate(() =>
      JSON.parse(window.BrclioTerminalPartitions.storage.getItem('brclio.terminal.command-history.v1') || '{}').entries?.includes('pwd'))).toBe(true);
    const directory = path.join(temp,'brclio-complete-directory');
    await fs.mkdir(directory);
    await pane.locator('.xterm-helper-textarea').focus();
    await page.keyboard.type('cd brclio-complete-d');
    await expect(pane.locator('.command-completion')).toHaveText('补全路径或参数');
    await pane.locator('.command-completion').click();
    await expect(pane.locator('.xterm-rows')).toContainText('brclio-complete-directory');
    console.log('A real integrated shell suggested pwd from the visible prefix and recorded it only after Enter.');
  } finally { await app?.close(); await fs.rm(temp,{recursive:true,force:true}); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
