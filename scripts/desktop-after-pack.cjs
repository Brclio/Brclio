'use strict';

module.exports = async function afterPack(context) {
  if (context.electronPlatformName === 'darwin') return require('./mac-after-pack.cjs')(context);
  if (context.electronPlatformName === 'win32') return require('./windows-after-pack.cjs')(context);
};
