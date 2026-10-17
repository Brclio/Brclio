'use strict';

const path = require('node:path');
const fs = require('node:fs/promises');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { POWERSHELL_SIGNATURE_FUNCTIONS } = require('./windows-shell-signature.cjs');

const PACKAGE_NAME = 'Brclio.Toolbox.Shell';
const DEFAULT_PUBLISHER = 'CN=Brclio';
const APPLICATION_ID = 'Brclio';
const CLSID = 'CFD1E4D4-3973-45D3-8542-45A77E6C58C9';
const DLL_NAME = 'BrclioExplorerCommand.dll';
const PACKAGE_FILE = 'BrclioShell.msix';
const MENU_LABEL = '复制路径 · Brclio';
const REQUEST_ENV = 'BRCLIO_WINDOWS_SHELL_REQUEST';

// The script is fixed source. All paths and action arguments arrive as JSON in
// the child process environment, never as PowerShell source or shell commands.
// Windows PowerShell 5.1 uses an explicit UTF-8 stream for its JSON response.
const WINDOWS_SHELL_SCRIPT = String.raw`$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
${POWERSHELL_SIGNATURE_FUNCTIONS}
function Write-Result($value) {
  $bytes = [Text.Encoding]::UTF8.GetBytes((ConvertTo-Json -InputObject $value -Depth 10 -Compress))
  $stdout = [Console]::OpenStandardOutput()
  $stdout.Write($bytes, 0, $bytes.Length)
  $stdout.Flush()
}
function Read-Xml($stream) {
  $settings = New-Object System.Xml.XmlReaderSettings
  $settings.DtdProcessing = [System.Xml.DtdProcessing]::Prohibit
  $settings.XmlResolver = $null
  $reader = [System.Xml.XmlReader]::Create($stream, $settings)
  try {
    $document = New-Object System.Xml.XmlDocument
    $document.XmlResolver = $null
    $document.Load($reader)
    return ,$document
  } finally { $reader.Dispose() }
}
function Read-Manifest([string]$location) {
  $stream = [IO.File]::OpenRead($location)
  try { return Read-Xml $stream } finally { $stream.Dispose() }
}
function Read-MsixManifest([string]$location) {
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $archive = [IO.Compression.ZipFile]::OpenRead($location)
  try {
    $entry = $archive.GetEntry('AppxManifest.xml')
    if ($null -eq $entry -or $entry.Length -gt 262144) { throw 'MSIX 中缺少有效的包清单。' }
    $stream = $entry.Open()
    try { return Read-Xml $stream } finally { $stream.Dispose() }
  } finally { $archive.Dispose() }
}
function Certificate-Hash($certificate) {
  $sha = [Security.Cryptography.SHA256]::Create()
  try { return [BitConverter]::ToString($sha.ComputeHash($certificate.RawData)).Replace('-', '') } finally { $sha.Dispose() }
}
function Read-PinnedCertificate([string]$directory, $signature, [string]$publisher) {
  $metadataPath = Join-Path $directory 'shell-build.json'
  $certificatePath = Join-Path $directory 'BrclioShell.cer'
  if (!(Test-Path -LiteralPath $metadataPath -PathType Leaf) -or !(Test-Path -LiteralPath $certificatePath -PathType Leaf)) { return $null }
  $metadata = [IO.File]::ReadAllText($metadataPath) | ConvertFrom-Json
  if ($metadata.selfSigned -ne $true -or $metadata.signed -ne $true -or $metadata.certificateSha256 -notmatch '^[a-fA-F0-9]{64}$') { return $null }
  $certificate = New-Object Security.Cryptography.X509Certificates.X509Certificate2($certificatePath)
  $hash = Certificate-Hash $certificate
  $eku = @($certificate.Extensions | Where-Object { $_.Oid.Value -eq '2.5.29.37' })
  $basic = @($certificate.Extensions | Where-Object { $_.Oid.Value -eq '2.5.29.19' })
  $codeSigning = $eku.Count -eq 1 -and @($eku[0].EnhancedKeyUsages | Where-Object { $_.Value -eq '1.3.6.1.5.5.7.3.3' }).Count -eq 1
  if ($hash -ine $metadata.certificateSha256 -or $certificate.Subject -cne $publisher -or $certificate.Issuer -cne $certificate.Subject -or !$codeSigning -or $basic.Count -ne 1 -or $basic[0].CertificateAuthority -or $certificate.HasPrivateKey -or $certificate.NotBefore -gt [DateTime]::Now -or $certificate.NotAfter -lt [DateTime]::Now -or $null -eq $signature.SignerCertificate -or [Convert]::ToBase64String($certificate.RawData) -cne [Convert]::ToBase64String($signature.SignerCertificate.RawData)) { throw 'Windows 右键扩展的专用签名证书不匹配，请重新安装正式安装包。' }
  return @{ certificate = $certificate; hash = $hash }
}
function Manifest-Info($document) {
  $ns = New-Object System.Xml.XmlNamespaceManager($document.NameTable)
  $ns.AddNamespace('f', 'http://schemas.microsoft.com/appx/manifest/foundation/windows10')
  $ns.AddNamespace('com', 'http://schemas.microsoft.com/appx/manifest/com/windows10')
  $ns.AddNamespace('d4', 'http://schemas.microsoft.com/appx/manifest/desktop/windows10/4')
  $ns.AddNamespace('d5', 'http://schemas.microsoft.com/appx/manifest/desktop/windows10/5')
  $ns.AddNamespace('uap10', 'http://schemas.microsoft.com/appx/manifest/uap/windows10/10')
  $identity = $document.SelectSingleNode('/f:Package/f:Identity', $ns)
  if ($null -eq $identity) { throw '右键扩展缺少包身份。' }
  $name = $identity.GetAttribute('Name')
  $publisher = $identity.GetAttribute('Publisher')
  $version = $identity.GetAttribute('Version')
  $application = $document.SelectSingleNode('/f:Package/f:Applications/f:Application[@Id="Brclio"]', $ns)
  $valid = $name -ceq 'Brclio.Toolbox.Shell' -and $publisher.Length -gt 0 -and $publisher.Length -le 8192 -and $version -match '^\d+\.\d+\.\d+\.\d+$' -and $null -ne $application
  if ($valid) {
    $valid = $application.GetAttribute('Executable') -ieq $request.executableName
    $external = $document.SelectSingleNode('/f:Package/f:Properties/uap10:AllowExternalContent', $ns)
    $valid = $valid -and $null -ne $external -and $external.InnerText -ieq 'true'
    $classes = @($application.SelectNodes('f:Extensions/com:Extension[@Category="windows.comServer"]/com:ComServer/com:SurrogateServer/com:Class', $ns) | Where-Object { $_.GetAttribute('Id').Trim('{}') -ieq 'CFD1E4D4-3973-45D3-8542-45A77E6C58C9' })
    $valid = $valid -and $classes.Count -eq 1
    if ($classes.Count -eq 1) { $valid = $valid -and $classes[0].GetAttribute('Path').Replace('/', '\') -ieq ('resources\windows-shell\' + $version + '\BrclioExplorerCommand.dll') }
    foreach ($type in @('*', 'Directory', 'Directory\Background')) {
      $items = @($application.SelectNodes('f:Extensions/d4:Extension[@Category="windows.fileExplorerContextMenus"]/d4:FileExplorerContextMenus/d5:ItemType', $ns) | Where-Object { $_.GetAttribute('Type') -ceq $type })
      $valid = $valid -and $items.Count -eq 1
      if ($items.Count -eq 1) {
        $verbs = @($items[0].SelectNodes('d5:Verb', $ns) | Where-Object { $_.GetAttribute('Id') -ceq 'BrclioCopyPath' -and $_.GetAttribute('Clsid').Trim('{}') -ieq 'CFD1E4D4-3973-45D3-8542-45A77E6C58C9' })
        $valid = $valid -and $verbs.Count -eq 1
      }
    }
  }
  return @{ valid = [bool]$valid; name = $name; publisher = $publisher; version = $version }
}
function Read-Assets([string]$root) {
  $directory = Join-Path $root 'resources\windows-shell'
  $manifestPath = Join-Path $directory 'AppxManifest.xml'
  $packagePath = Join-Path $directory 'BrclioShell.msix'
  $result = @{ available = $false; publisher = 'CN=Brclio'; version = $null; packagePath = $packagePath; error = $null; needsTrust = $false; certificateThumbprint = $null }
  try {
    if (!(Test-Path -LiteralPath $manifestPath -PathType Leaf)) { throw '请安装包含已签名 Windows 右键扩展的 Brclio 新版安装包。' }
    $manifest = Manifest-Info (Read-Manifest $manifestPath)
    if (!$manifest.valid) { throw 'Windows 右键扩展清单与 Brclio 不匹配，请重新安装已签名的正式安装包。' }
    $result.publisher = $manifest.publisher
    $result.version = $manifest.version
    $dllPath = Join-Path $directory ($manifest.version + '\BrclioExplorerCommand.dll')
    if (!(Test-Path -LiteralPath $dllPath -PathType Leaf) -or !(Test-Path -LiteralPath $packagePath -PathType Leaf)) { throw '请安装包含已签名 Windows 右键扩展的 Brclio 新版安装包。' }
    $signature = Test-BrclioShellSignature $packagePath $manifest.publisher $directory
    $dllSignature = Test-BrclioShellSignature $dllPath $manifest.publisher $directory
    if ($signature.certificateThumbprint -cne $dllSignature.certificateThumbprint) { throw 'Windows 右键扩展 DLL 与 MSIX 签名证书不一致。' }
    if ($signature.pinned) {
      $helperSignature = Test-BrclioShellSignature (Join-Path $directory 'BrclioShellTrust.exe') $manifest.publisher $directory
      if (!$helperSignature.pinned -or $helperSignature.certificateThumbprint -cne $signature.certificateThumbprint) { throw 'Windows 右键扩展的专用证书助手签名不匹配。' }
    }
    $result.certificateThumbprint = $signature.certificateThumbprint
    $result.needsTrust = $signature.needsTrust -or $dllSignature.needsTrust
    $packed = Manifest-Info (Read-MsixManifest $packagePath)
    if (!$packed.valid -or $packed.publisher -cne $manifest.publisher -or $packed.version -cne $manifest.version) { throw 'Windows 右键扩展 MSIX 与安装清单不一致，请重新安装正式安装包。' }
    $result.available = $true
  } catch { $result.error = $_.Exception.Message }
  return $result
}
function Invoke-MachineTrustHelper([string]$operation, [string]$publisher, [string]$thumbprint) {
  if ($operation -notin @('--add', '--remove', '--cleanup')) { throw '无效的 Brclio 专用证书操作。' }
  $directory = Join-Path $request.root 'resources\windows-shell'
  $helper = Join-Path $directory 'BrclioShellTrust.exe'
  $verified = Test-BrclioShellSignature $helper $publisher $directory
  if (!$verified.pinned -or ($thumbprint -and $verified.certificateThumbprint -cne $thumbprint)) { throw 'Windows 右键扩展证书助手未通过专用签名验证。' }
  $arguments = @($operation)
  if ($operation -ne '--cleanup') { $arguments += ('"' + (Join-Path $directory 'BrclioShell.cer') + '"') }
  $parameters = @{ FilePath = $helper; ArgumentList = $arguments; Wait = $true; PassThru = $true }
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  try { $administrator = (New-Object Security.Principal.WindowsPrincipal($identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) }
  finally { $identity.Dispose() }
  if ($administrator) { $parameters.NoNewWindow = $true }
  else { $parameters.Verb = 'RunAs'; $parameters.WindowStyle = 'Hidden' }
  try { $process = Start-Process @parameters }
  catch { throw ('Windows 管理员确认未完成，无法设置 Brclio 专用证书信任：' + $_.Exception.Message) }
  $process.Refresh()
  $code = $process.ExitCode
  $process.Dispose()
  if ($operation -eq '--add' -and $code -eq 10) { return $true }
  if ($code -eq 0) { return $false }
  throw ('Brclio 专用证书助手操作失败（退出代码 ' + $code + '）。')
}
function Owned-MachineMarkers([string]$thumbprint) {
  $parent = 'HKLM:\Software\Brclio\ShellCertificates'
  if (!(Test-Path -LiteralPath $parent)) { return @() }
  return @(Get-ChildItem -LiteralPath $parent | Where-Object {
    $values = Get-ItemProperty -LiteralPath $_.PSPath
    $_.PSChildName -match '^[a-fA-F0-9]{40}$' -and (!$thumbprint -or $_.PSChildName -ieq $thumbprint) -and $values.BrclioOwner -ceq 'com.brclio.toolbox' -and $values.CertificateSha256 -match '^[a-fA-F0-9]{64}$'
  })
}
function Trust-Certificate($assets) {
  if (!$assets.available) { throw $assets.error }
  $directory = Join-Path $request.root 'resources\windows-shell'
  $beforeTrust = Test-BrclioShellSignature $assets.packagePath $assets.publisher $directory
  $signature = Get-AuthenticodeSignature -LiteralPath $assets.packagePath
  $pinned = Read-PinnedCertificate $directory $signature $assets.publisher
  if ($null -eq $pinned) { throw 'Windows 右键扩展缺少有效的专用签名证书。' }
  $certificate = $pinned.certificate
  $store = New-Object Security.Cryptography.X509Certificates.X509Store('TrustedPeople', 'CurrentUser')
  $imported = $false
  $machineImported = $false
  $marker = 'HKCU:\Software\Brclio\ShellCertificates\' + $certificate.Thumbprint
  try {
    $store.Open([Security.Cryptography.X509Certificates.OpenFlags]::ReadWrite)
    $existing = @($store.Certificates.Find([Security.Cryptography.X509Certificates.X509FindType]::FindByThumbprint, $certificate.Thumbprint, $false))
    if ($existing.Count -eq 0) {
      $store.Add($certificate)
      $imported = $true
      New-Item -Path $marker -Force | Out-Null
      New-ItemProperty -LiteralPath $marker -Name 'BrclioOwner' -Value 'com.brclio.toolbox' -PropertyType String -Force | Out-Null
      New-ItemProperty -LiteralPath $marker -Name 'CertificateSha256' -Value $pinned.hash -PropertyType String -Force | Out-Null
      New-ItemProperty -LiteralPath $marker -Name 'Publisher' -Value $certificate.Subject -PropertyType String -Force | Out-Null
    } elseif (@($existing | Where-Object { (Certificate-Hash $_) -ine $pinned.hash }).Count -gt 0) {
      throw '已有同指纹证书与扩展签名不匹配，已保留原有证书。'
    }
    if (!$beforeTrust.machineTrusted) {
      $machineImported = Invoke-MachineTrustHelper '--add' $assets.publisher $certificate.Thumbprint
    }
    # Verify full-file hashes, exact leaf peer trust and WinVerifyTrust
    # integrity before the OS independently validates Add-AppxPackage.
    $verified = Test-BrclioShellSignature $assets.packagePath $assets.publisher $directory
    $verifiedDll = Test-BrclioShellSignature (Join-Path $directory ($assets.version + '\BrclioExplorerCommand.dll')) $assets.publisher $directory
    if (!$verified.trusted -or !$verifiedDll.trusted -or $verified.needsTrust -or $verifiedDll.needsTrust -or $verified.certificateThumbprint -cne $certificate.Thumbprint -or $verifiedDll.certificateThumbprint -cne $certificate.Thumbprint) { throw 'Windows 右键扩展完整性验证失败。' }
  } catch {
    $failure = $_.Exception.Message
    if ($machineImported) {
      try {
        [void](Invoke-MachineTrustHelper '--remove' $assets.publisher $certificate.Thumbprint)
        $after = Test-BrclioShellSignature $assets.packagePath $assets.publisher $directory
        if ($after.machineTrusted) { throw '仍有依赖扩展或无法确认使用状态，已保留本次专用机器证书信任。' }
      } catch { $failure += (' 证书回滚未完成：' + $_.Exception.Message) }
    }
    if ($imported) { $store.Remove($certificate); Remove-Item -LiteralPath $marker -Force -ErrorAction SilentlyContinue }
    throw $failure
  } finally { $store.Close() }
  return @{ currentUserImported = $imported; machineImported = $machineImported }
}
function Package-UsesCertificate($package, [string]$hash) {
  try {
    # Read the signature from the actual registered identity package, not an
    # external MSIX which an installer may already have overwritten.
    Add-Type -AssemblyName System.Security
    $signaturePath = Join-Path $package.InstallLocation 'AppxSignature.p7x'
    $raw = [IO.File]::ReadAllBytes($signaturePath)
    if ($raw.Length -lt 5 -or $raw.Length -gt 1048576 -or [Text.Encoding]::ASCII.GetString($raw, 0, 4) -cne 'PKCX') { return $true }
    $cms = New-Object Security.Cryptography.Pkcs.SignedCms
    $cms.Decode([byte[]]$raw[4..($raw.Length - 1)])
    $cms.CheckSignature($true)
    if ($cms.SignerInfos.Count -ne 1 -or $null -eq $cms.SignerInfos[0].Certificate) { return $true }
    return (Certificate-Hash $cms.SignerInfos[0].Certificate) -ieq $hash
  } catch { return $true }
}
function Remove-OwnedCertificates([string]$onlyThumbprint, [bool]$machineImported) {
  $machineError = $null
  if ((!$onlyThumbprint -or $machineImported) -and @(Owned-MachineMarkers $onlyThumbprint).Count -gt 0) {
    try {
      $operation = '--cleanup'
      if ($onlyThumbprint) { $operation = '--remove' }
      [void](Invoke-MachineTrustHelper $operation $assets.publisher $onlyThumbprint)
      if ($onlyThumbprint) {
        $directory = Join-Path $request.root 'resources\windows-shell'
        $after = Test-BrclioShellSignature (Join-Path $directory 'BrclioShellTrust.exe') $assets.publisher $directory
        if ($after.machineTrusted) { throw '仍有依赖扩展或无法确认使用状态，已保留本次专用机器证书信任。' }
      }
    } catch { $machineError = $_.Exception.Message }
  }
  $parent = 'HKCU:\Software\Brclio\ShellCertificates'
  if (!(Test-Path -LiteralPath $parent)) { if ($machineError) { throw $machineError }; return }
  $packages = @(Get-AppxPackage -ErrorAction Stop)
  $store = New-Object Security.Cryptography.X509Certificates.X509Store('TrustedPeople', 'CurrentUser')
  try {
    $store.Open([Security.Cryptography.X509Certificates.OpenFlags]::ReadWrite)
    foreach ($marker in @(Get-ChildItem -LiteralPath $parent)) {
      $thumbprint = $marker.PSChildName
      if ($thumbprint -notmatch '^[A-Fa-f0-9]{40}$' -or ($onlyThumbprint -and $thumbprint -ine $onlyThumbprint)) { continue }
      $values = Get-ItemProperty -LiteralPath $marker.PSPath
      if ($values.BrclioOwner -cne 'com.brclio.toolbox' -or $values.CertificateSha256 -notmatch '^[A-Fa-f0-9]{64}$' -or !$values.Publisher) { continue }
      $dependent = @($packages | Where-Object { $_.Publisher -ceq $values.Publisher })
      if ($onlyThumbprint) {
        # A previous build can share CN=Brclio while using a different leaf.
        # Reclaim a newly imported leaf only if actual registered signatures
        # confirm none use it. Unknown or unreadable signatures are preserved.
        if (@($dependent | Where-Object { Package-UsesCertificate $_ $values.CertificateSha256 }).Count -gt 0) { throw '无法确认本次导入的证书未被使用，已保留该证书信任。' }
      } elseif ($dependent.Count -gt 0) { continue }
      $certificates = @($store.Certificates.Find([Security.Cryptography.X509Certificates.X509FindType]::FindByThumbprint, $thumbprint, $false))
      foreach ($certificate in $certificates) {
        if ((Certificate-Hash $certificate) -ieq $values.CertificateSha256 -and $certificate.Subject -ceq $values.Publisher) { $store.Remove($certificate) }
      }
      if ($certificates.Count -eq 0 -or @($certificates | Where-Object { (Certificate-Hash $_) -ine $values.CertificateSha256 -or $_.Subject -cne $values.Publisher }).Count -eq 0) { Remove-Item -LiteralPath $marker.PSPath -Force }
    }
  } finally { $store.Close() }
  if ($machineError) { throw $machineError }
}
function Read-Packages([string]$publisher) {
  $manager = New-Object Windows.Management.Deployment.PackageManager
  return @(foreach ($package in @(Get-AppxPackage -Name 'Brclio.Toolbox.Shell' -ErrorAction Stop)) {
    $entry = @{ name = [string]$package.Name; publisher = [string]$package.Publisher; fullName = [string]$package.PackageFullName; version = [string]$package.Version; externalLocation = $null; owned = $false; usable = $false; healthy = $false; rollbackAvailable = $false; error = $null }
    try {
      $manifest = Manifest-Info (Get-AppxPackageManifest -Package $package.PackageFullName -ErrorAction Stop)
      $entry.owned = $package.Name -ceq 'Brclio.Toolbox.Shell' -and $package.Publisher -ceq $publisher -and $manifest.valid -and $manifest.name -ceq $package.Name -and $manifest.publisher -ceq $package.Publisher -and $manifest.version -ceq $entry.version
      # InstallLocation is the small MSIX package, NOT the app installation.
      # EffectiveExternalLocation is the public sparse-package location API.
      $native = $manager.FindPackageForUser('', $package.PackageFullName)
      $entry.healthy = [bool]$native.Status.VerifyIsOK()
      if ($null -ne $native.EffectiveExternalLocation) { $entry.externalLocation = [string]$native.EffectiveExternalLocation.Path }
      if ($entry.owned -and $entry.externalLocation) {
        $entry.usable = (Test-Path -LiteralPath (Join-Path $entry.externalLocation $request.executableName) -PathType Leaf) -and (Test-Path -LiteralPath (Join-Path $entry.externalLocation ('resources\windows-shell\' + $entry.version + '\BrclioExplorerCommand.dll')) -PathType Leaf)
        if ($entry.usable) {
          $old = Read-Assets $entry.externalLocation
          $entry.rollbackAvailable = $old.available -and !$old.needsTrust -and $old.publisher -ceq $publisher -and $old.version -ceq $entry.version
        }
      }
    } catch { $entry.error = $_.Exception.Message }
    $entry
  })
}
try {
  $request = [Environment]::GetEnvironmentVariable('BRCLIO_WINDOWS_SHELL_REQUEST', 'Process') | ConvertFrom-Json
  if ($null -eq $request -or $request.action -notin @('query', 'install', 'remove', 'restore', 'trust', 'removeTrust') -or ![IO.Path]::IsPathRooted($request.root) -or [IO.Path]::GetFileName($request.executableName) -cne $request.executableName) { throw '无效的 Windows 右键扩展请求。' }
  [void][Windows.Management.Deployment.PackageManager, Windows.Management.Deployment, ContentType=WindowsRuntime]
  $assets = Read-Assets $request.root
  $trustImported = $false
  $machineTrustImported = $false
  if ($request.action -eq 'trust') {
    $imported = Trust-Certificate $assets
    $trustImported = $imported.currentUserImported -or $imported.machineImported
    $machineTrustImported = $imported.machineImported
    $assets = Read-Assets $request.root
  } elseif ($request.action -eq 'removeTrust') {
    Remove-OwnedCertificates ([string]$request.thumbprint) ([bool]$request.machineImported)
    $assets = Read-Assets $request.root
  } elseif ($request.action -eq 'remove') {
    $packages = Read-Packages $assets.publisher
    $target = @($packages | Where-Object { $_.fullName -ceq $request.fullName })
    if ($target.Count -gt 0) {
      if ($target.Count -ne 1 -or !$target[0].owned) { throw '发现不属于 Brclio 的同名扩展，已保留原有设置。' }
      Remove-AppxPackage -Package $target[0].fullName -ErrorAction Stop | Out-Null
    }
  } elseif ($request.action -eq 'install' -or $request.action -eq 'restore') {
    $root = $request.root
    if ($request.action -eq 'restore') { $root = [string]$request.restoreRoot }
    $candidate = Read-Assets $root
    if (!$candidate.available -or $candidate.needsTrust -or $candidate.publisher -cne $assets.publisher) { throw '右键扩展尚未通过可信签名和完整性验证。' }
    if ($request.action -eq 'restore' -and $candidate.version -cne $request.restoreVersion) { throw '原有右键扩展安装包已变化，无法恢复注册。' }
    if (@(Read-Packages $assets.publisher | Where-Object { !$_.owned }).Count -gt 0) { throw '发现不属于 Brclio 的同名扩展，已保留原有设置。' }
    Add-AppxPackage -Path $candidate.packagePath -ExternalLocation $root -ForceUpdateFromAnyVersion -ErrorAction Stop | Out-Null
  }
  Write-Result @{ ok = $true; assets = $assets; packages = @(Read-Packages $assets.publisher); trustImported = $trustImported; machineTrustImported = $machineTrustImported }
} catch { Write-Result @{ ok = $false; error = $_.Exception.Message } }
`;

