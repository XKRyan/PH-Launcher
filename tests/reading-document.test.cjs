'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const JSZip = require('jszip');
const { importReadingDocument, MAX_FILE_BYTES } = require('../electron/reading-document.cjs');
const directory = fs.mkdtemp(path.join(os.tmpdir(), 'ph-reading-fixtures-'));
async function fixture(name, data) { const file = path.join(await directory, name); await fs.writeFile(file, data); return file; }
function pdf(text = 'The evidence supports a coherent explanation.') {
  const stream = text ? `BT /F1 12 Tf 40 700 Td (${text}) Tj ET` : '';
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`];
  let result = '%PDF-1.4\n'; const offsets = [0];
  objects.forEach((object, i) => { offsets.push(Buffer.byteLength(result)); result += `${i + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(result);
  result += 'xref\n0 6\n0000000000 65535 f \n' + offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  result += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(result);
}
async function docx(text) {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>');
  zip.file('word/document.xml', `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}
test('DOCX main-body extraction is local plain text, including XML entities', async () => {
  const result = await importReadingDocument(await fixture('fixture.docx', await docx('English reading &amp; evidence.')));
  assert.equal(result.title, 'fixture'); assert.equal(result.text, 'English reading & evidence.');
  assert.match(result.warning, /Word/);
});
test('PDF text extraction uses the real packaged PDF.js parser', async () => {
  const result = await importReadingDocument(await fixture('fixture.pdf', pdf()));
  assert.match(result.text, /evidence supports a coherent/);
});
test('scan-only PDF and corrupted file report useful errors', async () => {
  await assert.rejects(importReadingDocument(await fixture('scan.pdf', pdf(''))), /扫描件/);
  await assert.rejects(importReadingDocument(await fixture('broken.pdf', 'not a pdf')), /有效/);
  await assert.rejects(importReadingDocument(await fixture('broken.docx', 'not a zip')), /损坏/);
});
test('UTF-8 and UTF-16 text, long input warning, and unsupported files', async () => {
  assert.equal((await importReadingDocument(await fixture('hello.txt', 'English 中文'))).text, 'English 中文');
  assert.equal((await importReadingDocument(await fixture('hello16.txt', Buffer.concat([Buffer.from([255,254]), Buffer.from('English 中文', 'utf16le')])))).text, 'English 中文');
  const long = await importReadingDocument(await fixture('long.md', 'Evidence '.repeat(3000)));
  assert.equal(long.text.length, 20000); assert.match(long.warning, /其余尚未导入/);
  await assert.rejects(importReadingDocument('anything.doc'), /另存/);
  await assert.rejects(importReadingDocument('anything.exe'), /支持/);
  await assert.rejects(importReadingDocument(await fixture('binary.txt', Buffer.from([255,255,192]))), /编码/);
});
test('oversized, ZIP expansion and timeout are bounded', async () => {
  const large = await fixture('large.txt', 'English'); const file = await fs.open(large, 'r+');
  await file.truncate(MAX_FILE_BYTES + 1); await file.close();
  await assert.rejects(importReadingDocument(large), /20 MB/);
  const bomb = await fixture('expanded.docx', await docx('a'.repeat(13 * 1024 * 1024)));
  await assert.rejects(importReadingDocument(bomb), /过大/);
  await assert.rejects(importReadingDocument(await fixture('timeout.txt', 'English text'), { timeoutMs: 1 }), /超过 30 秒/);
  assert.equal((await importReadingDocument(await fixture('after.txt', 'English after timeout'))).text, 'English after timeout');
});
module.exports = { pdf, docx };
