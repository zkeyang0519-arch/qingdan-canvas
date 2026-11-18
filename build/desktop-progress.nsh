!ifndef QINGDAO_INSTALL_PROGRESS
!define QINGDAO_INSTALL_PROGRESS

; NSIS cannot measure the old uninstaller or the embedded archive's extraction.
; Animate its native progress control while those operations are in flight.
!macro QingdaoBusyBar active
  ${IfNot} ${Silent}
    Push $0
    Push $1
    FindWindow $0 "#32770" "" $HWNDPARENT
    GetDlgItem $0 $0 1004
    ${If} $0 != 0
      System::Call 'user32::GetWindowLongW(p r0, i -16)i.r1'
      !if ${active} == 1
        IntOp $1 $1 | 0x08
        System::Call 'user32::SetWindowLongW(p r0, i -16, i r1)'
        SendMessage $0 0x040A 1 40 ; PBM_SETMARQUEE
      !else
        SendMessage $0 0x040A 0 0
        IntOp $1 $1 & 0xfffffff7
        System::Call 'user32::SetWindowLongW(p r0, i -16, i r1)'
        SendMessage $0 0x0406 0 100 ; PBM_SETRANGE32
        SendMessage $0 0x0402 100 0 ; PBM_SETPOS
      !endif
    ${EndIf}
    Pop $1
    Pop $0
  ${EndIf}
!macroend

!macro QingdaoStage zh en
  SetDetailsPrint textonly
  ${If} $LANGUAGE == 2052
    DetailPrint "${zh}"
  ${Else}
    DetailPrint "${en}"
  ${EndIf}
  SetDetailsPrint lastused
!macroend

; Tauri supplies the directory and maintenance pages and WebView2 status.
!macro NSIS_HOOK_PREINSTALL
  !insertmacro QingdaoBusyBar 1
  !insertmacro QingdaoStage "正在写入轻岛轻量版程序文件…" "Installing Qingdao Preview files…"
!macroend

!macro NSIS_HOOK_POSTINSTALL
  !insertmacro QingdaoStage "轻量版程序和启动入口已就绪。" "Qingdao Preview and its shortcuts are ready."
  !insertmacro QingdaoBusyBar 0
!macroend
!endif
