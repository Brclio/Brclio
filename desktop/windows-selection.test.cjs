'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const path = require('node:path');
const { getWindowsSelectedPaths, WINDOWS_SELECTION_SCRIPT } = require('./windows-selection.cjs');
const { createWindowsSelectionFixture, SELECTION_FIXTURE_SCRIPT } = require('./windows-selection-smoke.cjs');

const selected = (paths, handler) => getWindowsSelectedPaths({ execFile: async (...args) => {
  if (handler) handler(...args);
  return { stdout: JSON.stringify(paths) };
} });

test('runs a fixed hidden PowerShell command with bounded UTF-8 output', async () => {
  const paths = ['C:\\用户的文件\\报价 & $(no-code) `sample`.txt', "D:\\a b\\O'Reilly.txt", '\\\\server\\共享\\原始.txt'];
  assert.deepEqual(await selected(paths, (program, args, options) => {
    assert.equal(program, path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'));
    assert.deepEqual(args.slice(0, -1), ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand']);
    assert.equal(Buffer.from(args.at(-1), 'base64').toString('utf16le'), WINDOWS_SELECTION_SCRIPT);
    assert.deepEqual(options, { windowsHide: true, encoding: 'utf8', timeout: 10000, maxBuffer: 4 * 1024 * 1024 });
    for (const value of paths) assert.equal(WINDOWS_SELECTION_SCRIPT.includes(value), false);
  }), paths);
});

test('keeps a single selection as an array and preserves path text exactly', async () => {
  const paths = ['C:\\  原始  \\a "quoted" & b.txt'];
  assert.deepEqual(await selected(paths), paths);
  assert.deepEqual(await selected(['C:\\', '\\\\server\\share', '\\\\?\\C:\\very long\\file.txt', '\\\\?\\UNC\\server\\share\\file.txt']), ['C:\\', '\\\\server\\share', '\\\\?\\C:\\very long\\file.txt', '\\\\?\\UNC\\server\\share\\file.txt']);
});

test('rejects malformed output, virtual shell items, relative paths and control characters', async () => {
  for (const stdout of ['not-json', 'null', '{}', '"C:\\\\single.txt"']) {
    await assert.rejects(getWindowsSelectedPaths({ execFile: async () => ({ stdout }) }), /无法读取/);
  }
  for (const value of [null, 7, {}, '', 'relative.txt', 'C:relative.txt', '\\rooted.txt', '/posix/path', '\\\\server', '\\\\.\\PhysicalDrive0', '::{shell-id}', 'C:\\line\nname', 'C:\\tab\tname', 'C:\\nul\0name', 'C:\\delete\u007fname', 'C:\\control\u0085name']) {
    await assert.rejects(selected([value]), /路径无效/, JSON.stringify(value));
  }
  await assert.rejects(getWindowsSelectedPaths({ execFile: async () => ({ stdout: Buffer.from('[]') }) }), /无法读取/);
  await assert.rejects(getWindowsSelectedPaths({ execFile: async () => undefined }), /无法读取/);
});

test('rejects an empty selection and enforces item and byte limits', async () => {
  await assert.rejects(selected([]), /先在资源管理器中选中/);
  const atLimit = Array.from({ length: 1000 }, (_, index) => `C:\\item ${index}.txt`);
  assert.deepEqual(await selected(atLimit), atLimit);
  await assert.rejects(selected([...atLimit, 'C:\\extra.txt']), /过多或内容过大/);
  await assert.rejects(selected(['C:\\' + '中'.repeat(1.4 * 1024 * 1024)]), /过多或内容过大/);
});

test('maps process failures to actionable Chinese messages without returning stderr', async () => {
  const cases = [
    [{ code: 10 }, /先切换到资源管理器/],
    [{ code: 11 }, /先在资源管理器中选中/],
    [{ code: 12 }, /当前标签页/],
    [{ code: 13 }, /当前窗口已切换/],
    [{ code: 14 }, /不是文件或文件夹/],
    [{ code: 15 }, /过多或内容过大/],
    [{ code: 16 }, /无法读取/],
    [{ code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }, /过多或内容过大/],
    [{ code: 'ETIMEDOUT' }, /超时/],
    [{ killed: true }, /超时/],
    [{ code: 'ENOENT' }, /未找到 Windows PowerShell/],
    [{ code: 1 }, /无法读取/]
  ];
  for (const [error, pattern] of cases) {
    const failure = Object.assign(new Error('raw executable error with selected private paths'), error);
    await assert.rejects(getWindowsSelectedPaths({ execFile: async () => { throw failure; } }), result => pattern.test(result.message) && !result.message.includes('private paths'));
  }
});

test('native ambiguity diagnostics are opt-in and keep the user-facing error concise', async () => {
  const detail = { matchedWindows: 2, visibleViews: 0, unreadable: true, records: [{ browser: 12, error: 'COM failure' }] };
  const failure = Object.assign(new Error('process failure'), { code: 12, stderr: JSON.stringify(detail) });
  await assert.rejects(getWindowsSelectedPaths({ execFile: async () => { throw failure; } }), error => error.selectionDiagnostics === undefined && /当前标签页/.test(error.message));
  await assert.rejects(getWindowsSelectedPaths({ diagnostics: true, execFile: async (_program, _args, options) => {
    assert.equal(options.env.BRCLIO_SELECTION_DIAGNOSTICS, '1');
    throw failure;
  } }), error => {
    assert.deepEqual(error.selectionDiagnostics, detail);
    return /当前标签页/.test(error.message) && !error.message.includes('COM failure');
  });
});

test('missing foreground diagnostics preserve the refusal and contain no selected paths', async () => {
  const detail = {reason:'foreground_not_explorer',foreground:12,foregroundClass:'ApplicationFrameWindow',process:'WWAHost'};
  const error = Object.assign(new Error('raw process failure'), {code:10,stderr:JSON.stringify(detail)});
  await assert.rejects(getWindowsSelectedPaths({diagnostics:true,execFile:async()=>{throw error;}}),failure=>{
    assert.match(failure.message,/先切换到资源管理器/);assert.deepEqual(failure.selectionDiagnostics,detail);return true;
  });
  assert.match(WINDOWS_SELECTION_SCRIPT,/Write-ContextDiagnostics 'foreground_not_explorer'/);
  assert.match(WINDOWS_SELECTION_SCRIPT,/Write-ContextDiagnostics 'foreground_not_registered'/);
  assert.match(WINDOWS_SELECTION_SCRIPT,/if \(\$env:BRCLIO_SELECTION_DIAGNOSTICS -ne '1'\) \{ return \}/);
  assert.match(WINDOWS_SELECTION_SCRIPT,/foregroundClass = \[BrclioSelectionWindow\]::WindowClass/);
  assert.doesNotMatch(WINDOWS_SELECTION_SCRIPT.match(/function Write-ContextDiagnostics[\s\S]*?\n  \}/)[0],/SelectedItems|\.Path|Folder/);
});

test('script queries the visible active Shell view and rechecks its focus instead of trusting a tab Document', () => {
  assert.match(WINDOWS_SELECTION_SCRIPT, /GetWindowThreadProcessId/);
  assert.match(WINDOWS_SELECTION_SCRIPT, /ProcessName -ine 'explorer'/);
  assert.match(WINDOWS_SELECTION_SCRIPT, /\$windowNumber -ne \$foregroundNumber/);
  assert.match(WINDOWS_SELECTION_SCRIPT, /browser\.QueryActiveShellView\(\)/);
  assert.ok(WINDOWS_SELECTION_SCRIPT.indexOf('if (!IsForegroundView(browserWindow, foreground)) return null;') < WINDOWS_SELECTION_SCRIPT.indexOf('browser.QueryActiveShellView()'));
  assert.match(WINDOWS_SELECTION_SCRIPT, /view\.GetItemObject\(0, ref dispatch\)/);
  assert.match(WINDOWS_SELECTION_SCRIPT, /IsWindowVisible\(view\) && GetAncestor\(view, 2\) == foreground/);
  assert.match(WINDOWS_SELECTION_SCRIPT, /GetGUIThreadInfo\(0, ref info\).*info.Active != foreground/);
  assert.match(WINDOWS_SELECTION_SCRIPT, /view == focus \|\| IsChild\(view, focus\)/);
  assert.match(WINDOWS_SELECTION_SCRIPT, /\$focusedViews.Count -eq 1/);
  assert.match(WINDOWS_SELECTION_SCRIPT, /\$finalFocus -ne \$focus/);
  assert.match(WINDOWS_SELECTION_SCRIPT, /\$unreadableMatch -or \$views.Count -ne 1\) \{/);
  assert.match(WINDOWS_SELECTION_SCRIPT, /exit 12\n  \}/);
  assert.match(WINDOWS_SELECTION_SCRIPT, /FolderView\.SelectedItems\(\)/);
  assert.match(WINDOWS_SELECTION_SCRIPT, /\$selected\.Count -eq 0\) \{ exit 11 \}/);
  assert.match(WINDOWS_SELECTION_SCRIPT, /GetForegroundWindow\(\) -ne \$foreground\) \{ exit 13 \}/);
  assert.match(WINDOWS_SELECTION_SCRIPT, /IsForegroundView\(\[IntPtr\]\$activeView.Handle, \$foreground\)\) \{ exit 13 \}/);
  assert.match(WINDOWS_SELECTION_SCRIPT, /if \(-not \$item.IsFileSystem\) \{ exit 14 \}/);
  assert.match(WINDOWS_SELECTION_SCRIPT, /ConvertTo-Json -InputObject \$paths -Compress/);
  assert.match(WINDOWS_SELECTION_SCRIPT, /\[Text.Encoding\]::UTF8.GetBytes/);
  assert.doesNotMatch(WINDOWS_SELECTION_SCRIPT, /Document|Folder\.Self|Invoke-Expression|SetForegroundWindow|Start-Process|Set-Clipboard/);
});

