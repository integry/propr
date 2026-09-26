import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  hasExactlyOneExplicitConnectStatusRoot,
  isExplicitConnectStatusInvocation,
} from './index.js';

test('every Connect status argument shape is identified before dotenv or option validation', () => {
  for (const args of [
    ['connect', 'status', '--json'],
    ['connect', 'status', '--json', '--root'],
    ['connect', 'status', '--json', '--root='],
    ['connect', 'status', '--root', '/one', '--root', '/two', '--json'],
    ['--project', 'owner/repo', 'connect', 'status', '--root=/one', '-j'],
    ['connect', 'status', '--json', '--', '--root', '/ignored'],
    ['connect', 'status', '--root=/one', '--', '--root=/ignored'],
  ]) assert.equal(isExplicitConnectStatusInvocation(['node', 'propr', ...args]), true, args.join(' '));

  for (const args of [
    ['connect', '--', 'status', '--json', '--root=/ignored'],
    ['--', 'connect', 'status', '--json', '--root=/ignored'],
  ]) assert.equal(isExplicitConnectStatusInvocation(['node', 'propr', ...args]), false, args.join(' '));

  for (const args of [
    ['connect', 'status', '--json'],
    ['connect', 'status', '--json', '--root'],
    ['connect', 'status', '--json', '--root='],
    ['connect', 'status', '--json', '--root', ''],
    ['connect', 'status', '--root', '/one', '--root', '/two', '--json'],
    ['connect', 'status', '--root=/one', '--root=/two', '--json'],
    ['connect', 'status', '--json', '--', '--root', '/ignored'],
    ['connect', 'status', '--json', '--', '--root=/ignored'],
  ]) assert.equal(hasExactlyOneExplicitConnectStatusRoot(['node', 'propr', ...args]), false, args.join(' '));

  for (const args of [
    ['connect', 'status', '--json', '--root', '/one'],
    ['--project', 'owner/repo', 'connect', 'status', '--root=/one', '-j'],
    ['connect', 'status', '--json', '--root', '/one', '--', '--root', '/ignored'],
    ['connect', 'status', '--root=/one', '--', '--root=/ignored', '--help'],
  ]) assert.equal(hasExactlyOneExplicitConnectStatusRoot(['node', 'propr', ...args]), true, args.join(' '));
});

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

  const builtEntryPoint = fileURLToPath(new URL('../dist/index.js', import.meta.url));
  const hostileCwd = mkdtempSync(join(tmpdir(), 'propr-connect-help-'));
  writeFileSync(join(hostileCwd, '.env'), [
    'PROPR_STACK=help-cwd-stack-SENTINEL',
    'HOST_DATA_DIR=${HELP_CWD_SECRET_SENTINEL}',
  ].join('\n'));
  try {
    for (const args of [
      ['connect', 'status', '--help'],
      ['connect', 'status', '-h'],
      ['connect', 'status', '--help', '--json', '--root'],
      ['connect', 'status', '--json', '--root', '--help'],
      ['connect', 'status', '--root=/one', '-h', '--root=/two', '--json'],
      ['--project', 'owner/repo', 'connect', 'status', '--root=', '--json', '-h'],
      ['connect', 'status', '--json', '--help', '--', '--root=/ignored'],
    ]) {
      const help = spawnSync(process.execPath, [builtEntryPoint, ...args], {
        cwd: hostileCwd,
        encoding: 'utf8',
        env: { ...process.env, HELP_CWD_SECRET_SENTINEL: 'never-print-this-SENTINEL' },
      });
      assert.equal(help.status, 0, `${args.join(' ')}\n${help.stderr}`);
      assert.equal(help.stderr, '', args.join(' '));
      assert.match(help.stdout, /^Usage: propr connect status \[options\]$/m, args.join(' '));
      assert.match(help.stdout, /Print the versioned secret-free desktop discovery contract/, args.join(' '));
      assert.match(help.stdout, /-h, --help\s+display help for command/, args.join(' '));
      assert.equal(help.stdout.includes('"schemaVersion"'), false, args.join(' '));
      assert.equal(help.stdout.includes('INVALID_ROOT'), false, args.join(' '));
      assert.equal(help.stdout.includes('SENTINEL'), false, args.join(' '));
    }
  } finally {
    rmSync(hostileCwd, { recursive: true, force: true });
  }
});
