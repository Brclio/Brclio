'use strict';
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const result = spawnSync(process.platform === 'win32' ? 'python' : 'python3', [
  path.join(__dirname, 'prepare-xhs-runtime.py'), ...process.argv.slice(2),
], { stdio: 'inherit' });
if (result.error) { console.error(result.error.message); process.exit(1); }
process.exit(result.status ?? 1);
