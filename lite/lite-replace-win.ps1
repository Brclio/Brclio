$ErrorActionPreference = 'Stop'
$stage = $PSScriptRoot
$target = $env:BRCLIO_LITE_TARGET
$candidate = $env:BRCLIO_LITE_SOURCE
$backup = Join-Path $stage 'previous.exe'
try {
  $parent = Get-Process -Id ([int]$env:BRCLIO_LITE_PARENT)
  $replace = $env:BRCLIO_LITE_REPLACE -eq 'true'
  if ($replace -and $parent.Path -ine $target) { throw 'The running Lite executable changed.' }
  $before = if ($replace) { (Get-FileHash -Algorithm SHA256 -LiteralPath $target).Hash }
  [IO.File]::WriteAllText((Join-Path $stage 'ready'),'ready')
  if (!$parent.WaitForExit(90000)) { throw 'The old Lite downloader did not exit.' }
  if ((Get-FileHash -Algorithm SHA256 -LiteralPath $candidate).Hash -ine $env:BRCLIO_LITE_SHA) { throw 'The Lite package checksum changed.' }
  if ($replace) {
    if ((Get-FileHash -Algorithm SHA256 -LiteralPath $target).Hash -ine $before) { throw 'The Lite executable changed before replacement.' }
    [IO.File]::Replace($candidate,$target,$backup)
  } elseif ([IO.File]::Exists($target)) {
    if ((Get-FileHash -Algorithm SHA256 -LiteralPath $target).Hash -ine $env:BRCLIO_LITE_SHA) { throw 'A different file occupies the destination.' }
  } else {
    [IO.File]::Move($candidate,$target)
  }
  try { Start-Process -FilePath $target }
  catch {
    if ([IO.File]::Exists($backup)) {
      [IO.File]::Replace($backup,$target,(Join-Path $stage 'failed.exe'))
      Start-Process -FilePath $target
    }
    throw
  }
  Remove-Item -LiteralPath $stage -Recurse -Force
} catch {
  [IO.File]::WriteAllText((Join-Path $stage 'error.log'),$_.Exception.Message)
  Add-Type -AssemblyName System.Windows.Forms
  [void][System.Windows.Forms.MessageBox]::Show($_.Exception.Message,'Brclio Downloader Lite')
  exit 1
}
