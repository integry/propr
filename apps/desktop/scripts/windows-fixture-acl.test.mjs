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

const exactDaclProofSource = String.raw`
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
try {
  $entryKind=$env:PROPR_FIXTURE_ACL_KIND
  $entryPath=$env:PROPR_FIXTURE_ACL_PATH
  $proofKind=$env:PROPR_FIXTURE_ACL_PROOF
  if(($entryKind -ne 'directory' -and $entryKind -ne 'file') -or
    ($proofKind -ne 'owner' -and $proofKind -ne 'exact') -or
    [String]::IsNullOrEmpty($entryPath)){exit 70}
} catch { exit 70 }
try {
  $sections=[System.Security.AccessControl.AccessControlSections]::Access -bor [System.Security.AccessControl.AccessControlSections]::Owner
  $acl=if($entryKind -eq 'directory'){
    [System.IO.Directory]::GetAccessControl($entryPath,$sections)
  }else{[System.IO.File]::GetAccessControl($entryPath,$sections)}
} catch { exit 71 }
try {
  $current=[Security.Principal.WindowsIdentity]::GetCurrent().User
  $owner=$acl.GetOwner([Security.Principal.SecurityIdentifier])
  if($null -eq $current -or $null -eq $owner -or $owner.Value -ne $current.Value){exit 72}
} catch { exit 72 }
if($proofKind -eq 'owner'){exit 0}
try {
  $rules=@($acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]))
  if(-not $acl.AreAccessRulesProtected -or -not $acl.AreAccessRulesCanonical -or
    $rules.Count -ne 3 -or @($rules | Where-Object {$_.IsInherited}).Count -ne 0){exit 73}
} catch { exit 73 }
try {
  $expectedSids=@($current.Value,'S-1-5-18','S-1-5-32-544')
  $expectedInheritance=if($entryKind -eq 'directory'){
    [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
  }else{[Security.AccessControl.InheritanceFlags]::None}
  foreach($sid in $expectedSids){
    $matches=@($rules | Where-Object {$_.IdentityReference.Value -eq $sid})
    if($matches.Count -ne 1){exit 74}
    $rule=$matches[0]
    if($rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or
      $rule.FileSystemRights -ne [Security.AccessControl.FileSystemRights]::FullControl -or
      $rule.InheritanceFlags -ne $expectedInheritance -or
      $rule.PropagationFlags -ne [Security.AccessControl.PropagationFlags]::None -or
      $rule.IsInherited){exit 74}
  }
} catch { exit 74 }
`;

const encodedExactDaclProof = Buffer.from(exactDaclProofSource, 'utf16le').toString('base64');

const assertPowerShellStreamEmpty = (stream, category) => {
  if (!Buffer.isBuffer(stream) || stream.length !== 0) {
    const error = new Error(`Windows fixture ACL helper stream contract failed [category=${category}]`);
    error.stack = error.message;
    throw error;
  }
};

const assertAclProof = (powershell, entry, proofKind) => {
  const result = spawnSync(powershell, [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encodedExactDaclProof,
  ], {
    shell: false,
    windowsHide: true,
    timeout: 30_000,
    env: {
      ...process.env,
      PROPR_FIXTURE_ACL_KIND: entry.kind,
      PROPR_FIXTURE_ACL_PATH: entry.path,
      PROPR_FIXTURE_ACL_PROOF: proofKind,
    },
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  assertPowerShellStreamEmpty(result.stdout, 'dacl-proof-stdout');
  assertPowerShellStreamEmpty(result.stderr, 'dacl-proof-stderr');
  const category = new Map([
    [70, 'input'],
    [71, 'access-control-read'],
    [72, 'owner'],
    [73, 'protection'],
    [74, 'rules'],
  ]).get(result.status) ?? 'unexpected-exit';
  assert.equal(result.status, 0, `${entry.kind} ${proofKind} ACL proof failed [category=${category}]`);
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

    const ownerBaselineEntries = [
      { kind: 'directory', path: canonicalDirectory.path },
      { kind: 'file', path: canonicalFile.path },
    ];
    for (const entry of ownerBaselineEntries) assertAclProof(powershell, entry, 'owner');

    const entries = [
      { label: 'relative path', kind: 'directory', path: 'data', status: 40 },
      { label: 'mismatched directory kind', kind: 'file', path: canonicalDirectory.path, status: 41 },
      { label: 'mismatched file kind', kind: 'directory', path: canonicalFile.path, status: 41 },
      // A server-only UNC is rooted, but PS5.1/.NET Framework rejects it because
      // a valid UNC must also name a share. This reaches GetFullPath (phase 48).
      { label: 'invalid full path', kind: 'file', path: '\\\\propr-invalid-unc\\', status: 48 },
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
      if (entry.status === 0) assertAclProof(powershell, entry, 'exact');
    }
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
