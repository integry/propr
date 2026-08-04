import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

test('direct CLI execution is not disabled by test environment variables', () => {
  const entryPoint = fileURLToPath(new URL('./index.ts', import.meta.url));
  const result = spawnSync(process.execPath, ['--import', 'tsx', entryPoint, '--version'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      NODE_ENV: 'test',
      NODE_TEST_CONTEXT: 'child-v8',
    },
  });

  assert.equal(result.status, 0, result.stderr);
  const packageVersion = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
  assert.equal(result.stdout.trim(), packageVersion);
});
