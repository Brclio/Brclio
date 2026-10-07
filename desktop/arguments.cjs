'use strict';

function getCopyPaths(argv) {
  const marker = argv.indexOf('--copy-path');
  if (marker < 0) return null;
  const args = argv.slice(marker + 1);
  if (args[0] === '--') args.shift();
  if (!args.length) throw new Error('没有收到要复制的文件或文件夹路径。');
  if (args.length > 1000 || args.some(value => typeof value !== 'string' || !value || value.includes('\0'))) {
    throw new Error('收到的路径无效，请重新选择文件或文件夹。');
  }
  return args;
}

// Windows native command-line quoting, without cmd.exe or PowerShell evaluation.
function windowsArgument(value) {
  return `"${String(value).replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1')}"`;
}

function shellArgument(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

function launchCommand({ executable, appPath, packaged }, platform) {
  const quote = platform === 'win32' ? windowsArgument : shellArgument;
  return [executable, ...(packaged ? [] : [appPath])].map(quote).join(' ');
}

module.exports = { getCopyPaths, windowsArgument, shellArgument, launchCommand };
