'use strict';

const path = require('node:path');
function provider({ platform = process.platform, preferences, getOwner, load = require, packaged = false, resources = process.resourcesPath }) {
  if (platform === 'darwin') return {
    available: () => preferences.canPromptTouchID(),
    authenticate: () => preferences.promptTouchID('解锁 Brclio 终端'),
  };
  if (platform !== 'win32') return { available: () => false };
  const file = packaged ? path.join(resources, 'terminal-auth', 'brclio_hello.node') :
    path.resolve(__dirname, '../../runtime/win-x64/terminal-hello/build/Release/brclio_hello.node');
  return {
    async available() { try { return await load(file).available() === true; } catch { return false; } },
    async authenticate() {
      const owner = getOwner();
      if (!owner || owner.isDestroyed() || !owner.isFocused()) throw new Error('请先返回终端锁屏。');
      let verified = false;
      try { verified = await load(file).verify(owner.getNativeWindowHandle()); } catch { /* PIN is still available. */ }
      if (verified !== true) throw new Error('Windows Hello 未完成验证，请重试或输入本机终端 PIN。');
    },
  };
}
module.exports = { provider };
