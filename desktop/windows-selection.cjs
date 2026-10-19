'use strict';

const { execFile: nodeExecFile } = require('node:child_process');
const { promisify } = require('node:util');
const path = require('node:path');

const MAX_SELECTION_BYTES = 4 * 1024 * 1024;
const MAX_SELECTED_ITEMS = 1000;
const SELECTION_TIMEOUT = 10000;

// No selected path is inserted into PowerShell source or command arguments.
// Shell.Windows may expose several tabs with the same HWND. Read the visible
// IShellBrowser active view, rather than a tab's cached Document selection.
const WINDOWS_SELECTION_SCRIPT = String.raw`$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class BrclioSelectionWindow {
  [DllImport("user32.dll")]
  public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")]
  public static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  private static extern int GetClassName(IntPtr window, System.Text.StringBuilder text, int maximum);
  public static string WindowClass(IntPtr window) {
    System.Text.StringBuilder text = new System.Text.StringBuilder(128);
    GetClassName(window, text, text.Capacity);
    return text.ToString();
  }
  [DllImport("user32.dll")]
  [return: MarshalAs(UnmanagedType.Bool)]
  public static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll")]
  private static extern IntPtr GetAncestor(IntPtr window, uint flags);
  [DllImport("user32.dll")]
  private static extern bool GetGUIThreadInfo(uint thread, ref GuiThreadInfo info);
  [DllImport("user32.dll")]
  private static extern bool IsChild(IntPtr parent, IntPtr child);
  [StructLayout(LayoutKind.Sequential)]
  private struct Rect { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)]
  private struct GuiThreadInfo {
    public uint Size, Flags;
    public IntPtr Active, Focus, Capture, MenuOwner, MoveSize, Caret;
    public Rect CaretRectangle;
  }

  public static IntPtr GetFocusedWindow(IntPtr foreground) {
    GuiThreadInfo info = new GuiThreadInfo();
    info.Size = (uint)Marshal.SizeOf(typeof(GuiThreadInfo));
    if (!GetGUIThreadInfo(0, ref info) || info.Active != foreground) return IntPtr.Zero;
    return info.Focus;
  }

  public static bool ViewContainsFocus(IntPtr view, IntPtr focus) {
    return focus != IntPtr.Zero && (view == focus || IsChild(view, focus));
  }

  public static bool IsForegroundView(IntPtr view, IntPtr foreground) {
    return IsWindowVisible(view) && GetAncestor(view, 2) == foreground;
  }

  public static object GetActiveFolderView(object window, IntPtr foreground, out long browserNumber, out long viewNumber) {
    browserNumber = 0;
    viewNumber = 0;
    Guid service = new Guid("4C96BE40-915C-11CF-99D3-00AA004AE837");
    Guid browserId = typeof(IShellBrowser).GUID;
    IShellBrowser browser = (IShellBrowser)((IServiceProvider)window).QueryService(ref service, ref browserId);
    IntPtr browserWindow;
    browser.GetWindow(out browserWindow);
    browserNumber = browserWindow.ToInt64();
    if (!IsForegroundView(browserWindow, foreground)) return null;
    IShellView view = browser.QueryActiveShellView();
    IntPtr handle;
    view.GetWindow(out handle);
    viewNumber = handle.ToInt64();
    if (!IsForegroundView(handle, foreground)) return null;
    Guid dispatch = new Guid("00020400-0000-0000-C000-000000000046");
    return view.GetItemObject(0, ref dispatch);
  }

  [ComImport, Guid("6D5140C1-7436-11CE-8034-00AA006009FA"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  private interface IServiceProvider {
    [return: MarshalAs(UnmanagedType.Interface)]
    object QueryService(ref Guid service, ref Guid interfaceId);
  }
  [ComImport, Guid("000214E2-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  private interface IShellBrowser {
    void GetWindow(out IntPtr window);
    void UnusedContextSensitiveHelp();
    void UnusedInsertMenusSB();
    void UnusedSetMenuSB();
    void UnusedRemoveMenusSB();
    void UnusedSetStatusTextSB();
    void UnusedEnableModelessSB();
    void UnusedTranslateAcceleratorSB();
    void UnusedBrowseObject();
    void UnusedGetViewStateStream();
    void UnusedGetControlWindow();
    void UnusedSendControlMsg();
    IShellView QueryActiveShellView();
  }
  [ComImport, Guid("000214E3-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  private interface IShellView {
    void GetWindow(out IntPtr window);
    void UnusedContextSensitiveHelp();
    void UnusedTranslateAccelerator();
    void UnusedEnableModeless();
    void UnusedUIActivate();
    void UnusedRefresh();
    void UnusedCreateViewWindow();
    void UnusedDestroyViewWindow();
    void UnusedGetCurrentInfo();
    void UnusedAddPropertySheetPages();
    void UnusedSaveViewState();
    void UnusedSelectItem();
    [return: MarshalAs(UnmanagedType.IDispatch)]
    object GetItemObject(uint aspect, ref Guid interfaceId);
  }
}
'@
  function Write-ContextDiagnostics([string]$reason, [string]$processName) {
    if ($env:BRCLIO_SELECTION_DIAGNOSTICS -ne '1') { return }
    try {
      $detail = @{ reason = $reason; foreground = $foreground.ToInt64(); foregroundClass = [BrclioSelectionWindow]::WindowClass($foreground); process = $processName }
      $diagnosticBytes = [Text.Encoding]::UTF8.GetBytes((ConvertTo-Json -InputObject $detail -Compress))
      $stderr = [Console]::OpenStandardError()
      $stderr.Write($diagnosticBytes, 0, $diagnosticBytes.Length)
      $stderr.Flush()
    } catch {}
  }
  $foreground = [BrclioSelectionWindow]::GetForegroundWindow()
  if ($foreground -eq [IntPtr]::Zero) { Write-ContextDiagnostics 'missing_foreground' ''; exit 10 }
  [uint32]$foregroundProcessId = 0
  [void][BrclioSelectionWindow]::GetWindowThreadProcessId($foreground, [ref]$foregroundProcessId)
  $foregroundProcess = Get-Process -Id $foregroundProcessId -ErrorAction Stop
  if ($foregroundProcess.ProcessName -ine 'explorer') { Write-ContextDiagnostics 'foreground_not_explorer' $foregroundProcess.ProcessName; exit 10 }
  $focus = [BrclioSelectionWindow]::GetFocusedWindow($foreground)
  $focusRequired = $false
  $foregroundNumber = $foreground.ToInt64() -band [Int64]4294967295
  $shell = New-Object -ComObject Shell.Application
  $windows = $shell.Windows()
  $matchedWindows = 0
  $unreadableMatch = $false
  $views = @{}
  $diagnostics = New-Object 'System.Collections.Generic.List[object]'
  foreach ($window in $windows) {
    try {
      $windowNumber = [Int64]$window.HWND -band [Int64]4294967295
      if ($windowNumber -ne $foregroundNumber) { continue }
      if ([IO.Path]::GetFileName([string]$window.FullName) -ine 'explorer.exe') { continue }
      $matchedWindows += 1
      [Int64]$browserNumber = 0
      [Int64]$viewNumber = 0
      try {
        $folderView = [BrclioSelectionWindow]::GetActiveFolderView($window, $foreground, [ref]$browserNumber, [ref]$viewNumber)
        if ($null -ne $folderView) { $views[[string]$viewNumber] = @{ FolderView = $folderView; Handle = $viewNumber } }
        if ($diagnostics.Count -lt 20) { [void]$diagnostics.Add(@{ window = $windowNumber; browser = $browserNumber; view = $viewNumber; accepted = ($null -ne $folderView); browserVisible = [BrclioSelectionWindow]::IsWindowVisible([IntPtr]$browserNumber); viewVisible = [BrclioSelectionWindow]::IsWindowVisible([IntPtr]$viewNumber); ownsFocus = [BrclioSelectionWindow]::ViewContainsFocus([IntPtr]$viewNumber, $focus) }) }
      } catch {
        $unreadableMatch = $true
        if ($diagnostics.Count -lt 20) { [void]$diagnostics.Add(@{ window = $windowNumber; browser = $browserNumber; view = $viewNumber; error = $_.Exception.Message }) }
      }
    } catch { continue }
  }
  if ($matchedWindows -eq 0) { Write-ContextDiagnostics 'foreground_not_registered' 'explorer'; exit 10 }
  # Windows 11 can retain WS_VISIBLE on background tab panes. Only the pane
  # containing the foreground keyboard focus can disambiguate those views.
  if (-not $unreadableMatch -and $views.Count -gt 1) {
    $focusedViews = @(foreach ($candidate in $views.Values) {
      if ([BrclioSelectionWindow]::ViewContainsFocus([IntPtr]$candidate.Handle, $focus)) { $candidate }
    })
    if ($focusedViews.Count -eq 1) {
      $views = @{ focused = $focusedViews[0] }
      $focusRequired = $true
    }
  }
  if ($unreadableMatch -or $views.Count -ne 1) {
    if ($env:BRCLIO_SELECTION_DIAGNOSTICS -eq '1') {
      try {
        $detail = @{ foreground = $foregroundNumber; focus = $focus.ToInt64(); matchedWindows = $matchedWindows; unreadable = $unreadableMatch; visibleViews = $views.Count; records = @($diagnostics.ToArray()) }
        $diagnosticBytes = [Text.Encoding]::UTF8.GetBytes((ConvertTo-Json -InputObject $detail -Depth 4 -Compress))
        $stderr = [Console]::OpenStandardError()
        $stderr.Write($diagnosticBytes, 0, $diagnosticBytes.Length)
        $stderr.Flush()
      } catch {}
    }
    exit 12
  }
  $activeView = @($views.Values)[0]
  $selected = $activeView.FolderView.SelectedItems()
  if ($null -eq $selected -or $selected.Count -eq 0) { exit 11 }
  if ($selected.Count -gt 1000) { exit 15 }
  $paths = @(
    foreach ($item in $selected) {
      if (-not $item.IsFileSystem) { exit 14 }
      [string]$item.Path
    }
  )
  if ([BrclioSelectionWindow]::GetForegroundWindow() -ne $foreground) { exit 13 }
  if (-not [BrclioSelectionWindow]::IsForegroundView([IntPtr]$activeView.Handle, $foreground)) { exit 13 }
  $finalFocus = [BrclioSelectionWindow]::GetFocusedWindow($foreground)
  if ($finalFocus -ne $focus) { exit 13 }
  if ($focusRequired -and -not [BrclioSelectionWindow]::ViewContainsFocus([IntPtr]$activeView.Handle, $finalFocus)) { exit 13 }
  $bytes = [Text.Encoding]::UTF8.GetBytes((ConvertTo-Json -InputObject $paths -Compress))
  if ($bytes.Length -gt 4194304) { exit 15 }
  $stdout = [Console]::OpenStandardOutput()
  $stdout.Write($bytes, 0, $bytes.Length)
  $stdout.Flush()
} catch { exit 16 }
`;

