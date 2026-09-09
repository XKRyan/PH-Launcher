// Temporary startup timing probe: timestamps each stdout line of a child run.
const { spawn } = require('node:child_process');
const path = require('node:path');
const start = Date.now();
const child = spawn(process.execPath, process.argv.slice(2), { cwd: path.join(__dirname), env: { ...process.env, ELECTRON_RUN_AS_NODE: '' } });
const stamp = () => `+${String(Date.now() - start).padStart(6)}ms`;
for (const stream of [child.stdout, child.stderr]) {
  let buffer = '';
  stream.on('data', (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) if (line.trim()) console.log(`${stamp()} | ${line.slice(0, 160)}`);
  });
}
child.on('exit', (code) => { console.log(`${stamp()} | exit ${code}`); process.exit(code || 0); });
