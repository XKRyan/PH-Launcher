'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const JSZip = require('jszip');
const mammoth = require('mammoth');
const { DOCX_MIME, crc32, readDocxParagraphs, buildDocx, appendDocxParagraphs } = require('../electron/docx.cjs');

const SAMPLE = { title: '阅读标题', paragraphs: ['第一段', 'second paragraph'] };

async function mammothText(buffer) {
  return (await mammoth.extractRawText({ buffer })).value;
}

// 供错误路径使用的、不含 word/document.xml 的合法 zip（jszip 仅在测试里使用）。
async function zipWithoutDocument() {
  const zip = new JSZip();
  zip.file('_rels/.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>');
  return zip.generateAsync({ type: 'nodebuffer' });
}

// 手工拼一个只含 word/document.xml 的最小 docx，用于段落数量上限等边界。
async function paragraphOnlyDocx(paragraphXml) {
  const zip = new JSZip();
  zip.file('word/document.xml', '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    `<w:body>${paragraphXml}</w:body></w:document>`);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

test('DOCX_MIME is the official Word MIME type', () => {
  assert.equal(DOCX_MIME, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
});

test('crc32 follows the IEEE polynomial with the standard test vectors', () => {
  assert.equal(crc32(Buffer.from('123456789')), 0xCBF43926);
  assert.equal(crc32(Buffer.alloc(0)), 0);
});

test('buildDocx writes a PK zip that mammoth reads, with a bold large-size heading', async () => {
  const buffer = buildDocx(SAMPLE);
  assert.ok(Buffer.isBuffer(buffer));
  assert.ok(buffer.subarray(0, 4).equals(Buffer.from('PK\x03\x04')), 'starts with local file header signature');
  assert.equal(buffer.readUInt16LE(4), 20, 'version needed to extract is 20');
  assert.equal(buffer.readUInt16LE(6), 0x0800, 'general purpose flag marks UTF-8 filenames');
  assert.equal(buffer.readUInt16LE(8), 8, 'entries are deflated');

  const text = await mammothText(buffer);
  assert.match(text, /阅读标题/);
  assert.match(text, /第一段/);
  assert.match(text, /second paragraph/);

  const documentXml = await (await JSZip.loadAsync(buffer)).file('word/document.xml').async('string');
  assert.match(documentXml, /<w:b\/><w:sz w:val="32"\/>/, 'the heading run is bold at 32 half-points');
});

test('readDocxParagraphs returns the title followed by every paragraph, exactly', async () => {
  const paragraphs = ['One', 'Two  spaces kept', '中文段落'];
  const result = await readDocxParagraphs(buildDocx({ title: '笔记标题', paragraphs }));
  assert.deepEqual(result, ['笔记标题', ...paragraphs]);
});

test('appendDocxParagraphs keeps original content, lands before the trailing sectPr, and keeps other parts identical', async () => {
  const original = buildDocx({ title: '原标题', paragraphs: ['old-1', 'old-2'] });
  const appended = await appendDocxParagraphs(original, ['new-1', 'new-2']);
  assert.ok(Buffer.isBuffer(appended), 'appendDocxParagraphs returns a Buffer');
  assert.deepEqual(await readDocxParagraphs(appended), ['原标题', 'old-1', 'old-2', 'new-1', 'new-2']);

  const text = await mammothText(appended);
  for (const line of ['原标题', 'old-1', 'old-2', 'new-1', 'new-2']) assert.ok(text.includes(line));

  const before = await JSZip.loadAsync(original);
  const after = await JSZip.loadAsync(appended);
  const documentXml = await after.file('word/document.xml').async('string');
  const sectPrAt = documentXml.indexOf('<w:sectPr');
  assert.ok(sectPrAt > 0, 'the document still ends with a sectPr');
  assert.ok(documentXml.indexOf('new-2') < sectPrAt, 'new paragraphs are inserted before the trailing sectPr');
  assert.match(documentXml, /<\/w:sectPr><\/w:body><\/w:document>$/, 'sectPr stays the last body element');
  assert.equal(Object.keys(after.files).length, Object.keys(before.files).length, 'entry count is unchanged');
  for (const name of ['[Content_Types].xml', '_rels/.rels']) {
    assert.equal(await after.file(name).async('string'), await before.file(name).async('string'), `${name} is byte-identical`);
  }
});

test('appending twice keeps every generation of paragraphs', async () => {
  const once = await appendDocxParagraphs(buildDocx({ title: 'T', paragraphs: ['a1'] }), ['b1']);
  const twice = await appendDocxParagraphs(once, ['c1']);
  assert.deepEqual(await readDocxParagraphs(twice), ['T', 'a1', 'b1', 'c1']);
});

test('XML special characters survive a build → mammoth → read round trip unchanged', async () => {
  const tricky = `<a> & "b" 'c' &lt;tag&gt;`;
  const buffer = buildDocx({ title: tricky, paragraphs: [tricky] });
  const text = await mammothText(buffer);
  assert.ok(text.includes(`<a> & "b" 'c' &lt;tag&gt;`), 'mammoth decodes the escaped entities back to the original characters');
  assert.deepEqual(await readDocxParagraphs(buffer), [tricky, tricky]);
});

test('a newline inside one paragraph is stored as <w:br/> and read back as a line break', async () => {
  const buffer = buildDocx({ title: '换行测试', paragraphs: ['first line\r\nsecond line\nthird line\rfourth'] });
  const documentXml = await (await JSZip.loadAsync(buffer)).file('word/document.xml').async('string');
  assert.equal((documentXml.match(/<w:br\/>/g) || []).length, 3, '\r\n, \n and \r each become one <w:br/>');
  assert.ok(documentXml.includes('<w:t xml:space="preserve">first line</w:t><w:br/><w:t xml:space="preserve">second line</w:t>'));

  // mammoth 的 extractRawText 会输出每一行的内容（它的 raw text 写法不渲染 br，
  // 换行结构由 document.xml 与读取器断言覆盖）。
  const text = await mammothText(buffer);
  for (const line of ['first line', 'second line', 'third line', 'fourth']) assert.ok(text.includes(line));
  assert.deepEqual(await readDocxParagraphs(buffer), ['换行测试', 'first line\nsecond line\nthird line\nfourth']);
});

test('readDocxParagraphs caps at 500 paragraphs and skips whitespace-only ones', async () => {
  const paragraph = '<w:p><w:r><w:t>段落</w:t></w:r></w:p>';
  const empties = '<w:p><w:r><w:t>   </w:t></w:r></w:p><w:p/>';
  const result = await readDocxParagraphs(await paragraphOnlyDocx(empties + paragraph.repeat(502)));
  assert.equal(result.length, 500);
  assert.equal(result[0], '段落');
});

test('readDocxParagraphs hard-fails with Chinese errors on non-zip, missing document.xml, and oversized input', async () => {
  await assert.rejects(readDocxParagraphs(Buffer.from('this is definitely not a zip file')), /不是有效的 \.docx/);
  await assert.rejects(readDocxParagraphs(await zipWithoutDocument()), /word\/document\.xml/);
  await assert.rejects(readDocxParagraphs(Buffer.alloc(24 * 1024 * 1024 + 1)), /24 MB/);
});

test('buildDocx rejects invalid titles and invalid paragraph arrays', () => {
  assert.throws(() => buildDocx({ title: '', paragraphs: [] }), /标题/);
  assert.throws(() => buildDocx({ title: '   ', paragraphs: [] }), /标题/);
  assert.throws(() => buildDocx({ title: 'x'.repeat(201), paragraphs: [] }), /标题/);
  assert.throws(() => buildDocx({ title: 42, paragraphs: [] }), /标题/);
  assert.throws(() => buildDocx({ title: 'ok', paragraphs: 'not an array' }), /字符串数组/);
  assert.throws(() => buildDocx({ title: 'ok', paragraphs: ['ok', 42] }), /字符串数组/);
  assert.throws(() => buildDocx({ title: 'ok', paragraphs: Array.from({ length: 501 }, (unused, i) => `p${i}`) }), /字符串数组/);
  assert.throws(() => buildDocx({ title: 'ok', paragraphs: ['x'.repeat(20001)] }), /字符串数组/);
});

test('appendDocxParagraphs rejects buffers that are not a docx, with Chinese errors', async () => {
  await assert.rejects(async () => appendDocxParagraphs(Buffer.from('still not a zip'), ['new']), /不是有效的 \.docx/);
  await assert.rejects(async () => appendDocxParagraphs(await zipWithoutDocument(), ['new']), /word\/document\.xml/);
  await assert.rejects(async () => appendDocxParagraphs(Buffer.alloc(24 * 1024 * 1024 + 1), ['new']), /24 MB/);
  await assert.rejects(async () => appendDocxParagraphs(buildDocx(SAMPLE), ['bad', 42]), /字符串数组/);
});
