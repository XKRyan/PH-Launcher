; PH Launcher 安装器：只有一种发布形态（安装版）。
;
; 架构约定：程序文件夹里 = PH Launcher.exe + PingheLauncherLite.exe + data/。
; 安装时就把 data 目录建好，用户打开程序前就能看到数据放在哪里；
; 卸载时绝不删除 data/（里面有课表、日程、AI 会话和账号配置）。
!macro customInstall
  CreateDirectory "$INSTDIR\data"
  DetailPrint "已创建共用数据文件夹：$INSTDIR\data"
!macroend

!macro customUnInstall
  ; 数据文件夹原样保留。要彻底清理请手动删除 $INSTDIR\data。
  DetailPrint "共用数据文件夹保留在：$INSTDIR\data"
!macroend
