'use strict';

// 最小 .docx 读写模块：读取正文段落、生成精简 Word 文档、在文末追加段落。
// 运行时只依赖 yauzl（读 zip）与 node:zlib（deflate），不引入新的第三方依赖。
// ZIP 打包为手写实现：本地文件头 + 中央目录 + EOCD；CRC-32 为本地表驱动实现（IEEE 0xEDB88320）。

const zlib = require('node:zlib');
const yauzl = require('yauzl');

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

const MAX_DOCX_BYTES = 24 * 1024 * 1024; // .docx 容器大小上限
const MAX_ENTRY_BYTES = 64 * 1024 * 1024; // 单条目解压后大小上限（防 ZIP 炸弹）
const MAX_TOTAL_BYTES = 96 * 1024 * 1024; // 解压后总量上限（防 ZIP 炸弹）
const MAX_ZIP_ENTRIES = 2000; // ZIP 条目数上限
const MAX_PARAGRAPHS = 500; // 段落条数上限
const MAX_PARAGRAPH_CHARS = 20000; // 单段字符上限
const MAX_TITLE_CHARS = 200; // 标题字符上限

const INVALID_DOCX = '不是有效的 .docx 文档（ZIP 结构无法解析）';
const MISSING_DOCUMENT_XML = '不是有效的 .docx 文档：缺少 word/document.xml';
const PARAGRAPHS_INVALID = '段落必须是不超过 500 条、每条不超过 20000 字符的字符串数组';
const TITLE_INVALID = '标题必须是不超过 200 字的非空字符串';

// —— OOXML 骨架：最小但规范的 [Content_Types].xml / _rels/.rels / word/document.xml ——

const CONTENT_TYPES_XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
  '<Default Extension="xml" ContentType="application/xml"/>' +
  '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
  '</Types>';

const RELS_XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
  '</Relationships>';

const DOCUMENT_OPEN = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>';
// A4 页面与 1 英寸页边距的收尾 sectPr，追加段落时要插在它前面。
const DOCUMENT_CLOSE = '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>' +
  '<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="851" w:footer="992" w:gutter="0"/>' +
  '</w:sectPr></w:body></w:document>';

// —— CRC-32（IEEE 多项式 0xEDB88320，表驱动）——

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let value = n;
    for (let bit = 0; bit < 8; bit += 1) value = (value & 1) !== 0 ? 0xEDB88320 ^ (value >>> 1) : value >>> 1;
    table[n] = value >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buffer.length; i += 1) crc = (crc >>> 8) ^ CRC32_TABLE[(crc ^ buffer[i]) & 0xFF];
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

// —— ZIP 打包（仅写：本地文件头 → deflate 数据 → 中央目录 → EOCD）——

function dosTime(date) {
  return (((date.getHours() & 31) << 11) | ((date.getMinutes() & 63) << 5) | (Math.floor(date.getSeconds() / 2) & 31)) & 0xFFFF;
}

function dosDate(date) {
  return ((((date.getFullYear() - 1980) & 127) << 9) | (((date.getMonth() + 1) & 15) << 5) | (date.getDate() & 31)) & 0xFFFF;
}

// entries: [{ name, data: Buffer }]，按数组顺序写入；不写目录条目（纯路径即可）。
function buildZip(entries) {
  const now = new Date();
  const time = dosTime(now);
  const date = dosDate(now);
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, 'utf8');
    const raw = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data);
    const checksum = crc32(raw);
    const compressed = zlib.deflateRawSync(raw, { level: 9 });
    const local = Buffer.alloc(30 + nameBytes.length);
    local.writeUInt32LE(0x04034b50, 0); // 本地文件头签名
    local.writeUInt16LE(20, 4); // 解压所需版本
    local.writeUInt16LE(0x0800, 6); // 通用标志：UTF-8 文件名
    local.writeUInt16LE(8, 8); // 压缩方法：deflate
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(checksum, 14); // 未压缩数据的 CRC-32
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28); // 扩展字段长度
    nameBytes.copy(local, 30);
    locals.push(local, compressed);

    const central = Buffer.alloc(46 + nameBytes.length);
    central.writeUInt32LE(0x02014b50, 0); // 中央目录签名
    central.writeUInt16LE(20, 4); // 创建版本
    central.writeUInt16LE(20, 6); // 解压所需版本
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42); // 本地头偏移
    nameBytes.copy(central, 46);
    centrals.push(central);

    offset += local.length + compressed.length;
  }
  const centralDirectory = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // EOCD 签名
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDirectory.length, 12);
  eocd.writeUInt32LE(offset, 16); // 中央目录起始偏移
  return Buffer.concat([...locals, centralDirectory, eocd]);
}

// —— ZIP 同步解析（仅供 append 使用：读出全部条目后整体重建）——

