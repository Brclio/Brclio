'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

async function compileWindows(source, file) {
  const compiler = path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe');
  await promisify(execFile)(compiler, ['/nologo', '/noconfig', '/target:winexe', '/codepage:65001', '/r:System.dll',
    '/r:System.Windows.Forms.dll', '/r:System.Drawing.dll', '/out:' + file, source], { windowsHide: true, timeout: 20000 });
}

async function prepareAskpass() {
  // Windows installers ship the compiled helper. End users never need a C# compiler.
  if (process.platform === 'win32' && process.resourcesPath && __dirname.includes('app.asar' + path.sep)) {
    const file = path.join(process.resourcesPath, 'terminal-auth', 'askpass.exe');
    await fs.access(file, fs.constants.X_OK);
    return { file, cleanup() {} };
  }
  // Native OpenSSH launches this program by filesystem path, including from an ASAR build.
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'brclio-sftp-auth-'));
  const cleanup = () => fs.rm(directory, { recursive: true, force: true }).catch(() => {});
  try {
    if (process.platform === 'darwin') {
      const file = path.join(directory, 'askpass');
      await fs.writeFile(file, await fs.readFile(path.join(__dirname, 'sftp-askpass-mac')), { flag: 'wx', mode: 0o700 });
      return { file, cleanup };
    }
    if (process.platform === 'win32') {
      const source = path.join(directory, 'askpass.cs');
      const file = path.join(directory, 'askpass.exe');
      await fs.writeFile(source, await fs.readFile(path.join(__dirname, 'sftp-askpass-win.cs')), { flag: 'wx' });
      await compileWindows(source, file);
      return { file, cleanup };
    }
    throw new Error('当前平台没有图形 SSH 身份验证助手。');
  } catch (error) {
    await cleanup();
    throw new Error('无法准备 SFTP 身份验证助手。' + error.message);
  }
}
module.exports = { prepareAskpass, compileWindows };
