; Keep installation paths out of generated PowerShell source. The upstream
; check embeds $INSTDIR in a quoted script, which breaks on a valid apostrophe.
; This process-scoped environment variable passes the exact path as data.
!macro BrclioQueryApp
  nsExec::ExecToStack `"$PowerShellPath" -NoLogo -NoProfile -NonInteractive -Command "try { $$p = @(Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object { $$_.ExecutablePath -and [string]::Equals($$_.ExecutablePath, $$env:BRCLIO_NSIS_EXECUTABLE, [StringComparison]::OrdinalIgnoreCase) }); if ($$p.Count) { exit 10 }; exit 0 } catch { exit 20 }"`
  Pop $R0
  Pop $R1
!macroend

!macro customCheckAppRunning
  System::Call 'kernel32::SetEnvironmentVariable(t "BRCLIO_NSIS_EXECUTABLE", t "$INSTDIR\${APP_EXECUTABLE_FILENAME}") i.r0'
  ${If} $0 == 0
    SetErrorLevel 2
    Quit
  ${EndIf}
  StrCpy $R2 0
  ${Do}
    !insertmacro BrclioQueryApp
    ${If} $R0 != 10
      ${ExitDo}
    ${EndIf}
    ${IfNot} ${isUpdated}
      ${ExitDo}
    ${EndIf}
    Sleep 600
    IntOp $R2 $R2 + 1
  ${LoopWhile} $R2 < 5
  ${If} $R0 == 10
    ${If} ${Silent}
      ; The updater has already waited for its parent. Do not forcibly close an
      ; unrelated second client or claim success while executable files are busy.
      SetErrorLevel 2
      Quit
    ${EndIf}
    MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION "$(appRunning)" /SD IDCANCEL IDOK +3
    SetErrorLevel 2
    Quit
    nsExec::ExecToStack `"$PowerShellPath" -NoLogo -NoProfile -NonInteractive -Command "try { Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object { $$_.ExecutablePath -and [string]::Equals($$_.ExecutablePath, $$env:BRCLIO_NSIS_EXECUTABLE, [StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force -ErrorAction Stop }; exit 0 } catch { exit 20 }"`
    Pop $R0
    Pop $R1
    Sleep 300
    !insertmacro BrclioQueryApp
  ${EndIf}
  System::Call 'kernel32::SetEnvironmentVariable(t "BRCLIO_NSIS_EXECUTABLE", p 0)'
  ${If} $R0 != 0
    DetailPrint "Unable to confirm that Brclio has closed; installation was stopped."
    SetErrorLevel 2
    Quit
  ${EndIf}
!macroend

