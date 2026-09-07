'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { dialogOptions } = require('../electron/interface-language.cjs');

test('native dialog localization changes only interface copy and preserves user data', () => {
  const options = {
    title: '保存',
    message: 'Alex Zhang',
    detail: 'C:\\Users\\Alex Zhang\\IB English\\Final draft.pdf',
    defaultPath: 'C:\\Users\\Alex Zhang\\IB English\\Final draft.pdf',
    filters: [
      { name: 'PDF 文件', extensions: ['pdf'] },
      { name: 'Alex Zhang originals', extensions: ['docx', 'pages'] },
    ],
    properties: ['showOverwriteConfirmation'],
  };
  const translated = dialogOptions(options, 'en');
  assert.equal(translated.title, 'Save');
  assert.equal(translated.message, 'Alex Zhang');
  assert.equal(translated.detail, options.detail);
  assert.equal(translated.defaultPath, options.defaultPath);
  assert.deepEqual(translated.filters.map(filter => filter.extensions), [['pdf'], ['docx', 'pages']]);
  assert.equal(translated.filters[1].name, 'Alex Zhang originals');
  assert.deepEqual(translated.properties, options.properties);
  assert.deepEqual(options.filters[0], { name: 'PDF 文件', extensions: ['pdf'] });
});

test('Chinese native dialogs are returned without altering paths, extensions, or captured names', () => {
  const options = { title: '保存', defaultPath: 'D:\\School\\李华\\作品.pptx', filters: [{ name: '李华的演示文稿', extensions: ['pptx'] }] };
  assert.deepEqual(dialogOptions(options, 'zh-CN'), options);
});
