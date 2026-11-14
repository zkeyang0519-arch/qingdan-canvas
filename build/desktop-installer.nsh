; The launcher and in-app updater must save and close Qingdao themselves.
; Never let NSIS terminate a reopened app or an unsaved old version.
!macro customCheckAppRunning
  StrCpy $R1 0
  ${Do}
    ${nsProcess::FindProcess} "${APP_EXECUTABLE_FILENAME}" $R0
    ${If} $R0 != 0
      ${ExitDo}
    ${EndIf}
    ${If} $R1 >= 100
      SetErrorLevel 2
      Quit
    ${EndIf}
    ; Electron starts the installer immediately before its saved quit. Allow
    ; that graceful exit, but never terminate any remaining process ourselves.
    Sleep 100
    IntOp $R1 $R1 + 1
  ${Loop}
!macroend

; electron-builder's top-level protocols declaration is not emitted by its
; NSIS target. Register the per-user Windows handler explicitly, including
; silent first installs where the application has not run yet.
!macro customInstall
  WriteRegStr HKCU "Software\Classes\qingdao" "" "URL:Qingdao Protocol"
  WriteRegStr HKCU "Software\Classes\qingdao" "URL Protocol" ""
  WriteRegStr HKCU "Software\Classes\qingdao\DefaultIcon" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}",0'
  WriteRegStr HKCU "Software\Classes\qingdao\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'
!macroend

!macro customUnInstall
  ReadRegStr $R0 HKCU "Software\Classes\qingdao\shell\open\command" ""
  StrCpy $R1 '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'
  ${If} $R0 == $R1
    DeleteRegKey HKCU "Software\Classes\qingdao"
  ${EndIf}
!macroend
