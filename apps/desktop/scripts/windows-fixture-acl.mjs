import { spawnSync } from 'node:child_process';
import { lstatSync } from 'node:fs';
import { win32 } from 'node:path';
import { TextDecoder } from 'node:util';

export const windowsFixtureAclSource = String.raw`
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
function Set-ProprFixtureAcl {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory=$true)][ValidateSet('directory','file')][string]$EntryKind,
    [Parameter(Mandatory=$true)][ValidateNotNullOrEmpty()][string]$EntryPath
  )
  try {
    if(-not [IO.Path]::IsPathRooted($EntryPath)){exit 40}
  } catch { exit 40 }
  try {
    $canonicalPath=[IO.Path]::GetFullPath($EntryPath)
  } catch { exit 48 }
  try {
    if(-not [String]::Equals($canonicalPath,$EntryPath,[StringComparison]::OrdinalIgnoreCase)){exit 49}
  } catch { exit 49 }
  try {
    $item=Get-Item -LiteralPath $canonicalPath
    $directory=$EntryKind -eq 'directory'
    if($directory -ne $item.PSIsContainer){exit 41}
  } catch { exit 41 }
  try {
    $current=[Security.Principal.WindowsIdentity]::GetCurrent().User
    if($null -eq $current){exit 42}
  } catch { exit 42 }
  try {
    $system=[Security.Principal.SecurityIdentifier]::new('S-1-5-18')
    $admins=[Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')
  } catch { exit 43 }
  try {
    $acl=Get-Acl -LiteralPath $canonicalPath
  } catch { exit 44 }
  try {
    $null=$acl.SetAccessRuleProtection($true,$false)
    foreach($existing in @($acl.Access)){$null=$acl.RemoveAccessRuleSpecific($existing)}
  } catch { exit 45 }
  try {
    foreach($identity in @($current,$system,$admins)){
      $rights=[Security.AccessControl.FileSystemRights]::FullControl
      $accessType=[Security.AccessControl.AccessControlType]::Allow
      $rule=if($directory){
        $inheritance=[Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
        $propagation=[Security.AccessControl.PropagationFlags]::None
        [Security.AccessControl.FileSystemAccessRule]::new($identity,$rights,$inheritance,$propagation,$accessType)
      }else{[Security.AccessControl.FileSystemAccessRule]::new($identity,$rights,$accessType)}
      $null=$acl.AddAccessRule($rule)
    }
  } catch { exit 46 }
  try {
    $null=Set-Acl -LiteralPath $canonicalPath -AclObject $acl
  } catch { exit 47 }
}
try {
  $null=Set-ProprFixtureAcl -EntryKind $env:PROPR_FIXTURE_ACL_KIND -EntryPath $env:PROPR_FIXTURE_ACL_PATH
} catch {
  exit 50
}`;

export const encodedWindowsFixtureAcl = Buffer.from(windowsFixtureAclSource, 'utf16le').toString('base64');

const WINDOWS_FIXTURE_PATH_MAX_BYTES = 4 * 1024;
const WINDOWS_FIXTURE_PROCESS_MAX_BYTES = 8 * 1024;

const windowsFixtureCanonicalPathSource = String.raw`
$ErrorActionPreference='Stop'
try {
  $entryPath=$env:PROPR_FIXTURE_CANONICAL_PATH
  if([String]::IsNullOrEmpty($entryPath) -or -not [IO.Path]::IsPathRooted($entryPath)){exit 60}
} catch { exit 60 }
try {
  $canonicalPath=[IO.Path]::GetFullPath($entryPath)
} catch { exit 61 }
try {
  $utf8=[Text.UTF8Encoding]::new($false)
  $byteCount=$utf8.GetByteCount($canonicalPath)
  if($byteCount -lt 1 -or $byteCount -gt 4096 -or $canonicalPath.IndexOf([char]0) -ge 0 -or $canonicalPath.IndexOf([char]13) -ge 0 -or $canonicalPath.IndexOf([char]10) -ge 0){exit 62}
  [Console]::OutputEncoding=$utf8
  $null=[Console]::Out.Write($canonicalPath)
} catch { exit 63 }
`;

const encodedWindowsFixtureCanonicalPath = Buffer.from(
  windowsFixtureCanonicalPathSource,
  'utf16le',
).toString('base64');

const canonicalizationFailure = (phase, category) => {
  const error = new Error(`Windows fixture canonicalization failed [phase=${phase} category=${category}]`);
  error.stack = error.message;
  throw error;
};

