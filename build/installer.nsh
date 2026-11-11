; PH Launcher 安装器：只有一种发布形态（安装版）。
;
; 架构约定：程序文件夹里 = PH Launcher.exe + PingheLauncherLite.exe + data/。
; 安装时就把 data 目录建好，用户打开程序前就能看到数据放在哪里。
;
; 数据安全：electron-builder 默认的卸载流程是 RMDir /r $INSTDIR，会把 data/ 一起删掉
; ——课表、日程、账号、AI 会话全在里面。这里接管文件删除（customRemoveFiles）：
; 只删程序文件，data/ 原地保留，卸载后文件夹里只剩用户自己的数据。

; 两个安装器共用每用户的安装登记。变量必须是全局的，因为 customInit 检出的数据根
; 要在目录页之后的 customInstall 中继续使用；用户改安装目录时也不能丢掉 Lite 的数据根。
; 构建卸载器时这些变量不会被使用，条件声明可避免 electron-builder 把 NSIS 警告当成错误。
!ifndef BUILD_UNINSTALLER
  Var /GLOBAL DetectedLiteInstallDir
  Var /GLOBAL DetectedLiteDataRoot
  ; 目录页直接说明联动规则；这只是检测到 Lite 时的默认值，用户仍可自由修改。
  !ifndef MUI_DIRECTORYPAGE_TEXT_TOP
    !define MUI_DIRECTORYPAGE_TEXT_TOP "选择 PH Launcher 的安装目录。若检测到 Pinghe Launcher Lite，将默认装到它的目录并共用数据根；你仍可更改。"
  !endif
!endif

; Node/Python 按规范原子写 UTF-8 无 BOM，但 Windows 原生 INI API 会用系统 ANSI 代码页读取，
; 中文安装/数据路径会乱码。读取前只做编码转换到临时 UTF-16LE INI；内容不执行、不改原登记。
; PowerShell 不可用时退回 ReadINIStr 原路径，至少 ASCII 路径的旧机仍可联动。
!macro preparePingheRegistryForRead ResultFile ExitCode Output Suffix
  StrCpy ${ResultFile} "$LOCALAPPDATA\PingheSeries\installations.ini"
  Delete "$TEMP\phl-installations-utf16.ini"
  nsExec::ExecToStack "$\"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe$\" -NoLogo -NoProfile -NonInteractive -Command $\"$$source=Join-Path $$env:LOCALAPPDATA 'PingheSeries\installations.ini'; $$text=if([IO.File]::Exists($$source)){[IO.File]::ReadAllText($$source,[Text.UTF8Encoding]::new($$false))}else{''}; [IO.File]::WriteAllText((Join-Path $$env:TEMP 'phl-installations-utf16.ini'),$$text,[Text.Encoding]::Unicode)$\""
  Pop ${ExitCode}
  Pop ${Output}
  StrCmp ${ExitCode} "0" 0 phl_prepare_registry_done_${Suffix}
  IfFileExists "$TEMP\phl-installations-utf16.ini" 0 phl_prepare_registry_done_${Suffix}
  StrCpy ${ResultFile} "$TEMP\phl-installations-utf16.ini"
phl_prepare_registry_done_${Suffix}:
!macroend

; WriteINIStr 在 Unicode 临时 INI 上更新自己的节，再把完整文件转回 UTF-8 无 BOM并原子替换；
; 这样既满足 NSIS 原生读写，又不把 Node/Python 共用登记变成混合 ANSI/UTF-16 编码。
!macro commitPreparedPingheRegistry PreparedFile ExitCode Output Suffix
  StrCmp ${PreparedFile} "$TEMP\phl-installations-utf16.ini" 0 phl_commit_registry_done_${Suffix}
  nsExec::ExecToStack "$\"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe$\" -NoLogo -NoProfile -NonInteractive -Command $\"$$source=Join-Path $$env:TEMP 'phl-installations-utf16.ini'; $$target=Join-Path $$env:LOCALAPPDATA 'PingheSeries\installations.ini'; $$text=[IO.File]::ReadAllText($$source,[Text.Encoding]::Unicode); $$token=([Guid]::NewGuid()).ToString('N'); $$temporary=$$target+'.'+$$token+'.tmp'; $$backup=$$target+'.'+$$token+'.bak'; [IO.File]::WriteAllText($$temporary,$$text,[Text.UTF8Encoding]::new($$false)); if([IO.File]::Exists($$target)){[IO.File]::Replace($$temporary,$$target,$$backup); [IO.File]::Delete($$backup)}else{[IO.File]::Move($$temporary,$$target)}$\""
  Pop ${ExitCode}
  Pop ${Output}
  StrCmp ${ExitCode} "0" phl_commit_registry_done_${Suffix}
  DetailPrint "安装登记 UTF-8 原子写失败；应用启动后会重试，不影响安装和用户数据。"
phl_commit_registry_done_${Suffix}:
  Delete "$TEMP\phl-installations-utf16.ini"
!macroend

