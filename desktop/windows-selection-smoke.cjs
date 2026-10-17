'use strict';

// Real Explorer fixture, explicitly restricted to opted-in disposable CI.
// It opens only unique temporary folders and closes only its fixture windows.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { getWindowsSelectedPaths } = require('./windows-selection.cjs');

const REQUEST_ENV = 'BRCLIO_SELECTION_FIXTURE_REQUEST';
const run = promisify(execFile);
const SHORTCUT_KEYS = { 'Alt+P': '%p', 'Ctrl+Alt+Shift+P': '^%+p' };

const SELECTION_FIXTURE_SCRIPT = String.raw`$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class BrclioExplorerFixture {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr window);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr window, int command);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr window);
}
'@
$request = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:BRCLIO_SELECTION_FIXTURE_REQUEST)) | ConvertFrom-Json
$shell = New-Object -ComObject Shell.Application
function Same-Path([string]$left, [string]$right) {
  return [string]::Equals($left.TrimEnd('\'), $right.TrimEnd('\'), [StringComparison]::OrdinalIgnoreCase)
}
function Window-Handle($window) { return [IntPtr]([Int64]$window.HWND -band [Int64]4294967295) }
function Find-FixtureView([string]$directory) {
  $found = @(foreach ($window in $shell.Windows()) {
    try { if (Same-Path ([string]$window.Document.Folder.Self.Path) $directory) { $window } } catch {}
  })
  return ,$found
}
function Activate-View($window) {
  $handle = Window-Handle $window
  [void][BrclioExplorerFixture]::ShowWindow($handle, 9)
  for ($attempt = 0; $attempt -lt 20; $attempt++) {
    [void][BrclioExplorerFixture]::SetForegroundWindow($handle)
    if ([BrclioExplorerFixture]::GetForegroundWindow() -eq $handle) { return }
    Start-Sleep -Milliseconds 100
  }
  throw 'Windows did not allow activating the isolated Explorer fixture.'
}
function Select-FixtureItems($window, $paths) {
  if ($paths.Count -eq 0) { return }
  $first = $true
  foreach ($filePath in $paths) {
    $item = $window.Document.Folder.ParseName([IO.Path]::GetFileName([string]$filePath))
    if ($null -eq $item -or -not (Same-Path ([string]$item.Path) ([string]$filePath))) { throw 'Fixture file was not found in Explorer.' }
    $flags = 1
    if ($first) { $flags = 29; $first = $false }
    $window.Document.SelectItem($item, $flags)
  }
  for ($attempt = 0; $attempt -lt 30; $attempt++) {
    $actual = @(foreach ($selectedItem in $window.Document.SelectedItems()) { [string]$selectedItem.Path })
    $matches = ($actual.Count -eq $paths.Count)
    foreach ($expected in $paths) { if ($actual -notcontains [string]$expected) { $matches = $false } }
    if ($matches) { return }
    Start-Sleep -Milliseconds 100
  }
  throw 'Explorer did not apply the fixture selection.'
}
function Identity($window) {
  $pointer = [Runtime.InteropServices.Marshal]::GetIUnknownForObject($window)
  try { return $pointer.ToInt64() } finally { [void][Runtime.InteropServices.Marshal]::Release($pointer) }
}
$result = $null
switch ($request.action) {
  'inspect' {
    $foreground = [BrclioExplorerFixture]::GetForegroundWindow()
    [uint32]$foregroundProcessId = 0
    [void][BrclioExplorerFixture]::GetWindowThreadProcessId($foreground, [ref]$foregroundProcessId)
    $processName = $null
    if ($foregroundProcessId -ne 0) { $processName = (Get-Process -Id $foregroundProcessId).ProcessName }
    $system = Get-CimInstance Win32_OperatingSystem
    $result = @{ originalWindow = $foreground.ToInt64(); originalProcess = $processName; build = [int]$system.BuildNumber; productType = [int]$system.ProductType; sessionId = [Diagnostics.Process]::GetCurrentProcess().SessionId }
  }
  'activate' {
    $views = Find-FixtureView $request.directory
    if ($views.Count -eq 0) {
      $shell.Explore([string]$request.directory)
      for ($attempt = 0; $attempt -lt 100; $attempt++) {
        Start-Sleep -Milliseconds 100
        $views = Find-FixtureView $request.directory
        if ($views.Count -gt 0) { break }
      }
    }
    if ($views.Count -ne 1) { throw 'Could not identify a unique temporary Explorer window.' }
    Select-FixtureItems $views[0] @($request.paths)
    Activate-View $views[0]
    $result = @{ window = (Window-Handle $views[0]).ToInt64() }
  }
  'press' {
    if (@('%p', '^%+p') -notcontains [string]$request.keys) { throw 'Unsupported fixture shortcut.' }
    $keyboard = New-Object -ComObject WScript.Shell
    $keyboard.SendKeys([string]$request.keys)
    Start-Sleep -Milliseconds 200
    $result = @{ pressed = $true }
  }
  'createTab' {
    $views = Find-FixtureView $request.firstDirectory
    if ($views.Count -ne 1) { throw 'Could not find the initial Explorer fixture for tab testing.' }
    $window = $views[0]
    Activate-View $window
    $handle = Window-Handle $window
    $before = @(foreach ($candidate in $shell.Windows()) { if ((Window-Handle $candidate) -eq $handle) { Identity $candidate } })
    $keyboard = New-Object -ComObject WScript.Shell
    $keyboard.SendKeys('^t')
    $tabs = @()
    for ($attempt = 0; $attempt -lt 100; $attempt++) {
      Start-Sleep -Milliseconds 100
      $tabs = @(foreach ($candidate in $shell.Windows()) {
        if ((Window-Handle $candidate) -eq $handle -and $before -notcontains (Identity $candidate)) { $candidate }
      })
      if ($tabs.Count -gt 0) { break }
    }
    if ($tabs.Count -ne 1) { throw 'Windows 11 did not expose the newly created fixture tab through Shell.Windows.' }
    $tab = $tabs[0]
    $tab.Navigate2([string]$request.directory)
    $loaded = $false
    for ($attempt = 0; $attempt -lt 100; $attempt++) {
      Start-Sleep -Milliseconds 100
      try { if (Same-Path ([string]$tab.Document.Folder.Self.Path) ([string]$request.directory)) { $loaded = $true; break } } catch {}
    }
    if (-not $loaded) { throw 'The new fixture tab did not navigate to its temporary folder.' }
    Select-FixtureItems $tab @($request.paths)
    Activate-View $tab
    $result = @{ window = $handle.ToInt64(); tabs = $before.Count + 1 }
  }
  'previousTab' {
    $handle = [IntPtr][Int64]$request.window
    [void][BrclioExplorerFixture]::SetForegroundWindow($handle)
    if ([BrclioExplorerFixture]::GetForegroundWindow() -ne $handle) { throw 'Fixture Explorer lost focus before tab switching.' }
    $keyboard = New-Object -ComObject WScript.Shell
    $keyboard.SendKeys('^+{TAB}')
    Start-Sleep -Milliseconds 300
    $result = @{ switched = $true }
  }
  'restoreForeground' {
    $handle = [IntPtr][Int64]$request.originalWindow
    if (-not [BrclioExplorerFixture]::IsWindow($handle)) { throw 'Original foreground window no longer exists.' }
    [void][BrclioExplorerFixture]::SetForegroundWindow($handle)
    if ([BrclioExplorerFixture]::GetForegroundWindow() -ne $handle) { throw 'Original foreground window could not be restored.' }
    $result = @{ restored = $true }
  }
  'cleanup' {
    foreach ($window in @($shell.Windows())) {
      try {
        $number = (Window-Handle $window).ToInt64()
        $directory = [string]$window.Document.Folder.Self.Path
        $ownedPath = $directory.StartsWith(([string]$request.root).TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)
        if ($request.windows -contains $number -or $ownedPath) { $window.Quit() }
      } catch {}
    }
    $original = [IntPtr][Int64]$request.originalWindow
    if ([BrclioExplorerFixture]::IsWindow($original)) { [void][BrclioExplorerFixture]::SetForegroundWindow($original) }
    $result = @{ cleaned = $true }
  }
  default { throw 'Unknown Explorer fixture action.' }
}
$bytes = [Text.Encoding]::UTF8.GetBytes((ConvertTo-Json -InputObject $result -Compress))
$stdout = [Console]::OpenStandardOutput()
$stdout.Write($bytes, 0, $bytes.Length)
$stdout.Flush()
`;

