const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'locales', 'en.js'), 'utf8');
const context = { window: {} };
vm.runInNewContext(source, context);
const catalog = context.window.PH_EN;

assert.ok(catalog && catalog.exact && Array.isArray(catalog.patterns));
assert.ok(Object.keys(catalog.exact).length >= 250, 'catalog should cover the fixed UI surface');
for (const key of ['我的课表', '我的日程', '班级课表', '我的课程', '计划', '离线词典', '背单词', 'AI学习助手', '添加任务', '保存', '取消', '关闭', '界面语言']) {
  assert.ok(catalog.exact[key], `missing fixed UI translation: ${key}`);
}
for (const [pattern] of catalog.patterns) assert.ok(pattern.startsWith('^') && pattern.endsWith('$'), `unbounded pattern: ${pattern}`);
assert.equal(catalog.exact['课程'], 'Classes');
assert.equal(catalog.exact['邮件'], 'Mail');
console.log(`locale catalog OK: ${Object.keys(catalog.exact).length} exact, ${catalog.patterns.length} patterns`);
