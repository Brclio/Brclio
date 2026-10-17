#!/usr/bin/env node
'use strict';

const { execFileSync } = require('node:child_process');
const { createHash, randomBytes } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { POWERSHELL_SIGNATURE_FUNCTIONS } = require('../desktop/windows-shell-signature.cjs');

const root = path.resolve(__dirname, '..');
const native = path.join(root, 'native', 'windows');
const DLL_NAME = 'BrclioExplorerCommand.dll';

function manifestVersion(version) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version) ||
      version.split('.').some(part => Number(part) > 65535)) {
    throw new Error(`Windows shell packaging requires numeric version X.Y.Z with components <= 65535; received ${version}`);
  }
  return `${version}.0`;
}

function renderManifest(version, publisher = process.env.BRCLIO_WINDOWS_SHELL_PUBLISHER || 'CN=Brclio') {
  if (!publisher.trim() || /[\x00-\x1f\x7f]/.test(publisher)) throw new Error('Invalid Windows shell package publisher.');
  const escaped = publisher.replace(/[&<>"']/g, value => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[value]));
  return fs.readFileSync(path.join(native, 'AppxManifest.xml.in'), 'utf8')
    .replaceAll('__VERSION__', manifestVersion(version)).replace('Publisher="CN=Brclio"', `Publisher="${escaped}"`);
}

function execute(executable, args, options = {}) {
  return execFileSync(executable, args, {
    encoding: 'utf8', windowsHide: true, maxBuffer: 4 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000, ...options,
  }).trim();
}

function compilerEnvironment() {
  if (process.platform !== 'win32') throw new Error('Windows Explorer extension compilation requires Windows with Visual Studio C++ tools and the Windows SDK.');
  const programFiles = process.env['ProgramFiles(x86)'] || process.env.ProgramFiles;
  if (!programFiles) throw new Error('Cannot locate Visual Studio Installer.');
  const vswhere = path.join(programFiles, 'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
  const installation = execute(vswhere, ['-utf8', '-latest', '-products', '*', '-requires',
    'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationPath']);
  if (!installation || /[\r\n"%]/.test(installation)) throw new Error('Could not locate a usable Visual Studio C++ installation.');
  const devcmd = path.join(installation, 'Common7', 'Tools', 'VsDevCmd.bat');
  const command = `call "${devcmd}" -no_logo -arch=x64 -host_arch=x64 >nul && set`;
  // Only the trusted Visual Studio installation path enters cmd.exe. Source,
  // output and selected file paths are passed directly to native processes.
  const cmd = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe');
  // cmd.exe consumes source after /c, not CRT argv. Node's ordinary Windows
  // argv quoting would turn the batch path's quotes into literal backslashes.
  const output = execute(cmd, ['/d', '/u', '/s', '/c', command], {
    encoding: 'utf16le', windowsVerbatimArguments: true,
  });
  const environment = { ...process.env };
  for (const line of output.split(/\r?\n/)) {
    const equals = line.indexOf('=');
    if (equals > 0) {
      const key = line.slice(0, equals);
      const previous = Object.keys(environment).find(item => item.toLowerCase() === key.toLowerCase());
      if (previous && previous !== key) delete environment[previous];
      environment[key] = line.slice(equals + 1);
    }
  }
  if (environment.VSCMD_ARG_TGT_ARCH !== 'x64') throw new Error('Visual Studio did not initialize the x64 toolchain.');
  // Let Windows PowerShell 5.1 rebuild its native module search path when the
  // build was launched from PowerShell 7, as on GitHub's Windows runners.
  for (const key of Object.keys(environment)) if (key.toLowerCase() === 'psmodulepath') delete environment[key];
  return environment;
}

function verifyPE(filename) {
  const bytes = fs.readFileSync(filename);
  if (bytes.length < 64 || bytes.toString('ascii', 0, 2) !== 'MZ') throw new Error(`${filename} is not a PE binary.`);
  const offset = bytes.readUInt32LE(0x3c);
  if (offset + 24 > bytes.length || bytes.toString('ascii', offset, offset + 4) !== 'PE\0\0' ||
      bytes.readUInt16LE(offset + 4) !== 0x8664 || !(bytes.readUInt16LE(offset + 22) & 0x2000)) {
    throw new Error(`${filename} must be an x64 Windows DLL.`);
  }
}

function sdkTool(name, env) {
  const sdkVersion = (env.WindowsSDKVersion || '').replace(/[\\/]+$/, '');
  const candidates = [
    env.WindowsSdkVerBinPath && path.join(env.WindowsSdkVerBinPath, 'x64', name),
    env.WindowsSdkBinPath && sdkVersion && path.join(env.WindowsSdkBinPath, sdkVersion, 'x64', name),
    env.WindowsSdkDir && sdkVersion && path.join(env.WindowsSdkDir, 'bin', sdkVersion, 'x64', name),
  ];
  const tool = candidates.find(filename => filename && fs.existsSync(filename));
  if (!tool) throw new Error(`Windows SDK ${name} was not found. Install the Windows 10/11 SDK with Visual Studio C++ tools.`);
  return tool;
}

function signPackage(filename, dll, publisher, temporary, output, env) {
  let certificate = process.env.BRCLIO_WINDOWS_SHELL_CERTIFICATE_FILE;
  let password = process.env.BRCLIO_WINDOWS_SHELL_CERTIFICATE_PASSWORD;
  const selfSigned = !certificate;
  const publicCertificate = path.join(output, 'BrclioShell.cer');
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  if (selfSigned) {
    certificate = path.join(temporary, 'ephemeral-shell-signing.pfx');
    password = randomBytes(32).toString('base64');
    execute(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', path.join(native, 'CreateShellCertificate.ps1'), '-Publisher', publisher,
      '-PfxPath', certificate, '-CertificatePath', publicCertificate],
    { env: { ...env, BRCLIO_SHELL_BUILD_PFX_PASSWORD: password } });
  } else {
    fs.rmSync(publicCertificate, { force: true });
  }
  if (!fs.statSync(certificate).isFile()) throw new Error('Windows shell signing certificate file was not found.');
  const signtool = sdkTool('signtool.exe', env);
  const args = ['sign', '/fd', 'SHA256', '/f', certificate];
  if (password !== undefined) args.push('/p', password);
  const timestamp = process.env.BRCLIO_WINDOWS_SHELL_TIMESTAMP_URL;
  if (timestamp) args.push('/tr', timestamp, '/td', 'SHA256');
  args.push(dll, filename);
  // execFileSync's error text embeds arguments. Never expose a PFX password.
  try {
    execute(signtool, args, { env });
    if (!selfSigned) execute(signtool, ['verify', '/pa', '/all', filename], { env });
  } catch {
    throw new Error('Windows shell MSIX signing or certificate-chain verification failed. Check the certificate, matching manifest publisher, password, and timestamp configuration.');
  }
  const signature = JSON.parse(execute(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', path.join(native, 'ReadShellSignature.ps1'), '-PackagePath', filename,
    '-CertificatePath', publicCertificate], { env }));
  if (signature.publisher !== publisher) throw new Error('Signed MSIX publisher does not match its manifest.');
  if (!/^[a-f0-9]{64}$/.test(signature.certificateSha256)) throw new Error('Cannot compile the shell trust helper without an exact public certificate pin.');
  const pinHeader = path.join(temporary, 'CertificatePin.h');
  fs.writeFileSync(pinHeader, `#define EXPECTED_CERT_SHA256 "${signature.certificateSha256}"\n`);
  const trustHelper = path.join(output, 'BrclioShellTrust.exe');
  execute('cl.exe', ['/nologo', '/std:c++17', '/EHsc', '/O2', '/W4', '/WX', '/MT', '/utf-8', '/guard:cf',
    '/DUNICODE', '/D_UNICODE', '/D_WIN32_WINNT=0x0A00', `/FI${pinHeader}`,
    path.join(native, 'ShellTrust.cpp'), `/Fo${path.join(temporary, 'ShellTrust.obj')}`,
    '/link', `/OUT:${trustHelper}`, '/SUBSYSTEM:WINDOWS', '/MACHINE:X64', '/DYNAMICBASE', '/NXCOMPAT', '/GUARD:CF',
    'crypt32.lib', 'advapi32.lib', 'shell32.lib', 'shlwapi.lib', 'windowsapp.lib', 'runtimeobject.lib'], { cwd: temporary, env });
  const helperSignArgs = args.slice(0, -2).concat(trustHelper);
  try { execute(signtool, helperSignArgs, { env }); }
  catch { throw new Error('Windows shell trust helper signing failed. Check the configured certificate and timestamp service.'); }
  password = undefined;
  return { signed: true, selfSigned, certificate: 'BrclioShell.cer',
    certificateSha256: signature.certificateSha256, certificateThumbprint: signature.certificateThumbprint,
    trustHelper: 'BrclioShellTrust.exe', trustHelperSha256: createHash('sha256').update(fs.readFileSync(trustHelper)).digest('hex') };
}

function build({ output, version, arch = 'x64', publisher = process.env.BRCLIO_WINDOWS_SHELL_PUBLISHER || 'CN=Brclio' }) {
  if (arch !== 'x64') throw new Error('Brclio Windows Explorer extension currently supports x64 builds only.');
  const manifest = renderManifest(version, publisher);
  const env = compilerEnvironment();
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'brclio-windows-shell-'));
  try {
    const dll = path.join(temporary, DLL_NAME);
    execute('cl.exe', ['/nologo', '/std:c++17', '/EHsc', '/O2', '/W4', '/WX', '/MT', '/utf-8', '/guard:cf',
      '/DUNICODE', '/D_UNICODE', '/D_WIN32_WINNT=0x0A00', '/LD',
      path.join(native, 'ExplorerCommand.cpp'), `/Fo${path.join(temporary, 'ExplorerCommand.obj')}`,
      '/link', `/DEF:${path.join(native, 'ExplorerCommand.def')}`, `/OUT:${dll}`,
      `/IMPLIB:${path.join(temporary, 'BrclioExplorerCommand.lib')}`,
      '/MACHINE:X64', '/DYNAMICBASE', '/NXCOMPAT', '/GUARD:CF',
      'ole32.lib', 'shell32.lib', 'shlwapi.lib', 'uuid.lib'], { cwd: temporary, env });
    verifyPE(dll);
    const exports = execute('dumpbin.exe', ['/nologo', '/exports', dll], { env });
    if (!/\bDllGetClassObject\b/.test(exports) || !/\bDllCanUnloadNow\b/.test(exports)) throw new Error('COM DLL exports are missing.');
    const dependencies = execute('dumpbin.exe', ['/nologo', '/dependents', dll], { env });
    if (/\b(?:VCRUNTIME\d*|MSVCP\d*|ucrtbase)(?:_\d+)?\.dll\b/i.test(dependencies)) {
      throw new Error('Explorer extension unexpectedly depends on a Visual C++ runtime DLL.');
    }
    const versionDirectory = path.join(output, manifestVersion(version));
    const outputDLL = path.join(versionDirectory, DLL_NAME);
    fs.mkdirSync(versionDirectory, { recursive: true });
    fs.copyFileSync(dll, outputDLL);
    fs.writeFileSync(path.join(output, 'AppxManifest.xml'), manifest);
    fs.writeFileSync(path.join(output, 'VerifyShellSignature.ps1'), `\uFEFF${POWERSHELL_SIGNATURE_FUNCTIONS}`, 'utf8');
    fs.cpSync(path.join(native, 'Assets'), path.join(output, 'Assets'), { recursive: true });
    const identityLayout = path.join(temporary, 'identity');
    fs.mkdirSync(identityLayout);
    fs.writeFileSync(path.join(identityLayout, 'AppxManifest.xml'), manifest);
    const msix = path.join(output, 'BrclioShell.msix');
    // Sparse identity packages deliberately exclude external app/DLL/assets.
    execute(sdkTool('makeappx.exe', env), ['pack', '/d', identityLayout, '/p', msix, '/nv', '/o'], { env });
    const signature = signPackage(msix, outputDLL, publisher, temporary, output, env);
    const report = { version, packageVersion: manifestVersion(version), arch,
      dll: path.win32.join(manifestVersion(version), DLL_NAME),
      sha256: createHash('sha256').update(fs.readFileSync(outputDLL)).digest('hex'),
      packageName: 'Brclio.Toolbox.Shell', publisher, applicationId: 'Brclio',
      clsid: 'CFD1E4D4-3973-45D3-8542-45A77E6C58C9', runtime: 'static', ...signature,
      msix: 'BrclioShell.msix', msixSha256: createHash('sha256').update(fs.readFileSync(msix)).digest('hex') };
    fs.writeFileSync(path.join(output, 'shell-build.json'), `${JSON.stringify(report, null, 2)}\n`);
    return { output, ...report };
  } catch (error) {
    if (error.stderr) process.stderr.write(error.stderr.toString());
    if (error.stdout) process.stderr.write(error.stdout.toString());
    throw error;
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

if (require.main === module) {
  const options = { version: require('../package.json').version,
    output: path.join(native, 'build', 'x64'), arch: 'x64' };
  for (let index = 2; index < process.argv.length; index += 2) {
    const flag = process.argv[index];
    if (!['--arch', '--version', '--output'].includes(flag) || !process.argv[index + 1]) {
      throw new Error('Usage: node scripts/windows-build-shell.cjs [--arch x64] [--version X.Y.Z] [--output DIRECTORY]');
    }
    options[flag.slice(2)] = process.argv[index + 1];
  }
  options.output = path.resolve(options.output);
  console.log(JSON.stringify(build(options)));
}

module.exports = { build, compilerEnvironment, execute, manifestVersion, renderManifest, verifyPE };