function locateEndOfCentralDirectory(buffer) {
  const minStart = Math.max(0, buffer.length - 22 - 0xFFFF); // EOCD 注释最长 65535 字节
  for (let i = buffer.length - 22; i >= minStart; i -= 1) {
    if (buffer.readUInt32LE(i) !== 0x06054b50) continue;
    const cdSize = buffer.readUInt32LE(i + 12);
    const cdOffset = buffer.readUInt32LE(i + 16);
    // 中央目录必须恰好结束于 EOCD 处，避免误匹配注释里的同名字节。
    if (cdOffset + cdSize === i) return { totalEntries: buffer.readUInt16LE(i + 10), cdOffset };
  }
  throw new Error(INVALID_DOCX);
}

function readZipEntriesSync(buffer) {
  const eocd = locateEndOfCentralDirectory(buffer);
  if (eocd.totalEntries === 0xFFFF || eocd.cdOffset === 0xFFFFFFFF) throw new Error('暂不支持 ZIP64 格式的 .docx 文档');
  if (eocd.totalEntries > MAX_ZIP_ENTRIES) throw new Error('文档包含过多条目，无法处理');
  const entries = [];
  let totalBytes = 0;
  let offset = eocd.cdOffset;
  for (let index = 0; index < eocd.totalEntries; index += 1) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error(INVALID_DOCX);
    const flags = buffer.readUInt16LE(offset + 8);
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    offset += 46 + nameLength + extraLength + commentLength;
    if (name.endsWith('/')) continue; // 目录条目没有数据，重建时跳过
    if ((flags & 1) !== 0) throw new Error('文档已加密，请先解密后再处理');
    if (method !== 0 && method !== 8) throw new Error(`${INVALID_DOCX}：不支持的压缩方法`);
    if (uncompressedSize > MAX_ENTRY_BYTES) throw new Error('文档条目过大，无法处理');
    if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== 0x04034b50) throw new Error(INVALID_DOCX);
    const dataStart = localOffset + 30 + buffer.readUInt16LE(localOffset + 26) + buffer.readUInt16LE(localOffset + 28);
    if (dataStart + compressedSize > buffer.length) throw new Error(INVALID_DOCX);
    const raw = buffer.subarray(dataStart, dataStart + compressedSize);
    let data;
    if (method === 0) {
      data = Buffer.from(raw);
    } else {
      try {
        data = zlib.inflateRawSync(raw, { maxOutputLength: MAX_ENTRY_BYTES });
      } catch (error) {
        throw new Error(error && error.code === 'ERR_BUFFER_TOO_LARGE' ? '文档条目过大，无法处理' : INVALID_DOCX);
      }
    }
    totalBytes += data.length;
    if (totalBytes > MAX_TOTAL_BYTES) throw new Error('文档解压后过大，无法处理');
    entries.push({ name, data });
  }
  return entries;
}

// —— ZIP 异步读取（readDocxParagraphs 按约定走 yauzl.fromBuffer）——

function assertDocxBuffer(buffer) {
  if (!Buffer.isBuffer(buffer) && !(buffer instanceof Uint8Array)) throw new Error('文档内容必须是 Buffer 或 Uint8Array');
  if (buffer.byteLength > MAX_DOCX_BYTES) throw new Error('文档超过 24 MB，无法处理');
  return Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
}

function readDocxPart(buffer, entryName) {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true, validateEntrySizes: true }, (error, zip) => {
      if (error) return reject(new Error(INVALID_DOCX));
      let found = null;
      let failed = false;
      const fail = (message) => { if (!failed) { failed = true; zip.close(); reject(new Error(message)); } };
      zip.on('error', () => fail(INVALID_DOCX));
      zip.on('entry', (entry) => {
        if (found) return zip.readEntry();
        if ((entry.generalPurposeBitFlag & 1) !== 0) return fail('文档已加密，请先解密后再处理');
        if (entry.uncompressedSize > MAX_ENTRY_BYTES) return fail('文档条目过大，无法处理');
        if (entry.fileName !== entryName) return zip.readEntry();
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError) return fail(INVALID_DOCX);
          const chunks = [];
          let total = 0;
          stream.on('data', (chunk) => {
            total += chunk.length;
            if (total > MAX_ENTRY_BYTES) { stream.destroy(); return fail('文档条目过大，无法处理'); }
            chunks.push(chunk);
          });
          stream.on('error', () => fail(INVALID_DOCX));
          stream.on('end', () => { found = Buffer.concat(chunks); zip.readEntry(); });
        });
      });
      zip.on('end', () => {
        zip.close();
        if (!failed) found ? resolve(found) : reject(new Error(`不是有效的 .docx 文档：缺少 ${entryName}`));
      });
      zip.readEntry();
    });
  });
}

// —— OOXML 文本处理 ——

