#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { build, compilerEnvironment, execute } = require('../../scripts/windows-build-shell.cjs');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'brclio-windows-tests-'));
try {
  const source = path.join(__dirname, 'CommandLineTests.cpp');
  const binary = path.join(temporary, process.platform === 'win32' ? 'CommandLineTests.exe' : 'CommandLineTests');
  if (process.platform === 'win32') {
    const env = compilerEnvironment();
    execute('cl.exe', ['/nologo', '/std:c++17', '/EHsc', '/W4', '/WX', '/MT', '/utf-8', source,
      `/Fo${path.join(temporary, 'CommandLineTests.obj')}`, `/Fe${binary}`, '/link', 'shell32.lib'],
    { cwd: temporary, env });
    console.log(execute(binary, []));
    const install = path.join(temporary, 'Installed Brclio 中文');
    const shellDirectory = path.join(install, 'resources', 'windows-shell');
    const built = build({ output: shellDirectory, version: require('../../package.json').version });
    const harness = path.join(temporary, 'ComTests.exe');
    execute('cl.exe', ['/nologo', '/std:c++17', '/EHsc', '/W4', '/WX', '/MT', '/utf-8',
      path.join(__dirname, 'ComTests.cpp'), `/Fo${path.join(temporary, 'ComTests.obj')}`, `/Fe${harness}`,
      '/link', 'shell32.lib', 'shlwapi.lib', 'ole32.lib', 'uuid.lib'], { cwd: temporary, env });
    console.log(execute(harness, [install, built.packageVersion], { env: { ...process.env,
      BRCLIO_SHELL_TEST_OUTPUT: path.join(temporary, 'child-arguments.bin') } }));
    if (process.env.BRCLIO_ALLOW_SHELL_TRUST_SMOKE === '1') {
      const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      console.log(execute(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', path.join(__dirname, 'TrustSmoke.ps1'), '-Directory', shellDirectory]));
      console.log(execute(process.execPath, [path.resolve(__dirname, '../../desktop/windows-shell-smoke.cjs'), install]));
    }
  } else {
    execute(process.env.CXX || 'c++', ['-std=c++17', '-Wall', '-Wextra', '-Werror', source, '-o', binary]);
    console.log(execute(binary, []));
  }
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
