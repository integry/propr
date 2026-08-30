import { writeFileSync } from 'node:fs';
import { createServer } from 'node:net';

const [pipePath, readyPath, resultPath, mode] = process.argv.slice(2);
if (![pipePath, readyPath, resultPath, mode].every((value) => typeof value === 'string' && value.length > 0)) {
  process.exit(2);
}

let fired = false;
const server = createServer({ allowHalfOpen: true }, (socket) => {
  let input = Buffer.alloc(0);
  socket.on('data', (chunk) => {
    input = Buffer.concat([input, chunk]);
    if (input.byteLength > 1024) socket.destroy();
  });
  socket.on('end', () => {
    fired = true;
    const line = input.toString('ascii').replace(/\n$/, '');
    const parts = line.split('|');
    const challenge = mode === 'stale' ? '0'.repeat(64) : (parts[1] ?? '0'.repeat(64));
    const response = {
      version: 1,
      kind: 'ready',
      challenge,
      supervisorPid: '1',
      sequence: 1,
      volumeSerialNumber: '0',
      fileId: '0',
      sha256: '0'.repeat(64),
      mac: '0'.repeat(64),
    };
    socket.end(`${JSON.stringify(response)}\n`);
    server.close(() => {
      writeFileSync(resultPath, JSON.stringify({ fired, mode }), 'utf8');
    });
  });
});

server.listen(pipePath, () => writeFileSync(readyPath, 'ready', 'utf8'));
setTimeout(() => {
  writeFileSync(resultPath, JSON.stringify({ fired, mode, timeout: true }), 'utf8');
  server.close(() => process.exit(fired ? 0 : 3));
}, 10_000).unref();
