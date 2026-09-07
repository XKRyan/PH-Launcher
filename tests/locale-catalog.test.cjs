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

for (const key of [
  '交替练习', '释义拼写', '导入与备份', '粘贴你有权使用的英文材料，每篇最多 20000 字符。',
  '阅读书架', '批量挑词收藏', '上课提醒', '选择自己的教学组', '刷新课程与作业',
  'AI 连接设置已保存', '正在测试模型（首次加载最多等待 90 秒），可以随时返回。',
  'AI 建议的更改', '打开 PH Launcher', '退出 PH Launcher', '隐藏其他应用', '前置全部窗口'
  , '主要导航', '添加自定义网页', '专注计时器', '你的第一本生词本，从这里开始。',
  '词书、导入和阅读收词都在“我的词书”与“更多工具”中', '上一月', '日历视图',
  '选择 IB 科目与考试版本', '希望保持的记忆程度', '导入阅读文档', '导出 PH Launcher 数据'
  , '每天半页，也是一条长路。', '我的阅读书架', '练习方式', '开始这一组回忆', '保存表达'
]) assert.ok(catalog.exact[key], `missing regression translation: ${key}`);

const translate = (value) => {
  if (catalog.exact[value] !== undefined) return catalog.exact[value];
  for (const [pattern, replacement] of catalog.patterns) {
    const re = new RegExp(pattern);
    if (re.test(value)) return value.replace(re, replacement);
  }
  return value;
};
assert.equal(translate('删除 Alex 保存的账号和密码？网站登录状态不会受影响。'), 'Delete the saved username and password for Alex? The website sign-in state will not change.');
assert.equal(translate('清除“Study site”的登录状态、Cookie 与缓存？'), 'Clear the sign-in state, cookies, and cache for “Study site”?');
assert.equal(translate('保存来自 example.test 的文件'), 'Save file from example.test');
assert.equal(translate('本轮 2 次回忆 · 当前还有 3 个'), '2 recalls this session · 3 remaining');
assert.equal(translate('新词预览 · 第 1 / 5 个'), 'New-word preview · 1 of 5');
assert.equal(translate('evidence · 我的表达'), 'evidence · My sentence');
assert.equal(translate('6 个不同单词'), '6 unique words');
assert.equal(translate('有 5 个到期词会先出现；新词会在复习后按小组预览。'), '5 due words will appear first; new words will be previewed in groups after the reviews.');
assert.equal(translate('复习后还有 4 个新词可学'), '4 new words available after the reviews');
assert.equal(translate('当前可学 1,234 个'), '1,234 available now');
assert.equal(translate('当前难度可学 1,234 个新词'), '1,234 new words available at this level');
assert.equal(translate('下次复习 9月8日 08:00。'), 'Next review: 9/8 08:00.');
assert.equal(catalog.exact['快捷提问'], 'Quick prompts');
assert.equal(catalog.exact['AI 可能出错，请核对重要信息。'], 'AI can make mistakes. Check important information.');
assert.equal(translate('3 项任务'), '3 tasks');
assert.equal(translate('2 项已逾期'), '2 overdue');
assert.equal(translate('完成 4 次专注'), '4 focus sessions completed');
assert.equal(translate('15 分钟前'), '15 minutes ago');
assert.equal(translate('English · 今天 08:00'), 'English · Today 08:00');
assert.equal(translate('9月8日 08:00'), '9/8 08:00');
assert.equal(translate('自动保存 · 15 分钟前'), 'Auto-saved · 15 minutes ago');
assert.equal(translate('仅 2026-09-07 当天生效；重新同步可更新日期与教学组。'), 'Applies only on 2026-09-07; sync again to update the date and class group.');
assert.equal(translate('删除任务“读 Chapter 3”？'), 'Delete task “读 Chapter 3”?');
assert.equal(translate('120 词 · 650 字符'), '120 words · 650 characters');
assert.equal(translate('本地 · qwen3.5:4b · 正在准备'), 'Local · qwen3.5:4b · Preparing');
assert.equal(translate('本地 · qwen3.5:4b · 已准备'), 'Local · qwen3.5:4b · Ready');
assert.equal(translate('聊天记录未保存：磁盘空间不足'), 'Chat history was not saved: 磁盘空间不足');
assert.equal(translate('本轮已完成 7 次回忆。 下次复习：9月8日 08:00。'), '7 recalls completed this session. Next review: 9/8 08:00.');
assert.equal(translate('当前词本暂无可学词条。你可以继续阅读，遇到好词再收进来。'), 'No cards are available in this wordbook. Keep reading and save useful words as you find them.');
assert.equal(catalog.exact['复习 · 看词回忆'], 'Review · Word-to-meaning recall');
assert.equal(translate('evidence · 费力想起 · 下次 10 分钟'), 'evidence · Recalled with effort · Next: 10 minutes');
assert.equal(translate('evidence · 记住了 · 下次 9月8日 08:00'), 'evidence · Remembered · Next: 9/8 08:00');
assert.equal(translate('12 次回忆 · 3 次遗忘'), '12 recalls · 3 lapses');
assert.equal(translate('已在 4 篇不同阅读材料中再次遇见 · 不等于已掌握'), 'Seen again in 4 different texts · This does not mean mastered');
assert.equal(translate('第 2 / 5 页'), 'Page 2 of 5');
assert.equal(translate('夜深了，今天先做哪件事？'), 'It’s late. What would you like to start with?');
assert.equal(translate('早上好，今天先做哪件事？'), 'Good morning. What would you like to start with?');
assert.equal(translate('中午好，今天先做哪件事？'), 'Good afternoon. What would you like to start with?');
assert.equal(translate('下午好，今天先做哪件事？'), 'Good afternoon. What would you like to start with?');
assert.equal(translate('晚上好，今天先做哪件事？'), 'Good evening. What would you like to start with?');
assert.equal(translate('下午好，Alex，今天先做哪件事？'), 'Good afternoon, Alex. What would you like to start with?');
for (const [sourceText, expected] of [
  ['正在打开你的词本…', 'Opening your wordbook…'],
  ['词本暂时没能打开', 'Could not open your wordbook'],
  ['正在打开邮件…', 'Opening message…'],
  ['正在读取学校数据，请稍候。你可以继续使用其他本地工具。', 'Reading school data. You can keep using other local tools.'],
  ['附件没有保存，请重试。', 'Attachment was not saved. Try again.'],
  ['正在准备本机模型…', 'Preparing the local model…'],
  ['此设备当前无法保存聊天记录。', 'Chat history cannot be saved on this device right now.'],
  ['例如：Physics', 'For example: Physics']
]) assert.equal(translate(sourceText), expected, `missing transient translation: ${sourceText}`);
for (const key of [
  '密码会使用当前系统用户密钥单独加密，只会发送到对应学校以登录并读取课表或课程；不会交给 AI 或写入学校数据。更换账号会清除该网站旧会话。',
  '搜索课程、教学组或老师', '输入邮箱地址', '搜索单词、释义或原句',
  '从感兴趣的内容开始。你挑选的词会保留所在原句。', '明确兴趣领域与初步选题'
]) assert.ok(catalog.exact[key], `missing complete-surface translation: ${key}`);
assert.equal(translate('例如 perspective'), 'For example: perspective');
assert.equal(translate('80% · 较轻的复习量'), '80% · Lighter review load');
assert.equal(translate('无法保存账号：磁盘不可用'), 'Could not save account: 磁盘不可用');
assert.equal(translate('暂时无法查词：离线词库损坏'), 'Could not look up this word: 离线词库损坏');
assert.equal(translate('发现 3 个到期词，已开始复习'), 'Found 3 due words. Review started.');
assert.equal(require(path.join(__dirname, '..', 'src', 'locales', 'en.js')).exact['打开 PH Launcher'], 'Open PH Launcher');
console.log(`locale catalog OK: ${Object.keys(catalog.exact).length} exact, ${catalog.patterns.length} patterns`);
