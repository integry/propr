import { spawnSync } from 'node:child_process';
import { open } from 'node:fs/promises';
import { win32 } from 'node:path';
import {
  canonicalizeWindowsFixtureEntry,
  windowsPowerShell51Path,
} from './windows-fixture-acl.mjs';

export const WINDOWS_ARTIFACT_FAILURE_CATEGORIES = Object.freeze([
  'artifact-missing',
  'artifact-inaccessible',
  'artifact-type',
  'architecture-mismatch',
  'spawn-failed',
]);

const STAGING_PARENT_LEAF = 'propr-connect-packaged-stage';
const STAGING_LEAF_PATTERN = /^propr-connect-package-[a-f0-9]{32}$/u;
const EXPECTED_MACHINES = Object.freeze({ x64: 0x8664, arm64: 0xaa64 });
const MAX_CONTRACT_PATH_LENGTH = 4096;
const PE_HEADER_BYTES = 4096;

export class WindowsArtifactFailure extends Error {
  constructor(category) {
    super(`Packaged Connect Windows artifact failed [category=${category}]`);
    this.name = 'WindowsArtifactFailure';
    this.category = category;
    this.stack = this.message;
  }
}

const fail = category => { throw new WindowsArtifactFailure(category); };

const isCanonicalAbsoluteWindowsPath = value => (
  typeof value === 'string'
  && value.length > 3
  && value.length <= MAX_CONTRACT_PATH_LENGTH
  && !value.includes('\0')
  && !value.includes('\r')
  && !value.includes('\n')
  && !value.includes('/')
  && /^[A-Za-z]:\\/u.test(value)
  && win32.isAbsolute(value)
  && win32.normalize(value) === value
  && !value.endsWith('\\')
);

export const parseWindowsStagedPackageContract = environment => {
  const runnerTemp = environment?.RUNNER_TEMP;
  const parent = environment?.PROPR_DESKTOP_CONNECT_STAGING_PARENT;
  const leaf = environment?.PROPR_DESKTOP_CONNECT_STAGING_LEAF;
  if (!isCanonicalAbsoluteWindowsPath(runnerTemp)
    || !isCanonicalAbsoluteWindowsPath(parent)
    || win32.dirname(parent) !== runnerTemp
    || win32.basename(parent) !== STAGING_PARENT_LEAF
    || !STAGING_LEAF_PATTERN.test(leaf ?? '')) {
    fail('artifact-type');
  }
  const root = win32.join(parent, leaf);
  if (win32.dirname(root) !== parent || win32.basename(root) !== leaf) fail('artifact-type');
  return Object.freeze({
    runnerTemp,
    parent,
    leaf,
    root,
    executable: win32.join(root, 'propr-desktop.exe'),
    resources: win32.join(root, 'resources'),
    applicationArchive: win32.join(root, 'resources', 'app.asar'),
  });
};

export const assertPackagedWindowsPeArchitecture = (bytes, expectedArchitecture) => {
  if (!Buffer.isBuffer(bytes) || !Object.hasOwn(EXPECTED_MACHINES, expectedArchitecture)) {
    fail('architecture-mismatch');
  }
  if (bytes.length < 0x40 || bytes.toString('ascii', 0, 2) !== 'MZ') fail('artifact-type');
  const peOffset = bytes.readUInt32LE(0x3c);
  if (peOffset < 0x40
    || peOffset + 6 > bytes.length
    || bytes.toString('ascii', peOffset, peOffset + 4) !== 'PE\0\0') {
    fail('artifact-type');
  }
  if (bytes.readUInt16LE(peOffset + 4) !== EXPECTED_MACHINES[expectedArchitecture]) {
    fail('architecture-mismatch');
  }
};

const readPeHeader = async path => {
  let handle;
  try {
    handle = await open(path, 'r');
    const bytes = Buffer.alloc(PE_HEADER_BYTES);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    return bytes.subarray(0, bytesRead);
  } catch (error) {
    if (error?.code === 'ENOENT') fail('artifact-missing');
    fail('artifact-inaccessible');
  } finally {
    await handle?.close().catch(() => {});
  }
};

