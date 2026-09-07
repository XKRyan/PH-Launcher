'use strict';
const fs = require('node:fs');
const path = require('node:path');
const catalog = require('../src/locales/en.js');
const known = s => catalog.exact[s] !== undefined || catalog.patterns.some(([p]) => new RegExp(p).test(s));
const found = new Map();
function add(s, file) {
  s = s.trim();
  if (!/[\u3400-\u9fff]/.test(s) || s.includes('${') || s.includes('<') || s.includes('\\') || s.length > 400 || known(s)) return;
  if (!found.has(s)) found.set(s, file);
}
for (const name of fs.readdirSync(path.join(__dirname,'../src'))) {
  if (!/\.(js|html)$/.test(name)) continue;
  const source = fs.readFileSync(path.join(__dirname,'../src',name),'utf8');
  for (const m of source.matchAll(/(['"])((?:\\.|(?!\1)[^\\\r\n])*?)\1/g)) add(m[2], name);
  for (const m of source.matchAll(/>([^<>]+)</g)) add(m[1], name);
}
for (const [text,file] of found) console.log(JSON.stringify({file,text}));
