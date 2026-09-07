const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { parseHTML } = require('linkedom');

test('conversation has one compact dock with optional prompts and one-line input', () => {
  const { document } = parseHTML(fs.readFileSync(require.resolve('../src/index.html'), 'utf8'));
  const conversation = document.querySelector('.agent-conversation');
  assert.equal(conversation.children.length, 2);
  assert.equal(conversation.firstElementChild.id, 'chatMessages');
  const dock = conversation.querySelector('.chat-input-dock');
  assert.equal(dock.querySelector('#aiInput').getAttribute('rows'), '1');
  assert.equal(dock.querySelector('.chat-quick-prompts').hasAttribute('open'), false);
  for (const id of ['aiUseMemories', 'aiAttachments', 'aiInput', 'aiSend']) assert.ok(dock.querySelector('#' + id));
});

test('compact attachments retain add/remove, bilingual help, and send metadata', async () => {
  const { window } = parseHTML('<html><body><div id="attachments"></div></body></html>');
  let language = 'en'; const removed = [];
  window.i18n = { locale: () => language };
  vm.runInNewContext(fs.readFileSync(require.resolve('../src/ai-attachments.js'), 'utf8'), { window });
  const root = window.document.querySelector('#attachments');
  const ui = window.PHAiAttachments.mount({ root, pick: async () => [{ id:'test', type:'document', name:'My notes.txt', mime:'text/plain', preview:'Sample' }], remove: async id => removed.push(id) });
  assert.equal(root.querySelector('.ai-attachment-help').hasAttribute('open'), false);
  assert.match(root.querySelector('summary').textContent, /Attachment info/);
  assert.equal(root.querySelector('.ai-attachments-list').children.length, 0);
  await root.querySelector('.ai-attachment-add').onclick();
  assert.equal(ui.list()[0].name, 'My notes.txt');
  language = 'zh-CN'; window.dispatchEvent(new window.Event('ph:language-changed'));
  assert.equal(root.querySelector('summary').textContent, '附件说明');
  assert.equal(ui.list()[0].name, 'My notes.txt');
  await root.querySelector('[data-ai-attachment-remove]').onclick();
  assert.equal(ui.list().length, 0); assert.deepEqual(removed, ['test']);
});

test('composer grows for text but is capped and shrinks after clearing', () => {
  const source = fs.readFileSync(require.resolve('../src/app.js'), 'utf8');
  const fn = source.match(/function resizeAiInput\(\) \{[\s\S]*?\n\}/)[0];
  const input = { style:{}, scrollHeight:52 };
  const context = { $: () => input }; vm.runInNewContext(fn, context);
  context.resizeAiInput(); assert.equal(input.style.height, '52px');
  input.scrollHeight = 600; context.resizeAiInput(); assert.equal(input.style.height, '112px');
  input.scrollHeight = 44; context.resizeAiInput(); assert.equal(input.style.height, '44px');
});