!macro customInit
  SetShellVarContext current
  StrCpy $DetectedLiteInstallDir ""
  StrCpy $DetectedLiteDataRoot ""

  ; 1) 新版 Lite 的登记优先。path 必须仍有 Lite 主程序，避免陈旧登记把目录页带错位置。
  !insertmacro preparePingheRegistryForRead $0 $8 $9 init
  ReadINIStr $1 "$0" "phl-lite" "path"
  ReadINIStr $2 "$0" "phl-lite" "data_root"
  Delete "$TEMP\phl-installations-utf16.ini"
  StrCmp $1 "" phl_detect_lite_from_registry
  ; 登记只接受绝对路径：相对值经 GetFullPathName 后会改变，直接忽略并走安全 fallback。
  GetFullPathName $8 "$1"
  StrCmp $8 "$1" 0 phl_detect_lite_from_registry
  IfFileExists "$1\PingheLauncherLite.exe" 0 phl_detect_lite_from_registry
  StrCpy $DetectedLiteInstallDir "$1"
  StrCpy $DetectedLiteDataRoot "$2"
  StrCmp $DetectedLiteDataRoot "" phl_detect_lite_done
  GetFullPathName $8 "$DetectedLiteDataRoot"
  StrCmp $8 "$DetectedLiteDataRoot" phl_detect_lite_done
  ; path 有效但 data_root 损坏时仍可联目录；数据根安全回退到用户最后选择的 $INSTDIR\data。
  StrCpy $DetectedLiteDataRoot ""
  Goto phl_detect_lite_done

phl_detect_lite_from_registry:
  ; 2) 旧版 Lite 没有安装登记时枚举 HKCU 卸载项；只接受名称、目录和 exe 都匹配的项。
  StrCpy $3 0
phl_detect_lite_registry_loop:
  EnumRegKey $4 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall" $3
  StrCmp $4 "" phl_detect_lite_standard_directory
  IntOp $3 $3 + 1
  ReadRegStr $5 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\$4" "DisplayName"
  StrCmp $5 "Pinghe Launcher Lite" 0 phl_detect_lite_registry_loop
  ReadRegStr $6 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\$4" "InstallLocation"
  StrCmp $6 "" phl_detect_lite_registry_loop
  GetFullPathName $8 "$6"
  StrCmp $8 "$6" 0 phl_detect_lite_registry_loop
  IfFileExists "$6\PingheLauncherLite.exe" 0 phl_detect_lite_registry_loop
  StrCpy $DetectedLiteInstallDir "$6"
  StrCpy $DetectedLiteDataRoot "$6\data"
  Goto phl_detect_lite_done

phl_detect_lite_standard_directory:
  ; 3) 注册表也没有时只检查双方约定的 per-user 标准目录；否则保留 PHL 自己的默认值。
  IfFileExists "$LOCALAPPDATA\Programs\PH Launcher\PingheLauncherLite.exe" 0 phl_detect_lite_done
  StrCpy $DetectedLiteInstallDir "$LOCALAPPDATA\Programs\PH Launcher"
  StrCpy $DetectedLiteDataRoot "$LOCALAPPDATA\Programs\PH Launcher\data"

phl_detect_lite_done:
  StrCmp $DetectedLiteInstallDir "" phl_custom_init_done

  ; electron-builder 的安装范围页离开时会再次执行 setInstallModePerUser，并据此重置
  ; $INSTDIR。两处同时赋值，才能让随后显示的目录页真正以 Lite 目录为默认值。
  ; 显式 /D 始终由用户/自动更新器优先，不能被自动检测覆盖。
  !insertmacro GetDParameter $7
  StrCmp $7 "" 0 phl_custom_init_done
  StrCpy $perUserInstallationFolder "$DetectedLiteInstallDir"
  ; Lite 是 per-user 安装；明确选择 all-users 时仍沿用 Program Files，不把机器级安装带进用户目录。
  StrCmp $installMode "all" phl_custom_init_done
  StrCpy $INSTDIR "$DetectedLiteInstallDir"

phl_custom_init_done:
  ; 只在读每用户登记时临时切到 current，不能破坏 electron-builder 已选好的安装范围。
  StrCmp $installMode "all" 0 phl_custom_init_scope_restored
  SetShellVarContext all
phl_custom_init_scope_restored:
!macroend

!macro customInstall
  SetShellVarContext current

  ; 保留既有约定：安装目录下始终可见 data/。Lite 登记了外置数据根时，另行创建该目录；
  ; 两处都只 CreateDirectory，绝不迁移、覆盖或删除任何已有数据。
  CreateDirectory "$INSTDIR\data"
  StrCpy $0 "$INSTDIR\data"
  StrCmp $DetectedLiteDataRoot "" phl_data_root_ready
  StrCpy $0 "$DetectedLiteDataRoot"
