'use strict';
const { parentPort, workerData } = require('node:worker_threads');
const MAX_TEXT = 20000;
const data = Buffer.from(workerData.data);
// Only bytes explicitly selected by the user enter the parser. Never fetch links.
globalThis.fetch = async () => { throw new Error('Document network access is disabled'); };

async function validateDocx(buffer) {
  const yauzl = require('yauzl');
  await new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true, validateEntrySizes: true, strictFileNames: true }, (error, zip) => {
      if (error) return reject(new Error('Word 文档损坏，请另存为 .docx 后重试'));
      let total = 0, count = 0, hasDocument = false;
      const fail = () => { zip.close(); reject(new Error('Word 文档过大、加密或格式异常，请另存后重试')); };
      zip.on('error', fail);
      zip.on('end', () => hasDocument ? resolve() : reject(new Error('不是有效的 .docx 文档')));
      zip.on('entry', entry => {
        total += entry.uncompressedSize; count++;
        if (count > 2000 || total > 40 * 1024 * 1024 || entry.uncompressedSize > 12 * 1024 * 1024 || entry.generalPurposeBitFlag & 1) return fail();
        if (entry.fileName === 'word/document.xml') hasDocument = true;
        if (entry.fileName.endsWith('/')) return zip.readEntry();
        zip.openReadStream(entry, (error, stream) => {
          if (error) return fail();
          let actual = 0;
          stream.on('data', chunk => { actual += chunk.length; if (actual > entry.uncompressedSize || actual > 12 * 1024 * 1024) { stream.destroy(); fail(); } });
          stream.on('error', fail); stream.on('end', () => zip.readEntry());
        });
      });
      zip.readEntry();
    });
  });
}

async function parsePdf() {
  if (!data.subarray(0, 1024).includes(Buffer.from('%PDF-'))) throw new Error('不是有效的 PDF 文件');
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const loading = pdfjs.getDocument({ data: new Uint8Array(data), isEvalSupported: false, enableXfa: false,
    useWasm: false, useWorkerFetch: false, disableFontFace: true, useSystemFonts: false,
    isOffscreenCanvasSupported: false, disableAutoFetch: true, verbosity: 0 });
  let doc;
  try {
    doc = await loading.promise;
    if (doc.numPages > 200) throw new Error('PDF 超过 200 页，请按章节拆分后导入');
    let text = '', emptyPages = 0;
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      const pageText = content.items.map(item => typeof item.str === 'string' ? item.str + (item.hasEOL ? '\n' : ' ') : '').join('').trim();
      if (!pageText) emptyPages++;
      text += pageText + '\n\n';
      page.cleanup();
      if (text.length > MAX_TEXT) break;
    }
    if (!text.trim()) throw new Error('PDF 没有可提取的文字，可能是扫描件；请先 OCR 或粘贴文字');
    return { text, warning: emptyPages ? '部分页面没有文字层，可能需要 OCR；请核对正文是否完整。' : 'PDF 的分栏与换行可能变化，请核对提取的正文。' };
  } catch (error) {
    if (error.name === 'PasswordException') throw new Error('PDF 已加密，请先在阅读器中解锁并另存后导入');
    if (/^PDF/.test(error.message)) throw error;
    throw new Error('PDF 无法读取，请另存为普通 PDF 或粘贴文字');
  } finally { await loading.destroy(); }
}

async function parse() {
  let result;
  if (workerData.extension === '.docx') {
    await validateDocx(data);
    const mammoth = require('mammoth');
    const parsed = await mammoth.extractRawText({ buffer: data }, { externalFileAccess: false });
    result = { text: parsed.value, warning: '已提取 Word 正文；图片、批注与排版不包含在阅读文本中。' };
  } else if (workerData.extension === '.pdf') result = await parsePdf();
  else {
    const encoding = data[0] === 0xff && data[1] === 0xfe ? 'utf-16le' : data[0] === 0xfe && data[1] === 0xff ? 'utf-16be' : 'utf-8';
    try { result = { text: new TextDecoder(encoding, { fatal: true }).decode(data) }; }
    catch { throw new Error('文本编码无法识别，请另存为 UTF-8，或直接粘贴文字'); }
  }
  result.text = result.text.replace(/\0/g, '').replace(/\r\n?/g, '\n').trim();
  if (!result.text || !/[A-Za-z]/.test(result.text)) throw new Error('没有找到英文正文，请换一份材料或粘贴文字');
  if (result.text.length > MAX_TEXT) {
    result.text = result.text.slice(0, MAX_TEXT);
    result.warning = '材料较长，本次只提取前 20000 字符，其余尚未导入。请按章节拆分以保留全文。' + (result.warning || '');
  }
  return result;
}
parse().then(result => parentPort.postMessage(result)).catch(error => {
  const safe = /^[\u3400-\u9fff]|^(?:PDF|Word|文本|不是|没有)/.test(error.message) ? error.message : '文档读取失败，请另存后重试或粘贴文字';
  parentPort.postMessage({ error: safe });
});
