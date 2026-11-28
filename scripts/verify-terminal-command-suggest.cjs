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
  async function launchTerminal() {
    app = await electron.launch({args:[root],cwd:root,env});
    const home = await app.firstWindow();
    await home.waitForURL('file://**/web/index.html');
    await home.evaluate(() => window.brclio.openTerminal('window'));
    const find = () => app.windows().find(p => p.url().endsWith('/desktop/terminal/index.html'));
    await expect.poll(() => Boolean(find())).toBe(true);
    return find();
  }
  async function openLibrary(page) {
    if (!await page.locator('#command-library-browse').isVisible()) await page.locator('#quick-commands').click();
    await expect(page.locator('#workspace-commands')).toBeVisible();
    await expect(page.locator('dialog[open]')).toHaveCount(0);
  }
  async function settings(page) {
    const controls = page.locator('#command-library-settings');
    if (!await controls.evaluate(node => node.open)) await controls.locator('summary').click();
  }
  try {
    const page = await launchTerminal();
    const pane = page.locator('.pane.active:visible');
    await openLibrary(page);
    await settings(page);
    await page.locator('#command-library-enable').check();
    await page.locator('#command-library-suggest').check();
    await page.locator('#workspace-collapse').click();
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
      await openLibrary(page);
      await settings(page);
      const clear = page.locator('#command-library-clear');
      if (await clear.isEnabled()) await clear.click();
      await page.locator('#workspace-collapse').click();
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
    await openLibrary(page);
    await page.locator('#command-library-source').selectOption('history');
    await page.locator('#command-library-list').getByRole('option', {name:'历史 · pwd',exact:true}).click();
    await page.locator('#command-library-remember').click();
    await expect(page.locator('#command-library-status')).toHaveText('已收藏。');
    await expect(page.locator('#command-library-remember')).toBeDisabled();
    await page.locator('#command-library-edit').click();
    await expect(page.locator('#command-library-text')).toHaveValue('pwd');
    await page.locator('#command-library-name').fill('查看当前目录');
    await page.locator('#quick-appearance').click();
    await page.evaluate(() => {
      const model = window.BrclioSnippetModel, store = window.BrclioTerminalPartitions.storage;
      const items = model.read(store);
      items.find(item => item.text === 'pwd').name = '另一设备的名称';
      model.store(store, items);
      window.dispatchEvent(new Event('brclio-snippets-changed'));
    });
    await page.locator('#quick-commands').click();
    await expect(page.locator('#command-library-name')).toHaveValue('查看当前目录');
    await page.locator('#command-library-save').click();
    await expect(page.locator('#command-library-editor-status')).toContainText('条目已更改');
    await page.locator('#command-library-cancel').click();
    await page.locator('#command-library-edit').click();
    await expect(page.locator('#command-library-name')).toHaveValue('另一设备的名称');
    await page.locator('#command-library-name').fill('查看当前目录');
    await page.locator('#command-library-save').click();
    await openLibrary(page);
    await page.locator('#command-library-new').click();
    await page.locator('#command-library-name').fill('临时草稿');
    await page.locator('#quick-ssh').click();
    await page.locator('#workspace-collapse').click();
    await openLibrary(page);
    await page.locator('#command-library-new').click();
    await expect(page.locator('dialog[open]')).toHaveCount(0);
    await expect(pane).toBeVisible();
    await expect(page.locator('#command-library-name')).toHaveValue('');
    await page.locator('#command-library-name').fill('写入回忆测试文件');
    const proof = path.join(temp,'shortcut-proof.txt');
    const command = 'echo recalled > "' + proof + '"';
    await page.locator('#command-library-text').fill(command);
    await page.locator('#quick-ssh').click();
    await page.locator('#quick-commands').click();
    await expect(page.locator('#command-library-text')).toHaveValue(command);
    await page.locator('#command-library-save').click();
    await expect(page.locator('#command-library-status')).toHaveText('已保存。');

    // A pane from the old account must not contribute commands to the new one.
    await page.locator('#command-library-new').click();
    await page.locator('#command-library-text').fill('previous-account-draft');
    await page.locator('#quick-ssh').click();
    const isolated = await page.evaluate(() => {
      const parts = window.BrclioTerminalPartitions;
      const recorder = window.BrclioCommandLibrary.recorder({profile:'default'});
      const owner = parts.owner;
      try {
        parts.activate('command-recall-test-account');
        window.dispatchEvent(new Event('brclio-terminal-account-changed'));
        const draftCleared = document.getElementById('command-library-text').value === '';
        const key = 'brclio.terminal.command-history.v1';
        parts.storage.setItem(key, JSON.stringify({enabled:true,entries:[]}));
        recorder.add('pwd');
        window.BrclioCommandLibrary.open();
        const oldPaneBlocked = document.getElementById('command-library-insert').disabled;
        window.BrclioTerminalWorkspace.close();
        return {draftCleared, snippets:window.BrclioSnippetModel.read(parts.storage).length,
          history:JSON.parse(parts.storage.getItem(key)).entries.length, oldPaneBlocked};
      } finally {
        parts.activate(owner);
        window.dispatchEvent(new Event('brclio-terminal-account-changed'));
      }
    });
    assert.deepEqual(isolated,{draftCleared:true,snippets:0,history:0,oldPaneBlocked:true});
    await app.close(); app = undefined;
    const restarted = await launchTerminal();
    await openLibrary(restarted);
    await settings(restarted);
    await expect(restarted.locator('#command-library-enable')).toBeChecked();
    await restarted.locator('#command-library-source').selectOption('history');
    await expect(restarted.locator('#command-library-list').getByRole('option',{name:'历史 · pwd',exact:true})).toHaveCount(1);
    await restarted.locator('#command-library-clear').click();
    await expect(restarted.locator('#command-library-list').getByRole('option')).toHaveCount(0);
    await restarted.locator('#command-library-source').selectOption('saved');
    await expect(restarted.locator('#command-library-list').getByRole('option')).toHaveCount(2);
    await restarted.locator('#command-library-query').fill('回忆测试');
    await restarted.locator('#command-library-list').press('Enter');
    await expect(restarted.locator('#workspace-commands')).toBeVisible();
    await expect(restarted.locator('dialog[open]')).toHaveCount(0);
    const target = restarted.locator('.pane.active:visible');
    await expect(target.locator('.xterm-rows')).toContainText('echo recalled');
    assert.equal(await fs.stat(proof).then(() => true, () => false),false);
    await target.locator('.xterm-helper-textarea').press('Enter');
    await expect.poll(() => fs.stat(proof).then(info => info.size, () => 0)).toBeGreaterThan(0);
    await expect.poll(() => restarted.evaluate(line => {
      const saved = JSON.parse(window.BrclioTerminalPartitions.storage.getItem('brclio.terminal.command-history.v1'));
      return saved.entries.includes(line);
    }, command)).toBe(true);
    console.log('Verified real shell completion, command execution and visible history on: ' + profiles.join(', '));
    console.log('Verified one-click favorites, custom commands, account isolation and recall after app restart.');
  } finally { await app?.close(); await fs.rm(temp,{recursive:true,force:true}); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
