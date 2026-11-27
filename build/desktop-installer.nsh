!include "${BUILD_RESOURCES_DIR}\desktop-progress.nsh"

!if "${APP_ID}" S== "cn.zky.qingdao.beta"
  !define QINGDAO_PROTOCOL "qingdao-beta"
  !define QINGDAO_STATE_DIRECTORY "QingdaoBeta"
!else
  !define QINGDAO_PROTOCOL "qingdao"
  !define QINGDAO_STATE_DIRECTORY "Qingdao"
!endif

!macro QingdaoInstallTrace text
  Push $R9
  CreateDirectory "$LOCALAPPDATA\${QINGDAO_STATE_DIRECTORY}"
  FileOpen $R9 "$LOCALAPPDATA\${QINGDAO_STATE_DIRECTORY}\installer.log" a
  FileSeek $R9 0 END
  FileWrite $R9 "${APP_ID} ${VERSION}: ${text}$\r$\n"
  FileClose $R9
  Pop $R9
  ClearErrors
!macroend

!ifndef BUILD_UNINSTALLER
  Var qdOriginalTemp
  Var qdOriginalTmp
  Var qdUpdateTemp
  Var qdTempChanged
  !macro customInit
    StrCpy $qdTempChanged 0
    ${GetRoot} "$INSTDIR" $R0
    ${GetRoot} "$TEMP" $R1
    ${If} $R0 != $R1
      ; Older NSIS uninstallers rename into their plugin temp directory. Keep
      ; their temporary files on the installation volume, including D: installs.
      StrCpy $qdUpdateTemp "$INSTDIR.qingdao-update-temp"
      ${If} ${FileExists} "$qdUpdateTemp\*.*"
        ReadINIStr $R0 "$qdUpdateTemp\owner.ini" "Qingdao" "AppId"
        ${If} $R0 != "${APP_ID}"
          !insertmacro QingdaoInstallTrace "unrecognized update temp directory; aborted"
          SetErrorLevel 2
          Quit
        ${EndIf}
      ${EndIf}
      ClearErrors
      CreateDirectory "$qdUpdateTemp"
      WriteINIStr "$qdUpdateTemp\owner.ini" "Qingdao" "AppId" "${APP_ID}"
      ${If} ${Errors}
        !insertmacro QingdaoInstallTrace "update temp directory not writable; aborted"
        SetErrorLevel 2
        Quit
      ${EndIf}
      ReadEnvStr $qdOriginalTemp "TEMP"
      ReadEnvStr $qdOriginalTmp "TMP"
      System::Call 'kernel32::SetEnvironmentVariableW(w "TEMP", w "$qdUpdateTemp") i.r0'
      System::Call 'kernel32::SetEnvironmentVariableW(w "TMP", w "$qdUpdateTemp") i.r1'
      StrCpy $qdTempChanged 1
      ${If} $0 == 0
      ${OrIf} $1 == 0
        !insertmacro QingdaoInstallTrace "cannot configure same-volume temp; aborted"
        SetErrorLevel 2
        Quit
      ${EndIf}
      !insertmacro QingdaoInstallTrace "configured same-volume update temp"
    ${EndIf}
    ; Do not keep the parent installer's cwd inside the directory the old
    ; uninstaller needs to rename atomically.
    SetOutPath $TEMP
  !macroend
!endif

!macro customRemoveFiles
  ${If} ${isUpdated}
    Var /GLOBAL qdPreviousInstall
    ; Rename the whole owned program directory beside itself. This is atomic,
    ; stays on the same volume and does not walk long dependency paths.
    SetOutPath $TEMP
    System::Call 'kernel32::GetCurrentProcessId() i.r0'
    System::Call 'kernel32::GetTickCount() i.r1'
    StrCpy $qdPreviousInstall "$INSTDIR.previous-$0-$1"
    ${If} ${FileExists} "$qdPreviousInstall\*.*"
      SetErrorLevel 2
      Quit
    ${EndIf}
    ClearErrors
    Rename "$INSTDIR" "$qdPreviousInstall"
    ${If} ${Errors}
      !insertmacro QingdaoInstallTrace "program directory busy; original installation retained"
      SetErrorLevel 2
      Quit
    ${EndIf}
    FileOpen $R8 "$qdPreviousInstall\.qingdao-owned-backup" w
    FileWrite $R8 "${APP_ID}"
    FileClose $R8
    WriteINIStr "$INSTDIR.qingdao-rollback.ini" "Qingdao" "AppId" "${APP_ID}"
    WriteINIStr "$INSTDIR.qingdao-rollback.ini" "Qingdao" "Backup" "$qdPreviousInstall"
    ${If} ${Errors}
      Rename "$qdPreviousInstall" "$INSTDIR"
      !insertmacro QingdaoInstallTrace "backup receipt failed; restored previous directory"
      SetErrorLevel 2
      Quit
    ${EndIf}
    !insertmacro QingdaoInstallTrace "previous program directory saved on the same volume"
  ${Else}
    SetOutPath $TEMP
    RMDir /r "$INSTDIR"
  ${EndIf}