async function createWindowsSelectionFixture() {
  if (process.platform !== 'win32' || process.env.CI !== 'true' || process.env.BRCLIO_ALLOW_SELECTION_SMOKE !== '1') {
    throw new Error('Real Explorer selection verification requires an opted-in disposable Windows CI runner (CI=true, BRCLIO_ALLOW_SELECTION_SMOKE=1).');
  }
  const powershell = path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const execute = async request => {
    const { stdout } = await run(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', Buffer.from(SELECTION_FIXTURE_SCRIPT, 'utf16le').toString('base64')], {
      windowsHide: true, encoding: 'utf8', timeout: 35000, maxBuffer: 256 * 1024,
      env: { ...process.env, [REQUEST_ENV]: Buffer.from(JSON.stringify(request), 'utf8').toString('base64') }
    });
    return JSON.parse(stdout);
  };
  const metadata = await execute({ action: 'inspect' });
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'Brclio Explorer selection '));
  const directories = { first: path.join(root, 'first 中文 & literal'), second: path.join(root, 'second 独立选择'), empty: path.join(root, 'empty 未选择') };
  const selectedFolder = path.join(directories.first, '选中文件夹 folder');
  const paths = {
    first: [path.join(directories.first, "用户's & $(literal) `文件`.txt"), path.join(directories.first, '第二个 spaced 文件.txt'), selectedFolder],
    second: [path.join(directories.second, 'background 不应误复制.txt')],
    empty: []
  };
  const windows = new Set();
  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) return;
    try { await execute({ action: 'cleanup', root, windows: [...windows], originalWindow: metadata.originalWindow }); }
    finally { await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); cleaned = true; }
  };
  try {
    await Promise.all(Object.values(directories).map(directory => fs.mkdir(directory)));
    await fs.mkdir(selectedFolder);
    await Promise.all([...paths.first.filter(filename => filename !== selectedFolder), ...paths.second].map(filename => fs.writeFile(filename, 'isolated Explorer selection fixture\n')));
  } catch (error) { await cleanup(); throw error; }
  return {
    paths, metadata,
    async activate(name) {
      if (!Object.hasOwn(directories, name)) throw new Error('Unknown Explorer fixture view.');
      const result = await execute({ action: 'activate', directory: directories[name], paths: paths[name] });
      windows.add(result.window);
      return result;
    },
    async pressShortcut(accelerator) {
      if (!Object.hasOwn(SHORTCUT_KEYS, accelerator)) throw new Error('Unsupported Explorer fixture shortcut.');
      return execute({ action: 'press', keys: SHORTCUT_KEYS[accelerator] });
    },
    async createTab() {
      const result = await execute({ action: 'createTab', firstDirectory: directories.first, directory: directories.second, paths: paths.second });
      windows.add(result.window);
      return result;
    },
    previousTab: window => execute({ action: 'previousTab', window }),
    restoreForeground: () => execute({ action: 'restoreForeground', originalWindow: metadata.originalWindow }),
    cleanup
  };
}

