'use strict';

const guarded = Symbol.for('ph-launcher.stdio-guard');

// A GUI application can outlive the terminal/launcher owning its output pipes.
// Console writes emit stream errors asynchronously, outside IPC try/catch.
// Handle only a disconnected pipe; unrelated failures must remain observable.
function guardStdio(streams = [process.stdout, process.stderr]) {
  for (const stream of streams) {
    if (!stream || stream[guarded]) continue;
    stream.on('error', (error) => {
      if (error?.code !== 'EPIPE') throw error;
    });
    stream[guarded] = true;
  }
}

module.exports = { guardStdio };