!macroend

; Add the maintenance choice before the standard directory picker. Silent
; updates use electron-builder's registered directory without any UI.
!macro customPageAfterChangeDir
  Var qdPreviousDir
  Var qdChangeDir
  Var qdReplaceRadio
  Var qdChangeRadio
  Page custom qdChooseMode qdLeaveMode
  !define MUI_PAGE_CUSTOMFUNCTION_PRE qdDirectoryPre
  !define MUI_PAGE_CUSTOMFUNCTION_LEAVE qdDirectoryLeave
  !insertmacro MUI_PAGE_DIRECTORY

  Function qdChooseMode
    ${If} ${isUpdated}
      Abort
    ${EndIf}
    ReadRegStr $qdPreviousDir SHCTX "${INSTALL_REGISTRY_KEY}" "InstallLocation"
    ${IfNot} ${FileExists} "$qdPreviousDir\${APP_EXECUTABLE_FILENAME}"
      StrCpy $qdPreviousDir ""
      Abort
    ${EndIf}
    nsDialogs::Create 1018
    Pop $0
    ${If} $LANGUAGE == 2052
      !insertmacro MUI_HEADER_TEXT "选择安装方式" "已找到这台电脑上的轻岛"
      ${NSD_CreateLabel} 0 4u 100% 30u "当前安装位置$\r$\n$qdPreviousDir"
      Pop $0
      ${NSD_CreateRadioButton} 0 45u 100% 16u "覆盖已有版本，沿用当前安装位置"
      Pop $qdReplaceRadio
      ${NSD_CreateRadioButton} 0 69u 100% 16u "更换安装位置，选择其他文件夹"
    ${Else}
      !insertmacro MUI_HEADER_TEXT "Choose how to install" "An existing Qingdao installation was found"
      ${NSD_CreateLabel} 0 4u 100% 30u "Current installation$\r$\n$qdPreviousDir"
      Pop $0
      ${NSD_CreateRadioButton} 0 45u 100% 16u "Replace the existing version in its current folder"
      Pop $qdReplaceRadio
      ${NSD_CreateRadioButton} 0 69u 100% 16u "Move Qingdao to another folder"
    ${EndIf}
    Pop $qdChangeRadio
    ${If} $qdChangeDir == 1
      ${NSD_Check} $qdChangeRadio
    ${Else}
      ${NSD_Check} $qdReplaceRadio
    ${EndIf}
    nsDialogs::Show
  FunctionEnd
  Function qdLeaveMode
    ${NSD_GetState} $qdChangeRadio $qdChangeDir
    ${If} $qdChangeDir != 1
      StrCpy $INSTDIR $qdPreviousDir
    ${EndIf}
  FunctionEnd
  Function qdDirectoryPre
    ${If} ${isUpdated}
      Abort
    ${EndIf}
    ${If} $qdPreviousDir != ""
    ${AndIf} $qdChangeDir != 1
      Abort
    ${EndIf}
  FunctionEnd
  Function qdDirectoryLeave
    ${NSD_GetText} $mui.DirectoryPage.Directory $0
    StrCmp $0 "" qdInvalidFolder
    GetFullPathName $0 "$0"
    ${If} $qdPreviousDir != ""
    ${AndIf} $0 == $qdPreviousDir
      Return
    ${EndIf}
    ; The stock uninstaller owns its application folder. Accept a dedicated
    ; empty/new destination so unrelated files cannot become uninstall targets.
    System::Call 'shlwapi::PathIsRootW(w r0)i.r1'
    StrCmp $1 1 qdInvalidFolder
    System::Call 'kernel32::GetFileAttributesW(w r0)i.r1'
    StrCmp $1 -1 qdValidFolder
    System::Call 'shlwapi::PathIsDirectoryEmptyW(w r0)i.r1'
    StrCmp $1 0 qdInvalidFolder
    qdValidFolder:
    Return
    qdInvalidFolder:
    ${If} $LANGUAGE == 2052
      MessageBox MB_OK|MB_ICONEXCLAMATION "请选择一个新的或空的轻岛安装文件夹。"
    ${Else}
      MessageBox MB_OK|MB_ICONEXCLAMATION "Choose a new or empty folder for Qingdao."
    ${EndIf}
    Abort
  FunctionEnd
!macroend