const defaultRun = (executable, args, options) => promisify(execFile)(executable, args, { windowsHide: true, timeout: 60000, maxBuffer: 256 * 1024, ...options });
function sameLocation(left, right) {
  return typeof left === 'string' && typeof right === 'string' && path.win32.resolve(left).toLowerCase() === path.win32.resolve(right).toLowerCase();
}
function parseResult(stdout) {
  if (Buffer.byteLength(stdout || '') > 256 * 1024) throw new Error('Windows 右键扩展状态内容过大。');
  const result = JSON.parse(String(stdout).replace(/^\uFEFF/, ''));
  if (!result || typeof result.ok !== 'boolean') throw new Error('无法读取 Windows 右键扩展状态。');
  if (!result.ok) throw new Error(typeof result.error === 'string' ? result.error : 'Windows 右键扩展操作失败。');
  const { assets, packages } = result;
  if (!assets || typeof assets.available !== 'boolean' || typeof assets.publisher !== 'string' || (assets.version !== null && typeof assets.version !== 'string') || (assets.error !== null && typeof assets.error !== 'string') || (assets.needsTrust !== undefined && typeof assets.needsTrust !== 'boolean') || (assets.certificateThumbprint !== undefined && assets.certificateThumbprint !== null && (typeof assets.certificateThumbprint !== 'string' || !/^[a-fA-F0-9]{40}$/.test(assets.certificateThumbprint))) || ['trustImported', 'machineTrustImported'].some(key => result[key] !== undefined && typeof result[key] !== 'boolean') || !Array.isArray(packages) || packages.length > 32 || packages.some(item => !item || ['name', 'publisher', 'fullName', 'version'].some(key => typeof item[key] !== 'string') || ['owned', 'usable', 'healthy', 'rollbackAvailable'].some(key => typeof item[key] !== 'boolean') || (item.externalLocation !== null && typeof item.externalLocation !== 'string'))) throw new Error('无法读取 Windows 右键扩展状态。');
  return result;
}

