const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
test('each AI turn has its own deadline and API timeouts do not blame local models',()=>{
  const s=fs.readFileSync(require.resolve('../electron/main.cjs'),'utf8');
  const turn=s.slice(s.indexOf('async function requestAiTurn'),s.indexOf('function toolResultMessage'));
  assert.match(turn,/AbortSignal.any\(\[signal, deadline\]\)/);
  assert.match(s,/config.provider === 'api'\s*\? 'API 服务商本轮回复超时/);
  assert.doesNotMatch(s,/AI 回复超时，请检查本机模型是否仍在运行/);
  assert.match(s,/10 \* 60_000/);
});
