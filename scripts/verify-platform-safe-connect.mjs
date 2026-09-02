#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const files = [
  'packages/cli/src/commands/connectCommand.test.ts',
  'packages/cli/src/connectRootAuthority.test.ts',
  'packages/cli/src/commands/initStack.test.ts',
  'packages/cli/src/config/ConfigManager.test.ts',
  'packages/cli/src/index.test.ts',
  'packages/cli/src/orchestrator/index.test.ts',
  'packages/api/test/statusRoutes.test.ts',
].map((file) => join(root, file));

const result = spawnSync(process.execPath, [
  '--import', 'tsx', '--experimental-test-module-mocks', '--test', ...files,
], {
  cwd: root,
  shell: false,
  windowsHide: true,
  encoding: 'utf8',
  env: process.env,
  timeout: 90_000,
  maxBuffer: 16 * 1024 * 1024,
});

const stdout = result.stdout ?? '';
const stderr = result.stderr ?? '';
process.stdout.write(stdout);
process.stderr.write(stderr);

const tapValue = (name) => {
  const matches = [...stdout.matchAll(new RegExp(`^# ${name} (\\d+)$`, 'gm'))];
  return matches.length === 0 ? undefined : Number(matches.at(-1)[1]);
};
const valid = result.status === 0
  && !result.error
  && !result.signal
  && tapValue('tests') === 92
  && tapValue('pass') === 92
  && tapValue('fail') === 0
  && tapValue('skipped') === 0;

if (!valid) {
  process.stderr.write('Platform-safe Connect proof did not complete 92/92 within 90000ms.\n');
  process.exitCode = 1;
} else {
  process.stdout.write('Platform-safe Connect proof: tests=92 pass=92 fail=0 skipped=0 budgetMs=90000\n');
}
