'use strict';

// reg.exe emits text in the current Windows code page when redirected. Read
// REG_SZ values directly as Unicode, then write explicit UTF-8 JSON bytes.
// Only these three owned menu locations are queried; no user text enters code.
const QUERY_SCRIPT = String.raw`$ErrorActionPreference = 'Stop'
$relativeKeys = @('Software\Classes\*\shell\Brclio.CopyPath', 'Software\Classes\Directory\shell\Brclio.CopyPath', 'Software\Classes\Directory\Background\shell\Brclio.CopyPath')
function Read-String($key, [string]$name) {
  if ($null -eq $key) { return $null }
  if ($key.GetValueNames() -notcontains $name) { return $null }
  if ($key.GetValueKind($name) -ne [Microsoft.Win32.RegistryValueKind]::String) { return $null }
  return $key.GetValue($name, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
}
$hive = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser, [Microsoft.Win32.RegistryView]::Registry64)
try {
  $records = @(foreach ($relative in $relativeKeys) {
    $key = $hive.OpenSubKey($relative)
    $commandKey = $null
    try {
      if ($null -ne $key) { $commandKey = $key.OpenSubKey('command') }
      @{ key = 'HKCU\' + $relative; exists = ($null -ne $key); owner = (Read-String $key 'BrclioOwner');
        label = (Read-String $key ''); icon = (Read-String $key 'Icon'); model = (Read-String $key 'MultiSelectModel');
        command = (Read-String $commandKey '') }
    } finally {
      if ($null -ne $commandKey) { $commandKey.Dispose() }
      if ($null -ne $key) { $key.Dispose() }
    }
  })
  $bytes = [Text.Encoding]::UTF8.GetBytes((ConvertTo-Json -InputObject $records -Depth 4 -Compress))
  $stdout = [Console]::OpenStandardOutput()
  $stdout.Write($bytes, 0, $bytes.Length)
  $stdout.Flush()
} finally { $hive.Dispose() }
`;

const EXPECTED_KEYS = ['*', 'Directory', 'Directory\\Background'].map(value => `HKCU\\Software\\Classes\\${value}\\shell\\Brclio.CopyPath`);

async function readWindowsEntries(run, powershell) {
  const { stdout } = await run(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(QUERY_SCRIPT, 'utf16le').toString('base64')]);
  if (Buffer.byteLength(stdout) > 256 * 1024) throw new Error('右键菜单注册表内容过大。');
  const entries = JSON.parse(stdout);
  if (!Array.isArray(entries) || entries.length !== 3 || entries.some((item, index) => !item || item.key !== EXPECTED_KEYS[index] || typeof item.exists !== 'boolean' ||
    ['owner', 'label', 'icon', 'model', 'command'].some(key => item[key] !== null && typeof item[key] !== 'string'))) {
    throw new Error('无法读取 Windows 右键菜单配置。');
  }
  return entries;
}

module.exports = { readWindowsEntries, QUERY_SCRIPT };