test('Explorer fixture refuses an unapproved machine before opening any window', async () => {
  if (process.platform === 'win32' && process.env.CI === 'true' && process.env.BRCLIO_ALLOW_SELECTION_SMOKE === '1') return;
  await assert.rejects(createWindowsSelectionFixture(), /opted-in disposable Windows CI/);
});

test('fixed scripts parse and their native interop types compile in Windows PowerShell without automating Explorer', { skip: process.platform !== 'win32' }, async () => {
  const powershell = path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  for (const script of [WINDOWS_SELECTION_SCRIPT, SELECTION_FIXTURE_SCRIPT]) {
    const encodedScript = Buffer.from(script, 'utf16le').toString('base64');
    const nativeSource = script.match(/Add-Type -TypeDefinition @'\n([\s\S]*?)\n'@/)[1];
    const encodedNative = Buffer.from(nativeSource, 'utf16le').toString('base64');
    const parseScript = "$ErrorActionPreference = 'Stop'; [void][ScriptBlock]::Create([Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($env:BRCLIO_TEST_SCRIPT))); Add-Type -TypeDefinition ([Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($env:BRCLIO_TEST_NATIVE_SOURCE)))";
    assert.ok(encodedScript.length < 32000, 'Windows CreateProcess command-line length must remain bounded');
    await promisify(execFile)(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', Buffer.from(parseScript, 'utf16le').toString('base64')], {
      windowsHide: true, timeout: 10000,
      env: { ...process.env, BRCLIO_TEST_SCRIPT: encodedScript, BRCLIO_TEST_NATIVE_SOURCE: encodedNative }
    });
  }
});
