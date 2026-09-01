import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';
import {
  canonicalizeWindowsFixtureEntry,
  encodedWindowsFixtureAcl,
  windowsPowerShell51Path,
} from './windows-fixture-acl.mjs';

const windowsIt = process.platform === 'win32' ? it : it.skip;

const assertPowerShellStreamEmpty = (stream, category) => {
  if (!Buffer.isBuffer(stream) || stream.length !== 0) {
    const error = new Error(`Windows fixture ACL helper stream contract failed [category=${category}]`);
    error.stack = error.message;
    throw error;
  }
};

windowsIt('keeps the encoded Windows PowerShell 5.1 ACL helper fail-closed and byte-empty', t => {
  const powershell = windowsPowerShell51Path();
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
  const directory = join(fixture, 'data');
  const file = join(directory, 'identity.json');
  mkdirSync(directory);
  writeFileSync(file, '{}\n');

  try {
    const canonicalDirectory = canonicalizeWindowsFixtureEntry({
      entryKind: 'directory', entryPath: directory, powershellPath: powershell,
    });
    const canonicalFile = canonicalizeWindowsFixtureEntry({
      entryKind: 'file', entryPath: file, powershellPath: powershell,
    });
    const canonicalizedEntries = [
      [directory, canonicalDirectory],
      [file, canonicalFile],
    ];
    const normalizationCategories = new Set();
    for (const [originalPath, entry] of canonicalizedEntries) {
      if (entry.path.toUpperCase() !== originalPath.toUpperCase()) {
        normalizationCategories.add(entry.normalization);
      }
    }
    for (const category of [...normalizationCategories].sort()) {
      t.diagnostic(`PS5.1 path normalization category=${category}`);
    }

    const entries = [
      { label: 'relative path', kind: 'directory', path: 'data', status: 40 },
      { label: 'mismatched directory kind', kind: 'file', path: canonicalDirectory.path, status: 41 },
      { label: 'mismatched file kind', kind: 'directory', path: canonicalFile.path, status: 41 },
      { label: 'invalid full path', kind: 'file', path: `${canonicalDirectory.path}\\invalid|name`, status: 48 },
      { label: 'canonical traversal alias', kind: 'directory', path: `${canonicalDirectory.path}\\..\\data`, status: 49 },
      { label: 'empty path', kind: 'directory', path: '', status: 50 },
      { label: 'invalid entry kind', kind: 'invalid', path: canonicalFile.path, status: 50 },
      { label: 'directory success', kind: 'directory', path: canonicalDirectory.path, status: 0 },
      { label: 'file success', kind: 'file', path: canonicalFile.path, status: 0 },
    ];

    // Node realpath can retain a spelling that PS5.1 further canonicalizes.
    // Keep that spelling uncanonicalized and prove the helper rejects it.
    if (canonicalDirectory.path.toUpperCase() !== directory.toUpperCase()) {
      entries.unshift(
        {
          label: 'precanonical directory spelling',
          kind: 'directory',
          path: directory,
          status: 49,
        },
        {
          label: 'precanonical file spelling',
          kind: 'file',
          path: file,
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
      assertPowerShellStreamEmpty(result.stdout, 'powershell-stdout');
      assertPowerShellStreamEmpty(result.stderr, 'powershell-stderr');
      assert.equal(result.status, entry.status, `${entry.label} returned the wrong redacted phase code`);
    }
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