function escapeXml(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function normalizeNewlines(text) {
  return text.replace(/\r\n?/g, '\n');
}

// 段内换行统一转成 <w:br/>；<w:br/> 必须是 run 的直接子元素，与 <w:t> 平级，
// 每行各占一个 <w:t>（xml:space="preserve" 保留首尾空格）。
function textRuns(text) {
  return normalizeNewlines(text).split('\n').map((line) => `<w:t xml:space="preserve">${escapeXml(line)}</w:t>`).join('<w:br/>');
}

function headingParagraph(title) {
  return '<w:p><w:pPr><w:spacing w:after="240"/></w:pPr>' +
    `<w:r><w:rPr><w:b/><w:sz w:val="32"/><w:szCs w:val="32"/></w:rPr>${textRuns(title)}</w:r></w:p>`;
}

function bodyParagraph(text) {
  return `<w:p><w:r>${textRuns(text)}</w:r></w:p>`;
}

function safeCodePoint(value) {
  return Number.isInteger(value) && value >= 0 && value <= 0x10FFFF ? String.fromCodePoint(value) : '';
}

// 先解码具名/数字实体，最后解码 &amp;，避免 "amp;lt;" 一类被二次解码。
function decodeXmlEntities(text) {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (unused, code) => safeCodePoint(parseInt(code, 16)))
    .replace(/&#(\d+);/g, (unused, code) => safeCodePoint(Number(code)))
    .replace(/&amp;/g, '&');
}

const PARAGRAPH_TEXT_TOKENS = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:br(?:\s[^>]*)?\/?>|<w:tab(?:\s[^>]*)?\/?>/g;
const PARAGRAPH_PATTERN = /<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g;

function paragraphText(paragraphXml) {
  let text = '';
  let match;
  PARAGRAPH_TEXT_TOKENS.lastIndex = 0;
  while ((match = PARAGRAPH_TEXT_TOKENS.exec(paragraphXml)) !== null) {
    if (match[1] !== undefined) text += decodeXmlEntities(match[1]);
    else text += match[0].startsWith('<w:tab') ? '\t' : '\n';
  }
  return text;
}

function extractParagraphTexts(xml) {
  const paragraphs = [];
  let match;
  PARAGRAPH_PATTERN.lastIndex = 0;
  while ((match = PARAGRAPH_PATTERN.exec(xml)) !== null && paragraphs.length < MAX_PARAGRAPHS) {
    const text = paragraphText(match[0]).trim();
    if (text) paragraphs.push(text); // 跳过空白段落
  }
  return paragraphs;
}

// —— 输入校验 ——

function validateTitle(title) {
  if (typeof title !== 'string' || !title.trim() || title.length > MAX_TITLE_CHARS) throw new Error(TITLE_INVALID);
  return title;
}

function validateParagraphs(paragraphs) {
  if (!Array.isArray(paragraphs) || paragraphs.length > MAX_PARAGRAPHS) throw new Error(PARAGRAPHS_INVALID);
  for (const paragraph of paragraphs) {
    if (typeof paragraph !== 'string' || paragraph.length > MAX_PARAGRAPH_CHARS) throw new Error(PARAGRAPHS_INVALID);
  }
  return paragraphs;
}

// 新段落插在 </w:body> 之前；若 body 以正文级 sectPr 收尾（紧贴 </w:body>）则插在它前面。
function insertParagraphsBeforeTrailingSectPr(xml, paragraphsXml) {
  const bodyEnd = xml.lastIndexOf('</w:body>');
  if (bodyEnd === -1) throw new Error('不是有效的 .docx 文档：word/document.xml 缺少 </w:body>');
  const head = xml.slice(0, bodyEnd);
  const sectPrStart = head.lastIndexOf('<w:sectPr');
  const trailing = sectPrStart !== -1 &&
    /^<w:sectPr\b[^>]*(?:\/>|>[\s\S]*?<\/w:sectPr>)\s*$/.test(head.slice(sectPrStart));
  const insertAt = trailing ? sectPrStart : bodyEnd;
  return xml.slice(0, insertAt) + paragraphsXml.join('') + xml.slice(insertAt);
}

// —— 对外 API ——

async function readDocxParagraphs(buffer) {
  const documentXml = (await readDocxPart(assertDocxBuffer(buffer), 'word/document.xml')).toString('utf8');
  return extractParagraphTexts(documentXml);
}

function buildDocx(options) {
  const { title, paragraphs } = options || {};
  validateTitle(title);
  validateParagraphs(paragraphs);
  const body = [headingParagraph(title)].concat(paragraphs.map(bodyParagraph)).join('');
  return buildZip([
    { name: '[Content_Types].xml', data: Buffer.from(CONTENT_TYPES_XML, 'utf8') },
    { name: '_rels/.rels', data: Buffer.from(RELS_XML, 'utf8') },
    { name: 'word/document.xml', data: Buffer.from(DOCUMENT_OPEN + body + DOCUMENT_CLOSE, 'utf8') },
  ]);
}

function appendDocxParagraphs(buffer, paragraphs) {
  validateParagraphs(paragraphs);
  const entries = readZipEntriesSync(assertDocxBuffer(buffer));
  const documentEntry = entries.find((entry) => entry.name === 'word/document.xml');
  if (!documentEntry) throw new Error(MISSING_DOCUMENT_XML);
  const documentXml = insertParagraphsBeforeTrailingSectPr(documentEntry.data.toString('utf8'), paragraphs.map(bodyParagraph));
  return buildZip(entries.map((entry) => entry.name === 'word/document.xml'
    ? { name: entry.name, data: Buffer.from(documentXml, 'utf8') }
    : entry));
}

module.exports = { DOCX_MIME, crc32, readDocxParagraphs, buildDocx, appendDocxParagraphs };
