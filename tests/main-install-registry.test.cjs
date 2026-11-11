'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const mainFile = path.join(__dirname, '..', 'electron', 'main.cjs');
const source = fs.readFileSync(mainFile, 'utf8');

test('data-root.txt 的读取、写入与展示始终使用改向前的同一 profile', () => {
  assert.match(source, /dataPointerProfileDir\s*=\s*app\.getPath\('userData'\)/);
  assert.match(source, /resolveDataRoot\(\{[\s\S]*?userDataDir:\s*pointerProfileDir\(\)/);
  assert.match(source, /pointerFile:\s*path\.join\(pointerProfileDir\(\),\s*'data-root\.txt'\)/);
  assert.match(source, /writeRootPointer\(pointerProfileDir\(\),\s*lite\.root\)/);
  assert.match(source, /writeRootPointer\(pointerProfileDir\(\),\s*own\)/);
  assert.doesNotMatch(source, /writeRootPointer\(app\.getPath\('userData'\)/,
    'profile 改向后不能再把指针写进 data/phl/profile');
});

test('旧 Profile 迁移使用改向前目录且仍是只复制流程', () => {
  assert.match(source, /migrateProfile\(\{\s*layout:\s*dataRoot\(\),\s*userDataDir:\s*pointerProfileDir\(\)\s*\}\)/);
  assert.doesNotMatch(source, /migrateProfile\(\{[^}]*userDataDir:\s*app\.getPath\('userData'\)/);
});

test('打包应用启动登记 phl 的安装目录、实际数据根和 app 版本，失败不挡启动', () => {
  assert.match(source, /require\('\.\/pinghe-series-registry\.cjs'\)/);
  assert.match(source, /installRegistry\.record\('phl',\s*\{[\s\S]*?path:\s*installPath,[\s\S]*?dataRoot:\s*dataRoot\(\)\.root,[\s\S]*?version:\s*app\.getVersion\(\)/);
  assert.match(source, /if\s*\(!app\.isPackaged[\s\S]*?PHL_RECORD_INSTALL[\s\S]*?PHL_INSTALL_REGISTRY[\s\S]*?return false/);
  assert.match(source, /try\s*\{\s*if\s*\(recordSelfInstallation\(\)\)[\s\S]*?catch\s*\(error\)\s*\{\s*console\.warn/);
});

test('macOS 安装路径由可执行文件向上找 .app，Windows 取 exe 所在目录', () => {
  const registrySource = fs.readFileSync(path.join(__dirname, '..', 'electron', 'pinghe-series-registry.cjs'), 'utf8');
  assert.match(registrySource, /platform === 'darwin'/);
  assert.match(registrySource, /endsWith\('\.app'\)/);
  assert.match(source, /installPathFromExecutable\(app\.getPath\('exe'\)\)/);
});