function createWindowsShell({ launch, run = defaultRun, powershell = path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') }) {
  let root = launch?.packaged && path.win32.isAbsolute(launch.executable) ? path.win32.dirname(launch.executable) : null;
  const shellLocation = () => root ? path.win32.join(root, 'resources', 'windows-shell') : null;
  async function invoke(action, arguments_ = {}) {
    // WinRT returns canonical long paths. Windows can launch from an 8.3 alias
    // (including RUNNER~1 in TEMP); compare and register that same real root.
    if (process.platform === 'win32') {
      try { root = await fs.realpath(root); }
      catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error; }
    }
    const request = { action, root, executableName: path.win32.basename(launch.executable), ...arguments_ };
    const env = { ...process.env, [REQUEST_ENV]: JSON.stringify(request) };
    for (const key of Object.keys(env)) if (key.toLowerCase() === 'psmodulepath') delete env[key];
    // A large EncodedCommand exceeds Windows' 32,767-character process limit.
    // mkdtemp provides a private directory; the BOM supports PowerShell 5.1.
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'brclio-windows-shell-'));
    try {
      const script = path.join(temporary, 'shell.ps1');
      await fs.writeFile(script, `\uFEFF${WINDOWS_SHELL_SCRIPT}`, { encoding: 'utf8', mode: 0o600 });
      const timeout = action === 'trust' || action === 'removeTrust' ? 240000 : 60000;
      const result = await run(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], { env, timeout });
      return parseResult(result.stdout);
    } finally { await fs.rm(temporary, { recursive: true, force: true }); }
  }
  function snapshot(result) {
    const owned = result.packages.filter(item => item.owned && item.name === PACKAGE_NAME && item.publisher === result.assets.publisher);
    const installed = result.assets.available && !result.assets.needsTrust && owned.some(item => item.usable && item.healthy && item.version === result.assets.version && sameLocation(item.externalLocation, root));
    const conflict = result.packages.some(item => !item.owned);
    const location = shellLocation();
    const dllLocation = result.assets.version ? path.win32.join(location, result.assets.version, DLL_NAME) : location;
    return { installed, supported: true, available: result.assets.available, requiresInstall: !result.assets.available, kind: 'windows-shell-extension', location: dllLocation,
      registered: owned.length > 0, stale: owned.length > 0 && !installed, menuLabel: MENU_LABEL, ...(result.assets.error ? { error: result.assets.error } : {}),
      ...(result.assets.needsTrust ? { needsTrust: true, requiresElevation: true } : {}),
      ...(conflict ? { conflict: true } : {}),
      description: installed ? '已添加 Windows 11 外层右键菜单，可直接选择“复制路径 · Brclio”。如菜单尚未刷新，请重新打开资源管理器或重新登录。'
        : result.assets.error || (conflict ? '发现不属于 Brclio 的同名扩展，已保留原有设置。' : `启用后，“复制路径 · Brclio”会直接显示在 Windows 11 外层右键菜单。${result.assets.needsTrust ? '首次启用或签名证书变化时需要 Windows 管理员授权。' : ''}`) };
  }
  function unavailable() {
    return { installed: false, supported: true, available: false, requiresInstall: true, registered: false, stale: false, kind: 'windows-shell-extension', location: shellLocation(), menuLabel: MENU_LABEL,
      description: '请先安装包含已签名 Windows 右键扩展的 Brclio 正式安装包，开发预览无法添加外层菜单。' };
  }
  async function status() {
    if (!root) return unavailable();
    try { return snapshot(await invoke('query')); }
    catch (error) { return { ...unavailable(), requiresInstall: false, error: error.message, description: `暂时无法读取 Windows 右键扩展状态：${error.message}` }; }
  }
  async function set(enabled) {
    if (typeof enabled !== 'boolean') throw new TypeError('右键集成开关必须为布尔值。');
    if (!root) { if (enabled) throw new Error(unavailable().description); return unavailable(); }
    let before = await invoke('query');
    const owned = before.packages.filter(item => item.owned && item.name === PACKAGE_NAME && item.publisher === before.assets.publisher);
    if (!enabled) {
      for (const item of owned) await invoke('remove', { fullName: item.fullName });
      const after = snapshot(await invoke('removeTrust'));
      if (after.registered) throw new Error('Windows 右键扩展仍处于注册状态，请重试。');
      return after;
    }
    if (!before.assets.available) throw new Error(before.assets.error || '请安装包含已签名 Windows 右键扩展的 Brclio 正式安装包。');
    if (before.packages.some(item => !item.owned)) throw new Error('发现不属于 Brclio 的同名扩展，已保留原有设置。');
    if (snapshot(before).installed) return snapshot(before);
    // Windows cannot re-register the same package version at a new external
    // location. Preserve any usable old install before removing that version.
    const removed = [];
    let importedThumbprint = null;
    let importedMachineTrust = false;
    try {
      if (before.assets.needsTrust) {
        before = await invoke('trust');
        if (before.trustImported) importedThumbprint = before.assets.certificateThumbprint;
        importedMachineTrust = before.machineTrustImported === true;
        if (!before.assets.available || before.assets.needsTrust) throw new Error(before.assets.error || 'Windows 未确认右键扩展签名可信。');
        if (snapshot(before).installed) return snapshot(before);
      }
      if (before.packages.some(item => !item.owned)) throw new Error('发现不属于 Brclio 的同名扩展，已保留原有设置。');
      const replaced = before.packages.filter(item => item.owned && item.name === PACKAGE_NAME && item.publisher === before.assets.publisher && item.version === before.assets.version);
      if (replaced.some(item => item.usable && !item.rollbackAvailable)) throw new Error('原有右键扩展的已签名安装包不可用；为保留当前菜单，请先修复或卸载旧版 Brclio。');
      for (const item of replaced) {
        // Removal may commit before its follow-up query fails. Record the
        // attempt first, then inspect actual state before deciding to restore.
        removed.push(item);
        await invoke('remove', { fullName: item.fullName });
      }
      const after = snapshot(await invoke('install'));
      if (!after.installed) throw new Error('Windows 未确认外层右键菜单注册成功，请重新启用。');
      return after;
    } catch (error) {
      const restore = removed.filter(item => item.usable && item.rollbackAvailable);
      let rollbackError;
      if (restore.length > 0) {
        try {
          const current = await invoke('query');
          const needsRestore = restore.filter(item => !current.packages.some(entry => entry.owned && entry.usable && entry.healthy && entry.publisher === item.publisher && entry.version === item.version && sameLocation(entry.externalLocation, item.externalLocation)));
          if (needsRestore.length > 0) {
            for (const item of current.packages.filter(item => item.owned && item.publisher === before.assets.publisher && item.version === before.assets.version && sameLocation(item.externalLocation, root))) await invoke('remove', { fullName: item.fullName });
            for (const item of needsRestore) {
              const restored = await invoke('restore', { restoreRoot: item.externalLocation, restoreVersion: item.version });
              if (!restored.packages.some(entry => entry.owned && entry.usable && entry.healthy && entry.publisher === item.publisher && entry.version === item.version && sameLocation(entry.externalLocation, item.externalLocation))) throw new Error('Windows 未确认原有扩展恢复成功。');
            }
          }
        } catch (failure) { rollbackError = failure; }
      }
      if (importedThumbprint) {
        try { await invoke('removeTrust', { thumbprint: importedThumbprint, machineImported: importedMachineTrust }); }
        catch (failure) { rollbackError ||= failure; }
      }
      if (rollbackError) throw new Error(`${error.message} 回滚未全部完成：${rollbackError.message}`);
      throw error;
    }
  }
  return { status, set };
}

module.exports = { createWindowsShell, WINDOWS_SHELL_SCRIPT, PACKAGE_NAME, DEFAULT_PUBLISHER, APPLICATION_ID, CLSID, DLL_NAME, PACKAGE_FILE, REQUEST_ENV, sameLocation, parseResult };
