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

; Only remove integration keys carrying our ownership marker.
!macro customUnInstall
  ; NSIS passes --updated to the old uninstaller during an upgrade. Preserve
  ; path-copy ownership/commands; only an actual uninstall removes them.
  ${IfNot} ${isUpdated}
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
