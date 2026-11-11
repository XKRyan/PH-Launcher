'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');
const installerPath = path.join(projectRoot, 'build', 'installer.nsh');
const source = fs.readFileSync(installerPath, 'utf8');
const commands = source
  .split(/\r?\n/)
  .map((line) => line.split(';', 1)[0].trim())
  .filter(Boolean)
  .join('\n');

function macroBody(name) {
  const match = source.match(new RegExp(`!macro\\s+${name}\\b([\\s\\S]*?)!macroend`));
  assert.ok(match, `缺少 !macro ${name}`);
  return match[1];
}

function commandBody(name) {
  return macroBody(name)
    .split(/\r?\n/)
    .map((line) => line.split(';', 1)[0].trim())
    .filter(Boolean)
    .join('\n');
}

test('customInit 按登记、HKCU 卸载项、标准目录的顺序发现 Lite', () => {
  const init = commandBody('customInit');
  const iniRead = init.indexOf('ReadINIStr $1 "$0" "phl-lite" "path"');
  const registryRead = init.indexOf('EnumRegKey $4 HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall" $3');
  const standardRead = init.indexOf('IfFileExists "$LOCALAPPDATA\\Programs\\PH Launcher\\PingheLauncherLite.exe"');

  assert.ok(iniRead >= 0, '必须先读 [phl-lite] path');
  assert.match(init, /!insertmacro preparePingheRegistryForRead \$0 \$8 \$9[\s\S]*?ReadINIStr \$2 "\$0" "phl-lite" "data_root"/);
  assert.match(source, /!macro preparePingheRegistryForRead[\s\S]*?UTF8Encoding[\s\S]*?Text\.Encoding\]::Unicode/,
    'UTF-8 无 BOM 登记必须先转为 NSIS 可无损读取的 Unicode 临时 INI，支持中文路径');
  assert.match(source, /!macro commitPreparedPingheRegistry[\s\S]*?UTF8Encoding[\s\S]*?File\]::Replace/,
    'NSIS 写完后必须转回 UTF-8 无 BOM并原子替换，不能留下混合编码');
  assert.match(init, /GetFullPathName \$8 "\$1"\nStrCmp \$8 "\$1" 0 phl_detect_lite_from_registry/,
    '登记安装目录只接受绝对 Windows 路径');
  assert.match(init, /GetFullPathName \$8 "\$DetectedLiteDataRoot"[\s\S]*?StrCpy \$DetectedLiteDataRoot ""/,
    '登记 data_root 非绝对路径时必须清空并回退');
  assert.match(init, /IfFileExists "\$1\\PingheLauncherLite\.exe" 0 phl_detect_lite_from_registry/,
    '登记目录必须由 Lite 主程序证明仍有效');
  assert.ok(registryRead > iniRead, '登记优先于旧卸载项');
  assert.match(init, /StrCmp \$5 "Pinghe Launcher Lite" 0 phl_detect_lite_registry_loop/);
  assert.match(init, /ReadRegStr \$6 HKCU .* "InstallLocation"/);
  assert.match(init, /IfFileExists "\$6\\PingheLauncherLite\.exe" 0 phl_detect_lite_registry_loop/);
  assert.ok(standardRead > registryRead, '标准目录只能作为最后 fallback');
  assert.match(init, /StrCpy \$DetectedLiteDataRoot "\$6\\data"/);
  assert.match(init, /StrCpy \$DetectedLiteDataRoot "\$LOCALAPPDATA\\Programs\\PH Launcher\\data"/);
});

test('目录页说明检测 Lite 后会默认同目录并共用数据根，同时仍允许用户修改', () => {
  assert.match(source, /!define MUI_DIRECTORYPAGE_TEXT_TOP .*检测到 Pinghe Launcher Lite.*默认装到它的目录并共用数据根.*仍可更改/);
});

test('customInit 的目录页默认值可跨过 electron-builder 安装范围页重置', () => {
  const init = commandBody('customInit');
  assert.match(init, /!insertmacro GetDParameter \$7\nStrCmp \$7 "" 0 phl_custom_init_done/,
    '显式 /D 必须优先于自动检测');
  assert.match(init, /StrCpy \$perUserInstallationFolder "\$DetectedLiteInstallDir"[\s\S]*?StrCpy \$INSTDIR "\$DetectedLiteInstallDir"/,
    '仅设置 $INSTDIR 会被安装范围页的 setInstallModePerUser 覆盖');
  assert.match(init, /StrCmp \$installMode "all" phl_custom_init_done\nStrCpy \$INSTDIR/,
    'Lite 的 per-user 路径不能覆盖明确选择的 all-users 目录');
  assert.match(init, /StrCmp \$installMode "all" 0 phl_custom_init_scope_restored\nSetShellVarContext all/,
    '读 per-user 登记后必须恢复 electron-builder 的 all-users shell context');
});

