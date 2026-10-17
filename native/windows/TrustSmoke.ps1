param([Parameter(Mandatory=$true)][string]$Directory)
$ErrorActionPreference = 'Stop'
if ($env:BRCLIO_ALLOW_SHELL_TRUST_SMOKE -ne '1') { throw 'Trust smoke requires explicit opt-in.' }
$metadata = [IO.File]::ReadAllText((Join-Path $Directory 'shell-build.json')) | ConvertFrom-Json
$certificate = [Security.Cryptography.X509Certificates.X509Certificate2]::new((Join-Path $Directory 'BrclioShell.cer'))
$store = [Security.Cryptography.X509Certificates.X509Store]::new('TrustedPeople', 'CurrentUser')
$imported = $false
try {
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $hash = ([BitConverter]::ToString($sha.ComputeHash($certificate.RawData))).Replace('-', '').ToLowerInvariant() }
    finally { $sha.Dispose() }
    if ($hash -cne $metadata.certificateSha256 -or $certificate.HasPrivateKey -or $certificate.Subject -cne $metadata.publisher) { throw 'Trust fixture public certificate does not match its build.' }
    if ($metadata.packageVersion -notmatch '^\d+\.\d+\.\d+\.\d+$' -or $metadata.dll -cne ($metadata.packageVersion + '\BrclioExplorerCommand.dll')) { throw 'Invalid versioned DLL fixture path.' }
    $paths = @((Join-Path $Directory $metadata.dll), (Join-Path $Directory 'BrclioShell.msix'))
    foreach ($path in $paths) {
        $signature = Get-AuthenticodeSignature -LiteralPath $path
        if ($null -eq $signature.SignerCertificate -or [Convert]::ToBase64String($signature.SignerCertificate.RawData) -cne [Convert]::ToBase64String($certificate.RawData)) { throw 'Trust fixture signature does not match the public leaf.' }
    }
    $store.Open([Security.Cryptography.X509Certificates.OpenFlags]::ReadWrite)
    $existing = @($store.Certificates.Find([Security.Cryptography.X509Certificates.X509FindType]::FindByThumbprint, $certificate.Thumbprint, $false))
    if ($metadata.selfSigned -eq $true -and $existing.Count -eq 0) {
        $store.Add($certificate)
        $imported = $true
    }
    foreach ($path in $paths) {
        $signature = Get-AuthenticodeSignature -LiteralPath $path
        if ($signature.Status -ne 'Valid' -or $null -eq $signature.SignerCertificate -or [Convert]::ToBase64String($signature.SignerCertificate.RawData) -cne [Convert]::ToBase64String($certificate.RawData)) {
            throw ('CurrentUser TrustedPeople did not validate the signed fixture: ' + [IO.Path]::GetFileName($path) + ': ' + $signature.Status + ': ' + $signature.StatusMessage)
        }
    }
    Write-Output 'Windows DLL and MSIX signature trust smoke passed (CurrentUser TrustedPeople only)'
} finally {
    if ($imported) {
        foreach ($item in @($store.Certificates.Find([Security.Cryptography.X509Certificates.X509FindType]::FindByThumbprint, $certificate.Thumbprint, $false))) {
            if ([Convert]::ToBase64String($item.RawData) -ceq [Convert]::ToBase64String($certificate.RawData)) { $store.Remove($item) }
        }
    }
    $store.Close()
    $certificate.Dispose()
}
