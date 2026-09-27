; PH Launcher 安装器：只有一种发布形态（安装版）。
;
; 架构约定：程序文件夹里 = PH Launcher.exe + PingheLauncherLite.exe + data/。
; 安装时就把 data 目录建好，用户打开程序前就能看到数据放在哪里。
;
; 数据安全：electron-builder 默认的卸载流程是 RMDir /r $INSTDIR，会把 data/ 一起删掉
; ——课表、日程、账号、AI 会话全在里面。这里接管文件删除（customRemoveFiles）：
; 只删程序文件，data/ 原地保留，卸载后文件夹里只剩用户自己的数据。
!macro customInstall
  CreateDirectory "$INSTDIR\data"
  DetailPrint "已创建共用数据文件夹：$INSTDIR\data"
!macroend

!macro customUnInstall
  DetailPrint "用户数据保留在：$INSTDIR\data"
!macroend

; 替换模板里 "RMDir /r $INSTDIR" 那一段。
; 注意：这里绝不递归删除 $INSTDIR 本身，只删程序文件与程序目录。
!macro customRemoveFiles
  SetOutPath $TEMP
  RMDir /r "$INSTDIR\locales"
  RMDir /r "$INSTDIR\resources"
  Delete "$INSTDIR\*.dll"
  Delete "$INSTDIR\*.pak"
  Delete "$INSTDIR\*.bin"
  Delete "$INSTDIR\*.dat"
  Delete "$INSTDIR\*.json"
  Delete "$INSTDIR\*.txt"
  Delete "$INSTDIR\*.html"
  Delete "$INSTDIR\PH Launcher.exe"
  Delete "$INSTDIR\Uninstall PH Launcher.exe"
  Delete "$INSTDIR\${UNINSTALL_FILENAME}"
  ; 目录非空（里面还有 data/）时 RMDir 会失败，这正是想要的结果：
  ; 卸载后 $INSTDIR 只剩用户的 data/。
  RMDir "$INSTDIR"
!macroend