test('customInstall 保留 data 目录并只更新自己的 [phl] 节', () => {
  const install = commandBody('customInstall');
  assert.match(install, /CreateDirectory "\$INSTDIR\\data"/);
  assert.match(install, /StrCpy \$0 "\$INSTDIR\\data"/);
  assert.match(install, /StrCmp \$DetectedLiteDataRoot "" phl_data_root_ready\nStrCpy \$0 "\$DetectedLiteDataRoot"/,
    'Lite 登记的数据根优先，否则才使用新安装目录下的 data');
  assert.match(install, /CreateDirectory "\$0"/);
  assert.match(install, /CreateDirectory "\$APPDATA\\PH Launcher"[\s\S]*?IfFileExists "\$APPDATA\\PH Launcher\\data-root\.txt" phl_data_pointer_ready[\s\S]*?FileOpen \$9 "\$APPDATA\\PH Launcher\\data-root\.txt" w[\s\S]*?FileWriteUTF16LE \/BOM \$9 "\$0\$\\r\$\\n"[\s\S]*?FileClose \$9/,
    '采用的 Lite data_root 必须写入 PHL 实际读取的固定 profile 指针，中文路径无损且升级不覆盖已有选择');
  assert.match(install, /!insertmacro preparePingheRegistryForRead \$8 \$6 \$7 install[\s\S]*?!insertmacro commitPreparedPingheRegistry \$8 \$6 \$7 install/);
  for (const [key, value] of [
    ['installed', '1'],
    ['path', '$INSTDIR'],
    ['data_root', '$0'],
    ['version', '${VERSION}'],
  ]) {
    assert.ok(install.includes(`"phl" "${key}" "${value}"`), `缺少 [phl] ${key}`);
  }
  assert.doesNotMatch(install, /DeleteINISec|Delete\s|RMDir\s/i);
  assert.doesNotMatch(install, /"phl-lite"\s+"(?:installed|path|data_root|version)"/,
    '安装 PHL 不得改写 Lite 节');
  assert.match(install, /StrCmp \$installMode "all" 0 phl_custom_install_scope_restored\nSetShellVarContext all/);
});

test('customUnInstall 仅在登记路径匹配时删除 [phl]，所有卸载宏都不删 data', () => {
  const uninstall = commandBody('customUnInstall');
  const remove = commandBody('customRemoveFiles');
  const readAt = uninstall.indexOf('ReadINIStr $0 "$1" "phl" "path"');
  const guardAt = uninstall.indexOf('StrCmp $0 "$INSTDIR" 0 phl_keep_install_registry');
  assert.match(uninstall, /!insertmacro preparePingheRegistryForRead \$1 \$8 \$9/,
    '卸载时也要正确读取含中文的 UTF-8 登记路径');
  const deleteAt = uninstall.indexOf('DeleteINISec "$1" "phl"');

  assert.ok(readAt >= 0 && guardAt > readAt && deleteAt > guardAt, '删节前必须先读路径并做相等保护');
  assert.doesNotMatch(uninstall, /DeleteINISec .*"phl-lite"/);
  assert.match(uninstall, /StrCmp \$installMode "all" 0 phl_custom_uninstall_scope_restored\nSetShellVarContext all/);
  assert.doesNotMatch(`${uninstall}\n${remove}`, /(?:RMDir|Delete)\s+(?:\/r\s+)?"?\$INSTDIR\\data(?:\\|"|\s|$)/i);
  assert.doesNotMatch(`${uninstall}\n${remove}`, /(?:RMDir|Delete)\s+.*DetectedLiteDataRoot/i);
  assert.doesNotMatch(remove, /Delete\s+"\$INSTDIR\\\*\./i,
    '卸载不能用扩展名通配符误删同目录 Lite 或用户文件');
});

test('发现优先级和 data_root fallback 的行为表保持一致', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'phl-installer-registry-'));
  try {
    const registered = path.join(temp, 'registered');
    const legacy = path.join(temp, 'legacy');
    const standard = path.join(temp, 'standard');
    for (const folder of [registered, legacy, standard]) fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(registered, 'PingheLauncherLite.exe'), 'fixture');
    fs.writeFileSync(path.join(legacy, 'PingheLauncherLite.exe'), 'fixture');
    fs.writeFileSync(path.join(standard, 'PingheLauncherLite.exe'), 'fixture');

    // 与 NSIS 分支相同的输入/输出表：有效登记优先且携带外置 data_root。
    const detect = ({ iniPath = '', iniDataRoot = '', uninstallPath = '', standardPath = '' }) => {
      if (iniPath && fs.existsSync(path.join(iniPath, 'PingheLauncherLite.exe'))) {
        return { installDir: iniPath, dataRoot: iniDataRoot };
      }
      if (uninstallPath && fs.existsSync(path.join(uninstallPath, 'PingheLauncherLite.exe'))) {
        return { installDir: uninstallPath, dataRoot: path.join(uninstallPath, 'data') };
      }
      if (standardPath && fs.existsSync(path.join(standardPath, 'PingheLauncherLite.exe'))) {
        return { installDir: standardPath, dataRoot: path.join(standardPath, 'data') };
      }
      return { installDir: '', dataRoot: '' };
    };

    const externalData = path.join(temp, 'external-data');
    assert.deepEqual(detect({ iniPath: registered, iniDataRoot: externalData, uninstallPath: legacy, standardPath: standard }),
      { installDir: registered, dataRoot: externalData });
    fs.rmSync(path.join(registered, 'PingheLauncherLite.exe'));
    assert.deepEqual(detect({ iniPath: registered, iniDataRoot: externalData, uninstallPath: legacy, standardPath: standard }),
      { installDir: legacy, dataRoot: path.join(legacy, 'data') }, '陈旧登记应退到卸载项');
    fs.rmSync(path.join(legacy, 'PingheLauncherLite.exe'));
    assert.deepEqual(detect({ iniPath: registered, iniDataRoot: externalData, uninstallPath: legacy, standardPath: standard }),
      { installDir: standard, dataRoot: path.join(standard, 'data') });
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('源码安全守护不会被中文注释中的危险词误判', () => {
  assert.match(commands, /!macro customRemoveFiles/);
  assert.doesNotMatch(commands, /RMDir\s+\/r\s+"?\$INSTDIR(?:"|\s|$)/i,
    '不能恢复 electron-builder 默认的递归删除整个安装目录');
});
