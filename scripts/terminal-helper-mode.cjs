'use strict';

const fs = require('node:fs');
const path = require('node:path');

// The macOS binaries in node-pty 1.1.0's npm tarball have mode 0644.
function enableMacPtyHelper(moduleRoot, arch) {
  const candidates = ['build/Release', 'build/Debug', `prebuilds/darwin-${arch}`];
  let found = false;
  for (const directory of candidates) {
    const helper = path.join(moduleRoot, directory, 'spawn-helper');
    if (fs.existsSync(helper)) {
      fs.chmodSync(helper, 0o755);
      found = true;
    }
  }
  if (!found) throw new Error(`Missing node-pty spawn-helper for macOS ${arch} in ${moduleRoot}`);
}

if (require.main === module && process.platform === 'darwin') {
  enableMacPtyHelper(path.dirname(require.resolve('node-pty/package.json')), process.arch);
}

module.exports = { enableMacPtyHelper };
