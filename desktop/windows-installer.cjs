'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { createReadStream } = require('node:fs');
const { spawn } = require('node:child_process');

// PowerShell 5.1 silently exits before -File under libuv's DETACHED_PROCESS.
// A normal hidden launcher can run PowerShell, then create the real helper via
// .NET. Grandchildren are outside libuv's kill-on-parent-exit job, so the helper
// survives Brclio quitting without depending on a console window.
const LAUNCHER = String.raw`param([Parameter(Mandatory=$true)][string]$Configuration)
$ErrorActionPreference = 'Stop'
$start = New-Object Diagnostics.ProcessStartInfo
$start.FileName = Join-Path $PSHOME 'powershell.exe'
$helper = Join-Path ([IO.Path]::GetDirectoryName($Configuration)) 'install.ps1'
$start.Arguments = '-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $helper + '" -Configuration "' + $Configuration + '"'
$start.UseShellExecute = $false
$start.CreateNoWindow = $true
[Diagnostics.Process]::Start($start) | Out-Null
`;

// Values travel through a JSON file, never through generated PowerShell source
// or a command shell. The helper lives outside the directory NSIS replaces.
const HELPER = String.raw`param([Parameter(Mandatory=$true)][string]$Configuration)
$ErrorActionPreference = 'Stop'
$cfg = Get-Content -LiteralPath $Configuration -Raw -Encoding UTF8 | ConvertFrom-Json
$work = [IO.Path]::GetDirectoryName($Configuration)
$backups = @()
$registrationBackups = @()
$parentExited = $false
$installerRunning = $false
$installerStarted = $false
$backupReady = $false
$newProcess = $null
$installMode = ''
$launchConfirmed = $false
$phase = 'preparing'

function Write-Report([string]$destination, [hashtable]$report) {
  $report.version = $cfg.version
  $report.completedAt = [DateTime]::UtcNow.ToString('o')
  $temporary = $destination + '.tmp-' + $PID
  [IO.File]::WriteAllText($temporary, ($report | ConvertTo-Json -Depth 6 -Compress), (New-Object Text.UTF8Encoding($false)))
  Move-Item -LiteralPath $temporary -Destination $destination -Force
  if ($destination -eq $cfg.resultPath -and (Test-Path -LiteralPath $work -PathType Container)) {
    [IO.File]::WriteAllText((Join-Path $work 'result.json'), ($report | ConvertTo-Json -Depth 6 -Compress), (New-Object Text.UTF8Encoding($false)))
  }
}

function Assert-Installer {
  # Use .NET directly: a PowerShell 7 parent can pass a PSModulePath that does
  # not expose Windows PowerShell 5.1's Get-FileHash module to this process.
  $stream = [IO.File]::OpenRead($cfg.filename)
  $sha256 = [Security.Cryptography.SHA256]::Create()
  try {
    $length = $stream.Length
    $actual = [BitConverter]::ToString($sha256.ComputeHash($stream)).Replace('-', '').ToLowerInvariant()
  } finally { $sha256.Dispose(); $stream.Dispose() }
  if ($length -ne $cfg.size -or $actual -ne $cfg.expected) {
    throw '安装包已变更，已停止安装。请重新下载。'
  }
}

function Invoke-Native([string]$program, [string[]]$arguments) {
  # reg.exe can print even its success message to stderr. PowerShell 5.1
  # turns redirected stderr into ErrorRecords, so inspect the native exit code
  # without treating that success message as a terminating PowerShell error.
  $ErrorActionPreference = 'Continue'
  $LASTEXITCODE = $null
  & $program @arguments 2>&1 | Out-Null
  if ($null -eq $LASTEXITCODE) { throw ('无法启动更新所需的系统命令：' + [IO.Path]::GetFileName($program)) }
  return $LASTEXITCODE
}

function Save-Menus {
  $relativeKeys = @('Software\Classes\*\shell\Brclio.CopyPath', 'Software\Classes\Directory\shell\Brclio.CopyPath', 'Software\Classes\Directory\Background\shell\Brclio.CopyPath')
  $reg = Join-Path $env:SystemRoot 'System32\reg.exe'
  foreach ($relative in $relativeKeys) {
    $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($relative)
    if ($null -eq $key) { continue }
    try { $owner = $key.GetValue('BrclioOwner') } finally { $key.Dispose() }
    if ($owner -ne 'com.brclio.toolbox') { continue }
    $backup = Join-Path $work ('menu-' + $script:backups.Count + '.reg')
    if ((Invoke-Native $reg @('export', ('HKCU\' + $relative), $backup, '/y')) -ne 0) { throw '无法备份 Brclio 右键菜单，尚未开始安装。' }
    $script:backups += @{ relative = $relative; file = $backup }
  }
}

function Restore-Menus {
  $reg = Join-Path $env:SystemRoot 'System32\reg.exe'
  foreach ($backup in $script:backups) {
    $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($backup.relative)
    if ($null -ne $key) {
      try { $owner = $key.GetValue('BrclioOwner') } finally { $key.Dispose() }
      # Never overwrite a key that another application created meanwhile.
      if ($owner -ne 'com.brclio.toolbox') { continue }
    }
    if ((Invoke-Native $reg @('import', $backup.file)) -ne 0) { throw '安装已结束，但无法恢复 Brclio 右键菜单。请重新启用右键菜单。' }
  }
}

function Save-Installation {
  # electron-builder 26 derives this UUIDv5 from com.brclio.toolbox. Only
  # matching registered installations are eligible; unpacked builds are not.
  $guid = 'c8f079c5-a346-5aee-a72f-5280717e7b26'
  $reg = Join-Path $env:SystemRoot 'System32\reg.exe'
  foreach ($hive in @('HKCU', 'HKLM')) {
    $base = if ($hive -eq 'HKCU') { [Microsoft.Win32.Registry]::CurrentUser } else { [Microsoft.Win32.Registry]::LocalMachine }
    $relative = 'Software\' + $guid
    $key = $base.OpenSubKey($relative)
    if ($null -eq $key) { continue }
    try { $location = $key.GetValue('InstallLocation') } finally { $key.Dispose() }
    if ([string]::IsNullOrWhiteSpace($location) -or -not [string]::Equals($location.TrimEnd('\'), $cfg.installDirectory.TrimEnd('\'), [StringComparison]::OrdinalIgnoreCase)) { continue }
    if ($script:installMode -ne '') { throw '检测到重复的安装记录，请先保留一个 Brclio 安装后重试。' }
    # Refuse before quitting if rollback would need privileges we do not have.
    $writable = $base.OpenSubKey($relative, $true)
    if ($null -eq $writable) { throw '当前安装需要管理员权限。请以管理员身份运行 Brclio 后更新。' }
    $writable.Dispose()
    $script:installMode = if ($hive -eq 'HKCU') { '/currentuser' } else { '/allusers' }
    foreach ($entry in @($relative, ('Software\Microsoft\Windows\CurrentVersion\Uninstall\' + $guid))) {
      $exists = $base.OpenSubKey($entry)
      if ($null -eq $exists) { continue }
      $exists.Dispose()
      $backup = Join-Path $work ('registration-' + $script:registrationBackups.Count + '.reg')
      if ((Invoke-Native $reg @('export', ($hive + '\' + $entry), $backup, '/y')) -ne 0) { throw '无法备份安装记录，尚未开始覆盖安装。' }
      $script:registrationBackups += $backup
    }
  }
  if ($script:installMode -eq '') { throw '当前客户端不是已注册的安装版。请先使用正式安装程序安装 Brclio。' }
  $probe = Join-Path $cfg.installDirectory ('.brclio-write-' + $cfg.token)
  try { [IO.File]::WriteAllText($probe, '') } finally { Remove-Item -LiteralPath $probe -Force -ErrorAction SilentlyContinue }
  $robocopy = Join-Path $env:SystemRoot 'System32\robocopy.exe'
  if ((Invoke-Native $robocopy @($cfg.installDirectory, $cfg.backupDirectory, '/E', '/COPY:DAT', '/DCOPY:DAT', '/R:1', '/W:1', '/XJ', '/NFL', '/NDL', '/NJH', '/NJS', '/NP')) -ge 8) { throw '无法备份当前客户端，尚未开始覆盖安装。请检查可用磁盘空间。' }
  $script:backupReady = $true
}

function Restore-Installation {
  if (-not $script:backupReady -or -not $script:installerStarted) { return }
  if ($null -ne $script:newProcess -and -not $script:newProcess.HasExited) {
    $taskkill = Join-Path $env:SystemRoot 'System32\taskkill.exe'
    Invoke-Native $taskkill @('/PID', $script:newProcess.Id, '/T', '/F') | Out-Null
    $script:newProcess.WaitForExit(10000) | Out-Null
  }
  $robocopy = Join-Path $env:SystemRoot 'System32\robocopy.exe'
  if ((Invoke-Native $robocopy @($cfg.backupDirectory, $cfg.installDirectory, '/MIR', '/COPY:DAT', '/DCOPY:DAT', '/R:1', '/W:1', '/XJ', '/NFL', '/NDL', '/NJH', '/NJS', '/NP')) -ge 8) { throw '无法完整恢复旧版文件。备份仍保留，请关闭 Brclio 后重新安装。' }
  $reg = Join-Path $env:SystemRoot 'System32\reg.exe'
  foreach ($backup in $script:registrationBackups) {
    if ((Invoke-Native $reg @('import', $backup)) -ne 0) { throw '旧版文件已恢复，但安装记录恢复失败。请使用安装程序修复。' }
  }
}

try {
  Assert-Installer
  Save-Menus
  Save-Installation
  $parent = Get-Process -Id $cfg.parentPid -ErrorAction SilentlyContinue
  Write-Report $cfg.readyPath @{ status = 'ready' }
  $commitDeadline = [DateTime]::UtcNow.AddSeconds(30)
  $committed = $false
  while ([DateTime]::UtcNow -lt $commitDeadline) {
    if (Test-Path -LiteralPath $cfg.commitPath -PathType Leaf) {
      $commit = Get-Content -LiteralPath $cfg.commitPath -Raw -Encoding UTF8 | ConvertFrom-Json
      if ($commit.token -eq $cfg.token) { $committed = $true; break }
    }
    Start-Sleep -Milliseconds 100
  }
  if (-not $committed) { throw '更新准备未确认，未开始覆盖安装。' }
  $phase = 'waiting-for-exit'
  if ($null -ne $parent -and -not $parent.WaitForExit(60000)) { throw 'Brclio 尚未退出，未开始覆盖安装。请关闭软件后重试。' }
  $parentExited = $true
  if (Test-Path -LiteralPath (Join-Path $work 'cancel.json')) { throw '已取消更新，未开始覆盖安装。' }
  Assert-Installer
  $phase = 'installing'
  $start = New-Object Diagnostics.ProcessStartInfo
  $start.FileName = $cfg.filename
  # NSIS /D must be last and unquoted, including when the path contains spaces.
  # UseShellExecute=false ensures &, apostrophes and other path text are literal.
  $start.Arguments = '/S --updated --keep-shortcuts ' + $installMode + ' /D=' + $cfg.installDirectory
  $start.UseShellExecute = $false
  $installer = [Diagnostics.Process]::Start($start)
  $installerRunning = $true
  $installerStarted = $true
  if (-not $installer.WaitForExit(900000)) { throw '安装程序仍在运行。请完成或关闭安装程序后重试；当前未确认安装完成。' }
  $installerRunning = $false
  $exitCode = $installer.ExitCode
  if ($exitCode -ne 0) { throw ('安装未完成或已取消（退出码 ' + $exitCode + '）。') }
  $phase = 'verifying-install'
  if (-not (Test-Path -LiteralPath $cfg.executable -PathType Leaf)) { throw '安装程序未生成 Brclio.exe，未确认安装完成。' }
  $version = [Diagnostics.FileVersionInfo]::GetVersionInfo($cfg.executable).ProductVersion
  # electron-builder's PE resource uses four numeric components; app.getVersion
  # later confirms the exact semantic version in the authenticated launch ACK.
  if ($version -notmatch '^\d+\.\d+\.\d+(\.\d+)?$' -or (($version.Split('.')[0..2] -join '.') -ne $cfg.version)) { throw '安装后的版本与下载版本不一致，未确认安装完成。' }
  $phase = 'restoring-menus'
  Restore-Menus
  $phase = 'restarting'
  # Assisted NSIS does not launch in silent mode unless --force-run is passed.
  # Launch here only after exit code, installed version and menus are confirmed.
  # Quote with the Windows command-line rule, not PowerShell source escaping.
  $arguments = '--updated --brclio-update-job "' + $work + '" --brclio-update-token ' + $cfg.token
  $newProcess = Start-Process -FilePath $cfg.executable -ArgumentList $arguments -PassThru
  $deadline = [DateTime]::UtcNow.AddSeconds(90)
  $acknowledged = $false
  while ([DateTime]::UtcNow -lt $deadline) {
    if (Test-Path -LiteralPath $cfg.ackPath -PathType Leaf) {
      $ack = Get-Content -LiteralPath $cfg.ackPath -Raw -Encoding UTF8 | ConvertFrom-Json
      if ($ack.token -eq $cfg.token -and $ack.version -eq $cfg.version -and [string]::Equals($ack.executable, $cfg.executable, [StringComparison]::OrdinalIgnoreCase)) {
        $running = Get-Process -Id $ack.pid -ErrorAction SilentlyContinue
        if ($null -ne $running -and -not $running.HasExited -and [string]::Equals($running.Path, $cfg.executable, [StringComparison]::OrdinalIgnoreCase)) {
          $acknowledged = $true
          break
        }
      }
    }
    Start-Sleep -Milliseconds 200
  }
  if (-not $acknowledged) { throw '新版客户端未确认启动成功，正在恢复旧版。' }
  $launchConfirmed = $true
  $phase = 'complete'
  $report = @{ status = 'installed'; installerExitCode = $exitCode; launchAcknowledged = $true;
    launchedPid = $ack.pid; launchedVersion = $ack.version; launchedExecutable = $running.Path }
  try {
    Remove-Item -LiteralPath $cfg.backupDirectory -Recurse -Force
    foreach ($backup in $backups) { Remove-Item -LiteralPath $backup.file -Force }
    foreach ($backup in $registrationBackups) { Remove-Item -LiteralPath $backup -Force }
  } catch { $report.warning = '更新成功，但旧版备份未能清理；可稍后清理。' }
  # Retain the small private job receipt even if the app consumes its UI report.
  Write-Report $cfg.resultPath $report
} catch {
  $message = $_.Exception.Message
  [Console]::Error.WriteLine($_.ToString())
  [Console]::Error.WriteLine($_.ScriptStackTrace)
  if ($launchConfirmed) {
    # A reporting or cleanup failure must never roll back an acknowledged app.
    try { Write-Report $cfg.resultPath @{ status = 'installed'; launchAcknowledged = $true; warning = $message } } catch { }
    return
  }
  $rollbackSucceeded = -not $installerRunning
  if (-not $installerRunning) {
    try { Restore-Installation } catch { $message += ' ' + $_.Exception.Message; $rollbackSucceeded = $false }
    try { Restore-Menus } catch { $message += ' ' + $_.Exception.Message; $rollbackSucceeded = $false }
  }
  Write-Report $cfg.resultPath @{ status = 'error'; error = $message; phase = $phase; rollbackSucceeded = $rollbackSucceeded; installerStillRunning = $installerRunning }
  if (-not (Test-Path -LiteralPath $cfg.readyPath)) { Write-Report $cfg.readyPath @{ status = 'error'; error = $message } }
  if ($parentExited -and -not $installerRunning -and $rollbackSucceeded -and (Test-Path -LiteralPath $cfg.executable -PathType Leaf)) {
    try { Start-Process -FilePath $cfg.executable -ArgumentList @('--brclio-update-failed') | Out-Null } catch { }
  }
  if ($cfg.showErrors -and $parentExited) {
    try {
      Add-Type -AssemblyName System.Windows.Forms
      [System.Windows.Forms.MessageBox]::Show($message, 'Brclio 更新未完成') | Out-Null
    } catch { }
  }
}
`;