const FAILURE_MESSAGES = {
  10: '请先切换到资源管理器，并选中要复制路径的文件或文件夹。',
  11: '请先在资源管理器中选中文件或文件夹。',
  12: '无法确认资源管理器当前标签页，请先点击该页中已选中的文件或文件夹后重试。',
  13: '当前窗口已切换，请返回资源管理器后重试。',
  14: '所选项目不是文件或文件夹，无法复制路径。',
  15: '选中的路径过多或内容过大，请减少选择后重试。',
  16: '无法读取资源管理器中选中的路径，请重试。'
};

function isAbsoluteWindowsPath(value) {
  if (/^[A-Za-z]:[\\/]/.test(value)) return true;
  if (/^\\\\\?\\[A-Za-z]:\\/.test(value)) return true;
  const unc = /^\\\\(?:\?\\UNC\\)?([^\\/]+)\\([^\\/]+)(?:[\\/]|$)/i.exec(value);
  return Boolean(unc && !['.', '?'].includes(unc[1]));
}

function parseSelectedPaths(stdout) {
  if (typeof stdout !== 'string') throw new Error(FAILURE_MESSAGES[16]);
  if (Buffer.byteLength(stdout, 'utf8') > MAX_SELECTION_BYTES) throw new Error(FAILURE_MESSAGES[15]);
  let paths;
  try { paths = JSON.parse(stdout); } catch { throw new Error(FAILURE_MESSAGES[16]); }
  if (!Array.isArray(paths)) throw new Error(FAILURE_MESSAGES[16]);
  if (paths.length === 0) throw new Error(FAILURE_MESSAGES[11]);
  if (paths.length > MAX_SELECTED_ITEMS) throw new Error(FAILURE_MESSAGES[15]);
  if (paths.some(value => typeof value !== 'string' || value.length === 0 || /[\u0000-\u001f\u007f-\u009f]/.test(value) || !isAbsoluteWindowsPath(value))) {
    throw new Error('资源管理器返回的路径无效，无法复制。');
  }
  return paths;
}

