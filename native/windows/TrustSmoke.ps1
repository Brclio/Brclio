param([Parameter(Mandatory=$true)][string]$Directory)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
if ($env:BRCLIO_ALLOW_SHELL_TRUST_SMOKE -ne '1') { throw 'Trust smoke requires explicit opt-in.' }
. (Join-Path $Directory 'VerifyShellSignature.ps1')
Add-Type -AssemblyName System.IO.Compression.FileSystem

function Root-StoreSnapshot {
    $result = @()
    foreach ($location in @('CurrentUser', 'LocalMachine')) {
        $rootStore = [Security.Cryptography.X509Certificates.X509Store]::new('Root', $location)
        try {
            $rootStore.Open([Security.Cryptography.X509Certificates.OpenFlags]::ReadOnly)
            $result += @($rootStore.Certificates | ForEach-Object { $location + ':' + $_.Thumbprint })
        } finally { $rootStore.Close() }
    }
    return (($result | Sort-Object) -join ',')
}

function File-Hash([string]$Path) {
    $sha = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($sha.ComputeHash([IO.File]::ReadAllBytes($Path)))).Replace('-', '').ToLowerInvariant() }
    finally { $sha.Dispose() }
}

function Invoke-TrustHelper([string]$Action) {
    $start = [Diagnostics.ProcessStartInfo]::new()
    $start.FileName = Join-Path $Directory 'BrclioShellTrust.exe'
    $start.Arguments = $Action + ' "' + (Join-Path $Directory 'BrclioShell.cer') + '"'
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $process = [Diagnostics.Process]::Start($start)
    try {
        if (!$process.WaitForExit(60000)) { throw 'The isolated machine trust helper smoke timed out.' }
        return $process.ExitCode
    } finally { $process.Dispose() }
}

function Machine-CertificatePresent {
    $machine = [Security.Cryptography.X509Certificates.X509Store]::new('TrustedPeople', 'LocalMachine')
    try {
        $machine.Open([Security.Cryptography.X509Certificates.OpenFlags]::ReadOnly)
        return @($machine.Certificates.Find([Security.Cryptography.X509Certificates.X509FindType]::FindByThumbprint, $certificate.Thumbprint, $false) | Where-Object {
            [Convert]::ToBase64String($_.RawData) -ceq [Convert]::ToBase64String($certificate.RawData)
        }).Count -gt 0
    } finally { $machine.Close() }
}

function Assert-TamperedRejected([string]$Path, [string]$HashKey, [bool]$IsPackage) {
    $metadataPath = Join-Path $Directory 'shell-build.json'
    $savedMetadata = [IO.File]::ReadAllBytes($metadataPath)
    $savedFile = [IO.File]::ReadAllBytes($Path)
    try {
        if ($IsPackage) {
            # Preserve a valid ZIP and its original signature while changing
            # the signed manifest. A generic format failure would be weaker.
            $archive = [IO.Compression.ZipFile]::Open($Path, [IO.Compression.ZipArchiveMode]::Update)
            try {
                $entry = $archive.GetEntry('AppxManifest.xml')
                if ($null -eq $entry) { throw 'Tamper fixture manifest is missing.' }
                $reader = [IO.StreamReader]::new($entry.Open(), [Text.Encoding]::UTF8)
                try { $text = $reader.ReadToEnd() } finally { $reader.Dispose() }
                $changed = $text.Replace('<DisplayName>Brclio</DisplayName>', '<DisplayName>Brclio tampered</DisplayName>')
                if ($text -ceq $changed) { throw 'Cannot modify the signed manifest fixture.' }
                $entry.Delete()
                $replacement = $archive.CreateEntry('AppxManifest.xml')
                $stream = $replacement.Open()
                try {
                    $encoded = [Text.Encoding]::UTF8.GetBytes($changed)
                    $stream.Write($encoded, 0, $encoded.Length)
                } finally { $stream.Dispose() }
            } finally { $archive.Dispose() }
        } else {
            # Modify a code-section byte, outside the Authenticode signature.
            $changed = [byte[]]$savedFile.Clone()
            $pe = [BitConverter]::ToInt32($changed, 0x3c)
            $optionalSize = [BitConverter]::ToUInt16($changed, $pe + 20)
            $section = $pe + 24 + $optionalSize
            $data = [BitConverter]::ToInt32($changed, $section + 20)
            if ($data -le 0 -or ($data + 32) -ge $changed.Length) { throw 'Cannot find the signed DLL code section.' }
            $changed[$data + 32] = $changed[$data + 32] -bxor 1
            [IO.File]::WriteAllBytes($Path, $changed)
        }
        # Updating the ledger means this test proves native signature
        # integrity rejection, rather than merely detecting a SHA mismatch.
        $changedMetadata = [Text.Encoding]::UTF8.GetString($savedMetadata) | ConvertFrom-Json
        $changedMetadata.$HashKey = File-Hash $Path
        [IO.File]::WriteAllText($metadataPath, ($changedMetadata | ConvertTo-Json -Depth 10), [Text.Encoding]::UTF8)
        $rejected = $false
        try {
            $policy = Test-BrclioShellSignature $Path $metadata.publisher $Directory
            $rejected = -not $policy.trusted
        } catch { $rejected = $true }
        if (!$rejected) { throw ('The signature policy accepted tampered signed bytes: ' + [IO.Path]::GetFileName($Path)) }
        Write-Output ('Tampered signed file rejected: ' + [IO.Path]::GetFileName($Path))
    } finally {
        [IO.File]::WriteAllBytes($Path, $savedFile)
        [IO.File]::WriteAllBytes($metadataPath, $savedMetadata)
    }
}

