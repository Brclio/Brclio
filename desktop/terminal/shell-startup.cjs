'use strict';

const path = require('node:path');
const fs = require('node:fs');

function shellArguments(file, platform, enabled, env, directory = __dirname) {
  const args = platform === 'win32' ? [] : ['-l'];
  if (!enabled) return args;
  // Interactive shells are external processes and cannot read Electron ASARs.
  const scripts = path.join(directory.replace(/([\\/])app\.asar([\\/])/, '$1app.asar.unpacked$2'), 'shell-integration');
  const name = (platform === 'win32' ? path.win32 : path.posix).basename(file).toLowerCase();
  const required = { zsh: 'zsh/.zshenv', bash: 'bash.sh', 'powershell.exe': 'powershell.ps1', 'pwsh.exe': 'powershell.ps1' }[name];
  if (required) {
    try { fs.accessSync(path.join(scripts, required), fs.constants.R_OK); }
    catch { return args; }
  }
  if (name === 'zsh') {
    if (env.ZDOTDIR !== undefined) env.BRCLIO_ORIGINAL_ZDOTDIR = env.ZDOTDIR;
    env.ZDOTDIR = path.join(scripts, 'zsh');
  } else if (name === 'bash') {
    if (env.PROMPT_COMMAND === undefined) env.BRCLIO_UNEXPORT_PROMPT = '1';
    const hook = ". '" + path.join(scripts, 'bash.sh').replaceAll("'", "'\\''") + "' \"$?\"";
    env.PROMPT_COMMAND = [hook, env.PROMPT_COMMAND].filter(Boolean).join('\n');
  } else if (['powershell.exe', 'pwsh.exe'].includes(name)) {
    const hook = path.join(scripts, 'powershell.ps1').replaceAll("'", "''");
    return ['-NoExit', '-Command', ". '" + hook + "'"];
  } else if (name === 'cmd.exe') {
    env.PROMPT = '$E]133;A$E\\' + (env.PROMPT || '$P$G') + '$E]133;B$E\\';
  }
  return args;
}

module.exports = { shellArguments };
