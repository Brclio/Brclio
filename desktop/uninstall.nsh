; Only remove integration keys carrying our ownership marker.
!macro customUnInstall
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
!macroend