async function main() {
  const reportPath = path.join(__dirname, '..', 'artifacts', 'windows-selection-smoke.json');
  const report = { platform: process.platform, realExplorer: true, checks: [], passed: false };
  let fixture;
  try {
    fixture = await createWindowsSelectionFixture();
    report.environment = fixture.metadata;
    const equalPaths = (actual, expected) => assert.deepEqual([...actual].sort(), [...expected].sort());
    await fixture.activate('first');
    equalPaths(await getWindowsSelectedPaths(), fixture.paths.first);
    report.checks.push('foreground Unicode and literal-symbol file-and-folder multi-selection');
    await fixture.activate('second');
    equalPaths(await getWindowsSelectedPaths(), fixture.paths.second);
    report.checks.push('foreground single-selection excludes saved background-window selection');
    await fixture.activate('empty');
    await assert.rejects(getWindowsSelectedPaths(), /先在资源管理器中选中/);
    report.checks.push('empty selection rejects instead of copying the current folder');
    if (fixture.metadata.originalWindow && fixture.metadata.originalProcess !== 'explorer') {
      await fixture.restoreForeground();
      await assert.rejects(getWindowsSelectedPaths(), /先切换到资源管理器/);
      report.checks.push('non-Explorer foreground rejects saved background-window selection');
    }
    if (fixture.metadata.productType === 1 && fixture.metadata.build >= 22621) {
      const tab = await fixture.createTab();
      equalPaths(await getWindowsSelectedPaths(), fixture.paths.second);
      await fixture.previousTab(tab.window);
      equalPaths(await getWindowsSelectedPaths(), fixture.paths.first);
      report.checks.push('Windows 11 active-tab selection and switching exclude hidden-tab selection');
      report.windows11Tabs = 'passed';
    } else {
      report.windows11Tabs = 'not exercised: this runner is not client Windows 11 with Explorer tabs';
    }
    report.passed = true;
  } catch (error) {
    report.error = error.message;
    throw error;
  } finally {
    try { if (fixture) await fixture.cleanup(); }
    catch (error) { report.passed = false; report.cleanupError = error.message; throw error; }
    finally { await fs.mkdir(path.dirname(reportPath), { recursive: true }); await fs.writeFile(reportPath, JSON.stringify(report, null, 2) + '\n'); }
  }
  console.log(`PASS real Explorer selection: ${report.checks.join('; ')}. Report: ${reportPath}`);
}

module.exports = { createWindowsSelectionFixture, SELECTION_FIXTURE_SCRIPT };
if (require.main === module) main().catch(error => { console.error(error.stack); process.exitCode = 1; });