phl_data_root_ready:
  CreateDirectory "$0"
  DetailPrint "PH Launcher 共用数据根：$0"

  ; 登记只用于互相发现，PHL 自己仍按 data-root.txt 解析实际数据根。安装时把采用值写进
  ; Electron 改向前的固定 userData（%APPDATA%\PH Launcher），否则外置 Lite data_root
  ; 只出现在登记里、PHL 启动后却仍会回到 $INSTDIR\data。UTF-16LE+BOM 可无损保存中文路径。
  CreateDirectory "$APPDATA\PH Launcher"
  ; 升级不能覆盖用户已有的显式 data-root.txt；只有新装/尚未选择过数据根时写默认采用值。
  IfFileExists "$APPDATA\PH Launcher\data-root.txt" phl_data_pointer_ready
  FileOpen $9 "$APPDATA\PH Launcher\data-root.txt" w
  FileWriteUTF16LE /BOM $9 "$0$\r$\n"
  FileClose $9
phl_data_pointer_ready:

  ; WriteINIStr 只改 [phl] 的键，现有 [phl-lite] 节原样保留。先在 Unicode 临时 INI
  ; 上操作，再原子转回双方约定的 UTF-8 无 BOM，中文路径不会变成 ANSI 乱码。
  CreateDirectory "$LOCALAPPDATA\PingheSeries"
  !insertmacro preparePingheRegistryForRead $8 $6 $7 install
  WriteINIStr "$8" "phl" "installed" "1"
  WriteINIStr "$8" "phl" "path" "$INSTDIR"
  WriteINIStr "$8" "phl" "data_root" "$0"
  WriteINIStr "$8" "phl" "version" "${VERSION}"
  !insertmacro commitPreparedPingheRegistry $8 $6 $7 install
  DetailPrint "已更新 PH Launcher 安装登记；Lite 登记与用户数据均保留。"

  ; 登记固定属于当前用户；写完后恢复 all-users 安装的 shell context，避免影响后续启动流程。
  StrCmp $installMode "all" 0 phl_custom_install_scope_restored
  SetShellVarContext all
phl_custom_install_scope_restored:
!macroend

!macro customUnInstall
  SetShellVarContext current

  ; 旧目录中的卸载器不能误删后来安装在别处的新登记：只有路径相同才删自己的 [phl]。
  ; 同样先转码，确保安装目录含中文时仍能做正确的路径匹配。
  !insertmacro preparePingheRegistryForRead $1 $8 $9 uninstall
  ReadINIStr $0 "$1" "phl" "path"
  StrCmp $0 "$INSTDIR" 0 phl_keep_install_registry
  DeleteINISec "$1" "phl"
  !insertmacro commitPreparedPingheRegistry $1 $8 $9 uninstall
  Goto phl_install_registry_done
phl_keep_install_registry:
  Delete "$TEMP\phl-installations-utf16.ini"
phl_install_registry_done:
  ; 登记读写结束后恢复安装范围，否则模板稍后可能从错误的快捷方式目录删除链接。
  StrCmp $installMode "all" 0 phl_custom_uninstall_scope_restored
  SetShellVarContext all
phl_custom_uninstall_scope_restored:
  ; 卸载只撤销安装登记，绝不删除登记中的 data_root 或 $INSTDIR\data。
  DetailPrint "用户数据保留在：$INSTDIR\data"
!macroend

; 替换模板里 "RMDir /r $INSTDIR" 那一段。
; 注意：这里绝不递归删除 $INSTDIR 本身，只删程序文件与程序目录。
!macro customRemoveFiles
  SetOutPath $TEMP
  RMDir /r "$INSTDIR\locales"
  RMDir /r "$INSTDIR\resources"
  ; 只列 Electron/PHL 自己安装的顶层文件，不能用 *.json/*.txt 等通配符误删
  ; 同目录 Lite 或用户后来放入的文件；未来运行库漏删也比误删用户文件安全。
  Delete "$INSTDIR\chrome_100_percent.pak"
  Delete "$INSTDIR\chrome_200_percent.pak"
  Delete "$INSTDIR\resources.pak"
  Delete "$INSTDIR\d3dcompiler_47.dll"
  Delete "$INSTDIR\ffmpeg.dll"
  Delete "$INSTDIR\libEGL.dll"
  Delete "$INSTDIR\libGLESv2.dll"
  Delete "$INSTDIR\vk_swiftshader.dll"
  Delete "$INSTDIR\vulkan-1.dll"
  Delete "$INSTDIR\snapshot_blob.bin"
  Delete "$INSTDIR\v8_context_snapshot.bin"
  Delete "$INSTDIR\icudtl.dat"
  Delete "$INSTDIR\vk_swiftshader_icd.json"
  Delete "$INSTDIR\LICENSE.electron.txt"
  Delete "$INSTDIR\LICENSES.chromium.html"
  Delete "$INSTDIR\PH Launcher.exe"
  Delete "$INSTDIR\Uninstall PH Launcher.exe"
  Delete "$INSTDIR\${UNINSTALL_FILENAME}"
  ; 目录非空（里面还有 data/）时 RMDir 会失败，这正是想要的结果：
  ; 卸载后 $INSTDIR 只剩用户的 data/。
  RMDir "$INSTDIR"
!macroend
