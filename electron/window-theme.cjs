'use strict';
const themes={pinghe:['#173f33','#f5f2e9'],ocean:['#203f60','#edf3f7'],plum:['#513449','#f7f0f3'],forest:['#244b40','#f0f5ee'],graphite:['#333f48','#f1f2f3'],terracotta:['#643d33','#f8f0e8']};
function windowTheme(input={}) {
  const base=themes[input?.preset] || themes.pinghe;
  const valid=value=>typeof value==='string'&&/^#[0-9a-f]{6}$/i.test(value);
  const luminance=color=>[1,3,5].map(n=>parseInt(color.slice(n,n+2),16)/255).map(n=>n<=.04045?n/12.92:((n+.055)/1.055)**2.4).reduce((sum,n,i)=>sum+n*[.2126,.7152,.0722][i],0);
  let primary=valid(input?.primary)?input.primary:base[0];
  let paper=valid(input?.paper)?input.paper:base[1];
  // Match renderer contrast rules so restored custom themes cannot split the title bar.
  if(1.05/(luminance(primary)+.05)<4.5) primary=base[0];
  if((luminance(paper)+.05)/(luminance('#18231e')+.05)<7) paper=base[1];
  return {primary,paper,symbol:'#ffffff'};
}
module.exports={windowTheme};
