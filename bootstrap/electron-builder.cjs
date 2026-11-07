'use strict';

const app = require('./package.json');

module.exports = {
  appId: 'com.brclio.downloader',
  productName: app.productName,
  extraMetadata: { ...app, main: 'bootstrap/main.cjs' },
  directories: { output: 'release/downloader', buildResources: 'resources' },
  files: [
    'bootstrap/*.{cjs,html,css,js,json}', '!bootstrap/electron-builder.cjs', '!bootstrap/*.test.cjs',
    'bootstrap/replace-mac.sh', 'bootstrap/replace-win.ps1',
    'desktop/trusted-url.cjs',
    'desktop/electron-update-fetch.cjs', 'desktop/update-connect-bridge.cjs',
    'desktop/update-proxy.cjs', 'desktop/update-resume.cjs', 'desktop/updater.cjs',
    'desktop/mac-installer-helper.cjs', 'desktop/mac-installer.cjs',
    'desktop/windows-installer.cjs', 'desktop/windows-shell-signature.cjs',
    'package.json',
  ],
  mac: {
    target: ['dmg'],
    category: 'public.app-category.utilities',
    identity: '-',
    hardenedRuntime: false,
    icon: 'resources/icon.icns',
    artifactName: 'Brclio-Downloader-${version}-mac-${arch}.${ext}',
  },
  win: {
    target: ['nsis'],
    icon: 'resources/icon.ico',
    artifactName: 'Brclio-Downloader-${version}-windows-${arch}.${ext}',
  },
  nsis: { oneClick: true, perMachine: false },
};