async function digest(filename) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}

function createWindowsInstaller(options) {
  const platform = options.platform || process.platform;
  const execute = options.spawn || spawn;
  const resultPath = path.join(options.userData, 'updates', 'windows-install-result.json');
  const jobsDirectory = path.join(options.userData, 'updates', 'install-jobs');
  let pending;
  let activeJob;
  async function readResult({ consume = false } = {}) {
    let result;
    try {
      const content = await fs.readFile(resultPath, 'utf8');
      if (Buffer.byteLength(content) > 16 * 1024) throw new Error('更新结果文件过大。');
      result = JSON.parse(content);
    } catch (error) {
      if (error.code === 'ENOENT' || error instanceof SyntaxError) return null;
      throw error;
    }
    if (!['installed', 'error'].includes(result.status) || !/^\d+\.\d+\.\d+$/.test(result.version)) return null;
    if (consume) await fs.rm(resultPath, { force: true });
    return result;
  }

  async function cancelPending() {
    if (!activeJob) return { cancellationRequested: false };
    await fs.writeFile(path.join(activeJob.directory, 'cancel.json'), JSON.stringify({ token: activeJob.token }), { mode: 0o600 });
    return { cancellationRequested: true };
  }

  async function acknowledgeLaunch(argv, actualVersion) {
    const jobIndex = argv.indexOf('--brclio-update-job');
    const tokenIndex = argv.indexOf('--brclio-update-token');
    if (jobIndex < 0 && tokenIndex < 0) return null;
    if (jobIndex < 0 || tokenIndex < 0 || argv.filter(value => value === '--brclio-update-job').length !== 1 || argv.filter(value => value === '--brclio-update-token').length !== 1) throw new Error('更新启动参数无效。');
    const job = argv[jobIndex + 1]; const token = argv[tokenIndex + 1];
    if (typeof job !== 'string' || !path.isAbsolute(job) || !/^[a-f0-9]{64}$/.test(token || '') || !/^\d+\.\d+\.\d+$/.test(actualVersion || '')) throw new Error('更新启动参数无效。');
    const resolved = path.resolve(job);
    const equal = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
    if (!equal(path.dirname(resolved), path.resolve(jobsDirectory)) || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(path.basename(resolved))) throw new Error('更新任务不属于当前用户。');
    const stats = await fs.lstat(resolved);
    if (!stats.isDirectory() || stats.isSymbolicLink() || !equal(path.dirname(await fs.realpath(resolved)), await fs.realpath(jobsDirectory))) throw new Error('更新任务位置无效。');
    const configurationPath = path.join(resolved, 'configuration.json');
    const configurationStats = await fs.lstat(configurationPath);
    if (!configurationStats.isFile() || configurationStats.isSymbolicLink()) throw new Error('更新任务配置无效。');
    const source = await fs.readFile(configurationPath, 'utf8');
    if (Buffer.byteLength(source) > 32 * 1024) throw new Error('更新任务配置无效。');
    const configuration = JSON.parse(source);
    if (configuration.token !== token || configuration.version !== actualVersion ||
        !equal(path.win32.resolve(configuration.executable || ''), path.win32.resolve(options.executable)) ||
        !equal(configuration.ackPath || '', path.join(resolved, 'launch-ack.json'))) throw new Error('当前客户端与更新任务不匹配。');
    const existing = await fs.readFile(path.join(resolved, 'launch-ack.json'), 'utf8').then(text => JSON.parse(text), error => { if (error.code === 'ENOENT') return null; throw error; });
    if (existing?.token === token && existing.version === actualVersion && existing.pid === process.pid && equal(existing.executable || '', options.executable)) return { acknowledged: true, version: actualVersion };
    const temporary = path.join(resolved, `launch-ack-${crypto.randomUUID()}.tmp`);
    await fs.writeFile(temporary, JSON.stringify({ token, version: actualVersion, executable: options.executable, pid: process.pid }), { mode: 0o600, flag: 'wx' });
    await fs.rename(temporary, path.join(resolved, 'launch-ack.json'));
    return { acknowledged: true, version: actualVersion };
  }

  function start(verified) {
    if (pending) return pending;
    const operation = (async () => {
      if (platform !== 'win32') throw new Error('自动覆盖安装仅适用于 Windows 客户端。');
      if (!options.executable || !/^[a-z]:[\\/]/i.test(options.executable) || path.win32.basename(options.executable).toLowerCase() !== 'brclio.exe' || /[\x00-\x1f"<>|?*]/.test(options.executable)) {
        throw new Error('无法确定当前 Brclio 安装位置，请重新安装正式版。');
      }
      const installDirectory = path.win32.dirname(options.executable);
      if (installDirectory === path.win32.parse(installDirectory).root) throw new Error('不能向磁盘根目录覆盖安装。');
      const parentPid = options.parentPid || process.pid;
      if (!Number.isSafeInteger(parentPid) || parentPid < 1) throw new Error('当前软件进程无效。');
      if (!verified || !/^\d+\.\d+\.\d+$/.test(verified.version) ||
          !/^[a-f0-9]{64}$/i.test(verified.expected) || !Number.isSafeInteger(verified.size) || verified.size < 1 ||
          typeof verified.filename !== 'string' || !path.isAbsolute(verified.filename) ||
          path.basename(verified.filename) !== `Brclio-${verified.version}-windows-x64.exe`) {
        throw new Error('请先下载并校验官方 Windows 安装包。');
      }
      const stats = await fs.stat(verified.filename);
      if (!stats.isFile() || stats.size !== verified.size || await digest(verified.filename) !== verified.expected.toLowerCase()) {
        throw new Error('安装包已变更，请重新下载。');
      }
      const relativeData = path.win32.relative(installDirectory, options.userData);
      if (process.platform === 'win32' && (!relativeData || (!relativeData.startsWith('..') && !path.win32.isAbsolute(relativeData)))) {
        throw new Error('软件数据目录位于安装目录内，无法安全覆盖。');
      }
      await fs.mkdir(jobsDirectory, { recursive: true, mode: 0o700 });
      const working = path.join(jobsDirectory, crypto.randomUUID());
      await fs.mkdir(working, { mode: 0o700 });
      const helperPath = path.join(working, 'install.ps1');
      const launcherPath = path.join(working, 'launch.ps1');
      const helperLogPath = path.join(working, 'helper-output.log');
      const configurationPath = path.join(working, 'configuration.json');
      const readyPath = path.join(working, 'ready.json');
      const token = crypto.randomBytes(32).toString('hex');
      activeJob = { directory: working, token };
      await fs.writeFile(helperPath, '\uFEFF' + HELPER, { mode: 0o600 });
      await fs.writeFile(launcherPath, '\uFEFF' + LAUNCHER, { mode: 0o600 });
      await fs.writeFile(configurationPath, JSON.stringify({ ...verified, expected: verified.expected.toLowerCase(), executable: options.executable,
        installDirectory, parentPid, resultPath, readyPath, token, ackPath: path.join(working, 'launch-ack.json'),
        commitPath: path.join(working, 'commit.json'),
        backupDirectory: path.join(working, 'previous-app'), showErrors: options.showErrors !== false }), { mode: 0o600 });
      await fs.rm(resultPath, { force: true });
      let child;
      let failure;
      try {
        const powershell = path.win32.join(options.systemRoot || process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
        // The helper survives this process. Give it file handles rather than
        // pipes so startup failures remain inspectable after either app exits.
        // Windows PowerShell reconstructs its own module paths rather than
        // inheriting a possibly incompatible PowerShell 7 module search path.
        const helperEnvironment = Object.fromEntries(Object.entries(process.env).filter(([name]) => name.toLowerCase() !== 'psmodulepath'));
        const helperLog = await fs.open(helperLogPath, 'a', 0o600);
        try {
          child = execute(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', launcherPath, '-Configuration', configurationPath],
            { windowsHide: true, env: helperEnvironment, stdio: ['ignore', helperLog.fd, helperLog.fd] });
          child.once('error', error => { failure = error; });
          child.once('exit', code => { if (code !== 0) failure ||= new Error(`更新助手启动器已退出（${code}），未开始覆盖安装。`); });
        } finally { await helperLog.close(); }
        const deadline = Date.now() + (options.readyTimeout || 120000);
        while (Date.now() < deadline) {
          const ready = await fs.readFile(readyPath, 'utf8').then(text => JSON.parse(text), error => { if (error.code === 'ENOENT') return null; throw error; });
          if (ready?.status === 'error') throw new Error(ready.error || '无法准备自动安装。');
          if (ready?.status === 'ready') {
            const commitTemporary = path.join(working, 'commit.tmp');
            await fs.writeFile(commitTemporary, JSON.stringify({ token }), { mode: 0o600, flag: 'wx' });
            await fs.rename(commitTemporary, path.join(working, 'commit.json'));
            child.unref();
            return { installerStarted: true, automaticInstall: true, resultPath, jobDirectory: working };
          }
          if (failure) throw failure;
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        throw new Error('启动更新助手超时，尚未开始覆盖安装。');
      } catch (error) {
        child?.kill();
        // Preserve any exported menu backups and diagnostic result for recovery.
        // An exit can arrive while a preceding ready-file read still returns
        // ENOENT. Prefer the durable preparation error written before exit.
        const receipt = await fs.readFile(path.join(working, 'result.json'), 'utf8').then(JSON.parse).catch(() => null);
        if (receipt?.status === 'error' && typeof receipt.error === 'string') {
          error = new Error(receipt.error, { cause: error });
          error.helperResult = receipt;
        }
        error.jobDirectory = working;
        error.helperOutput = (await fs.readFile(helperLogPath, 'utf8').catch(() => '')).slice(-16 * 1024);
        throw error;
      }
    })();
    pending = operation;
    operation.catch(() => { if (pending === operation) pending = null; });
    return operation;
  }
  return { start, acknowledgeLaunch, readResult, cancelPending, resultPath };
}

module.exports = { createWindowsInstaller, HELPER, LAUNCHER };
