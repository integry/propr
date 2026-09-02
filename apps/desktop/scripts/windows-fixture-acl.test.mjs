import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';
import {
  canonicalizeWindowsFixtureEntry,
  encodedWindowsFixtureAcl,
  WINDOWS_FIXTURE_PROCESS_TIMEOUT_MS,
  windowsFixtureAclSource,
  windowsPowerShell51Path,
} from './windows-fixture-acl.mjs';

const windowsIt = process.platform === 'win32' ? it : it.skip;

const ownerClassifierSource = String.raw`
function Get-ProprOwnerCategoryToken {
  param(
    [Parameter(Mandatory=$true)][Security.Principal.SecurityIdentifier]$Owner,
    [Parameter(Mandatory=$true)][Security.Principal.SecurityIdentifier]$Current
  )
  if($Owner.Value -eq $Current.Value){return 1}
  if($Owner.Value -eq 'S-1-5-32-544'){return 2}
  if($Owner.Value -eq 'S-1-5-18'){return 3}
  return 0
}`;

const exactDaclProofSource = String.raw`
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
${ownerClassifierSource}
try {
  $entryKind=$env:PROPR_FIXTURE_ACL_KIND
  $entryPath=$env:PROPR_FIXTURE_ACL_PATH
  $proofKind=$env:PROPR_FIXTURE_ACL_PROOF
  $expectedOwnerCategory=$env:PROPR_FIXTURE_ACL_OWNER_CATEGORY
  if(($entryKind -ne 'directory' -and $entryKind -ne 'file') -or
    ($proofKind -ne 'owner' -and $proofKind -ne 'exact') -or
    [String]::IsNullOrEmpty($entryPath)){exit 70}
  if($proofKind -eq 'owner' -and -not [String]::IsNullOrEmpty($expectedOwnerCategory)){exit 70}
  if($proofKind -eq 'exact' -and
    $expectedOwnerCategory -ne 'current-user' -and
    $expectedOwnerCategory -ne 'administrators' -and
    $expectedOwnerCategory -ne 'system'){exit 70}
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
  if($null -eq $current -or $null -eq $owner){exit 72}
  $ownerCategoryToken=Get-ProprOwnerCategoryToken -Owner $owner -Current $current
} catch { exit 72 }
if($ownerCategoryToken -eq 0){exit 78}
if($proofKind -eq 'owner'){
  if($ownerCategoryToken -eq 1){exit 75}
  if($ownerCategoryToken -eq 2){exit 76}
  if($ownerCategoryToken -eq 3){exit 77}
  exit 72
}
try {
  $expectedOwnerCategoryToken=if($expectedOwnerCategory -eq 'current-user'){1}
    elseif($expectedOwnerCategory -eq 'administrators'){2}
    elseif($expectedOwnerCategory -eq 'system'){3}
    else{exit 70}
  if($ownerCategoryToken -ne $expectedOwnerCategoryToken){exit 79}
} catch { exit 72 }
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

const ownerClassifierRegressionSource = String.raw`
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
${ownerClassifierSource}
try {
  $current=[Security.Principal.WindowsIdentity]::GetCurrent().User
  $admins=[Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')
  $system=[Security.Principal.SecurityIdentifier]::new('S-1-5-18')
  $unknown=[Security.Principal.SecurityIdentifier]::new('S-1-0-0')
  if($null -eq $current -or
    (Get-ProprOwnerCategoryToken -Owner $current -Current $current) -ne 1 -or
    (Get-ProprOwnerCategoryToken -Owner $admins -Current $current) -ne 2 -or
    (Get-ProprOwnerCategoryToken -Owner $system -Current $current) -ne 3){exit 80}
  $unknownOwnerCategoryToken=Get-ProprOwnerCategoryToken -Owner $unknown -Current $current
} catch { exit 82 }
if($unknownOwnerCategoryToken -eq 0){exit 78}
exit 81
`;

const encodedOwnerClassifierRegression = Buffer.from(
  ownerClassifierRegressionSource,
  'utf16le',
).toString('base64');

const baselineOwnerCategories = new Map([
  [75, 'current-user'],
  [76, 'administrators'],
  [77, 'system'],
]);

const assertPowerShellStreamEmpty = (stream, category) => {
  if (!Buffer.isBuffer(stream) || stream.length !== 0) {
    const error = new Error(`Windows fixture ACL helper stream contract failed [category=${category}]`);
    error.stack = error.message;
    throw error;
  }
};

const runAclProof = (powershell, entry, proofKind, ownerCategory = '') => spawnSync(
  powershell,
  [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encodedExactDaclProof,
  ],
  {
    shell: false,
    windowsHide: true,
    timeout: WINDOWS_FIXTURE_PROCESS_TIMEOUT_MS,
    env: {
      ...process.env,
      PROPR_FIXTURE_ACL_KIND: entry.kind,
      PROPR_FIXTURE_ACL_PATH: entry.path,
      PROPR_FIXTURE_ACL_PROOF: proofKind,
      PROPR_FIXTURE_ACL_OWNER_CATEGORY: ownerCategory,
    },
  },
);

const proofFailureCategory = status => new Map([
  [70, 'input'],
  [71, 'access-control-read'],
  [72, 'owner-lookup'],
  [73, 'protection'],
  [74, 'rules'],
  [78, 'owner-not-allowlisted'],
  [79, 'owner-category-mismatch'],
]).get(status) ?? 'unexpected-exit';

const assertPowerShellInvocation = (result, category) => {
  if (result.error) {
    const reason = result.error.code === 'ETIMEDOUT' ? 'timeout' : 'spawn';
    const error = new Error(`Windows fixture ACL helper failed [category=${category} reason=${reason}]`);
    error.stack = error.message;
    throw error;
  }
  assert.equal(result.signal, null);
};

const assertProofProcess = (result, category = 'acl-proof') => {
  assertPowerShellInvocation(result, category);
  assertPowerShellStreamEmpty(result.stdout, 'dacl-proof-stdout');
  assertPowerShellStreamEmpty(result.stderr, 'dacl-proof-stderr');
};

const classifyBaselineOwner = (powershell, entry) => {
  const result = runAclProof(powershell, entry, 'owner');
  assertProofProcess(result);
  const ownerCategory = baselineOwnerCategories.get(result.status);
  assert.ok(
    ownerCategory,
    `${entry.kind} owner ACL proof failed [category=${proofFailureCategory(result.status)}]`,
  );
  return ownerCategory;
};

const assertExactAcl = (powershell, entry, ownerCategory) => {
  const result = runAclProof(powershell, entry, 'exact', ownerCategory);
  assertProofProcess(result);
  assert.equal(
    result.status,
    0,
    `${entry.kind} exact ACL proof failed [category=${proofFailureCategory(result.status)}]`,
  );
};

const assertOwnerCategoryMismatch = (powershell, entry, ownerCategory) => {
  const mismatchedCategory = ownerCategory === 'current-user' ? 'administrators' : 'current-user';
  const result = runAclProof(powershell, entry, 'exact', mismatchedCategory);
  assertProofProcess(result);
  assert.equal(result.status, 79, `${entry.kind} accepted a mismatched owner category`);
};

windowsIt('keeps the encoded Windows PowerShell 5.1 ACL helper fail-closed and byte-empty', t => {
  assert.equal(WINDOWS_FIXTURE_PROCESS_TIMEOUT_MS, 60_000);
  const powershell = windowsPowerShell51Path();
  const version = spawnSync(powershell, [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
    '[Console]::Out.Write($PSVersionTable.PSVersion.ToString(2))',
  ], {
    shell: false, windowsHide: true, encoding: 'utf8', timeout: WINDOWS_FIXTURE_PROCESS_TIMEOUT_MS,
  });
  assertPowerShellInvocation(version, 'version');
  assert.equal(version.status, 0);
  assert.equal(version.stdout, '5.1');
  assert.equal(version.stderr, '');

  assert.match(
    windowsFixtureAclSource,
    /AccessControlSections\]::Access\s*\r?\n/u,
    'production mutation must request the access-control section',
  );
  assert.doesNotMatch(
    windowsFixtureAclSource,
    /AccessControlSections\]::Owner|\.SetOwner\s*\(/u,
    'production mutation must not request or set owner',
  );

  const classifierRegression = spawnSync(powershell, [
    '-NoLogo', '-NoProfile', '-NonInteractive',
    '-EncodedCommand', encodedOwnerClassifierRegression,
  ], { shell: false, windowsHide: true, timeout: WINDOWS_FIXTURE_PROCESS_TIMEOUT_MS });
  assertProofProcess(classifierRegression, 'owner-classifier');
  const classifierCategory = new Map([
    [78, 'unknown-owner'],
    [80, 'allowlisted-owner'],
    [81, 'unknown-owner-accepted'],
    [82, 'owner-lookup'],
  ]).get(classifierRegression.status) ?? 'unexpected-exit';
  assert.equal(
    classifierRegression.status,
    78,
    `owner classifier regression failed [category=${classifierCategory}]`,
  );

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

    const entriesWithBaselineOwner = [
      { kind: 'directory', path: canonicalDirectory.path },
      { kind: 'file', path: canonicalFile.path },
    ].map(entry => ({ ...entry, ownerCategory: classifyBaselineOwner(powershell, entry) }));

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
        timeout: WINDOWS_FIXTURE_PROCESS_TIMEOUT_MS,
        env: {
          ...process.env,
          PROPR_FIXTURE_ACL_KIND: entry.kind,
          PROPR_FIXTURE_ACL_PATH: entry.path,
        },
      });

      assertPowerShellInvocation(result, 'mutation-case');
      assertPowerShellStreamEmpty(result.stdout, 'powershell-stdout');
      assertPowerShellStreamEmpty(result.stderr, 'powershell-stderr');
      assert.equal(result.status, entry.status, `${entry.label} returned the wrong redacted phase code`);
      if (entry.status === 0) {
        const baseline = entriesWithBaselineOwner.find(candidate => candidate.kind === entry.kind);
        assert.ok(baseline, `missing ${entry.kind} baseline owner category`);
        assertExactAcl(powershell, entry, baseline.ownerCategory);
        assertOwnerCategoryMismatch(powershell, entry, baseline.ownerCategory);
      }
    }
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
