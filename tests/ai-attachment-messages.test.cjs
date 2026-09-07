const test = require('node:test');
const assert = require('node:assert/strict');
const { attachToMessages } = require('../electron/ai-attachment-messages.cjs');
test('attachments enrich only the current request, keep history untouched, and use the selected provider format', () => {
  const messages = [{role:'user',content:'Explain this'}];
  const files = [{type:'document',name:'lesson.txt',text:'a'.repeat(16000)}, {type:'image',mime:'image/png',image:Buffer.from('test')}];
  const local = attachToMessages(messages, files, 'local');
  assert.equal(local[0].images.length, 1); assert.match(local[0].content, /"truncated":true/);
  const remote = attachToMessages(messages, files, 'api');
  assert.equal(remote[0].content[1].type, 'image_url'); assert.match(remote[0].content[1].image_url.url, /^data:image\/png;base64,/);
  assert.deepEqual(messages, [{role:'user',content:'Explain this'}]);
  assert.equal(attachToMessages(messages, [], 'api')[0].content, 'Explain this');
});