const windowsStagedPackagePreflightSource = String.raw`
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
try {
  $parent=$env:PROPR_DESKTOP_CONNECT_STAGING_PARENT
  $leaf=$env:PROPR_DESKTOP_CONNECT_STAGING_LEAF
  if([String]::IsNullOrEmpty($parent) -or [String]::IsNullOrEmpty($leaf)){exit 80}
  $root=[IO.Path]::Combine($parent,$leaf)
  $executable=[IO.Path]::Combine($root,'propr-desktop.exe')
  $resources=[IO.Path]::Combine($root,'resources')
  $archive=[IO.Path]::Combine($resources,'app.asar')
  $current=[Security.Principal.WindowsIdentity]::GetCurrent().User
  $principal=[Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
  if($null -eq $current -or $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){exit 81}
  $system=[Security.Principal.SecurityIdentifier]::new('S-1-5-18')
  $admins=[Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')
} catch { exit 80 }
try {
  $entries=@(
    @{Path=$parent;Directory=$true},
    @{Path=$root;Directory=$true},
    @{Path=$resources;Directory=$true},
    @{Path=$archive;Directory=$false},
    @{Path=$executable;Directory=$false}
  )
  $descendants=@(Get-ChildItem -LiteralPath $root -Force -Recurse -ErrorAction Stop)
  if($descendants.Count -lt 1 -or $descendants.Count -gt 20000){exit 82}
  foreach($item in $descendants){$entries+=@{Path=$item.FullName;Directory=$item.PSIsContainer}}
} catch { exit 83 }
try {
  foreach($entry in $entries){
    $item=Get-Item -LiteralPath $entry.Path -Force -ErrorAction Stop
    if($item.PSIsContainer -ne $entry.Directory -or
      ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or
      -not [String]::Equals($item.FullName,$entry.Path,[StringComparison]::OrdinalIgnoreCase)){exit 82}
    $sections=[Security.AccessControl.AccessControlSections]::Access -bor [Security.AccessControl.AccessControlSections]::Owner
    $acl=if($entry.Directory){[IO.Directory]::GetAccessControl($entry.Path,$sections)}else{[IO.File]::GetAccessControl($entry.Path,$sections)}
    $owner=$acl.GetOwner([Security.Principal.SecurityIdentifier])
    $rules=@($acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]))
    if($owner.Value -ne $admins.Value -or -not $acl.AreAccessRulesProtected -or
      -not $acl.AreAccessRulesCanonical -or $rules.Count -ne 3){exit 84}
    foreach($identity in @($current,$system,$admins)){
      $matches=@($rules | Where-Object {$_.IdentityReference.Value -eq $identity.Value})
      if($matches.Count -ne 1 -or $matches[0].AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow){exit 84}
      $expected=if($identity.Value -eq $current.Value){[Security.AccessControl.FileSystemRights]::ReadAndExecute -bor [Security.AccessControl.FileSystemRights]::Synchronize}else{[Security.AccessControl.FileSystemRights]::FullControl}
      $expectedInheritance=if($entry.Directory){[Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit}else{[Security.AccessControl.InheritanceFlags]::None}
      if($matches[0].FileSystemRights -ne $expected -or $matches[0].InheritanceFlags -ne $expectedInheritance -or
        $matches[0].PropagationFlags -ne [Security.AccessControl.PropagationFlags]::None -or $matches[0].IsInherited){exit 84}
    }
  }
} catch { exit 84 }
try {
  $stream=[IO.FileStream]::new($executable,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
  try { if($stream.ReadByte() -lt 0){exit 85} } finally { $stream.Dispose() }
} catch { exit 85 }
`;

const encodedWindowsStagedPackagePreflight = Buffer.from(
  windowsStagedPackagePreflightSource,
  'utf16le',
).toString('base64');

const runWindowsStagedPackagePreflight = paths => {
  const powershell = windowsPowerShell51Path();
  const result = spawnSync(powershell, [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encodedWindowsStagedPackagePreflight,
  ], {
    shell: false,
    windowsHide: true,
    timeout: 60_000,
    maxBuffer: 1024,
    env: {
      SystemRoot: process.env.SystemRoot,
      PROPR_DESKTOP_CONNECT_STAGING_PARENT: paths.parent,
      PROPR_DESKTOP_CONNECT_STAGING_LEAF: paths.leaf,
    },
  });
  if (result.error || result.signal || !Buffer.isBuffer(result.stdout) || result.stdout.length !== 0
    || !Buffer.isBuffer(result.stderr) || result.stderr.length !== 0) fail('artifact-inaccessible');
  if (result.status === 83 || result.status === 85) fail('artifact-inaccessible');
  if (result.status === 82 || result.status === 84 || result.status === 80 || result.status === 81) {
    fail('artifact-type');
  }
  if (result.status !== 0) fail('artifact-inaccessible');
};

const canonicalizeEntry = async (kind, path) => canonicalizeWindowsFixtureEntry({
  entryKind: kind,
  entryPath: path,
  powershellPath: windowsPowerShell51Path(),
});

export const validateWindowsStagedPackage = async ({
  environment = process.env,
  expectedArchitecture = process.arch,
  inspectPath,
  canonicalize = canonicalizeEntry,
  readHeader = readPeHeader,
  preflight = runWindowsStagedPackagePreflight,
} = {}) => {
  const paths = parseWindowsStagedPackageContract(environment);
  const inspect = inspectPath ?? (await import('node:fs/promises')).lstat;
  const entries = [
    ['directory', paths.runnerTemp],
    ['directory', paths.parent],
    ['directory', paths.root],
    ['directory', paths.resources],
    ['file', paths.applicationArchive],
    ['file', paths.executable],
  ];
  for (const [kind, path] of entries) {
    let stats;
    try { stats = await inspect(path); } catch (error) {
      if (error?.code === 'ENOENT') fail('artifact-missing');
      fail('artifact-inaccessible');
    }
    if (stats.isSymbolicLink()
      || (kind === 'directory' ? !stats.isDirectory() : !stats.isFile())) fail('artifact-type');
    let canonical;
    try { canonical = await canonicalize(kind, path); } catch { fail('artifact-type'); }
    if (!canonical || typeof canonical.path !== 'string'
      || canonical.path.toUpperCase() !== path.toUpperCase()) fail('artifact-type');
  }
  assertPackagedWindowsPeArchitecture(await readHeader(paths.executable), expectedArchitecture);
  try { await preflight(paths); } catch (error) {
    if (error instanceof WindowsArtifactFailure) throw error;
    fail('artifact-inaccessible');
  }
  return paths;
};

export const classifyWindowsArtifactFailure = error => {
  if (error instanceof WindowsArtifactFailure
    && WINDOWS_ARTIFACT_FAILURE_CATEGORIES.includes(error.category)) return error.category;
  if (error?.code === 'ENOENT') return 'artifact-missing';
  if (error?.code === 'EACCES' || error?.code === 'EPERM') return 'artifact-inaccessible';
  return 'spawn-failed';
};
