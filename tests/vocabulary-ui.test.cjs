const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ui = fs.readFileSync(path.join(__dirname, '..', 'src', 'vocabulary-ui.js'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '..', 'src', 'vocabulary.css'), 'utf8');

test('new cards use a preview batch and advanced tools are not default tabs', () => {
  assert.match(ui, /slice\(0, 5\)/);
  assert.match(ui, /新词预览 · 第/);
  assert.match(ui, /'start-batch-recall'/);
  assert.match(ui, /'known-new'/);
  assert.match(ui, /开始学新词/);
  assert.match(ui, /更多工具/);
  assert.doesNotMatch(ui, /<button data-vocab-action="reading" class="\$\{state\.view === 'reading'/);
});

test('dialog close control has a square centered target and a concentric focus ring', () => {
  assert.match(css, /\.vocab-dialog-head > button \{ display: grid; place-items: center;/);
  assert.match(css, /width: 2rem; height: 2rem; min-width: 2rem; padding: 0; line-height: 1;/);
  assert.match(css, /\.vocab-dialog-head > button:focus-visible \{ outline-offset: 2px;/);
});
