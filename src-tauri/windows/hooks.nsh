; hooks.nsh — Fude の Windows インストーラー (NSIS) に差し込む処理。
; tauri.conf.json の bundle.windows.nsis.installerHooks から読み込まれる。
;
; 「プログラムから開く」で Fude を選ぶと、Windows は起動先を
; HKCU\Software\Classes\Applications\fude.exe\shell\open\command に覚え、.md の既定アプリ
; (UserChoice の ProgId = Applications\fude.exe) はそこを見る。以前 MSI で
; C:\Program Files\Fude に入れていた頃の値が残ったまま今の場所 (%LOCALAPPDATA%\Fude) へ
; 入れ直すと、既定アプリが存在しない exe を指して「アプリケーションが見つかりません」になる。
; そこでインストール（更新を含む）のたびに今の場所へ書き直す。

!macro NSIS_HOOK_POSTINSTALL
  WriteRegStr HKCU "Software\Classes\Applications\${MAINBINARYNAME}.exe\shell\open\command" "" '"$INSTDIR\${MAINBINARYNAME}.exe" "%1"'
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ; 更新のための一時的なアンインストールでは消さない。消すのは自分を指しているときだけ
  ; （別の場所に入れた Fude の設定は残す）。
  ${If} $UpdateMode <> 1
    ReadRegStr $R0 HKCU "Software\Classes\Applications\${MAINBINARYNAME}.exe\shell\open\command" ""
    ${If} $R0 == '"$INSTDIR\${MAINBINARYNAME}.exe" "%1"'
      DeleteRegKey HKCU "Software\Classes\Applications\${MAINBINARYNAME}.exe"
    ${EndIf}
  ${EndIf}
!macroend