; The launcher and in-app updater must save and close Qingdao themselves.
; Never let NSIS terminate a reopened app or an unsaved old version.
!macro customCheckAppRunning
  SetOutPath $TEMP
  !insertmacro QingdaoInstallTrace "working directory released before update"
  !insertmacro QingdaoInstallTrace "checking application exit"
  !insertmacro QingdaoBusyBar 1
  !insertmacro QingdaoStage "正在检查轻岛是否已退出…" "Checking whether Qingdao has closed…"
  qdCheckAgain:
  StrCpy $R1 0
  ${Do}
    ${nsProcess::FindProcess} "${APP_EXECUTABLE_FILENAME}" $R0
    ${If} $R0 != 0
      !insertmacro QingdaoInstallTrace "application exit confirmed"
      ${ExitDo}
    ${EndIf}
    ${If} $R1 >= 600
      !insertmacro QingdaoInstallTrace "application still running; installation cancelled"
      ${IfNot} ${Silent}
        ${If} $LANGUAGE == 2052
          MessageBox MB_RETRYCANCEL|MB_ICONINFORMATION "请先从轻岛托盘菜单退出，等待办保存后再点「重试」。" IDRETRY qdCheckAgain
        ${Else}
          MessageBox MB_RETRYCANCEL|MB_ICONINFORMATION "Quit Qingdao from its tray menu, then click Retry." IDRETRY qdCheckAgain
        ${EndIf}
      ${EndIf}
      SetErrorLevel 2
      Quit
    ${EndIf}
    ; Electron starts the installer immediately before its saved quit. Allow
    ; that graceful exit, but never terminate any remaining process ourselves.
    Sleep 100
    IntOp $R1 $R1 + 1
  ${Loop}
  !insertmacro QingdaoStage "正在准备安装目录并解压程序文件…" "Preparing the installation folder and extracting files…"
!macroend

!macro customFiles_x64
  !insertmacro QingdaoStage "正在登记新版本和启动入口…" "Registering the new version and its shortcuts…"
!macroend

; electron-builder's top-level protocols declaration is not emitted by its
; NSIS target. Register the handler in the selected Windows scope, including
; silent first installs where the application has not run yet.
!macro customInstall
  WriteRegStr SHCTX "Software\Classes\${QINGDAO_PROTOCOL}" "" "URL:Qingdao Protocol"
  WriteRegStr SHCTX "Software\Classes\${QINGDAO_PROTOCOL}" "URL Protocol" ""
  WriteRegStr SHCTX "Software\Classes\${QINGDAO_PROTOCOL}\DefaultIcon" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}",0'
  WriteRegStr SHCTX "Software\Classes\${QINGDAO_PROTOCOL}\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'
  !insertmacro QingdaoStage "安装完成，轻岛已就绪。" "Installation complete. Qingdao is ready."
  !insertmacro QingdaoBusyBar 0
  !insertmacro QingdaoInstallTrace "files and channel protocol installed"
  ${If} $qdTempChanged == 1
    System::Call 'kernel32::SetEnvironmentVariableW(w "TEMP", w "$qdOriginalTemp")'
    System::Call 'kernel32::SetEnvironmentVariableW(w "TMP", w "$qdOriginalTmp")'
  ${EndIf}
  ReadINIStr $R0 "$INSTDIR.qingdao-rollback.ini" "Qingdao" "AppId"
  ${If} $R0 == "${APP_ID}"
    ReadINIStr $R1 "$INSTDIR.qingdao-rollback.ini" "Qingdao" "Backup"
    ExecWait '"$INSTDIR\resources\local-service\node.exe" "$INSTDIR\resources\local-service\desktop\cleanup-installation.cjs" "$R1" "$INSTDIR" "${APP_ID}"' $R2
    ${If} $R2 == 0
      Delete "$INSTDIR.qingdao-rollback.ini"
      !insertmacro QingdaoInstallTrace "previous program backup cleaned"
    ${Else}
      !insertmacro QingdaoInstallTrace "previous program backup retained for repair"
    ${EndIf}
  ${EndIf}
  ; This installer is per-user and cannot elevate. Launch the updated executable
  ; directly so the current user's environment and isolated profile survive.
  ; Interactive installs retain the normal finish-page launch choice.
  ${If} ${Silent}
  ${AndIf} ${isUpdated}
  ${AndIf} ${isForceRun}
    ClearErrors
    Exec '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --updated'
    ${If} ${Errors}
      !insertmacro QingdaoInstallTrace "updated application launch failed"
      SetErrorLevel 3
      Quit
    ${EndIf}
    !insertmacro QingdaoInstallTrace "updated application launch requested"
    !insertmacro quitSuccess
  ${EndIf}
!macroend

!macro customUnInstall
  !insertmacro QingdaoInstallTrace "uninstalling application files"
  ${IfNot} ${isUpdated}
    ReadRegStr $R0 SHCTX "Software\Classes\${QINGDAO_PROTOCOL}\shell\open\command" ""
    StrCpy $R1 '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'
    ${If} $R0 == $R1
      DeleteRegKey SHCTX "Software\Classes\${QINGDAO_PROTOCOL}"
    ${EndIf}
  ${EndIf}
!macroend