$metadata = [IO.File]::ReadAllText((Join-Path $Directory 'shell-build.json')) | ConvertFrom-Json
$certificate = [Security.Cryptography.X509Certificates.X509Certificate2]::new((Join-Path $Directory 'BrclioShell.cer'))
$store = [Security.Cryptography.X509Certificates.X509Store]::new('TrustedPeople', 'CurrentUser')
$imported = $false
$machineImported = $false
$rootBefore = Root-StoreSnapshot
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
        $policy = Test-BrclioShellSignature $path $metadata.publisher $Directory
        Write-Output ('Before trust ' + [IO.Path]::GetFileName($path) + ': Authenticode=' + $signature.Status + ', WinVerifyTrust=' + ('0x{0:X8}' -f [uint32]$policy.statusCode) + ', trusted=' + $policy.trusted)
    }
    $store.Open([Security.Cryptography.X509Certificates.OpenFlags]::ReadWrite)
    $existing = @($store.Certificates.Find([Security.Cryptography.X509Certificates.X509FindType]::FindByThumbprint, $certificate.Thumbprint, $false))
    if ($metadata.selfSigned -eq $true -and $existing.Count -eq 0) {
        $store.Add($certificate)
        $imported = $true
    }
    foreach ($path in $paths) {
        $signature = Get-AuthenticodeSignature -LiteralPath $path
        $policy = Test-BrclioShellSignature $path $metadata.publisher $Directory
        Write-Output ('After trust ' + [IO.Path]::GetFileName($path) + ': Authenticode=' + $signature.Status + ', WinVerifyTrust=' + ('0x{0:X8}' -f [uint32]$policy.statusCode) + ', trusted=' + $policy.trusted)
        if (!$policy.trusted) { throw ('The shared peer policy did not trust the signed fixture: ' + [IO.Path]::GetFileName($path)) }
    }
    $helper = Join-Path $Directory 'BrclioShellTrust.exe'
    $helperPolicy = Test-BrclioShellSignature $helper $metadata.publisher $Directory
    if (!$helperPolicy.trusted) { throw 'The machine trust helper did not pass its signature and exact hash policy.' }
    if ($metadata.selfSigned -eq $true) {
        $added = Invoke-TrustHelper '--add'
        if ($added -eq 10) { $machineImported = $true }
        elseif ($added -ne 0) { throw ('The isolated trust smoke requires an elevated Windows runner; helper exit ' + $added) }
        foreach ($path in @($paths + $helper)) {
            $policy = Test-BrclioShellSignature $path $metadata.publisher $Directory
            if (!$policy.trusted -or !$policy.machineTrusted -or $policy.needsTrust) { throw 'The dedicated machine leaf did not establish the exact peer policy.' }
        }
    }
    Assert-TamperedRejected $paths[0] 'sha256' $false
    Assert-TamperedRejected $paths[1] 'msixSha256' $true
    Assert-TamperedRejected $helper 'trustHelperSha256' $false
    if ((Root-StoreSnapshot) -cne $rootBefore) { throw 'The Root certificate stores changed during the leaf trust smoke.' }
    Write-Output 'Windows DLL, MSIX and machine helper trust/tamper smoke passed (TrustedPeople leaf stores only)'
} finally {
    $cleanupFailure = $null
    if ($machineImported) {
        try {
            $removed = Invoke-TrustHelper '--remove'
            if ($removed -ne 0 -or (Machine-CertificatePresent)) { throw 'The isolated smoke could not remove its newly imported machine leaf.' }
        } catch { $cleanupFailure = $_ }
    }
    try {
        if ($imported) {
            foreach ($item in @($store.Certificates.Find([Security.Cryptography.X509Certificates.X509FindType]::FindByThumbprint, $certificate.Thumbprint, $false))) {
                if ([Convert]::ToBase64String($item.RawData) -ceq [Convert]::ToBase64String($certificate.RawData)) { $store.Remove($item) }
            }
        }
    } finally { $store.Close(); $certificate.Dispose() }
    if ($cleanupFailure) { throw $cleanupFailure }
}
