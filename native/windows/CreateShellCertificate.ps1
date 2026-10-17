param(
    [Parameter(Mandatory=$true)][string]$Publisher,
    [Parameter(Mandatory=$true)][string]$PfxPath,
    [Parameter(Mandatory=$true)][string]$CertificatePath
)
$ErrorActionPreference = 'Stop'
# The key is an ephemeral CNG key. Neither it nor a certificate is installed in
# any Windows certificate store; only the public leaf is shipped with Brclio.
$password = [Environment]::GetEnvironmentVariable('BRCLIO_SHELL_BUILD_PFX_PASSWORD')
if ([string]::IsNullOrEmpty($password)) { throw 'Ephemeral signing password is missing.' }
$rsa = [Security.Cryptography.RSACng]::new(3072)
$certificate = $null
try {
    $request = [Security.Cryptography.X509Certificates.CertificateRequest]::new(
        $Publisher, $rsa, [Security.Cryptography.HashAlgorithmName]::SHA256,
        [Security.Cryptography.RSASignaturePadding]::Pkcs1)
    $request.CertificateExtensions.Add([Security.Cryptography.X509Certificates.X509BasicConstraintsExtension]::new($false, $false, 0, $true))
    $request.CertificateExtensions.Add([Security.Cryptography.X509Certificates.X509KeyUsageExtension]::new(
        [Security.Cryptography.X509Certificates.X509KeyUsageFlags]::DigitalSignature, $true))
    $usages = [Security.Cryptography.OidCollection]::new()
    [void]$usages.Add([Security.Cryptography.Oid]::new('1.3.6.1.5.5.7.3.3'))
    $request.CertificateExtensions.Add([Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension]::new($usages, $true))
    $certificate = $request.CreateSelfSigned([DateTimeOffset]::UtcNow.AddDays(-1), [DateTimeOffset]::UtcNow.AddYears(10))
    [IO.File]::WriteAllBytes($PfxPath, $certificate.Export([Security.Cryptography.X509Certificates.X509ContentType]::Pfx, $password))
    [IO.File]::WriteAllBytes($CertificatePath, $certificate.Export([Security.Cryptography.X509Certificates.X509ContentType]::Cert))
} finally {
    if ($certificate) { $certificate.Dispose() }
    $rsa.Dispose()
    $password = $null
}