; Remove only the current user's sparse package whose signing identity and
; external COM DLL belong to this installation. Paths remain environment data.
!macro BrclioRemoveModernMenu
  System::Call 'kernel32::SetEnvironmentVariable(t "BRCLIO_NSIS_EXECUTABLE", t "$INSTDIR\${APP_EXECUTABLE_FILENAME}") i.r0'
  ${If} $0 == 0
    SetErrorLevel 2
    Quit
  ${EndIf}
  InitPluginsDir
  ClearErrors
  FileOpen $R3 "$PLUGINSDIR\brclio-shell-uninstall.ps1" w
  IfErrors 0 +3
  SetErrorLevel 2
  Quit
  FileWrite $R3 "$$ErrorActionPreference = 'Stop'$\r$\n"
  FileWrite $R3 "function Resolve-BrclioShellPath([string]$$value) {$\r$\n"
  FileWrite $R3 "  return [IO.Path]::GetFullPath($$value).TrimEnd('\')$\r$\n"
  FileWrite $R3 "}$\r$\n"
  FileWrite $R3 "$\r$\n"
  FileWrite $R3 "function Get-BrclioShellDllRelativePath([string]$$version) {$\r$\n"
  FileWrite $R3 "  if ($$version -cnotmatch '^(0|[1-9]\d{0,4})\.(0|[1-9]\d{0,4})\.(0|[1-9]\d{0,4})\.(0|[1-9]\d{0,4})$$' -or @($$version.Split('.') | Where-Object { [int]$$_ -gt 65535 }).Count -gt 0) {$\r$\n"
  FileWrite $R3 "    throw 'The Brclio shell package version is invalid.'$\r$\n"
  FileWrite $R3 "  }$\r$\n"
  FileWrite $R3 "  return 'resources\windows-shell\' + $$version + '\BrclioExplorerCommand.dll'$\r$\n"
  FileWrite $R3 "}$\r$\n"
  FileWrite $R3 "$\r$\n"
  FileWrite $R3 "function Read-BrclioShellIdentity([string]$$directory) {$\r$\n"
  FileWrite $R3 "  $$manifestPath = Join-Path $$directory 'resources\windows-shell\AppxManifest.xml'$\r$\n"
  FileWrite $R3 "  $$identity = @{ Name = 'Brclio.Toolbox.Shell'; Publisher = 'CN=Brclio' }$\r$\n"
  FileWrite $R3 "  if (-not (Test-Path -LiteralPath $$manifestPath -PathType Leaf)) { return $$identity }$\r$\n"
  FileWrite $R3 "  [xml]$$manifest = Get-Content -LiteralPath $$manifestPath -Raw -Encoding UTF8$\r$\n"
  FileWrite $R3 "  $$node = $$manifest.SelectSingleNode('/*[local-name()=$\"Package$\"]/*[local-name()=$\"Identity$\"]')$\r$\n"
  FileWrite $R3 "  $$application = $$manifest.SelectSingleNode('/*[local-name()=$\"Package$\"]/*[local-name()=$\"Applications$\"]/*[local-name()=$\"Application$\" and @Id=$\"Brclio$\"]')$\r$\n"
  FileWrite $R3 "  $$classes = @($$manifest.SelectNodes('//*[local-name()=$\"Class$\" and @Id=$\"CFD1E4D4-3973-45D3-8542-45A77E6C58C9$\"]'))$\r$\n"
  FileWrite $R3 "  if ($$null -eq $$node -or $$node.Name -cne $$identity.Name -or [string]::IsNullOrWhiteSpace($$node.Publisher) -or $$null -eq $$application -or $$classes.Count -ne 1 -or $$classes[0].Path -cne (Get-BrclioShellDllRelativePath ([string]$$node.Version))) {$\r$\n"
  FileWrite $R3 "    throw 'The installed Brclio shell manifest is invalid; package ownership cannot be confirmed.'$\r$\n"
  FileWrite $R3 "  }$\r$\n"
  FileWrite $R3 "  $$identity.Publisher = [string]$$node.Publisher$\r$\n"
  FileWrite $R3 "  return $$identity$\r$\n"
  FileWrite $R3 "}$\r$\n"
  FileWrite $R3 "$\r$\n"
  FileWrite $R3 "function Get-BrclioShellExternalLocation($$package) {$\r$\n"
  FileWrite $R3 "  [Windows.Management.Deployment.PackageManager,Windows.Management.Deployment,ContentType=WindowsRuntime] | Out-Null$\r$\n"
  FileWrite $R3 "  $$manager = New-Object Windows.Management.Deployment.PackageManager$\r$\n"
  FileWrite $R3 "  $$registered = $$manager.FindPackageForUser('', $$package.PackageFullName)$\r$\n"
  FileWrite $R3 "  return [string]$$registered.EffectiveExternalLocation.Path$\r$\n"
  FileWrite $R3 "}$\r$\n"
  FileWrite $R3 "$\r$\n"
  FileWrite $R3 "function Test-BrclioShellPackage($$package, [string]$$directory, [hashtable]$$identity) {$\r$\n"
  FileWrite $R3 "  if ($$package.Name -cne $$identity.Name -or $$package.Publisher -cne $$identity.Publisher) { return $$false }$\r$\n"
  FileWrite $R3 "  try {$\r$\n"
  FileWrite $R3 "    [xml]$$manifest = Get-AppxPackageManifest -Package $$package.PackageFullName -ErrorAction Stop$\r$\n"
  FileWrite $R3 "    $$node = $$manifest.SelectSingleNode('/*[local-name()=$\"Package$\"]/*[local-name()=$\"Identity$\"]')$\r$\n"
  FileWrite $R3 "    $$application = $$manifest.SelectSingleNode('/*[local-name()=$\"Package$\"]/*[local-name()=$\"Applications$\"]/*[local-name()=$\"Application$\" and @Id=$\"Brclio$\"]')$\r$\n"
  FileWrite $R3 "    $$classes = @($$manifest.SelectNodes('//*[local-name()=$\"Class$\" and @Id=$\"CFD1E4D4-3973-45D3-8542-45A77E6C58C9$\"]'))$\r$\n"
  FileWrite $R3 "    if ($$null -eq $$node -or $$node.Name -cne $$identity.Name -or $$node.Publisher -cne $$identity.Publisher -or $$null -eq $$application -or $$classes.Count -ne 1) { return $$false }$\r$\n"
  FileWrite $R3 "    $$classPath = [string]$$classes[0].Path$\r$\n"
  FileWrite $R3 "    # The registered version determines its DLL path, even while an installer$\r$\n"
  FileWrite $R3 "    # has replaced the local manifest with the next version.$\r$\n"
  FileWrite $R3 "    $$relative = Get-BrclioShellDllRelativePath ([string]$$node.Version)$\r$\n"
  FileWrite $R3 "    $$expected = Resolve-BrclioShellPath (Join-Path $$directory $$relative)$\r$\n"
  FileWrite $R3 "    if ([IO.Path]::IsPathRooted($$classPath)) {$\r$\n"
  FileWrite $R3 "      return [string]::Equals((Resolve-BrclioShellPath $$classPath), $$expected, [StringComparison]::OrdinalIgnoreCase)$\r$\n"
  FileWrite $R3 "    }$\r$\n"
  FileWrite $R3 "    if ($$classPath -cne $$relative) { return $$false }$\r$\n"
  FileWrite $R3 "    $$external = Get-BrclioShellExternalLocation $$package$\r$\n"
  FileWrite $R3 "    if ([string]::IsNullOrWhiteSpace($$external)) { return $$false }$\r$\n"
  FileWrite $R3 "    return [string]::Equals((Resolve-BrclioShellPath $$external), (Resolve-BrclioShellPath $$directory), [StringComparison]::OrdinalIgnoreCase)$\r$\n"
  FileWrite $R3 "  } catch { return $$false }$\r$\n"
  FileWrite $R3 "}$\r$\n"
  FileWrite $R3 "$\r$\n"
  FileWrite $R3 "function Get-BrclioShellPackages([string]$$directory, [hashtable]$$identity) {$\r$\n"
  FileWrite $R3 "  if (-not (Get-Command Get-AppxPackage -ErrorAction SilentlyContinue)) { return }$\r$\n"
  FileWrite $R3 "  foreach ($$package in @(Get-AppxPackage -Name $$identity.Name -ErrorAction Stop)) {$\r$\n"
  FileWrite $R3 "    if (Test-BrclioShellPackage $$package $$directory $$identity) { $$package }$\r$\n"
  FileWrite $R3 "  }$\r$\n"
  FileWrite $R3 "}$\r$\n"
  FileWrite $R3 "$\r$\n"
  FileWrite $R3 "function Remove-BrclioShellPackages([string]$$directory, [hashtable]$$identity, [object[]]$$packages) {$\r$\n"
  FileWrite $R3 "  foreach ($$saved in $$packages) {$\r$\n"
  FileWrite $R3 "    # Re-read immediately before removal; another installation may have moved$\r$\n"
  FileWrite $R3 "    # the shared identity while an update or uninstall was in progress.$\r$\n"
  FileWrite $R3 "    foreach ($$package in @(Get-AppxPackage -Name $$identity.Name -ErrorAction Stop)) {$\r$\n"
  FileWrite $R3 "      if ($$package.PackageFullName -ceq $$saved.PackageFullName -and (Test-BrclioShellPackage $$package $$directory $$identity)) {$\r$\n"
  FileWrite $R3 "        Remove-AppxPackage -Package $$package.PackageFullName -ErrorAction Stop$\r$\n"
  FileWrite $R3 "      }$\r$\n"
  FileWrite $R3 "    }$\r$\n"
  FileWrite $R3 "  }$\r$\n"
  FileWrite $R3 "}$\r$\n"
  FileWrite $R3 "$\r$\n"
  FileWrite $R3 "function Remove-BrclioShellCertificateTrust {$\r$\n"
  FileWrite $R3 "  if (-not (Get-Command Get-AppxPackage -ErrorAction SilentlyContinue)) { return }$\r$\n"
  FileWrite $R3 "  $$markers = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Software\Brclio\ShellCertificates', $$true)$\r$\n"
  FileWrite $R3 "  if ($$null -eq $$markers) { return }$\r$\n"
  FileWrite $R3 "  $$store = New-Object Security.Cryptography.X509Certificates.X509Store('TrustedPeople', 'CurrentUser')$\r$\n"
  FileWrite $R3 "  try {$\r$\n"
  FileWrite $R3 "    $$store.Open([Security.Cryptography.X509Certificates.OpenFlags]::ReadWrite)$\r$\n"
  FileWrite $R3 "    foreach ($$thumbprint in $$markers.GetSubKeyNames()) {$\r$\n"
  FileWrite $R3 "      if ($$thumbprint -cnotmatch '^[A-Fa-f0-9]{40}$$') { continue }$\r$\n"
  FileWrite $R3 "      $$marker = $$markers.OpenSubKey($$thumbprint)$\r$\n"
  FileWrite $R3 "      try {$\r$\n"
  FileWrite $R3 "        $$owner = $$marker.GetValue('BrclioOwner')$\r$\n"
  FileWrite $R3 "        $$expected = [string]$$marker.GetValue('CertificateSha256')$\r$\n"
  FileWrite $R3 "        $$publisher = [string]$$marker.GetValue('Publisher')$\r$\n"
  FileWrite $R3 "      } finally { $$marker.Dispose() }$\r$\n"
  FileWrite $R3 "      if ($$owner -cne 'com.brclio.toolbox' -or $$expected -cnotmatch '^[A-Fa-f0-9]{64}$$' -or [string]::IsNullOrWhiteSpace($$publisher)) { continue }$\r$\n"
  FileWrite $R3 "      # Other current-user sparse packages can share this Publisher. Keep the$\r$\n"
  FileWrite $R3 "      # leaf trusted until every dependent package has been removed.$\r$\n"
  FileWrite $R3 "      if (@(Get-AppxPackage -ErrorAction Stop | Where-Object { $$_.Publisher -ceq $$publisher }).Count -gt 0) { continue }$\r$\n"
  FileWrite $R3 "      $$matches = @($$store.Certificates | Where-Object { [string]::Equals($$_.Thumbprint, $$thumbprint, [StringComparison]::OrdinalIgnoreCase) })$\r$\n"
  FileWrite $R3 "      $$owned = $$true$\r$\n"
  FileWrite $R3 "      foreach ($$certificate in $$matches) {$\r$\n"
  FileWrite $R3 "        $$sha256 = [Security.Cryptography.SHA256]::Create()$\r$\n"
  FileWrite $R3 "        try { $$actual = [BitConverter]::ToString($$sha256.ComputeHash($$certificate.RawData)).Replace('-', '') } finally { $$sha256.Dispose() }$\r$\n"
  FileWrite $R3 "        if ($$certificate.Subject -cne $$publisher -or -not [string]::Equals($$actual, $$expected, [StringComparison]::OrdinalIgnoreCase)) { $$owned = $$false; break }$\r$\n"
  FileWrite $R3 "      }$\r$\n"
  FileWrite $R3 "      if (-not $$owned) { continue }$\r$\n"
  FileWrite $R3 "      foreach ($$certificate in $$matches) { $$store.Remove($$certificate) }$\r$\n"
  FileWrite $R3 "      $$markers.DeleteSubKey($$thumbprint, $$false)$\r$\n"
  FileWrite $R3 "    }$\r$\n"
  FileWrite $R3 "  } finally { $$store.Close(); $$markers.Dispose() }$\r$\n"
  FileWrite $R3 "}$\r$\n"
  FileWrite $R3 "$\r$\n"
  FileWrite $R3 "try {$\r$\n"
  FileWrite $R3 "  $$directory = [IO.Path]::GetDirectoryName($$env:BRCLIO_NSIS_EXECUTABLE)$\r$\n"
  FileWrite $R3 "  $$identity = Read-BrclioShellIdentity $$directory$\r$\n"
  FileWrite $R3 "  $$packages = @(Get-BrclioShellPackages $$directory $$identity)$\r$\n"
  FileWrite $R3 "  Remove-BrclioShellPackages $$directory $$identity $$packages$\r$\n"
  FileWrite $R3 "  if (@(Get-BrclioShellPackages $$directory $$identity).Count -gt 0) { throw 'The owned Brclio shell package is still registered.' }$\r$\n"
  FileWrite $R3 "  Remove-BrclioShellCertificateTrust$\r$\n"
  FileWrite $R3 "  exit 0$\r$\n"
  FileWrite $R3 "} catch {$\r$\n"
  FileWrite $R3 "  [Console]::Error.WriteLine($$_.Exception.Message)$\r$\n"
  FileWrite $R3 "  exit 20$\r$\n"
  FileWrite $R3 "}$\r$\n"
  FileClose $R3
  IfErrors 0 +3
  SetErrorLevel 2
  Quit
  nsExec::ExecToStack `"$PowerShellPath" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\brclio-shell-uninstall.ps1"`
  Pop $R0
  Pop $R1
  Delete "$PLUGINSDIR\brclio-shell-uninstall.ps1"
  System::Call 'kernel32::SetEnvironmentVariable(t "BRCLIO_NSIS_EXECUTABLE", p 0)'
  ${If} $R0 != 0
    DetailPrint "Unable to remove the owned Brclio shell package: $R1"
    SetErrorLevel 2
    Quit
  ${EndIf}
