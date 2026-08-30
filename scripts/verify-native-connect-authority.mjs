#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';

const platform = process.platform;
if (platform !== 'darwin' && platform !== 'win32') {
  process.stderr.write('Native Connect authority verification requires macOS or Windows.\n');
  process.exit(1);
}

const common = [
  'ordinary-directory', 'ordinary-file', 'distinct-identity',
  'protected-root', 'protected-data', 'protected-env',
  'publication', 'ready-denial', 'recovery', 'identity-swap',
  'broad-publication', 'broad-root', 'broad-data', 'broad-env', 'broad-ancestor', 'explicit-deny',
  platform === 'win32' ? 'inherited-dacl' : 'inherited-darwin-acl',
  ...(platform === 'win32' ? ['foreign-owner'] : []),
  'packaged-helper-integrity',
  ...(platform === 'win32'
    ? ['bootstrap-after-lock', 'bootstrap-during-launch', 'bootstrap-aba', 'bootstrap-restart']
    : []),
  'reparse', 'replacement-barrier', 'inspection-handle-swap',
  'config-off', 'config-on', 'config-absence', 'config-disappearance',
  'config-broad-file', 'config-broad-directory', 'config-reparse', 'config-replacement',
];

const root = resolve(import.meta.dirname, '..');
const result = spawnSync(process.execPath, [
  '--import', 'tsx', '--test', join(root, 'test', 'nativeConnectAuthority.test.ts'),
], {
  cwd: root,
  shell: false,
  windowsHide: true,
  encoding: 'utf8',
  env: process.env,
  timeout: 180_000,
  maxBuffer: 2 * 1024 * 1024,
});

const stdout = result.stdout ?? '';
const stderr = result.stderr ?? '';
process.stdout.write(stdout);
process.stderr.write(stderr);

let summary;
for (const match of stdout.matchAll(/PROPR_NATIVE_AUTHORITY_SUMMARY (\{[^\r\n]+\})/g)) {
  try { summary = JSON.parse(match[1]); } catch { summary = undefined; }
}
const tapValue = (name) => {
  const matches = [...stdout.matchAll(new RegExp(`^# ${name} (\\d+)$`, 'gm'))];
  return matches.length === 0 ? undefined : Number(matches.at(-1)[1]);
};
const exactCounters = summary
  && summary.version === 1
  && summary.platform === platform
  && summary.counters
  && typeof summary.counters === 'object'
  && !Array.isArray(summary.counters)
  && Object.keys(summary.counters).sort().join('\0') === [...common].sort().join('\0')
  && common.every((name) => summary.counters[name] === 1);
const valid = result.status === 0
  && !result.error
  && !result.signal
  && tapValue('tests') === 6
  && tapValue('pass') === 6
  && tapValue('fail') === 0
  && tapValue('skipped') === 0
  && exactCounters;

if (!valid) {
  process.stderr.write('Native Connect authority proof was incomplete or malformed.\n');
  process.exit(1);
}
process.stdout.write(`Native authority proof: platform=${platform} tests=6 pass=6 fail=0 skipped=0 scenarios=${common.length}\n`);
