param([Parameter(Mandatory=$true)][string]$Configuration)
$ErrorActionPreference = 'Stop'
$work = Split-Path -LiteralPath $Configuration
try {
  $cfg = Get-Content -LiteralPath $Configuration -Raw -Encoding UTF8 | ConvertFrom-Json
  $parent = Get-Process -Id $cfg.parentPid -ErrorAction Stop
  [IO.File]::WriteAllText((Join-Path $work 'ready'), 'ready')
  if (-not $parent.WaitForExit(90000)) { throw 'Downloader did not quit.' }
  if (-not $cfg.existingVersion) {
    $stream = [IO.File]::OpenRead($cfg.filename)
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
      $digest = [BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-', '').ToLowerInvariant()
      if ($digest -cne $cfg.expected -or $stream.Length -ne $cfg.size) { throw 'Installer checksum changed.' }
      $start = New-Object Diagnostics.ProcessStartInfo
      $start.FileName = $cfg.filename
      $start.Arguments = '/S /currentuser'
      $start.UseShellExecute = $false
      $installer = [Diagnostics.Process]::Start($start)
      if (-not $installer.WaitForExit(900000)) { throw 'Installer is still running.' }
      if ($installer.ExitCode -ne 0) { throw "Installer returned exit code $($installer.ExitCode)." }
    } finally { $sha.Dispose(); $stream.Dispose() }
  }
  $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Software\' + $cfg.guid)
  if ($null -eq $key) { throw 'Cannot find the new downloader installation.' }
  try { $location = $key.GetValue('InstallLocation') } finally { $key.Dispose() }
  $exe = Join-Path $location 'Brclio Downloader.exe'
  $actual = [Diagnostics.FileVersionInfo]::GetVersionInfo($exe)
  $expectedVersion = if ($cfg.existingVersion) { $cfg.existingVersion } else { $cfg.version }
  if ($actual.ProductName -cne 'Brclio Downloader' -or ($actual.ProductVersion -ne $expectedVersion -and $actual.ProductVersion -ne ($expectedVersion + '.0'))) { throw 'Installed application identity or version mismatch.' }
  Start-Process -FilePath $exe
  Remove-Item -LiteralPath $work -Force -Recurse
} catch {
  $message = $_.Exception.Message
  [IO.File]::WriteAllText((Join-Path $work 'error.log'), $message)
  Add-Type -AssemblyName System.Windows.Forms
  [void][System.Windows.Forms.MessageBox]::Show($message, 'Brclio Downloader update')
  exit 1
}
