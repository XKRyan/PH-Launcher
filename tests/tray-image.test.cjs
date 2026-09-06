'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {createTrayImage}=require('../electron/tray-image.cjs');
test('tray uses packaged raster PNG and platform-specific sizes, never unsupported SVG URLs',()=>{
  for(const [platform,size] of [['win32',32],['darwin',18]]) {
    let loaded,options;
    const result={isEmpty:()=>false};
    const nativeImage={createFromPath:p=>{loaded=p;return {isEmpty:()=>false,resize:o=>{options=o;return result;}};}};
    assert.equal(createTrayImage(nativeImage,'F:/PH Launcher',platform),result);
    assert.match(loaded,/assets[\\/]icon\.png$/); assert.equal(options.width,size); assert.equal(options.height,size);
  }
});
test('missing tray raster fails visibly instead of creating a blank tray icon',()=>{
  assert.throws(()=>createTrayImage({createFromPath:()=>({isEmpty:()=>true})},'.'),/could not be loaded/);
});
