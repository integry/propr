import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import { it } from 'node:test';
import { encodedWindowsFixtureAcl } from './windows-fixture-acl.mjs';

const windowsIt = process.platform === 'win32' ? it : it.skip;

windowsIt('keeps the encoded Windows PowerShell 5.1 ACL helper success streams byte-empty', () => {
  assert.ok(process.env.SystemRoot);
  const powershell = win32.join(
    process.env.SystemRoot,
    'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe',
  );
  const version = spawnSync(powershell, [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
    '[Console]::Out.Write($PSVersionTable.PSVersion.ToString(2))',
  ], { shell: false, windowsHide: true, encoding: 'utf8', timeout: 10_000 });
  assert.ifError(version.error);
  assert.equal(version.status, 0);
  assert.equal(version.stdout, '5.1');
  assert.equal(version.stderr, '');

  const fixture = mkdtempSync(join(tmpdir(), 'propr-fixture-acl-output-'));
  const directory = join(fixture, 'data');
  const file = join(directory, 'identity.json');
  mkdirSync(directory);
  writeFileSync(file, '{}\n');

  try {
    for (const entry of [
      { kind: 'directory', path: directory },
      { kind: 'file', path: file },
    ]) {
      const result = spawnSync(powershell, [
        '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encodedWindowsFixtureAcl,
      ], {
        shell: false,
        windowsHide: true,
        timeout: 30_000,
        env: {
          ...process.env,
          PROPR_FIXTURE_ACL_KIND: entry.kind,
          PROPR_FIXTURE_ACL_PATH: entry.path,
        },
      });

      assert.ifError(result.error);
      assert.equal(result.signal, null);
      assert.equal(result.status, 0);
      assert.equal(result.stdout.length, 0, `${entry.kind} helper stdout must contain zero bytes`);
      assert.equal(result.stderr.length, 0, `${entry.kind} helper stderr must contain zero bytes`);
    }
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