export const windowsPowerShell51Path = (environment = process.env) => {
  const systemRoot = environment.SystemRoot;
  if (typeof systemRoot !== 'string'
    || systemRoot.length === 0
    || systemRoot.includes('\0')
    || systemRoot.includes('\r')
    || systemRoot.includes('\n')
    || !win32.isAbsolute(systemRoot)) {
    canonicalizationFailure('powershell-path', 'invalid-system-root');
  }
  return win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
};

const entryTypeMatches = (status, entryKind) => (entryKind === 'directory'
  ? status.isDirectory() && !status.isSymbolicLink()
  : status.isFile() && !status.isSymbolicLink());

const sameEntryIdentity = (left, right) => left.dev === right.dev && left.ino === right.ino;

const normalizationCategory = (originalPath, canonicalPath) => {
  if (originalPath === canonicalPath) return 'unchanged';
  if (originalPath.toUpperCase() === canonicalPath.toUpperCase()) return 'case-normalization';
  if (originalPath.split(/[\\/]/u).some(component => /~\d/u.test(component))) {
    return 'short-name-expansion';
  }
  if (originalPath.replaceAll('/', '\\').toUpperCase() === canonicalPath.toUpperCase()) {
    return 'separator-normalization';
  }
  return 'filesystem-path-normalization';
};

const readEntry = (entryPath, phase) => {
  try {
    return lstatSync(entryPath, { bigint: true });
  } catch {
    canonicalizationFailure(phase, 'entry-inspection-failed');
  }
};

export const canonicalizeWindowsFixtureEntry = ({ entryKind, entryPath, powershellPath }) => {
  if ((entryKind !== 'directory' && entryKind !== 'file') || typeof entryPath !== 'string') {
    canonicalizationFailure('input', 'invalid-entry');
  }
  if (typeof powershellPath !== 'string' || powershellPath.length === 0) {
    canonicalizationFailure('powershell-path', 'invalid-executable');
  }

  const before = readEntry(entryPath, 'original-before');
  if (!entryTypeMatches(before, entryKind)) canonicalizationFailure('original-before', 'type-mismatch');

  const result = spawnSync(powershellPath, [
    '-NoLogo', '-NoProfile', '-NonInteractive',
    '-EncodedCommand', encodedWindowsFixtureCanonicalPath,
  ], {
    shell: false,
    windowsHide: true,
    timeout: 10_000,
    maxBuffer: WINDOWS_FIXTURE_PROCESS_MAX_BYTES,
    env: {
      ...process.env,
      PROPR_FIXTURE_CANONICAL_PATH: entryPath,
    },
  });
  if (result.error || result.signal) canonicalizationFailure('powershell-invocation', 'process-failed');
  if (!Buffer.isBuffer(result.stderr) || result.stderr.length !== 0) {
    canonicalizationFailure('powershell-invocation', 'powershell-stderr');
  }
  const failurePhase = new Map([
    [60, 'rooted-path'],
    [61, 'full-path'],
    [62, 'bounded-result'],
    [63, 'result-write'],
  ]).get(result.status);
  if (failurePhase) canonicalizationFailure(failurePhase, 'operation-failed');
  if (result.status !== 0) canonicalizationFailure('powershell-invocation', 'unexpected-exit');
  if (!Buffer.isBuffer(result.stdout)
    || result.stdout.length === 0
    || result.stdout.length > WINDOWS_FIXTURE_PATH_MAX_BYTES) {
    canonicalizationFailure('result-validation', 'invalid-size');
  }

  let canonicalPath;
  try {
    canonicalPath = new TextDecoder('utf-8', { fatal: true }).decode(result.stdout);
  } catch {
    canonicalizationFailure('result-validation', 'invalid-encoding');
  }
  if (canonicalPath.includes('\0') || canonicalPath.includes('\r') || canonicalPath.includes('\n')) {
    canonicalizationFailure('result-validation', 'invalid-framing');
  }
  if (!win32.isAbsolute(canonicalPath)) canonicalizationFailure('result-validation', 'unrooted-path');

  const canonical = readEntry(canonicalPath, 'canonical-entry');
  const after = readEntry(entryPath, 'original-after');
  if (!entryTypeMatches(canonical, entryKind) || !entryTypeMatches(after, entryKind)) {
    canonicalizationFailure('identity-proof', 'type-mismatch');
  }
  if (!sameEntryIdentity(before, canonical) || !sameEntryIdentity(before, after)) {
    canonicalizationFailure('identity-proof', 'identity-mismatch');
  }

  return {
    path: canonicalPath,
    normalization: normalizationCategory(entryPath, canonicalPath),
  };
};
