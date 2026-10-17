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
  System::Call 'kernel32::SetEnvironmentVariable(t "BRCLIO_NSIS_INSTALL_MODE", t "$installMode") i.r0'
  ${If} $0 == 0
    System::Call 'kernel32::SetEnvironmentVariable(t "BRCLIO_NSIS_EXECUTABLE", p 0)'
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
  FileWrite $R3 "function Initialize-BrclioShellPaths {$\r$\n"
  FileWrite $R3 "  if ('Brclio.WindowsShell.PathNames' -as [type]) { return }$\r$\n"
  FileWrite $R3 "  Add-Type -TypeDefinition @'$\r$\n"
  FileWrite $R3 "using System;$\r$\n"
  FileWrite $R3 "using System.Runtime.InteropServices;$\r$\n"
  FileWrite $R3 "using System.Text;$\r$\n"
  FileWrite $R3 "namespace Brclio.WindowsShell {$\r$\n"
  FileWrite $R3 "  public static class PathNames {$\r$\n"
  FileWrite $R3 "    [DllImport($\"kernel32.dll$\", EntryPoint = $\"GetLongPathNameW$\", CharSet = CharSet.Unicode, ExactSpelling = true)]$\r$\n"
  FileWrite $R3 "    private static extern UInt32 GetLongPathName(string path, StringBuilder result, UInt32 capacity);$\r$\n"
  FileWrite $R3 "    public static string Expand(string path) {$\r$\n"
  FileWrite $R3 "      StringBuilder result = new StringBuilder(32768);$\r$\n"
  FileWrite $R3 "      UInt32 length = GetLongPathName(path, result, (UInt32)result.Capacity);$\r$\n"
  FileWrite $R3 "      if (length >= result.Capacity) {$\r$\n"
  FileWrite $R3 "        result = new StringBuilder(checked((int)length + 1));$\r$\n"
  FileWrite $R3 "        length = GetLongPathName(path, result, (UInt32)result.Capacity);$\r$\n"
  FileWrite $R3 "      }$\r$\n"
  FileWrite $R3 "      return length > 0 && length < result.Capacity ? result.ToString() : path;$\r$\n"
  FileWrite $R3 "    }$\r$\n"
  FileWrite $R3 "  }$\r$\n"
  FileWrite $R3 "}$\r$\n"
  FileWrite $R3 "'@$\r$\n"
  FileWrite $R3 "}$\r$\n"
  FileWrite $R3 "$\r$\n"
  FileWrite $R3 "function Resolve-BrclioShellPath([string]$$value) {$\r$\n"
  FileWrite $R3 "  $$fullPath = [IO.Path]::GetFullPath($$value)$\r$\n"
  FileWrite $R3 "  Initialize-BrclioShellPaths$\r$\n"
  FileWrite $R3 "  # WinRT reports long paths, while process.execPath and NSIS can retain an$\r$\n"
  FileWrite $R3 "  # 8.3 alias. Missing paths keep their existing full-path comparison behavior.$\r$\n"
  FileWrite $R3 "  return [Brclio.WindowsShell.PathNames]::Expand($$fullPath).TrimEnd('\')$\r$\n"
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
  FileWrite $R3 "  $$identity.Version = [string]$$node.Version$\r$\n"
  FileWrite $R3 "  return $$identity$\r$\n"
  FileWrite $R3 "}$\r$\n"
  FileWrite $R3 "$\r$\n"
  FileWrite $R3 "function Get-BrclioShellExternalLocation($$package) {$\r$\n"
  FileWrite $R3 "  [Windows.Management.Deployment.PackageManager,Windows.Management.Deployment,ContentType=WindowsRuntime] | Out-Null$\r$\n"
  FileWrite $R3 "  $$manager = New-Object Windows.Management.Deployment.PackageManager$\r$\n"
  FileWrite $R3 "  $$userSid = if ($$package.UserSid) { [string]$$package.UserSid } else { '' }$\r$\n"
  FileWrite $R3 "  $$registered = $$manager.FindPackageForUser($$userSid, $$package.PackageFullName)$\r$\n"
  FileWrite $R3 "  return [string]$$registered.EffectiveExternalLocation.Path$\r$\n"
  FileWrite $R3 "}$\r$\n"
  FileWrite $R3 "$\r$\n"
  FileWrite $R3 "function Test-BrclioShellPackage($$package, [string]$$directory, [hashtable]$$identity, [switch]$$Strict) {$\r$\n"
  FileWrite $R3 "  if ($$package.Name -cne $$identity.Name -or $$package.Publisher -cne $$identity.Publisher) { return $$false }$\r$\n"
  FileWrite $R3 "  try {$\r$\n"
  FileWrite $R3 "    if ($$package.UserSid) {$\r$\n"
  FileWrite $R3 "      [xml]$$manifest = Get-AppxPackageManifest -Package $$package.PackageFullName -User $$package.UserSid -ErrorAction Stop$\r$\n"
  FileWrite $R3 "    } else {$\r$\n"
  FileWrite $R3 "      [xml]$$manifest = Get-AppxPackageManifest -Package $$package.PackageFullName -ErrorAction Stop$\r$\n"
  FileWrite $R3 "    }$\r$\n"
  FileWrite $R3 "    $$node = $$manifest.SelectSingleNode('/*[local-name()=$\"Package$\"]/*[local-name()=$\"Identity$\"]')$\r$\n"
  FileWrite $R3 "    $$application = $$manifest.SelectSingleNode('/*[local-name()=$\"Package$\"]/*[local-name()=$\"Applications$\"]/*[local-name()=$\"Application$\" and @Id=$\"Brclio$\"]')$\r$\n"
  FileWrite $R3 "    $$classes = @($$manifest.SelectNodes('//*[local-name()=$\"Class$\" and @Id=$\"CFD1E4D4-3973-45D3-8542-45A77E6C58C9$\"]'))$\r$\n"
  FileWrite $R3 "    if ($$null -eq $$node -or $$node.Name -cne $$identity.Name -or $$node.Publisher -cne $$identity.Publisher -or $$null -eq $$application -or $$classes.Count -ne 1) {$\r$\n"
  FileWrite $R3 "      if ($$Strict) { throw 'The registered Brclio shell manifest cannot establish package ownership.' }$\r$\n"
  FileWrite $R3 "      return $$false$\r$\n"
  FileWrite $R3 "    }$\r$\n"
  FileWrite $R3 "    $$classPath = [string]$$classes[0].Path$\r$\n"
  FileWrite $R3 "    # The registered version determines its DLL path, even while an installer$\r$\n"
  FileWrite $R3 "    # has replaced the local manifest with the next version.$\r$\n"
  FileWrite $R3 "    $$relative = Get-BrclioShellDllRelativePath ([string]$$node.Version)$\r$\n"
  FileWrite $R3 "    $$expected = Resolve-BrclioShellPath (Join-Path $$directory $$relative)$\r$\n"
  FileWrite $R3 "    if ([IO.Path]::IsPathRooted($$classPath)) {$\r$\n"
  FileWrite $R3 "      return [string]::Equals((Resolve-BrclioShellPath $$classPath), $$expected, [StringComparison]::OrdinalIgnoreCase)$\r$\n"
  FileWrite $R3 "    }$\r$\n"
  FileWrite $R3 "    if ($$classPath -cne $$relative) {$\r$\n"
  FileWrite $R3 "      if ($$Strict) { throw 'The registered Brclio COM DLL path cannot establish package ownership.' }$\r$\n"
  FileWrite $R3 "      return $$false$\r$\n"
  FileWrite $R3 "    }$\r$\n"
  FileWrite $R3 "    $$external = Get-BrclioShellExternalLocation $$package$\r$\n"
  FileWrite $R3 "    if ([string]::IsNullOrWhiteSpace($$external)) {$\r$\n"
  FileWrite $R3 "      if ($$Strict) { throw 'The registered Brclio shell external location is unavailable.' }$\r$\n"
  FileWrite $R3 "      return $$false$\r$\n"
  FileWrite $R3 "    }$\r$\n"
  FileWrite $R3 "    return [string]::Equals((Resolve-BrclioShellPath $$external), (Resolve-BrclioShellPath $$directory), [StringComparison]::OrdinalIgnoreCase)$\r$\n"
  FileWrite $R3 "  } catch { if ($$Strict) { throw }; return $$false }$\r$\n"
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
  FileWrite $R3 "function Get-BrclioShellPackagesAllUsers([string]$$directory, [hashtable]$$identity) {$\r$\n"
  FileWrite $R3 "  if (-not (Get-Command Get-AppxPackage -ErrorAction SilentlyContinue)) { throw 'Appx package commands are unavailable; all-user shell cleanup cannot be confirmed.' }$\r$\n"
  FileWrite $R3 "  foreach ($$package in @(Get-AppxPackage -AllUsers -Name $$identity.Name -ErrorAction Stop)) {$\r$\n"
  FileWrite $R3 "    if ($$package.Name -cne $$identity.Name -or $$package.Publisher -cne $$identity.Publisher) { continue }$\r$\n"
  FileWrite $R3 "    $$users = @($$package.PackageUserInformation)$\r$\n"
  FileWrite $R3 "    if ($$users.Count -eq 0) { throw 'The registered Brclio package has no readable user registration state.' }$\r$\n"
  FileWrite $R3 "    foreach ($$user in $$users) {$\r$\n"
  FileWrite $R3 "      $$state = [string]$$user.InstallState$\r$\n"
  FileWrite $R3 "      # Staging alone creates no user's Explorer registration.$\r$\n"
  FileWrite $R3 "      if ($$state -cin @('NotInstalled', 'Staged')) { continue }$\r$\n"
  FileWrite $R3 "      $$sid = [string]$$user.UserSecurityId$\r$\n"
  FileWrite $R3 "      if ($$state -cne 'Installed' -or $$sid -cnotmatch '^S-\d-\d+(?:-\d+)+$$') { throw 'The registered Brclio package has an unknown user registration state.' }$\r$\n"
  FileWrite $R3 "      $$entry = [pscustomobject]@{ Name = $$package.Name; Publisher = $$package.Publisher; PackageFullName = $$package.PackageFullName; Version = $$package.Version; UserSid = $$sid }$\r$\n"
  FileWrite $R3 "      try {$\r$\n"
  FileWrite $R3 "        if (Test-BrclioShellPackage $$entry $$directory $$identity -Strict) { $$entry }$\r$\n"
  FileWrite $R3 "      } catch { throw ('Unable to validate Brclio shell registration for user ' + $$sid + ': ' + $$_.Exception.Message) }$\r$\n"
  FileWrite $R3 "    }$\r$\n"
  FileWrite $R3 "  }$\r$\n"
  FileWrite $R3 "}$\r$\n"
  FileWrite $R3 "$\r$\n"
  FileWrite $R3 "function Remove-BrclioShellPackagesAllUsers([string]$$directory, [hashtable]$$identity, [object[]]$$packages) {$\r$\n"
  FileWrite $R3 "  foreach ($$saved in $$packages) {$\r$\n"
  FileWrite $R3 "    # A package full name can be registered at different external roots for$\r$\n"
  FileWrite $R3 "    # different users. Never blindly remove that full name with -AllUsers.$\r$\n"
  FileWrite $R3 "    $$current = @(Get-BrclioShellPackagesAllUsers $$directory $$identity | Where-Object { $$_.PackageFullName -ceq $$saved.PackageFullName -and $$_.UserSid -ceq $$saved.UserSid })$\r$\n"
  FileWrite $R3 "    if ($$current.Count -gt 1) { throw 'Duplicate Brclio shell user registrations prevent safe cleanup.' }$\r$\n"
  FileWrite $R3 "    if ($$current.Count -eq 1) { Remove-AppxPackage -Package $$current[0].PackageFullName -User $$current[0].UserSid -ErrorAction Stop }$\r$\n"
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
  FileWrite $R3 "function Remove-BrclioShellMachineCertificateTrust([string]$$directory, [hashtable]$$identity) {$\r$\n"
  FileWrite $R3 "  $$machine = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::LocalMachine, [Microsoft.Win32.RegistryView]::Registry64)$\r$\n"
  FileWrite $R3 "  try { $$markers = $$machine.OpenSubKey('Software\Brclio\ShellCertificates') } finally { $$machine.Dispose() }$\r$\n"
  FileWrite $R3 "  if ($$null -eq $$markers) { return }$\r$\n"
  FileWrite $R3 "  $$owned = $$false$\r$\n"
  FileWrite $R3 "  try {$\r$\n"
  FileWrite $R3 "    foreach ($$thumbprint in $$markers.GetSubKeyNames()) {$\r$\n"
  FileWrite $R3 "      if ($$thumbprint -cnotmatch '^[A-Fa-f0-9]{40}$$') { continue }$\r$\n"
  FileWrite $R3 "      $$marker = $$markers.OpenSubKey($$thumbprint)$\r$\n"
  FileWrite $R3 "      if ($$null -eq $$marker) { continue }$\r$\n"
  FileWrite $R3 "      try {$\r$\n"
  FileWrite $R3 "        if ($$marker.GetValue('BrclioOwner') -ceq 'com.brclio.toolbox' -and [string]$$marker.GetValue('CertificateSha256') -cmatch '^[A-Fa-f0-9]{64}$$' -and -not [string]::IsNullOrWhiteSpace([string]$$marker.GetValue('Publisher'))) { $$owned = $$true; break }$\r$\n"
  FileWrite $R3 "      } finally { $$marker.Dispose() }$\r$\n"
  FileWrite $R3 "    }$\r$\n"
  FileWrite $R3 "  } finally { $$markers.Dispose() }$\r$\n"
  FileWrite $R3 "  if (-not $$owned) { return }$\r$\n"
  FileWrite $R3 "  $$assets = Join-Path $$directory 'resources\windows-shell'$\r$\n"
  FileWrite $R3 "  $$helper = Join-Path $$assets 'BrclioShellTrust.exe'$\r$\n"
  FileWrite $R3 "  # Older installations shipped no machine trust helper or machine markers.$\r$\n"
  FileWrite $R3 "  if (-not (Test-Path -LiteralPath $$helper -PathType Leaf)) { return }$\r$\n"
  FileWrite $R3 "  $$metadata = [IO.File]::ReadAllText((Join-Path $$assets 'shell-build.json')) | ConvertFrom-Json$\r$\n"
  FileWrite $R3 "  if ($$metadata.trustHelper -cne 'BrclioShellTrust.exe' -or $$metadata.trustHelperSha256 -cnotmatch '^[A-Fa-f0-9]{64}$$' -or (Get-BrclioShellFileHash $$helper) -ine $$metadata.trustHelperSha256) {$\r$\n"
  FileWrite $R3 "    throw 'The Brclio certificate cleanup helper checksum does not match this installation.'$\r$\n"
  FileWrite $R3 "  }$\r$\n"
  FileWrite $R3 "  $$certificate = New-Object Security.Cryptography.X509Certificates.X509Certificate2((Join-Path $$assets 'BrclioShell.cer'))$\r$\n"
  FileWrite $R3 "  try {$\r$\n"
  FileWrite $R3 "    $$signature = Get-AuthenticodeSignature -LiteralPath $$helper$\r$\n"
  FileWrite $R3 "    if ($$null -eq $$signature.SignerCertificate -or $$signature.SignerCertificate.Subject -cne $$identity.Publisher -or [Convert]::ToBase64String($$signature.SignerCertificate.RawData) -cne [Convert]::ToBase64String($$certificate.RawData)) {$\r$\n"
  FileWrite $R3 "      throw 'The Brclio certificate cleanup helper signer does not match this installation.'$\r$\n"
  FileWrite $R3 "    }$\r$\n"
  FileWrite $R3 "  } finally { $$certificate.Dispose() }$\r$\n"
  FileWrite $R3 "  Test-BrclioShellSignature $$helper $$identity.Publisher $$assets | Out-Null$\r$\n"
  FileWrite $R3 "  # Only the signed, hash-pinned fixed helper is elevated. It checks all users'$\r$\n"
  FileWrite $R3 "  # package dependencies and can remove only Brclio-marked TrustedPeople leaves.$\r$\n"
  FileWrite $R3 "  $$start = New-Object Diagnostics.ProcessStartInfo$\r$\n"
  FileWrite $R3 "  $$start.FileName = $$helper$\r$\n"
  FileWrite $R3 "  $$start.Arguments = '--cleanup'$\r$\n"
  FileWrite $R3 "  $$start.WorkingDirectory = $$assets$\r$\n"
  FileWrite $R3 "  $$start.UseShellExecute = $$true$\r$\n"
  FileWrite $R3 "  $$start.Verb = 'runas'$\r$\n"
  FileWrite $R3 "  $$process = [Diagnostics.Process]::Start($$start)$\r$\n"
  FileWrite $R3 "  if ($$null -eq $$process -or -not $$process.WaitForExit(180000)) { throw 'The Brclio certificate cleanup helper did not finish.' }$\r$\n"
  FileWrite $R3 "  if ($$process.ExitCode -ne 0) { throw ('The Brclio certificate cleanup helper failed (' + $$process.ExitCode + ').') }$\r$\n"
  FileWrite $R3 "}$\r$\n"
  FileWrite $R3 "$\r$\n"
  FileWrite $R3 "function Initialize-BrclioShellWinTrust {$\r$\n"
  FileWrite $R3 "  if ('Brclio.WindowsShell.WinTrust' -as [type]) { return }$\r$\n"
  FileWrite $R3 "  Add-Type -TypeDefinition @'$\r$\n"
  FileWrite $R3 "using System;$\r$\n"
  FileWrite $R3 "using System.Runtime.InteropServices;$\r$\n"
  FileWrite $R3 "namespace Brclio.WindowsShell {$\r$\n"
  FileWrite $R3 "  public static class WinTrust {$\r$\n"
  FileWrite $R3 "    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]$\r$\n"
  FileWrite $R3 "    private struct FileInfo {$\r$\n"
  FileWrite $R3 "      public UInt32 cbStruct;$\r$\n"
  FileWrite $R3 "      [MarshalAs(UnmanagedType.LPWStr)] public string filePath;$\r$\n"
  FileWrite $R3 "      public IntPtr fileHandle;$\r$\n"
  FileWrite $R3 "      public IntPtr knownSubject;$\r$\n"
  FileWrite $R3 "    }$\r$\n"
  FileWrite $R3 "    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]$\r$\n"
  FileWrite $R3 "    private struct TrustData {$\r$\n"
  FileWrite $R3 "      public UInt32 cbStruct;$\r$\n"
  FileWrite $R3 "      public IntPtr policyCallback;$\r$\n"
  FileWrite $R3 "      public IntPtr sipClient;$\r$\n"
  FileWrite $R3 "      public UInt32 uiChoice;$\r$\n"
  FileWrite $R3 "      public UInt32 revocationChecks;$\r$\n"
  FileWrite $R3 "      public UInt32 unionChoice;$\r$\n"
  FileWrite $R3 "      public IntPtr fileInfo;$\r$\n"
  FileWrite $R3 "      public UInt32 stateAction;$\r$\n"
  FileWrite $R3 "      public IntPtr stateData;$\r$\n"
  FileWrite $R3 "      public IntPtr urlReference;$\r$\n"
  FileWrite $R3 "      public UInt32 providerFlags;$\r$\n"
  FileWrite $R3 "      public UInt32 uiContext;$\r$\n"
  FileWrite $R3 "      public IntPtr signatureSettings;$\r$\n"
  FileWrite $R3 "    }$\r$\n"
  FileWrite $R3 "    [DllImport($\"wintrust.dll$\", ExactSpelling = true)]$\r$\n"
  FileWrite $R3 "    private static extern Int32 WinVerifyTrust(IntPtr window, [In] ref Guid action, [In, Out] ref TrustData data);$\r$\n"
  FileWrite $R3 "    public static UInt32 Verify(string path) {$\r$\n"
  FileWrite $R3 "      FileInfo file = new FileInfo();$\r$\n"
  FileWrite $R3 "      file.cbStruct = (UInt32)Marshal.SizeOf(typeof(FileInfo));$\r$\n"
  FileWrite $R3 "      file.filePath = path;$\r$\n"
  FileWrite $R3 "      file.fileHandle = IntPtr.Zero;$\r$\n"
  FileWrite $R3 "      file.knownSubject = IntPtr.Zero;$\r$\n"
  FileWrite $R3 "      IntPtr pointer = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(FileInfo)));$\r$\n"
  FileWrite $R3 "      bool marshaled = false;$\r$\n"
  FileWrite $R3 "      try {$\r$\n"
  FileWrite $R3 "        Marshal.StructureToPtr(file, pointer, false);$\r$\n"
  FileWrite $R3 "        marshaled = true;$\r$\n"
  FileWrite $R3 "        TrustData data = new TrustData();$\r$\n"
  FileWrite $R3 "        data.cbStruct = (UInt32)Marshal.SizeOf(typeof(TrustData));$\r$\n"
  FileWrite $R3 "        data.policyCallback = IntPtr.Zero;$\r$\n"
  FileWrite $R3 "        data.sipClient = IntPtr.Zero;$\r$\n"
  FileWrite $R3 "        data.uiChoice = 2;             // WTD_UI_NONE$\r$\n"
  FileWrite $R3 "        data.revocationChecks = 0;     // WTD_REVOKE_NONE$\r$\n"
  FileWrite $R3 "        data.unionChoice = 1;          // WTD_CHOICE_FILE$\r$\n"
  FileWrite $R3 "        data.fileInfo = pointer;$\r$\n"
  FileWrite $R3 "        data.stateAction = 1;          // WTD_STATEACTION_VERIFY$\r$\n"
  FileWrite $R3 "        data.stateData = IntPtr.Zero;$\r$\n"
  FileWrite $R3 "        data.urlReference = IntPtr.Zero;$\r$\n"
  FileWrite $R3 "        data.providerFlags = 0x1000;   // WTD_CACHE_ONLY_URL_RETRIEVAL$\r$\n"
  FileWrite $R3 "        data.uiContext = 0;$\r$\n"
  FileWrite $R3 "        data.signatureSettings = IntPtr.Zero;$\r$\n"
  FileWrite $R3 "        Guid action = new Guid($\"00AAC56B-CD44-11D0-8CC2-00C04FC295EE$\");$\r$\n"
  FileWrite $R3 "        try {$\r$\n"
  FileWrite $R3 "          return unchecked((UInt32)WinVerifyTrust(new IntPtr(-1), ref action, ref data));$\r$\n"
  FileWrite $R3 "        } finally {$\r$\n"
  FileWrite $R3 "          data.stateAction = 2;        // WTD_STATEACTION_CLOSE$\r$\n"
  FileWrite $R3 "          WinVerifyTrust(new IntPtr(-1), ref action, ref data);$\r$\n"
  FileWrite $R3 "        }$\r$\n"
  FileWrite $R3 "      } finally {$\r$\n"
  FileWrite $R3 "        if (marshaled) Marshal.DestroyStructure(pointer, typeof(FileInfo));$\r$\n"
  FileWrite $R3 "        Marshal.FreeHGlobal(pointer);$\r$\n"
  FileWrite $R3 "      }$\r$\n"
  FileWrite $R3 "    }$\r$\n"
  FileWrite $R3 "  }$\r$\n"
  FileWrite $R3 "}$\r$\n"
  FileWrite $R3 "'@$\r$\n"
  FileWrite $R3 "}$\r$\n"
  FileWrite $R3 "function Get-BrclioShellCertificateHash($$certificate) {$\r$\n"
  FileWrite $R3 "  $$sha = [Security.Cryptography.SHA256]::Create()$\r$\n"
  FileWrite $R3 "  try { return [BitConverter]::ToString($$sha.ComputeHash($$certificate.RawData)).Replace('-', '') } finally { $$sha.Dispose() }$\r$\n"
  FileWrite $R3 "}$\r$\n"
  FileWrite $R3 "function Get-BrclioShellFileHash([string]$$path) {$\r$\n"
  FileWrite $R3 "  $$stream = [IO.File]::OpenRead($$path)$\r$\n"
  FileWrite $R3 "  $$sha = [Security.Cryptography.SHA256]::Create()$\r$\n"
  FileWrite $R3 "  try { return [BitConverter]::ToString($$sha.ComputeHash($$stream)).Replace('-', '') }$\r$\n"
  FileWrite $R3 "  finally { $$sha.Dispose(); $$stream.Dispose() }$\r$\n"
  FileWrite $R3 "}$\r$\n"
  FileWrite $R3 "function Test-BrclioShellSignature([string]$$Path, [string]$$Publisher, [string]$$Directory) {$\r$\n"
  FileWrite $R3 "  $$signature = Get-AuthenticodeSignature -LiteralPath $$Path$\r$\n"
  FileWrite $R3 "  if ($$null -eq $$signature.SignerCertificate -or $$signature.SignerCertificate.Subject -cne $$Publisher) { throw 'Windows 右键扩展签名与包发布者不匹配。' }$\r$\n"
  FileWrite $R3 "  $$metadataPath = Join-Path $$Directory 'shell-build.json'$\r$\n"
  FileWrite $R3 "  $$metadata = $$null$\r$\n"
  FileWrite $R3 "  if (Test-Path -LiteralPath $$metadataPath -PathType Leaf) { $$metadata = [IO.File]::ReadAllText($$metadataPath) | ConvertFrom-Json }$\r$\n"
  FileWrite $R3 "  if ($$null -ne $$metadata -and $$null -ne $$metadata.PSObject.Properties['selfSigned'] -and $$metadata.selfSigned -isnot [bool]) { throw 'Windows 右键扩展签名元数据类型无效。' }$\r$\n"
  FileWrite $R3 "  if ($$null -eq $$metadata -or $$metadata.selfSigned -ne $$true) {$\r$\n"
  FileWrite $R3 "    if ($$signature.Status -ne 'Valid') { throw ('Windows 右键扩展未通过可信签名验证：' + $$signature.Status + ': ' + $$signature.StatusMessage) }$\r$\n"
  FileWrite $R3 "    return @{ trusted = $$true; needsTrust = $$false; currentUserTrusted = $$false; machineTrusted = $$false; certificateThumbprint = $$signature.SignerCertificate.Thumbprint; pinned = $$false; statusCode = [uint32]0 }$\r$\n"
  FileWrite $R3 "  }$\r$\n"
  FileWrite $R3 "  if ($$metadata.signed -isnot [bool] -or !$$metadata.signed -or $$metadata.publisher -cne $$Publisher -or $$metadata.certificateSha256 -isnot [string] -or $$metadata.certificateSha256 -notmatch '^[a-fA-F0-9]{64}$$' -or $$metadata.packageVersion -isnot [string] -or $$metadata.packageVersion -notmatch '^\d+\.\d+\.\d+\.\d+$$' -or $$metadata.dll -cne ($$metadata.packageVersion + '\BrclioExplorerCommand.dll')) { throw 'Windows 右键扩展签名元数据不完整或与包身份不匹配。' }$\r$\n"
  FileWrite $R3 "  $$certificatePath = Join-Path $$Directory 'BrclioShell.cer'$\r$\n"
  FileWrite $R3 "  if (!(Test-Path -LiteralPath $$certificatePath -PathType Leaf)) { throw 'Windows 右键扩展缺少专用公钥证书。' }$\r$\n"
  FileWrite $R3 "  $$certificate = New-Object Security.Cryptography.X509Certificates.X509Certificate2($$certificatePath)$\r$\n"
  FileWrite $R3 "  try {$\r$\n"
  FileWrite $R3 "    $$hash = Get-BrclioShellCertificateHash $$certificate$\r$\n"
  FileWrite $R3 "    $$eku = @($$certificate.Extensions | Where-Object { $$_.Oid.Value -eq '2.5.29.37' })$\r$\n"
  FileWrite $R3 "    $$basic = @($$certificate.Extensions | Where-Object { $$_.Oid.Value -eq '2.5.29.19' })$\r$\n"
  FileWrite $R3 "    $$usage = @($$certificate.Extensions | Where-Object { $$_.Oid.Value -eq '2.5.29.15' })$\r$\n"
  FileWrite $R3 "    $$codeSigning = $$eku.Count -eq 1 -and @($$eku[0].EnhancedKeyUsages | Where-Object { $$_.Value -eq '1.3.6.1.5.5.7.3.3' }).Count -eq 1$\r$\n"
  FileWrite $R3 "    if ($$hash -ine $$metadata.certificateSha256 -or $$certificate.Subject -cne $$Publisher -or $$certificate.Issuer -cne $$certificate.Subject -or !$$codeSigning -or $$basic.Count -ne 1 -or $$basic[0].CertificateAuthority -or $$usage.Count -ne 1 -or !($$usage[0].KeyUsages -band [Security.Cryptography.X509Certificates.X509KeyUsageFlags]::DigitalSignature) -or $$certificate.HasPrivateKey -or $$certificate.NotBefore -gt [DateTime]::Now -or $$certificate.NotAfter -lt [DateTime]::Now -or [Convert]::ToBase64String($$certificate.RawData) -cne [Convert]::ToBase64String($$signature.SignerCertificate.RawData)) { throw 'Windows 右键扩展的专用签名公钥证书不匹配或已失效。' }$\r$\n"
  FileWrite $R3 "    $$actualPath = [IO.Path]::GetFullPath($$Path)$\r$\n"
  FileWrite $R3 "    $$dllPath = [IO.Path]::GetFullPath((Join-Path $$Directory $$metadata.dll))$\r$\n"
  FileWrite $R3 "    $$msixPath = [IO.Path]::GetFullPath((Join-Path $$Directory 'BrclioShell.msix'))$\r$\n"
  FileWrite $R3 "    $$helperPath = [IO.Path]::GetFullPath((Join-Path $$Directory 'BrclioShellTrust.exe'))$\r$\n"
  FileWrite $R3 "    $$expectedHash = $$null$\r$\n"
  FileWrite $R3 "    if ([string]::Equals($$actualPath, $$dllPath, [StringComparison]::OrdinalIgnoreCase)) { $$expectedHash = $$metadata.sha256 }$\r$\n"
  FileWrite $R3 "    elseif ([string]::Equals($$actualPath, $$msixPath, [StringComparison]::OrdinalIgnoreCase)) { $$expectedHash = $$metadata.msixSha256 }$\r$\n"
  FileWrite $R3 "    elseif ([string]::Equals($$actualPath, $$helperPath, [StringComparison]::OrdinalIgnoreCase) -and $$metadata.trustHelper -ceq 'BrclioShellTrust.exe') { $$expectedHash = $$metadata.trustHelperSha256 }$\r$\n"
  FileWrite $R3 "    else { throw 'Windows 右键扩展签名文件路径与版本化安装清单不匹配。' }$\r$\n"
  FileWrite $R3 "    if ($$expectedHash -isnot [string] -or $$expectedHash -notmatch '^[a-fA-F0-9]{64}$$' -or (Get-BrclioShellFileHash $$Path) -ine $$expectedHash) { throw 'Windows 右键扩展文件校验和不匹配。' }$\r$\n"
  FileWrite $R3 "    Initialize-BrclioShellWinTrust$\r$\n"
  FileWrite $R3 "    $$code = [Brclio.WindowsShell.WinTrust]::Verify($$Path)$\r$\n"
  FileWrite $R3 "    # A pinned peer is not a globally trusted Windows root. Only this exact$\r$\n"
  FileWrite $R3 "    # root-chain error is eligible for our scoped peer policy. Bad digests,$\r$\n"
  FileWrite $R3 "    # revocation, expiration and every other failure remain fatal.$\r$\n"
  FileWrite $R3 "    if ($$code -ne [uint32]0 -and $$code -ne [uint32]2148204809) { throw ('Windows 右键扩展完整性验证失败：0x' + $$code.ToString('X8')) }$\r$\n"
  FileWrite $R3 "    $$peerTrust = @{}$\r$\n"
  FileWrite $R3 "    foreach ($$storeLocation in @('CurrentUser', 'LocalMachine')) {$\r$\n"
  FileWrite $R3 "      $$store = New-Object Security.Cryptography.X509Certificates.X509Store('TrustedPeople', $$storeLocation)$\r$\n"
  FileWrite $R3 "      try {$\r$\n"
  FileWrite $R3 "        $$store.Open([Security.Cryptography.X509Certificates.OpenFlags]::ReadOnly)$\r$\n"
  FileWrite $R3 "        $$matches = @($$store.Certificates.Find([Security.Cryptography.X509Certificates.X509FindType]::FindByThumbprint, $$certificate.Thumbprint, $$false) | Where-Object { [Convert]::ToBase64String($$_.RawData) -ceq [Convert]::ToBase64String($$certificate.RawData) })$\r$\n"
  FileWrite $R3 "        $$peerTrust[$$storeLocation] = $$matches.Count -gt 0$\r$\n"
  FileWrite $R3 "      } finally { $$store.Close() }$\r$\n"
  FileWrite $R3 "    }$\r$\n"
  FileWrite $R3 "    $$trusted = $$peerTrust.CurrentUser -or $$peerTrust.LocalMachine$\r$\n"
  FileWrite $R3 "    # Appx deployment validates against machine peer trust even though our$\r$\n"
  FileWrite $R3 "    # integrity policy can recognize the exact leaf in either peer store.$\r$\n"
  FileWrite $R3 "    return @{ trusted = [bool]$$trusted; needsTrust = !$$peerTrust.LocalMachine; currentUserTrusted = [bool]$$peerTrust.CurrentUser; machineTrusted = [bool]$$peerTrust.LocalMachine; certificateThumbprint = $$certificate.Thumbprint; pinned = $$true; statusCode = $$code }$\r$\n"
  FileWrite $R3 "  } finally { $$certificate.Dispose() }$\r$\n"
  FileWrite $R3 "}$\r$\n"
  FileWrite $R3 "$\r$\n"
  FileWrite $R3 "try {$\r$\n"
  FileWrite $R3 "  $$directory = [IO.Path]::GetDirectoryName($$env:BRCLIO_NSIS_EXECUTABLE)$\r$\n"
  FileWrite $R3 "  $$identity = Read-BrclioShellIdentity $$directory$\r$\n"
  FileWrite $R3 "  $$scope = $$env:BRCLIO_NSIS_INSTALL_MODE$\r$\n"
  FileWrite $R3 "  if ($$scope -ceq 'all') {$\r$\n"
  FileWrite $R3 "    $$packages = @(Get-BrclioShellPackagesAllUsers $$directory $$identity)$\r$\n"
  FileWrite $R3 "    Remove-BrclioShellPackagesAllUsers $$directory $$identity $$packages$\r$\n"
  FileWrite $R3 "    if (@(Get-BrclioShellPackagesAllUsers $$directory $$identity).Count -gt 0) { throw 'Owned Brclio shell user registrations remain.' }$\r$\n"
  FileWrite $R3 "  } elseif ($$scope -ceq 'CurrentUser') {$\r$\n"
  FileWrite $R3 "    $$packages = @(Get-BrclioShellPackages $$directory $$identity)$\r$\n"
  FileWrite $R3 "    Remove-BrclioShellPackages $$directory $$identity $$packages$\r$\n"
  FileWrite $R3 "    if (@(Get-BrclioShellPackages $$directory $$identity).Count -gt 0) { throw 'The owned Brclio shell package is still registered.' }$\r$\n"
  FileWrite $R3 "  } else { throw 'The Brclio uninstall account scope is unknown.' }$\r$\n"
  FileWrite $R3 "  Remove-BrclioShellMachineCertificateTrust $$directory $$identity$\r$\n"
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
  ; NSIS is 32-bit. Sysnative bypasses WOW64 redirection so Appx cmdlets and
  ; the native package APIs are available; keep upstream's path unchanged.
  StrCpy $R4 "$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe"
  IfFileExists "$R4" +2 0
  StrCpy $R4 "$PowerShellPath"
  nsExec::ExecToStack `"$R4" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\brclio-shell-uninstall.ps1"`
  Pop $R0
  Pop $R1
  Delete "$PLUGINSDIR\brclio-shell-uninstall.ps1"
  System::Call 'kernel32::SetEnvironmentVariable(t "BRCLIO_NSIS_EXECUTABLE", p 0)'
  System::Call 'kernel32::SetEnvironmentVariable(t "BRCLIO_NSIS_INSTALL_MODE", p 0)'
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
