import { copyFileSync, existsSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';

const [target, source, ready, continuation, resultPath, mode] = process.argv.slice(2);
if (![target, source, ready, continuation, resultPath, mode].every((value) => typeof value === 'string' && value.length > 0)) {
  process.exit(2);
}

const deadline = Date.now() + 2_000;
while (!existsSync(ready) && Date.now() < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);

let replaced = false;
let restored = false;
let code = 'NO_BARRIER';
const detached = `${target}.attacker-detached`;
if (existsSync(ready)) {
  code = 'BLOCKED';
  try {
    renameSync(target, detached);
    copyFileSync(source, target);
    replaced = true;
    code = 'REPLACED';
    if (mode === 'aba') {
      unlinkSync(target);
      renameSync(detached, target);
      restored = true;
      code = 'ABA_RESTORED';
    }
  } catch (error) {
    code = typeof error === 'object' && error && 'code' in error ? String(error.code) : 'BLOCKED';
  }
}
writeFileSync(resultPath, JSON.stringify({ attempted: existsSync(ready), replaced, restored, code }), { encoding: 'utf8' });
writeFileSync(continuation, 'continue', { encoding: 'utf8' });
