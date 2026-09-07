'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {windowTheme}=require('../electron/window-theme.cjs');
test('native title bar follows all themes, accepts saved custom colors and rejects malformed colors',()=>{
  const colors=['pinghe','ocean','plum','forest','graphite','terracotta'].map(preset=>windowTheme({preset}));
  assert.equal(new Set(colors.map(c=>c.primary)).size,6);assert.equal(new Set(colors.map(c=>c.paper)).size,6);
  assert.equal(windowTheme({preset:'ocean'}).primary,'#203f60');
  assert.equal(windowTheme({primary:'#123456',paper:'#fafafa'}).primary,'#123456');
  assert.equal(windowTheme({primary:'url(javascript:x)'}).primary,'#173f33');
  assert.equal(windowTheme({preset:'ocean',primary:'#ffffff',paper:'#000000'}).primary,'#203f60');
  assert.equal(windowTheme({preset:'ocean',primary:'#ffffff',paper:'#000000'}).paper,'#edf3f7');
});
