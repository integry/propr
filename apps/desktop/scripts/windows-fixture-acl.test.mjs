import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, win32 } from 'node:path';
import { it } from 'node:test';
import { encodedWindowsFixtureAcl } from './windows-fixture-acl.mjs';

const windowsIt = process.platform === 'win32' ? it : it.skip;

windowsIt('keeps the encoded Windows PowerShell 5.1 ACL helper fail-closed and byte-empty', () => {
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

  const temporaryDirectoryAlias = tmpdir();
  const canonicalTemporaryDirectory = realpathSync(temporaryDirectoryAlias);
  const fixture = mkdtempSync(join(canonicalTemporaryDirectory, 'propr-fixture-acl-output-'));
  const fixtureAlias = join(temporaryDirectoryAlias, basename(fixture));
  const directory = join(fixture, 'data');
  const file = join(directory, 'identity.json');
  mkdirSync(directory);
  writeFileSync(file, '{}\n');

  try {
    const entries = [
      { label: 'relative path', kind: 'directory', path: 'data', status: 40 },
      { label: 'mismatched directory kind', kind: 'file', path: directory, status: 41 },
      { label: 'mismatched file kind', kind: 'directory', path: file, status: 41 },
      { label: 'invalid full path', kind: 'file', path: `${directory}\\invalid|name`, status: 48 },
      { label: 'canonical traversal alias', kind: 'directory', path: `${directory}\\..\\data`, status: 49 },
      { label: 'empty path', kind: 'directory', path: '', status: 50 },
      { label: 'invalid entry kind', kind: 'invalid', path: file, status: 50 },
      { label: 'directory success', kind: 'directory', path: directory, status: 0 },
      { label: 'file success', kind: 'file', path: file, status: 0 },
    ];

    // Windows PowerShell 5.1 GetFullPath expands existing 8.3 components. When
    // the runner supplies that spelling, reproduce the original directory and
    // file failures and prove they are canonical-equality rejections.
    if (fixtureAlias.toUpperCase() !== fixture.toUpperCase()) {
      entries.unshift(
        {
          label: 'temporary directory canonical alias',
          kind: 'directory',
          path: join(fixtureAlias, 'data'),
          status: 49,
        },
        {
          label: 'temporary file canonical alias',
          kind: 'file',
          path: join(fixtureAlias, 'data', 'identity.json'),
          status: 49,
        },
      );
    }

    for (const entry of entries) {
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
      assert.equal(result.status, entry.status, `${entry.label} returned the wrong redacted phase code`);
      assert.equal(result.stdout.length, 0, `${entry.label} helper stdout must contain zero bytes`);
      assert.equal(result.stderr.length, 0, `${entry.label} helper stderr must contain zero bytes`);
    }
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
