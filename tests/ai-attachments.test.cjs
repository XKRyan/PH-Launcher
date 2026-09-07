'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createAiAttachments, MAX_EACH } = require('../electron/ai-attachments.cjs');

const base = path.resolve('C:/fixture');
const jpg = Buffer.from([0xff, 0xd8, 0xff, 0x00]);
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]);
function fixture(files) {
  return createAiAttachments({
    stat: async (file) => ({ isFile: () => true, size: files[file].length }),
    readFile: async (file) => Buffer.from(files[file]),
    importDocument: async (file) => ({ text: files[file].toString('utf8'), title: 'fixture' }),
  });
}

test('keeps document text private while exposing only safe metadata and history', async () => {
  const file = path.join(base, 'note.txt'); const store = fixture({ [file]: Buffer.from('Private study note about evidence.') });
  const [meta] = await store.add([file]);
  assert.deepEqual(Object.keys(meta).sort(), ['id', 'mime', 'name', 'preview', 'size', 'type']);
  assert.equal(Object.hasOwn(meta, 'text'), false);
  assert.deepEqual(store.history([meta.id]), [{ id: meta.id, type: 'document', name: 'note.txt', mime: 'text/plain' }]);
  assert.equal(store.payload([meta.id])[0].text, 'Private study note about evidence.');
});

test('validates image magic and treats SVG as inert reference text, never an image', async () => {
  const photo = path.join(base, 'photo.jpg'); const spoof = path.join(base, 'spoof.png'); const svg = path.join(base, 'drawing.svg');
  const store = fixture({ [photo]: jpg, [spoof]: Buffer.from('<svg/>'), [svg]: Buffer.from('<svg/>') });
  const [meta] = await store.add([photo]); assert.equal(meta.mime, 'image/jpeg'); assert.ok(Buffer.isBuffer(store.payload([meta.id])[0].image));
  await assert.rejects(store.add([spoof]), /不匹配/);
  const [drawing] = await store.add([svg]);
  assert.equal(drawing.type, 'document');
  assert.equal(store.payload([drawing.id])[0].text, '<svg/>');
});

test('any file extension is accepted but unparsed binary content is explicitly unavailable', async () => {
  const file=path.join(base,'archive.zip'); const code=path.join(base,'data.csv');
  const store=fixture({[file]:Buffer.from([0x50,0x4b,0,0xff]),[code]:Buffer.from('name,score\nAlex,90')});
  const [binary,csv]=await store.add([file,code]);
  assert.equal(binary.contentAvailable,false);
  assert.match(store.payload([binary.id])[0].text,/File contents were NOT provided/);
  assert.equal(store.payload([csv.id])[0].text,'name,score\nAlex,90');
});

test('uses the local document extractor for PDF and DOCX, with no network path', async () => {
  const pdf = path.join(base, 'chapter.pdf'); let extracted = 0;
  const store = createAiAttachments({ stat: async () => ({ isFile: () => true, size: 8 }), readFile: async () => Buffer.from('%PDF-1.7'), importDocument: async (file, options) => { extracted++; assert.equal(file, pdf); assert.equal(options.timeoutMs, 30_000); return { text: 'Extracted locally.' }; } });
  const [meta] = await store.add([pdf]); assert.equal(meta.type, 'document'); assert.equal(extracted, 1);
});

test('rejects spoofed documents and leaves a multi-file selection atomic', async () => {
  const good = path.join(base, 'good.txt'); const bad = path.join(base, 'bad.pdf');
  const store = fixture({ [good]: Buffer.from('A local note.'), [bad]: Buffer.from('not a PDF') });
  await assert.rejects(store.add([good, bad]), /不匹配/);
  assert.deepEqual(store.list(), []);
});

test('enforces per-type, per-file, aggregate, and duplicate-reference limits', async () => {
  const files = Object.fromEntries([0, 1, 2, 3].map((index) => [path.join(base, `p${index}.jpg`), jpg])); const store = fixture(files);
  await store.add(Object.keys(files).slice(0, 3));
  await assert.rejects(store.add([Object.keys(files)[3]]), /3 张照片/);
  const huge = path.join(base, 'huge.txt'); const oversized = createAiAttachments({ stat: async () => ({ isFile: () => true, size: MAX_EACH + 1 }), readFile: async () => Buffer.alloc(0), importDocument: async () => ({ text: '' }) });
  await assert.rejects(oversized.add([huge]), /10 MB/);
  const ids = store.list().map((item) => item.id); assert.throws(() => store.payload([ids[0], ids[0]]), /引用/);
});

test('removal and clear invalidate in-memory send tokens', async () => {
  const file = path.join(base, 'photo.png'); const store = fixture({ [file]: png }); const [meta] = await store.add([file]);
  assert.equal(store.remove(meta.id), true); assert.throws(() => store.payload([meta.id]), /已移除/);
  const [again] = await store.add([file]); store.clear(); assert.deepEqual(store.list(), []); assert.throws(() => store.payload([again.id]), /已移除/);
});