!macroend

; Only remove integration keys carrying our ownership marker.
!macro customUnInstall
  ; NSIS passes --updated to the old uninstaller during an upgrade. Preserve
  ; shell package identity, certificate trust and legacy commands; only an
  ; actual uninstall removes integration belonging to this installation.
  ${IfNot} ${isUpdated}
  !insertmacro BrclioRemoveModernMenu
  ReadRegStr $0 HKCU "Software\Classes\*\shell\Brclio.CopyPath" "BrclioOwner"
  ${If} $0 == "com.brclio.toolbox"
    DeleteRegKey HKCU "Software\Classes\*\shell\Brclio.CopyPath"
  ${EndIf}
  ReadRegStr $0 HKCU "Software\Classes\Directory\shell\Brclio.CopyPath" "BrclioOwner"
  ${If} $0 == "com.brclio.toolbox"
    DeleteRegKey HKCU "Software\Classes\Directory\shell\Brclio.CopyPath"
  ${EndIf}
  ReadRegStr $0 HKCU "Software\Classes\Directory\Background\shell\Brclio.CopyPath" "BrclioOwner"
  ${If} $0 == "com.brclio.toolbox"
    DeleteRegKey HKCU "Software\Classes\Directory\Background\shell\Brclio.CopyPath"
  ${EndIf}
  ${EndIf}
!macroend
