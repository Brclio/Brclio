param(
    [Parameter(Mandatory=$true)][string]$PackagePath,
    [Parameter(Mandatory=$true)][string]$CertificatePath
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
Add-Type -AssemblyName System.Security
$archive = [IO.Compression.ZipFile]::OpenRead($PackagePath)
try {
    $entry = $archive.GetEntry('AppxSignature.p7x')
    if (-not $entry) { throw 'Signed MSIX has no signature payload.' }
    $stream = $entry.Open()
    $memory = [IO.MemoryStream]::new()
    try { $stream.CopyTo($memory); $bytes = $memory.ToArray() }
    finally { $stream.Dispose(); $memory.Dispose() }
    if ($bytes.Length -lt 5 -or [Text.Encoding]::ASCII.GetString($bytes, 0, 4) -ne 'PKCX') { throw 'Invalid MSIX signature header.' }
    $cms = [Security.Cryptography.Pkcs.SignedCms]::new()
    $cms.Decode([byte[]]$bytes[4..($bytes.Length - 1)])
    $cms.CheckSignature($true)
    if ($cms.SignerInfos.Count -ne 1) { throw 'Expected exactly one MSIX signer.' }
    $certificate = $cms.SignerInfos[0].Certificate
    if (-not $certificate) { throw 'MSIX signer certificate is missing.' }
    $der = $certificate.Export([Security.Cryptography.X509Certificates.X509ContentType]::Cert)
    if ([IO.File]::Exists($CertificatePath)) {
        $expected = [IO.File]::ReadAllBytes($CertificatePath)
        if ([Convert]::ToBase64String($expected) -ne [Convert]::ToBase64String($der)) { throw 'MSIX signer differs from exported public certificate.' }
    } else {
        [IO.File]::WriteAllBytes($CertificatePath, $der)
    }
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $fingerprint = ([BitConverter]::ToString($sha.ComputeHash($der))).Replace('-', '').ToLowerInvariant() }
    finally { $sha.Dispose() }
    $json = @{ publisher=$certificate.Subject; certificateSha256=$fingerprint; certificateThumbprint=$certificate.Thumbprint } | ConvertTo-Json -Compress
    $encoded = [Text.Encoding]::UTF8.GetBytes($json)
    $stdout = [Console]::OpenStandardOutput()
    $stdout.Write($encoded, 0, $encoded.Length)
    $stdout.Flush()
} finally { $archive.Dispose() }