async function getWindowsSelectedPaths({ execFile = promisify(nodeExecFile), diagnostics = false } = {}) {
  const powershell = path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  let result;
  try {
    result = await execFile(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', Buffer.from(WINDOWS_SELECTION_SCRIPT, 'utf16le').toString('base64')], {
      windowsHide: true,
      encoding: 'utf8',
      timeout: SELECTION_TIMEOUT,
      maxBuffer: MAX_SELECTION_BYTES,
      ...(diagnostics ? { env: { ...process.env, BRCLIO_SELECTION_DIAGNOSTICS: '1' } } : {})
    });
  } catch (error) {
    if (error?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') throw new Error(FAILURE_MESSAGES[15]);
    if (error?.killed || error?.code === 'ETIMEDOUT') throw new Error('读取资源管理器选择超时，请重试。');
    if (error?.code === 'ENOENT') throw new Error('未找到 Windows PowerShell，无法读取资源管理器选择。');
    const failure = new Error(FAILURE_MESSAGES[error?.code] || FAILURE_MESSAGES[16]);
    if (diagnostics && typeof error?.stderr === 'string' && error.stderr.trim()) {
      const detail = error.stderr.slice(0, 16 * 1024);
      try { failure.selectionDiagnostics = JSON.parse(detail); } catch { failure.selectionDiagnostics = detail; }
    }
    throw failure;
  }
  return parseSelectedPaths(result?.stdout);
}

module.exports = { getWindowsSelectedPaths, WINDOWS_SELECTION_SCRIPT };
