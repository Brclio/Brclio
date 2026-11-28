'use strict';
const assert = require('node:assert/strict');

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {_electron:electron,expect} = require('@playwright/test');

async function main() {
  const root = path.resolve(__dirname,'..'), temp = await fs.mkdtemp(path.join(os.tmpdir(),'brclio-cmd-completion-'));
  const env = {...process.env,BRCLIO_USER_DATA:temp};
  if (process.platform === 'win32') delete env.PSModulePath;
  else {
    Object.assign(env,{HOME:temp,SHELL:'/bin/zsh',ZDOTDIR:temp,HISTFILE:path.join(temp,'history'),BASH_SILENCE_DEPRECATION_WARNING:'1'});
    await fs.writeFile(path.join(temp,'.bash_profile'),"PS1='smoke$ '\n");
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
    await fs.mkdir(path.join(temp,'brclio-complete-directory'));
    // Capture only counters and known marker types from this isolated fixture.
    // Never print PTY output, typed text or history entries on failure.
    await page.evaluate(() => {
      const states = new Map(), pending = new Map();
      function trace(id) {
        if (!states.has(id)) states.set(id,{A:0,B:0,C:0,D:0,bashCounter:null,enterKeys:0,bytes:0});
        return states.get(id);
      }
      window.__suggestTrace = id => trace(id);
      const original = window.BrclioCommandMarks;
      window.BrclioCommandMarks = {...original,attach(terminal,...args) {
        const paneState = () => trace(terminal.element?.closest('.pane')?.dataset.id);
        const marks = original.attach(terminal,...args);
        terminal.parser.registerOscHandler(133,value => {
          const key = value.split(';')[0];
          if (/^[ABCD]$/.test(key)) {
            const field = 'parsed' + key, state = paneState();
            state[field] = (state[field] || 0) + 1;
          }
          return false;
        });
        terminal.parser.registerOscHandler(1337,value => {
          const counter = /^BrclioBashCommand=(\d{1,10})$/.exec(value);
          if (counter) paneState().parsedCounter = Number(counter[1]);
          return false;
        });
        terminal.onData(data => { if (data === '\r') paneState().xtermEnter = (paneState().xtermEnter || 0) + 1; });
        const accept = marks.acceptVisibleInput;
        marks.acceptVisibleInput = () => {
          const state = paneState();
          state.acceptedEnter = (state.acceptedEnter || 0) + 1;
          const prefix = marks.inputPrefix();
          state.acceptedLengths = [...(state.acceptedLengths || []),prefix?.length ?? -1];
          return accept();
        };
        return marks;
      }};
      document.addEventListener('keydown',event => {
        if (event.key === 'Enter' && event.target.matches('.xterm-helper-textarea')) {
          const id = event.target.closest('.pane')?.dataset.id;
          if (id) trace(id).enterKeys++;
        }
      },true);
      window.brclioTerminal.onData(({id,data}) => {
        const state = trace(id); state.bytes += data.length;
        const chunk = (pending.get(id) || '') + data;
        for (const match of chunk.matchAll(/\x1b\](?:133;([ABCD])(?:;[^\x07\x1b]{0,64})?|1337;BrclioBashCommand=(\d{1,10}))(?:\x07|\x1b\\)/g)) {
          if (match[1]) state[match[1]]++; else state.bashCounter=Number(match[2]);
        }
        const partial = /\x1b(?:\][\dA-Za-z;=]{0,64}\x1b?)?$/.exec(chunk);
        pending.set(id,partial?.[0] || '');
      });
    });
    const windows = process.platform === 'win32';
    const login = windows ? '' : path.basename(os.userInfo().shell || '');
    const profiles = windows ? ['default'] : ['zsh','bash'].map(shell => shell === login ? 'default' : shell);
    for (const profile of profiles) {
      await page.locator('#connection-center').click();
      await page.locator('[data-center=commands]').click();
      const clear = page.locator('#command-library-clear');
      if (await clear.isEnabled()) await clear.click();
      await page.locator('#command-library-close').click();
      await page.locator('#profile').selectOption(profile);
      await page.locator('#new-tab').click();
      await expect(pane).toHaveAttribute('data-state','running',{timeout:15000});
      const id = await pane.getAttribute('data-id');
      const snapshot = () => page.evaluate(id => {
        const history = JSON.parse(window.BrclioTerminalPartitions.storage.getItem('brclio.terminal.command-history.v1') || '{}');
        return {...window.__suggestTrace(id),enabled:history.enabled,entries:history.entries?.length || 0,
          includesPwd:history.entries?.includes('pwd') || false,entryLengths:history.entries?.map(item => item.length)};
      },id);
      const proof = '.brclio-shell-proof-' + profile;
      let fileVerified = false;
      try {
        await expect.poll(async () => (await snapshot()).parsedB || 0,{timeout:20000}).toBeGreaterThan(0);
        const textarea = pane.locator('.xterm-helper-textarea');
        await textarea.focus();
        await page.keyboard.type('pw');
        await expect(pane.locator('.command-completion')).toHaveText('pwd');
        await pane.locator('.command-completion').click();
        await expect(pane.locator('.command-completion')).toBeHidden();
        await expect(pane.locator('.xterm-rows')).toContainText('pwd');
        const before = await snapshot();
        assert.equal(before.includesPwd,false);
        await textarea.press('Enter');
        await expect.poll(async () => (await snapshot()).parsedB,{timeout:15000}).toBeGreaterThan(before.parsedB);
        await textarea.focus();
        await page.keyboard.type(windows ? '(Get-Location).Path | Set-Content ' + proof : 'pwd > ' + proof);
        await expect(pane.locator('.xterm-rows')).toContainText(proof);
        await textarea.press('Enter');
        const name = path.join(temp,proof);
        await expect.poll(() => fs.readFile(name,'utf8').then(s => s.trim().length > 0,() => false),{timeout:15000}).toBe(true);
        assert.equal(await fs.realpath((await fs.readFile(name,'utf8')).trim()),await fs.realpath(temp));
        fileVerified = true;
        await expect.poll(async () => (await snapshot()).includesPwd).toBe(true);
        if ((await snapshot()).bashCounter !== null) {
          const origin = 'read -r -p "brclio-read> " reply';
          // Wait until the proof command itself has completed and the new
          // prompt has been parsed before starting this interactive fixture.
          await expect.poll(async () => (await snapshot()).parsedB).toBeGreaterThan(before.parsedB + 1);
          await textarea.focus();
          await page.keyboard.type(origin);
          await expect(pane.locator('.xterm-rows')).toContainText(origin);
          await textarea.press('Enter');
          await expect(pane.locator('.xterm-rows > div').filter({hasText:/^brclio-read>\s*$/})).toBeVisible();
          await page.keyboard.type('brclio-private-response');
          await textarea.press('Enter');
          await expect.poll(() => page.evaluate(origin => {
            const entries = JSON.parse(window.BrclioTerminalPartitions.storage.getItem('brclio.terminal.command-history.v1')).entries;
            return {command:entries.includes(origin),answer:entries.some(item => item.includes('brclio-private-response'))};
          },origin)).toEqual({command:true,answer:false});
        }
        await textarea.focus();
        await page.keyboard.type('cd brclio-complete-d');
        await expect(pane.locator('.command-completion')).toHaveText('补全路径或参数');
        await pane.locator('.command-completion').click();
        await expect(pane.locator('.xterm-rows')).toContainText('brclio-complete-directory');
      } catch (error) {
        console.error('Isolated command fixture:',{profile,login,fileVerified,...await snapshot()});
        throw error;
      }
    }
    console.log('Verified real shell completion, command execution and visible history on: ' + profiles.join(', '));
  } finally { await app?.close(); await fs.rm(temp,{recursive:true,force:true}); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
