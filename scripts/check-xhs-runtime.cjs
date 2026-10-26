'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execute = promisify(execFile);

// Fail before producing an installer that silently depends on system Python.
module.exports = async function checkXhsRuntime(context) {
  const platform = context.electronPlatformName;
  const platformName = { darwin: 'mac', win32: 'win', linux: 'linux' }[platform];
  const arch = typeof context.arch === 'string' ? context.arch : { 1: 'x64', 3: 'arm64' }[context.arch];
  if (!platformName || !['arm64', 'x64'].includes(arch)) throw new Error('小红书 Python 后台只支持原生 arm64 / x64 安装包。');
  const root = context.packager?.projectDir || path.resolve(__dirname, '..');
  const directory = path.join(root, 'runtime', `${platformName}-${arch}`);
  const filename = platform === 'win32' ? 'xhs-python.exe' : 'xhs-python';
  const executable = path.join(directory, 'python', filename);
  let info;
  try {
    info = JSON.parse(await fs.readFile(path.join(directory, 'build-info.json'), 'utf8'));
    if (!(await fs.stat(executable)).isFile()) throw new Error('missing executable');
  } catch {
    throw new Error(`缺少小红书内置 Python 后台：${directory}。请先在目标平台运行 npm run prepare:xhs。`);
  }
  if (info.platform !== platform || info.arch !== arch) throw new Error('小红书 Python 后台的系统或架构与安装包不一致，请重新构建。');
  const hash = createHash('sha256');
  for (const filename of ['python-worker.py', 'api/python_parse.py', 'api/python_image.py', 'api/python_video.py']) {
    hash.update(filename);
    hash.update(await fs.readFile(path.join(root, 'desktop', 'xhs', filename)));
  }
  if (info.sourceSha256 !== hash.digest('hex')) throw new Error('小红书 Python 源码已更新，请运行 npm run prepare:xhs 后重新打包。');
  if (platform === process.platform && arch === process.arch) {
    const { stdout } = await execute(executable, ['--health'], { timeout: 20000, maxBuffer: 100000 });
    const health = JSON.parse(stdout);
    if (health.ok !== true || health.engine !== 'python') throw new Error('小红书内置 Python 后台健康检查失败。');
  }
};
