'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {_electron:electron,expect} = require('@playwright/test');

async function verify(executablePath) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(),'brclio-preview-smoke-'));
  const releasePath = path.join(temp,'release-profile');
  let app;
  try {
    app = await electron.launch({executablePath,args:[],env:{...process.env,BRCLIO_PREVIEW_DATA_ROOT:temp,
      BRCLIO_USER_DATA:releasePath,ZDOTDIR:temp,HISTFILE:path.join(temp,'shell-history')}});
    const home = await app.firstWindow();
    await home.waitForURL('file://**/web/index.html',{timeout:60000});
    await expect(home.locator('#view-terminal')).toBeVisible({timeout:60000});
    const result = await app.evaluate(({app,globalShortcut}) => ({
      title:app.getName(),data:app.getPath('userData'),hotkey:globalShortcut.isRegistered('Alt+P'),
    }));
    assert.equal(result.title,'Brclio Terminal Preview');
    assert.equal(result.data,path.join(temp,'com.brclio.toolbox.terminal-preview'));
    assert.equal(result.hotkey,false);
    assert.equal((await home.evaluate(() => window.brclio.getPlatform())).capabilities.systemIntegration,false);
    assert.equal((await home.evaluate(() => window.brclio.getIntegrationStatus())).supported,false);
    assert.equal((await home.evaluate(() => window.brclio.getShortcutStatus())).supported,false);
    // The staged application must explicitly reject all five paths before they reach an OS service.
    for (const command of ['setIntegration','checkForUpdates','downloadUpdate','installUpdate']) {
      await assert.rejects(home.evaluate(name => window.brclio[name](true),command),/终端预览版/);
    }
    await assert.rejects(home.evaluate(async () => {
      const settings = await window.brclio.getSettings();
      return window.brclio.saveSettings({...settings,launchAtLogin:!settings.launchAtLogin});
    }),/终端预览版/);
    assert.equal(await fs.stat(releasePath).then(() => true,() => false),false);
  } finally {
    await app?.close();
    await fs.rm(temp,{recursive:true,force:true});
  }
}
module.exports = {verify};
