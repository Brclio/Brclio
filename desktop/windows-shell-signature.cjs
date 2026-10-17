'use strict';

// Shared by runtime registration, updater rollback and Windows build smoke.
// Peer trust is intentionally limited to the exact bundled non-CA leaf in
// CurrentUser\TrustedPeople. It never changes a Root store or Windows policy.
const POWERSHELL_SIGNATURE_FUNCTIONS = String.raw`function Initialize-BrclioShellWinTrust {
  if ('Brclio.WindowsShell.WinTrust' -as [type]) { return }
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
namespace Brclio.WindowsShell {
  public static class WinTrust {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct FileInfo {
      public UInt32 cbStruct;
      [MarshalAs(UnmanagedType.LPWStr)] public string filePath;
      public IntPtr fileHandle;
      public IntPtr knownSubject;
    }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct TrustData {
      public UInt32 cbStruct;
      public IntPtr policyCallback;
      public IntPtr sipClient;
      public UInt32 uiChoice;
      public UInt32 revocationChecks;
      public UInt32 unionChoice;
      public IntPtr fileInfo;
      public UInt32 stateAction;
      public IntPtr stateData;
      public IntPtr urlReference;
      public UInt32 providerFlags;
      public UInt32 uiContext;
      public IntPtr signatureSettings;
    }
    [DllImport("wintrust.dll", ExactSpelling = true)]
    private static extern Int32 WinVerifyTrust(IntPtr window, [In] ref Guid action, [In, Out] ref TrustData data);
    public static UInt32 Verify(string path) {
      FileInfo file = new FileInfo();
      file.cbStruct = (UInt32)Marshal.SizeOf(typeof(FileInfo));
      file.filePath = path;
      file.fileHandle = IntPtr.Zero;
      file.knownSubject = IntPtr.Zero;
      IntPtr pointer = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(FileInfo)));
      bool marshaled = false;
      try {
        Marshal.StructureToPtr(file, pointer, false);
        marshaled = true;
        TrustData data = new TrustData();
        data.cbStruct = (UInt32)Marshal.SizeOf(typeof(TrustData));
        data.policyCallback = IntPtr.Zero;
        data.sipClient = IntPtr.Zero;
        data.uiChoice = 2;             // WTD_UI_NONE
        data.revocationChecks = 0;     // WTD_REVOKE_NONE
        data.unionChoice = 1;          // WTD_CHOICE_FILE
        data.fileInfo = pointer;
        data.stateAction = 1;          // WTD_STATEACTION_VERIFY
        data.stateData = IntPtr.Zero;
        data.urlReference = IntPtr.Zero;
        data.providerFlags = 0x1000;   // WTD_CACHE_ONLY_URL_RETRIEVAL
        data.uiContext = 0;
        data.signatureSettings = IntPtr.Zero;
        Guid action = new Guid("00AAC56B-CD44-11D0-8CC2-00C04FC295EE");
        try {
          return unchecked((UInt32)WinVerifyTrust(new IntPtr(-1), ref action, ref data));
        } finally {
          data.stateAction = 2;        // WTD_STATEACTION_CLOSE
          WinVerifyTrust(new IntPtr(-1), ref action, ref data);
        }
      } finally {
        if (marshaled) Marshal.DestroyStructure(pointer, typeof(FileInfo));
        Marshal.FreeHGlobal(pointer);
      }
    }
  }
}
'@
}
function Get-BrclioShellCertificateHash($certificate) {
  $sha = [Security.Cryptography.SHA256]::Create()
  try { return [BitConverter]::ToString($sha.ComputeHash($certificate.RawData)).Replace('-', '') } finally { $sha.Dispose() }
}
function Get-BrclioShellFileHash([string]$path) {
  $stream = [IO.File]::OpenRead($path)
  $sha = [Security.Cryptography.SHA256]::Create()
  try { return [BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-', '') }
  finally { $sha.Dispose(); $stream.Dispose() }
}
function Test-BrclioShellSignature([string]$Path, [string]$Publisher, [string]$Directory) {
  $signature = Get-AuthenticodeSignature -LiteralPath $Path
  if ($null -eq $signature.SignerCertificate -or $signature.SignerCertificate.Subject -cne $Publisher) { throw 'Windows 右键扩展签名与包发布者不匹配。' }
  $metadataPath = Join-Path $Directory 'shell-build.json'
  $metadata = $null
  if (Test-Path -LiteralPath $metadataPath -PathType Leaf) { $metadata = [IO.File]::ReadAllText($metadataPath) | ConvertFrom-Json }
  if ($null -ne $metadata -and $null -ne $metadata.PSObject.Properties['selfSigned'] -and $metadata.selfSigned -isnot [bool]) { throw 'Windows 右键扩展签名元数据类型无效。' }
  if ($null -eq $metadata -or $metadata.selfSigned -ne $true) {
    if ($signature.Status -ne 'Valid') { throw ('Windows 右键扩展未通过可信签名验证：' + $signature.Status + ': ' + $signature.StatusMessage) }
    return @{ trusted = $true; needsTrust = $false; certificateThumbprint = $signature.SignerCertificate.Thumbprint; pinned = $false; statusCode = [uint32]0 }
  }
  if ($metadata.signed -isnot [bool] -or !$metadata.signed -or $metadata.publisher -cne $Publisher -or $metadata.certificateSha256 -isnot [string] -or $metadata.certificateSha256 -notmatch '^[a-fA-F0-9]{64}$' -or $metadata.packageVersion -isnot [string] -or $metadata.packageVersion -notmatch '^\d+\.\d+\.\d+\.\d+$' -or $metadata.dll -cne ($metadata.packageVersion + '\BrclioExplorerCommand.dll')) { throw 'Windows 右键扩展签名元数据不完整或与包身份不匹配。' }
  $certificatePath = Join-Path $Directory 'BrclioShell.cer'
  if (!(Test-Path -LiteralPath $certificatePath -PathType Leaf)) { throw 'Windows 右键扩展缺少专用公钥证书。' }
  $certificate = New-Object Security.Cryptography.X509Certificates.X509Certificate2($certificatePath)
  try {
    $hash = Get-BrclioShellCertificateHash $certificate
    $eku = @($certificate.Extensions | Where-Object { $_.Oid.Value -eq '2.5.29.37' })
    $basic = @($certificate.Extensions | Where-Object { $_.Oid.Value -eq '2.5.29.19' })
    $usage = @($certificate.Extensions | Where-Object { $_.Oid.Value -eq '2.5.29.15' })
    $codeSigning = $eku.Count -eq 1 -and @($eku[0].EnhancedKeyUsages | Where-Object { $_.Value -eq '1.3.6.1.5.5.7.3.3' }).Count -eq 1
    if ($hash -ine $metadata.certificateSha256 -or $certificate.Subject -cne $Publisher -or $certificate.Issuer -cne $certificate.Subject -or !$codeSigning -or $basic.Count -ne 1 -or $basic[0].CertificateAuthority -or $usage.Count -ne 1 -or !($usage[0].KeyUsages -band [Security.Cryptography.X509Certificates.X509KeyUsageFlags]::DigitalSignature) -or $certificate.HasPrivateKey -or $certificate.NotBefore -gt [DateTime]::Now -or $certificate.NotAfter -lt [DateTime]::Now -or [Convert]::ToBase64String($certificate.RawData) -cne [Convert]::ToBase64String($signature.SignerCertificate.RawData)) { throw 'Windows 右键扩展的专用签名公钥证书不匹配或已失效。' }
    $actualPath = [IO.Path]::GetFullPath($Path)
    $dllPath = [IO.Path]::GetFullPath((Join-Path $Directory $metadata.dll))
    $msixPath = [IO.Path]::GetFullPath((Join-Path $Directory 'BrclioShell.msix'))
    $expectedHash = $null
    if ([string]::Equals($actualPath, $dllPath, [StringComparison]::OrdinalIgnoreCase)) { $expectedHash = $metadata.sha256 }
    elseif ([string]::Equals($actualPath, $msixPath, [StringComparison]::OrdinalIgnoreCase)) { $expectedHash = $metadata.msixSha256 }
    else { throw 'Windows 右键扩展签名文件路径与版本化安装清单不匹配。' }
    if ($expectedHash -isnot [string] -or $expectedHash -notmatch '^[a-fA-F0-9]{64}$' -or (Get-BrclioShellFileHash $Path) -ine $expectedHash) { throw 'Windows 右键扩展文件校验和不匹配。' }
    Initialize-BrclioShellWinTrust
    $code = [Brclio.WindowsShell.WinTrust]::Verify($Path)
    # A pinned peer is not a globally trusted Windows root. Only this exact
    # root-chain error is eligible for our scoped peer policy. Bad digests,
    # revocation, expiration and every other failure remain fatal.
    if ($code -ne [uint32]0 -and $code -ne [uint32]2148204809) { throw ('Windows 右键扩展完整性验证失败：0x' + $code.ToString('X8')) }
    $store = New-Object Security.Cryptography.X509Certificates.X509Store('TrustedPeople', 'CurrentUser')
    try {
      $store.Open([Security.Cryptography.X509Certificates.OpenFlags]::ReadOnly)
      $matches = @($store.Certificates.Find([Security.Cryptography.X509Certificates.X509FindType]::FindByThumbprint, $certificate.Thumbprint, $false) | Where-Object { [Convert]::ToBase64String($_.RawData) -ceq [Convert]::ToBase64String($certificate.RawData) })
      $trusted = $matches.Count -gt 0
    } finally { $store.Close() }
    return @{ trusted = [bool]$trusted; needsTrust = !$trusted; certificateThumbprint = $certificate.Thumbprint; pinned = $true; statusCode = $code }
  } finally { $certificate.Dispose() }
}
`;

module.exports = { POWERSHELL_SIGNATURE_FUNCTIONS };
