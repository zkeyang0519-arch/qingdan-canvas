!include "${BUILD_RESOURCES_DIR}\desktop-progress.nsh"

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
  !insertmacro QingdaoBusyBar 1
  !insertmacro QingdaoStage "正在检查轻岛是否已退出…" "Checking whether Qingdao has closed…"
  qdCheckAgain:
  StrCpy $R1 0
  ${Do}
    ${nsProcess::FindProcess} "${APP_EXECUTABLE_FILENAME}" $R0
    ${If} $R0 != 0
      ${ExitDo}
    ${EndIf}
    ${If} $R1 >= 100
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
  WriteRegStr SHCTX "Software\Classes\qingdao" "" "URL:Qingdao Protocol"
  WriteRegStr SHCTX "Software\Classes\qingdao" "URL Protocol" ""
  WriteRegStr SHCTX "Software\Classes\qingdao\DefaultIcon" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}",0'
  WriteRegStr SHCTX "Software\Classes\qingdao\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'
  !insertmacro QingdaoStage "安装完成，轻岛已就绪。" "Installation complete. Qingdao is ready."
  !insertmacro QingdaoBusyBar 0
!macroend

!macro customUnInstall
  ReadRegStr $R0 SHCTX "Software\Classes\qingdao\shell\open\command" ""
  StrCpy $R1 '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'
  ${If} $R0 == $R1
    DeleteRegKey SHCTX "Software\Classes\qingdao"
  ${EndIf}
!macroend
