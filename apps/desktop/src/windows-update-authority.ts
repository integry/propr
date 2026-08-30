import { createHash, randomBytes, X509Certificate } from 'node:crypto';
import { spawn } from 'node:child_process';
import { constants as fsConstants, rmSync } from 'node:fs';
import { lstat, mkdtemp, open, realpath, rm, type FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TextDecoder } from 'node:util';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import type { Readable, Writable } from 'node:stream';

export interface WindowsFileIdentity {
  platform: 'win32';
  volumeSerial: string;
  fileId128: string;
}

export interface WindowsPrivatePathInspection {
  identity: WindowsFileIdentity;
  directory: boolean;
  links: string;
  size: string;
  reparseTag: string;
  ownerSid: string;
  daclProtected: true;
  aceCount: string;
  inheritedWriteAces: '0';
  broadWriteAces: '0';
}

export interface WindowsHeldVerification extends WindowsPrivatePathInspection {
  sha256: string;
  sha1: string;
}

export interface WindowsLockedArtifact {
  readonly inspection: WindowsHeldVerification;
  read(offset: number, length: number, signal?: AbortSignal): Promise<Buffer>;
  verify(signal?: AbortSignal): Promise<WindowsHeldVerification>;
  close(signal?: AbortSignal): Promise<void>;
}

export const WINDOWS_AUTHORITY_PROTOCOL_VERSION = 1 as const;
export const WINDOWS_AUTHORITY_REASON_CODES = Object.freeze([
  'compile_load',
  'request_protocol',
  'open_handle',
  'reparse_query',
  'reparse_point',
  'type_link_size',
  'owner_sid',
  'dacl_protection',
  'dacl_ace',
  'file_id_info',
  'no_share_lock',
  'hash_read',
  'ready_protocol',
  'held_read',
  'final_verify',
  'clean_shutdown',
  'stdio_protocol',
  'output_bound',
  'timeout',
  'process_exit',
] as const);

type WindowsAuthorityReason = typeof WINDOWS_AUTHORITY_REASON_CODES[number];
type BrokerOperation = 'inspect' | 'ensure-directory' | 'protect-directory' | 'protect-file';
type BrokerPurpose = 'setup' | 'artifact';

export const WINDOWS_AUTHORITY_COMPILE_STAGES = Object.freeze([
  'BUILD_COMPILER',
  'BUILD_SOURCE',
  'BUILD_OUTPUT',
  'TRANSPORT_SPAWN',
  'MANIFEST',
  'HELPER_OPEN',
  'HELPER_OWNER_DACL',
  'HELPER_REPARSE',
  'HELPER_IDENTITY',
  'HELPER_HASH',
  'PROTOCOL_INIT',
  'READY',
] as const);
export type WindowsAuthorityCompileStage = typeof WINDOWS_AUTHORITY_COMPILE_STAGES[number];

const BROKER_TIMEOUT_MS = 10_000;
const BROKER_STARTUP_TIMEOUT_MS = 60_000;
const BROKER_SESSION_TIMEOUT_MS = 10 * 60_000;
const BROKER_OUTPUT_BYTES = 16 * 1024;
const BROKER_PROTOCOL_LINE_BYTES = 2 * 1024 * 1024;
const BROKER_REQUEST_LINE_BYTES = 16 * 1024;
const BROKER_MAX_FRAMES = 8192;
const BROKER_MAX_INPUT_BYTES = 64 * 1024 * 1024;
const BROKER_MAX_OUTPUT_BYTES = 2 * 1024 * 1024 * 1024;
const BROKER_MAX_QUEUE_ENTRIES = 256;
const BROKER_ARTIFACT_BYTES = 1024 * 1024 * 1024;
const BROKER_SETUP_FILE_BYTES = 1024 * 1024 * 1024 + 64 * 1024;
const MAX_READ_BYTES = 1024 * 1024;
const reasonCodes = new Set<string>(WINDOWS_AUTHORITY_REASON_CODES);
const INSPECTION_KEYS = Object.freeze([
  'version', 'type', 'volumeSerial', 'fileId128', 'directory', 'links', 'size', 'reparseTag',
  'ownerSid', 'daclProtected', 'aceCount', 'inheritedWriteAces', 'broadWriteAces', 'sha256', 'sha1',
] as const);
const lockedArtifactProcesses = new WeakMap<WindowsLockedArtifact, LockedArtifactProcess>();

const HELPER_NAME = 'propr-windows-authority.exe';
const HELPER_MANIFEST_NAME = 'propr-windows-authority.manifest.json';
const LAUNCHER_NAME = 'propr-windows-launcher.node';
const BOOTSTRAP_NAME = 'propr-windows-bootstrap.node';
const HELPER_MAX_BYTES = 4 * 1024 * 1024;
const HELPER_MANIFEST_BYTES = 16 * 1024;
const HELPER_MANIFEST_KEYS = Object.freeze([
  'schemaVersion', 'name', 'format', 'architecture', 'machine', 'clr', 'size', 'sha256', 'sourceSha256',
  'protocol', 'trust', 'publisher', 'compiler',
  'signerPins', 'signerCertificateSha256', 'signerSpkiSha256',
  'bootstrap', 'launcher',
] as const);

interface WindowsNativeLauncherPolicy {
  name: typeof LAUNCHER_NAME | typeof BOOTSTRAP_NAME;
  format: 'PE';
  architecture: 'x64' | 'arm64';
  machine: 'AMD64' | 'ARM64';
  size: number;
  sha256: string;
  trust: 'unsigned-validation' | 'production-signed';
  publisher: string | null;
  signerPins: readonly string[];
  signerCertificateSha256: string | null;
  signerSpkiSha256: string | null;
}

interface WindowsAuthorityHelperManifest {
  schemaVersion: 1;
  name: typeof HELPER_NAME;
  format: 'PE32';
  architecture: 'anycpu';
  machine: 'I386';
  clr: true;
  size: number;
  sha256: string;
  sourceSha256: string;
  protocol: 'propr-windows-authority-v1';
  trust: 'unsigned-validation' | 'production-signed';
  publisher: string | null;
  signerPins: readonly string[];
  signerCertificateSha256: string | null;
  signerSpkiSha256: string | null;
  launcher: WindowsNativeLauncherPolicy;
  bootstrap: WindowsNativeLauncherPolicy;
  compiler: {
    kind: 'windows-fixed-system-dotnet-framework-csc-v1';
    framework: string;
  };
}

interface AuthenticatedWindowsAuthorityHelper {
  executable: string;
  systemRoot: string;
  executableHandle: FileHandle;
  launcherHandle: FileHandle;
  bootstrapHandle: FileHandle;
  manifestHandle: FileHandle;
  manifest: WindowsAuthorityHelperManifest;
  launcher: WindowsNativeLauncher;
}

interface WindowsNativeLauncher {
  probeSystemDirectory(policy: { systemRoot: ''; windir: ''; fault: null }): Buffer;
  protectPrivateDirectory(policy: { path: string }): boolean;
  verifyPrivateDirectoryForTest?(policy: { path: string; fault?: 'substitution' }): boolean;
  compileHeld?(policy: Record<string, unknown>): Record<string, unknown>;
  dangerousAclForTest?(policy: { sddl: string }): boolean;
}

interface WindowsNativeBootstrap {
  loadVerifiedModule(policy: Record<string, unknown>): WindowsNativeLauncher;
}

interface BrokerChild extends EventEmitter {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  exitCode: number | null;
  killed: boolean;
  kill(): boolean;
  unref(): void;
}

const require = createRequire(import.meta.url);

// This namespace is resolved by the Windows object manager, not by the child
// environment inherited from an attacker-controlled launcher.
const KERNEL_SYSTEM_POWERSHELL = String.raw`\\?\GLOBALROOT\SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe`;
const MICROSOFT_SYSTEM_ROOT_SPKI_SHA256 = new Set([
  '02376d0908ac23041cc7d666d9daf192554f7fc36317aa9cb800908616b28af8',
  'c9905b0ee01202293ca026e64f08412442c5504c06e44ca7e9726d61f20e4089',
  'b2f7298b52bf2c3cac4ddfe72de4d682ac58957595982f2b62301af597c699c5',
]);
const MICROSOFT_SYSTEM_CATALOG_POLICY = Object.freeze([
  Object.freeze({
    member: 'powershell.exe',
    catalog: 'Microsoft-Windows-PowerShell-ServerCore-Package~31bf3856ad364e35~amd64~~10.0.26100.32230.cat',
    publisher: 'CN=Microsoft Windows, O=Microsoft Corporation, L=Redmond, S=Washington, C=US',
    certificateSha256: '1308aad34660d785a76b7360c31308d8835cf5721c364a6f5aedcba85eb5b3de',
    spkiSha256: 'a693625901b3bb9292a8c61aa3b75e80027d578ee01501005a4761dabbf1b7d1',
    catalogSha256: '2d2ac25e4f3cc782a886422964dffc851a66af354220923d96153738867d7866',
  }),
  Object.freeze({
    member: 'powershell.exe',
    catalog: 'Microsoft-Windows-Client-Features-Package02~31bf3856ad364e35~arm64~~10.0.26100.1.cat',
    publisher: 'CN=Microsoft Windows, O=Microsoft Corporation, L=Redmond, S=Washington, C=US',
    certificateSha256: 'ce08760345bd5a18aa9091e6f083522ad593bd42f587699e025afd55be589334',
    spkiSha256: '130dc613f271c90adf66157a030391c404f1e4ca21ef8261ac914fc615298b62',
    catalogSha256: '08150f5768c0780ab94d998a4302718fd1a69d6e54220a057f2d16f691a4582c',
  }),
]);
const BOOTSTRAP_AUTHORITY_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$policy = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadLine())) | ConvertFrom-Json
$trustedOwners = @('S-1-5-18', 'S-1-5-32-544', 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')
$trustedPublishers = @(
  'CN=Microsoft Windows, O=Microsoft Corporation, L=Redmond, S=Washington, C=US',
  'CN=Microsoft Corporation, O=Microsoft Corporation, L=Redmond, S=Washington, C=US',
  'CN=Microsoft Windows, O=Microsoft Corporation, C=US',
  'CN=Microsoft Corporation, O=Microsoft Corporation, C=US'
)
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$currentAuthorities = New-Object Collections.Generic.HashSet[string] ([StringComparer]::OrdinalIgnoreCase)
[void]$currentAuthorities.Add($identity.User.Value)
foreach ($group in $identity.Groups) {[void]$currentAuthorities.Add($group.Value)}
$assembly = [AppDomain]::CurrentDomain.DefineDynamicAssembly(
  (New-Object Reflection.AssemblyName('ProprHeldObjectNative')), [Reflection.Emit.AssemblyBuilderAccess]::Run)
$module = $assembly.DefineDynamicModule('ProprHeldObjectNative')
$builder = $module.DefineType('ProprHeldObjectNative.Methods', [Reflection.TypeAttributes]'Public,Sealed,Abstract')
function Add-PInvoke([string]$name, [string]$library, [Type]$returnType, [Type[]]$parameterTypes,
    [Runtime.InteropServices.CharSet]$charSet = [Runtime.InteropServices.CharSet]::Auto) {
  $method = $builder.DefinePInvokeMethod($name, $library,
    [Reflection.MethodAttributes]'Public,Static,PinvokeImpl', [Reflection.CallingConventions]::Standard,
    $returnType, $parameterTypes, [Runtime.InteropServices.CallingConvention]::Winapi, $charSet)
  $method.SetImplementationFlags($method.GetMethodImplementationFlags() -bor [Reflection.MethodImplAttributes]::PreserveSig)
}
$intptrRef = [IntPtr].MakeByRefType(); $uintRef = [uint32].MakeByRefType(); $ushortRef = [uint16].MakeByRefType()
$guidRef = [Guid].MakeByRefType()
$boolRef = [bool].MakeByRefType()
Add-PInvoke '_get_osfhandle' 'msvcrt.dll' ([IntPtr]) @([int])
Add-PInvoke 'GetFileInformationByHandleEx' 'kernel32.dll' ([bool]) @([IntPtr], [int], [IntPtr], [uint32])
Add-PInvoke 'GetFileInformationByHandle' 'kernel32.dll' ([bool]) @([IntPtr], [IntPtr])
Add-PInvoke 'GetFinalPathNameByHandleW' 'kernel32.dll' ([uint32]) @([IntPtr], [Text.StringBuilder], [uint32], [uint32]) ([Runtime.InteropServices.CharSet]::Unicode)
Add-PInvoke 'CreateFileW' 'kernel32.dll' ([IntPtr]) @([string], [uint32], [uint32], [IntPtr], [uint32], [uint32], [IntPtr]) ([Runtime.InteropServices.CharSet]::Unicode)
Add-PInvoke 'CloseHandle' 'kernel32.dll' ([bool]) @([IntPtr])
Add-PInvoke 'GetSecurityInfo' 'advapi32.dll' ([uint32]) @([IntPtr], [int], [uint32], $intptrRef, $intptrRef, $intptrRef, $intptrRef, $intptrRef)
Add-PInvoke 'GetSecurityDescriptorControl' 'advapi32.dll' ([bool]) @([IntPtr], $ushortRef, $uintRef)
Add-PInvoke 'GetSecurityDescriptorLength' 'advapi32.dll' ([uint32]) @([IntPtr])
Add-PInvoke 'GetSecurityDescriptorDacl' 'advapi32.dll' ([bool]) @([IntPtr], $boolRef, $intptrRef, $boolRef)
Add-PInvoke 'GetAce' 'advapi32.dll' ([bool]) @([IntPtr], [uint32], $intptrRef)
Add-PInvoke 'ConvertSidToStringSidW' 'advapi32.dll' ([bool]) @([IntPtr], $intptrRef)
Add-PInvoke 'LocalFree' 'kernel32.dll' ([IntPtr]) @([IntPtr])
Add-PInvoke 'CryptCATAdminAcquireContext2' 'wintrust.dll' ([bool]) @($intptrRef, $guidRef, [string], [IntPtr], [uint32]) ([Runtime.InteropServices.CharSet]::Unicode)
Add-PInvoke 'CryptCATAdminCalcHashFromFileHandle2' 'wintrust.dll' ([bool]) @([IntPtr], [IntPtr], $uintRef, [byte[]], [uint32])
Add-PInvoke 'CryptCATAdminEnumCatalogFromHash' 'wintrust.dll' ([IntPtr]) @([IntPtr], [byte[]], [uint32], [uint32], $intptrRef)
Add-PInvoke 'CryptCATCatalogInfoFromContext' 'wintrust.dll' ([bool]) @([IntPtr], [IntPtr], [uint32])
Add-PInvoke 'CryptCATAdminReleaseCatalogContext' 'wintrust.dll' ([bool]) @([IntPtr], [IntPtr], [uint32])
Add-PInvoke 'CryptCATAdminReleaseContext' 'wintrust.dll' ([bool]) @([IntPtr], [uint32])
Add-PInvoke 'WinVerifyTrust' 'wintrust.dll' ([int32]) @([IntPtr], $guidRef, [IntPtr])
Add-PInvoke 'CryptQueryObject' 'crypt32.dll' ([bool]) @([uint32], [IntPtr], [uint32], [uint32], [uint32], $uintRef, $uintRef, $uintRef, $intptrRef, $intptrRef, [IntPtr])
Add-PInvoke 'CryptMsgGetParam' 'crypt32.dll' ([bool]) @([IntPtr], [uint32], [uint32], [IntPtr], $uintRef)
Add-PInvoke 'CertEnumCertificatesInStore' 'crypt32.dll' ([IntPtr]) @([IntPtr], [IntPtr])
Add-PInvoke 'CertFreeCertificateContext' 'crypt32.dll' ([bool]) @([IntPtr])
Add-PInvoke 'CertCloseStore' 'crypt32.dll' ([bool]) @([IntPtr], [uint32])
Add-PInvoke 'CryptMsgClose' 'crypt32.dll' ([bool]) @([IntPtr])
$native = $builder.CreateType()
$catalogLeases=New-Object Collections.Generic.List[object]

function Hex-Bytes([byte[]]$bytes) { ([BitConverter]::ToString($bytes)).Replace('-', '').ToLowerInvariant() }
function Read-Held([IO.FileStream]$stream, [int64]$expected, [int64]$maximum=4194304) {
  if (!$stream.CanSeek -or $expected -le 0 -or $expected -gt $maximum) { throw 'size' }
  $stream.Position = 0; $bytes = New-Object byte[] ([int]$expected); $offset = 0
  while ($offset -lt $bytes.Length) { $read = $stream.Read($bytes, $offset, $bytes.Length - $offset); if ($read -le 0) { throw 'read' }; $offset += $read }
  if ($stream.ReadByte() -ne -1) { throw 'size' }; return $bytes
}
function Get-HeldIdentity([IntPtr]$handle, [bool]$directory) {
  $tag = [Runtime.InteropServices.Marshal]::AllocHGlobal(8); $id = [Runtime.InteropServices.Marshal]::AllocHGlobal(24)
  $basic = [Runtime.InteropServices.Marshal]::AllocHGlobal(52)
  try {
    if (!$native::GetFileInformationByHandleEx($handle, 9, $tag, 8) -or
        !$native::GetFileInformationByHandleEx($handle, 18, $id, 24) -or
        !$native::GetFileInformationByHandle($handle, $basic)) { throw 'identity' }
    $attributes = [uint32][Runtime.InteropServices.Marshal]::ReadInt32($tag, 0)
    $reparse = [uint32][Runtime.InteropServices.Marshal]::ReadInt32($tag, 4)
    if (($attributes -band 0x400) -ne 0 -or $reparse -ne 0 -or (($attributes -band 0x10) -ne 0) -ne $directory) { throw 'type' }
    $volumeBytes = New-Object byte[] 8; [Runtime.InteropServices.Marshal]::Copy($id, $volumeBytes, 0, 8)
    $idBytes = New-Object byte[] 16; [Runtime.InteropServices.Marshal]::Copy([IntPtr]::Add($id, 8), $idBytes, 0, 16)
    $indexHigh = [uint32][Runtime.InteropServices.Marshal]::ReadInt32($basic, 44)
    $indexLow = [uint32][Runtime.InteropServices.Marshal]::ReadInt32($basic, 48)
    $links = [uint32][Runtime.InteropServices.Marshal]::ReadInt32($basic, 40)
    return @{ volumeSerial=([BitConverter]::ToUInt64($volumeBytes, 0)).ToString('x16'); fileId128=(Hex-Bytes $idBytes)
      nodeDev=([BitConverter]::ToUInt64($volumeBytes, 0)).ToString(); nodeIno=(([uint64]$indexHigh -shl 32) -bor $indexLow).ToString()
      links=$links.ToString(); reparseTag=$reparse.ToString('x8') }
  } finally { [Runtime.InteropServices.Marshal]::FreeHGlobal($tag); [Runtime.InteropServices.Marshal]::FreeHGlobal($id); [Runtime.InteropServices.Marshal]::FreeHGlobal($basic) }
}
function Expand-FileAccessMask([uint32]$mask) {
  if (($mask -band [uint32]0x80000000) -ne 0) {$mask=[uint32](($mask -band [uint32]0x7fffffff) -bor [uint32]0x00120089)}
  if (($mask -band [uint32]0x40000000) -ne 0) {$mask=[uint32](($mask -band [uint32]0xbfffffff) -bor [uint32]0x00120116)}
  if (($mask -band [uint32]0x20000000) -ne 0) {$mask=[uint32](($mask -band [uint32]0xdfffffff) -bor [uint32]0x001200a0)}
  if (($mask -band [uint32]0x10000000) -ne 0) {$mask=[uint32](($mask -band [uint32]0xefffffff) -bor [uint32]0x001f01ff)}
  return $mask
}
function Get-HeldSecurity([IntPtr]$handle, [string]$role) {
  if ($role -cne 'package' -and $role -cne 'os') {throw 'security-role'}
  $owner=[IntPtr]::Zero; $group=[IntPtr]::Zero; $dacl=[IntPtr]::Zero; $sacl=[IntPtr]::Zero; $descriptor=[IntPtr]::Zero
  if ($native::GetSecurityInfo($handle, 1, 5, [ref]$owner, [ref]$group, [ref]$dacl, [ref]$sacl, [ref]$descriptor) -ne 0 -or
      $owner -eq [IntPtr]::Zero -or $dacl -eq [IntPtr]::Zero -or $descriptor -eq [IntPtr]::Zero) { throw 'security' }
  try {
    $ownerText=[IntPtr]::Zero; if (!$native::ConvertSidToStringSidW($owner, [ref]$ownerText)) { throw 'owner' }
    try { $ownerSid=[Runtime.InteropServices.Marshal]::PtrToStringUni($ownerText) } finally { if ($ownerText -ne [IntPtr]::Zero) { [void]$native::LocalFree($ownerText) } }
    if ($trustedOwners -notcontains $ownerSid -or $currentAuthorities.Contains($ownerSid)) { throw 'owner' }
    $control=[uint16]0; $revision=[uint32]0
    if (!$native::GetSecurityDescriptorControl($descriptor, [ref]$control, [ref]$revision)) {throw 'dacl-protection'}
    $protected=($control -band 0x1000) -ne 0
    if ($role -ceq 'package' -and !$protected) {throw 'dacl-protection'}
    $present=$false; $defaulted=$false; $actualDacl=[IntPtr]::Zero
    if (!$native::GetSecurityDescriptorDacl($descriptor, [ref]$present, [ref]$actualDacl, [ref]$defaulted) -or !$present -or $actualDacl -eq [IntPtr]::Zero) { throw 'dacl' }
    $descriptorLength=$native::GetSecurityDescriptorLength($descriptor)
    if ($descriptorLength -le 0 -or $descriptorLength -gt 65536) {throw 'dacl'}
    $descriptorBytes=New-Object byte[] $descriptorLength
    [Runtime.InteropServices.Marshal]::Copy($descriptor,$descriptorBytes,0,$descriptorLength)
    $raw=New-Object Security.AccessControl.RawSecurityDescriptor($descriptorBytes,0)
    if (!$raw.DiscretionaryAcl) {throw 'dacl'}
    $aceCount=$raw.DiscretionaryAcl.Count
    $priorOrder=-1
    foreach ($ace in $raw.DiscretionaryAcl) {
      if (($ace.AceFlags -band [Security.AccessControl.AceFlags]::InheritOnly) -ne 0) {continue}
      $qualified=$ace -as [Security.AccessControl.QualifiedAce]
      $known=$ace -as [Security.AccessControl.KnownAce]
      if (!$qualified -or !$known -or !$known.SecurityIdentifier -or
          ($qualified.AceQualifier -ne [Security.AccessControl.AceQualifier]::AccessAllowed -and
           $qualified.AceQualifier -ne [Security.AccessControl.AceQualifier]::AccessDenied)) {throw 'ace'}
      $allowed=$qualified.AceQualifier -eq [Security.AccessControl.AceQualifier]::AccessAllowed
      $inherited=($ace.AceFlags -band [Security.AccessControl.AceFlags]::Inherited) -ne 0
      $order=if ($inherited) {if ($allowed) {3} else {2}} else {if ($allowed) {1} else {0}}
      if ($order -lt $priorOrder) {throw 'ace-order'}; $priorOrder=$order
      $mask=Expand-FileAccessMask ([uint32]$known.AccessMask)
      if (!$allowed -or ($mask -band [uint32]0x000D0156) -eq 0) {continue}
      $sid=$known.SecurityIdentifier.Value
      if ($currentAuthorities.Contains($sid) -or $trustedOwners -notcontains $sid) {throw 'ace'}
    }
    return @{ ownerSid=$ownerSid; daclProtected=$protected; aceCount=$aceCount.ToString(); role=$role }
  } finally { if ($descriptor -ne [IntPtr]::Zero) {[void]$native::LocalFree($descriptor)} }
}
function Get-FinalPath([IntPtr]$handle) { $value=New-Object Text.StringBuilder 32768; $length=$native::GetFinalPathNameByHandleW($handle,$value,32768,0); if ($length -le 0 -or $length -ge 32768) {throw 'path'}; $value.ToString() }
function Invoke-HeldFileTrust([IntPtr]$handle, [string]$path) {
  if ([IntPtr]::Size -ne 8) {throw 'wintrust-layout'}
  $pathPointer=[Runtime.InteropServices.Marshal]::StringToHGlobalUni($path)
  $file=[Runtime.InteropServices.Marshal]::AllocHGlobal(32); $data=[Runtime.InteropServices.Marshal]::AllocHGlobal(88)
  try {
    for ($offset=0;$offset -lt 32;$offset+=4) {[Runtime.InteropServices.Marshal]::WriteInt32($file,$offset,0)}
    for ($offset=0;$offset -lt 88;$offset+=4) {[Runtime.InteropServices.Marshal]::WriteInt32($data,$offset,0)}
    [Runtime.InteropServices.Marshal]::WriteInt32($file,0,32)
    [Runtime.InteropServices.Marshal]::WriteIntPtr($file,8,$pathPointer)
    [Runtime.InteropServices.Marshal]::WriteIntPtr($file,16,$handle)
    [Runtime.InteropServices.Marshal]::WriteInt32($data,0,88)
    [Runtime.InteropServices.Marshal]::WriteInt32($data,24,2)
    [Runtime.InteropServices.Marshal]::WriteInt32($data,28,0)
    [Runtime.InteropServices.Marshal]::WriteInt32($data,32,1)
    [Runtime.InteropServices.Marshal]::WriteIntPtr($data,40,$file)
    [Runtime.InteropServices.Marshal]::WriteInt32($data,48,1)
    [Runtime.InteropServices.Marshal]::WriteInt32($data,72,0x1010)
    $action=[Guid]'00AAC56B-CD44-11d0-8CC2-00C04FC295EE'
    $status=$native::WinVerifyTrust([IntPtr](-1),[ref]$action,$data)
    [Runtime.InteropServices.Marshal]::WriteInt32($data,48,2); [void]$native::WinVerifyTrust([IntPtr](-1),[ref]$action,$data)
    if ($status -ne 0) {throw 'signature'}
  } finally {
    [Runtime.InteropServices.Marshal]::FreeHGlobal($data); [Runtime.InteropServices.Marshal]::FreeHGlobal($file)
    [Runtime.InteropServices.Marshal]::FreeHGlobal($pathPointer)
  }
}
function Invoke-HeldCatalogTrust([IntPtr]$memberHandle, [string]$memberPath, [string]$catalogPath, [byte[]]$memberHash, [IntPtr]$admin) {
  if ([IntPtr]::Size -ne 8) {throw 'wintrust-layout'}
  $memberTag=(Hex-Bytes $memberHash).ToUpperInvariant()
  if ($memberTag.Length -ne $memberHash.Length*2) {throw 'member-tag'}
  $catalogPointer=[Runtime.InteropServices.Marshal]::StringToHGlobalUni($catalogPath)
  $tagPointer=[Runtime.InteropServices.Marshal]::StringToHGlobalUni($memberTag)
  $memberPointer=[Runtime.InteropServices.Marshal]::StringToHGlobalUni($memberPath)
  $pin=[Runtime.InteropServices.GCHandle]::Alloc($memberHash,[Runtime.InteropServices.GCHandleType]::Pinned)
  $catalog=[Runtime.InteropServices.Marshal]::AllocHGlobal(72); $data=[Runtime.InteropServices.Marshal]::AllocHGlobal(88)
  try {
    for ($offset=0;$offset -lt 72;$offset+=4) {[Runtime.InteropServices.Marshal]::WriteInt32($catalog,$offset,0)}
    for ($offset=0;$offset -lt 88;$offset+=4) {[Runtime.InteropServices.Marshal]::WriteInt32($data,$offset,0)}
    [Runtime.InteropServices.Marshal]::WriteInt32($catalog,0,72)
    [Runtime.InteropServices.Marshal]::WriteIntPtr($catalog,8,$catalogPointer)
    [Runtime.InteropServices.Marshal]::WriteIntPtr($catalog,16,$tagPointer)
    [Runtime.InteropServices.Marshal]::WriteIntPtr($catalog,24,$memberPointer)
    [Runtime.InteropServices.Marshal]::WriteIntPtr($catalog,32,$memberHandle)
    [Runtime.InteropServices.Marshal]::WriteIntPtr($catalog,40,$pin.AddrOfPinnedObject())
    [Runtime.InteropServices.Marshal]::WriteInt32($catalog,48,$memberHash.Length)
    [Runtime.InteropServices.Marshal]::WriteIntPtr($catalog,64,$admin)
    [Runtime.InteropServices.Marshal]::WriteInt32($data,0,88)
    [Runtime.InteropServices.Marshal]::WriteInt32($data,24,2)
    [Runtime.InteropServices.Marshal]::WriteInt32($data,28,0)
    [Runtime.InteropServices.Marshal]::WriteInt32($data,32,2)
    [Runtime.InteropServices.Marshal]::WriteIntPtr($data,40,$catalog)
    [Runtime.InteropServices.Marshal]::WriteInt32($data,48,1)
    [Runtime.InteropServices.Marshal]::WriteInt32($data,72,0x1010)
    $policy=[Guid]'00AAC56B-CD44-11d0-8CC2-00C04FC295EE'
    $status=$native::WinVerifyTrust([IntPtr](-1),[ref]$policy,$data)
    [Runtime.InteropServices.Marshal]::WriteInt32($data,48,2); [void]$native::WinVerifyTrust([IntPtr](-1),[ref]$policy,$data)
    if ($status -ne 0) {throw 'catalog-trust'}
  } finally {
    [Runtime.InteropServices.Marshal]::FreeHGlobal($data); [Runtime.InteropServices.Marshal]::FreeHGlobal($catalog)
    $pin.Free(); [Runtime.InteropServices.Marshal]::FreeHGlobal($memberPointer)
    [Runtime.InteropServices.Marshal]::FreeHGlobal($tagPointer); [Runtime.InteropServices.Marshal]::FreeHGlobal($catalogPointer)
  }
}
function Get-RawSigner([byte[]]$bytes, [bool]$standaloneCatalog) {
  if ([IntPtr]::Size -ne 8 -or !$bytes -or $bytes.Length -le 0) {throw 'signer-parse'}
  $pin=[Runtime.InteropServices.GCHandle]::Alloc($bytes,[Runtime.InteropServices.GCHandleType]::Pinned)
  $blob=[Runtime.InteropServices.Marshal]::AllocHGlobal(16); $store=[IntPtr]::Zero; $message=[IntPtr]::Zero
  try {
    for ($offset=0;$offset -lt 16;$offset+=4) {[Runtime.InteropServices.Marshal]::WriteInt32($blob,$offset,0)}
    [Runtime.InteropServices.Marshal]::WriteInt32($blob,0,$bytes.Length)
    [Runtime.InteropServices.Marshal]::WriteIntPtr($blob,8,$pin.AddrOfPinnedObject())
    $encoding=[uint32]0; $content=[uint32]0; $format=[uint32]0
    $contentFlag=if ($standaloneCatalog) {[uint32]0x100} else {[uint32]0x400}
    $expectedContent=if ($standaloneCatalog) {[uint32]8} else {[uint32]10}
    if (!$native::CryptQueryObject(2,$blob,$contentFlag,2,0,[ref]$encoding,[ref]$content,[ref]$format,[ref]$store,[ref]$message,[IntPtr]::Zero) -or
        $content -ne $expectedContent -or $format -ne 1 -or $store -eq [IntPtr]::Zero -or $message -eq [IntPtr]::Zero) {throw 'signer-parse'}
    $signerBytes=[uint32]0
    if (!$native::CryptMsgGetParam($message,6,0,[IntPtr]::Zero,[ref]$signerBytes) -or $signerBytes -lt 32 -or $signerBytes -gt 65536) {throw 'signer-parse'}
    $signer=[Runtime.InteropServices.Marshal]::AllocHGlobal([int]$signerBytes)
    try {
      if (!$native::CryptMsgGetParam($message,6,0,$signer,[ref]$signerBytes)) {throw 'signer-parse'}
      $issuerLength=[Runtime.InteropServices.Marshal]::ReadInt32($signer,4); $issuerPointer=[Runtime.InteropServices.Marshal]::ReadIntPtr($signer,8)
      $serialLength=[Runtime.InteropServices.Marshal]::ReadInt32($signer,16); $serialPointer=[Runtime.InteropServices.Marshal]::ReadIntPtr($signer,24)
      if ($issuerLength -le 0 -or $issuerLength -gt 4096 -or $serialLength -le 0 -or $serialLength -gt 64) {throw 'signer-parse'}
      $issuer=New-Object byte[] $issuerLength; [Runtime.InteropServices.Marshal]::Copy($issuerPointer,$issuer,0,$issuerLength)
      $serial=New-Object byte[] $serialLength; [Runtime.InteropServices.Marshal]::Copy($serialPointer,$serial,0,$serialLength)
      $certificate=$null; $previous=[IntPtr]::Zero
      while ($true) {
        $candidate=$native::CertEnumCertificatesInStore($store,$previous)
        if ($candidate -eq [IntPtr]::Zero) {$previous=[IntPtr]::Zero; break}
        $previous=$candidate; $parsed=New-Object Security.Cryptography.X509Certificates.X509Certificate2($candidate)
        if ((Hex-Bytes $parsed.IssuerName.RawData) -ceq (Hex-Bytes $issuer) -and (Hex-Bytes $parsed.GetSerialNumber()) -ceq (Hex-Bytes $serial)) {
          $certificate=New-Object Security.Cryptography.X509Certificates.X509Certificate2 -ArgumentList @(,$parsed.RawData)
          $parsed.Dispose(); [void]$native::CertFreeCertificateContext($candidate); $previous=[IntPtr]::Zero; break
        }
        $parsed.Dispose()
      }
      if (!$certificate) {throw 'signer-parse'}
    } finally {[Runtime.InteropServices.Marshal]::FreeHGlobal($signer)}
  } finally {
    if ($message -ne [IntPtr]::Zero) {[void]$native::CryptMsgClose($message)}
    if ($store -ne [IntPtr]::Zero) {[void]$native::CertCloseStore($store,0)}
    [Runtime.InteropServices.Marshal]::FreeHGlobal($blob); $pin.Free()
  }
  $root = $null
  if ($certificate) {
    $chain=New-Object Security.Cryptography.X509Certificates.X509Chain
    try {
      $chain.ChainPolicy.RevocationMode=[Security.Cryptography.X509Certificates.X509RevocationMode]::Offline
      $chain.ChainPolicy.RevocationFlag=[Security.Cryptography.X509Certificates.X509RevocationFlag]::ExcludeRoot
      [void]$chain.Build($certificate)
      foreach ($status in $chain.ChainStatus) {
        if ($status.Status -ne [Security.Cryptography.X509Certificates.X509ChainStatusFlags]::RevocationStatusUnknown -and
            $status.Status -ne [Security.Cryptography.X509Certificates.X509ChainStatusFlags]::OfflineRevocation) {throw 'chain'}
      }
      if ($chain.ChainElements.Count -lt 2) {throw 'chain'}
      $root=[Convert]::ToBase64String($chain.ChainElements[$chain.ChainElements.Count-1].Certificate.RawData)
    } finally {$chain.Dispose()}
  }
  return @{subject=$certificate.Subject;certificate=[Convert]::ToBase64String($certificate.RawData);rootCertificate=$root}
}
function Test-Signature([IntPtr]$handle, [string]$path, [byte[]]$bytes, [bool]$standaloneCatalog, [bool]$required, [string]$expectedPublisher) {
  if (!$required) {return @{subject=$null;certificate=$null;rootCertificate=$null}}
  if (!$standaloneCatalog) {Invoke-HeldFileTrust $handle $path}
  $signature=Get-RawSigner $bytes $standaloneCatalog
  if (($standaloneCatalog -and $trustedPublishers -notcontains $signature.subject) -or
      (!$standaloneCatalog -and $signature.subject -cne $expectedPublisher)) {throw 'signature'}
  return $signature
}
function Get-SystemCatalogProof([IntPtr]$memberHandle, [string]$windowsRoot) {
  $admin=[IntPtr]::Zero; $catalog=[IntPtr]::Zero; $previous=[IntPtr]::Zero
  $action=[Guid]'F750E6C3-38EE-11D1-85E5-00C04FC295EE'
  if (!$native::CryptCATAdminAcquireContext2([ref]$admin,[ref]$action,'SHA256',[IntPtr]::Zero,0)) {throw 'catalog-enumeration'}
  try {
    $hashBytes=[uint32]0
    if (!$native::CryptCATAdminCalcHashFromFileHandle2($admin,$memberHandle,[ref]$hashBytes,$null,0) -or $hashBytes -le 0 -or $hashBytes -gt 128) {throw 'catalog-hash'}
    $memberHash=New-Object byte[] $hashBytes
    if (!$native::CryptCATAdminCalcHashFromFileHandle2($admin,$memberHandle,[ref]$hashBytes,$memberHash,0)) {throw 'catalog-hash'}
    $catalog=$native::CryptCATAdminEnumCatalogFromHash($admin,$memberHash,$hashBytes,0,[ref]$previous)
    if ($catalog -eq [IntPtr]::Zero) {throw 'catalog-member'}
    $info=[Runtime.InteropServices.Marshal]::AllocHGlobal(524)
    try {
      for ($offset=0;$offset -lt 524;$offset+=4) {[Runtime.InteropServices.Marshal]::WriteInt32($info,$offset,0)}
      [Runtime.InteropServices.Marshal]::WriteInt32($info,0,524)
      if (!$native::CryptCATCatalogInfoFromContext($catalog,$info,0)) {throw 'catalog-enumeration'}
      $catalogPath=[Runtime.InteropServices.Marshal]::PtrToStringUni([IntPtr]::Add($info,4))
    } finally {[Runtime.InteropServices.Marshal]::FreeHGlobal($info)}
    $catalogRoot=([IO.Path]::Combine($windowsRoot,'System32','CatRoot','{F750E6C3-38EE-11D1-85E5-00C04FC295EE}')).TrimEnd('\')+'\'
    if (!$catalogPath.StartsWith($catalogRoot,[StringComparison]::OrdinalIgnoreCase) -or
        $catalogPath.IndexOf('\',$catalogRoot.Length) -ge 0) {throw 'catalog-path'}
    $stream=[IO.File]::Open($catalogPath,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
    try {
      $handle=$stream.SafeFileHandle.DangerousGetHandle(); $identity=Get-HeldIdentity $handle $false; [void](Get-HeldSecurity $handle 'os')
      if (!(Get-FinalPath $handle).EndsWith($catalogPath,[StringComparison]::OrdinalIgnoreCase)) {throw 'catalog-path'}
      Invoke-HeldCatalogTrust $memberHandle (Get-FinalPath $memberHandle) $catalogPath $memberHash $admin
      $bytes=Read-Held $stream $stream.Length 33554432; $sha=[Security.Cryptography.SHA256]::Create()
      try {$digest=Hex-Bytes $sha.ComputeHash($bytes)} finally {$sha.Dispose()}
      $signature=Test-Signature $handle $catalogPath $bytes $true $true $null
      $catalogLeases.Add([pscustomobject]@{stream=$stream;path=$catalogPath;sha256=$digest;
        volumeSerial=$identity.volumeSerial;fileId128=$identity.fileId128;length=[int64]$stream.Length;
        admin=$admin;catalog=$catalog})
      $admin=[IntPtr]::Zero; $catalog=[IntPtr]::Zero
      return @{name=[IO.Path]::GetFileName($catalogPath);sha256=$digest;volumeSerial=$identity.volumeSerial;fileId128=$identity.fileId128;signature=$signature}
    } catch {$stream.Dispose();throw}
  } finally {
    if ($catalog -ne [IntPtr]::Zero) {[void]$native::CryptCATAdminReleaseCatalogContext($admin,$catalog,0)}
    if ($admin -ne [IntPtr]::Zero) {[void]$native::CryptCATAdminReleaseContext($admin,0)}
  }
}

# fd 3 is a duplicate of the exact Node-retained bootstrap handle. Every
# target fact below is queried from it; the pathname is opened only as a
# no-write/no-delete load lease and must resolve to the identical FILE_ID_128.
$heldHandle=$native::_get_osfhandle(3); if ($heldHandle -eq [IntPtr](-1)) {throw 'held'}
$heldSafe=New-Object Microsoft.Win32.SafeHandles.SafeFileHandle($heldHandle,$false)
$held=New-Object IO.FileStream($heldSafe,[IO.FileAccess]::Read,65536,$false)
$load=[IO.File]::Open($policy.path,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
$ancestorHandles=New-Object Collections.Generic.List[object]
$self=$null
try {
  $heldIdentity=Get-HeldIdentity $heldHandle $false; $loadHandle=$load.SafeFileHandle.DangerousGetHandle()
  $loadIdentity=Get-HeldIdentity $loadHandle $false
  if ($heldIdentity.volumeSerial -cne $loadIdentity.volumeSerial -or $heldIdentity.fileId128 -cne $loadIdentity.fileId128 -or
      $heldIdentity.nodeDev -cne $policy.nodeDev -or $heldIdentity.nodeIno -cne $policy.nodeIno -or $heldIdentity.links -cne '1') {throw 'split-handle'}
  if ((Get-FinalPath $heldHandle) -cne (Get-FinalPath $loadHandle)) {throw 'load-path'}
  $security=Get-HeldSecurity $heldHandle 'package'
  $authorityRoot=[IO.Path]::GetFullPath($policy.authorityRoot).TrimEnd('\')
  $cursor=[IO.Directory]::GetParent($policy.path); $rootSeen=$false
  while ($cursor) {
    $directory=$native::CreateFileW($cursor.FullName,0x80 -bor 0x20000,1,[IntPtr]::Zero,3,0x2200000,[IntPtr]::Zero)
    if ($directory -eq [IntPtr](-1)) {throw 'ancestor'}; $ancestorHandles.Add([pscustomobject]@{handle=$directory;role='package'})
    [void](Get-HeldIdentity $directory $true); [void](Get-HeldSecurity $directory 'package')
    if ($cursor.FullName.TrimEnd('\') -ieq $authorityRoot) {$rootSeen=$true; break}; $cursor=$cursor.Parent
  }
  if (!$rootSeen) {throw 'ancestor-root'}
  $bytes=Read-Held $held ([int64]$policy.size); $sha=[Security.Cryptography.SHA256]::Create()
  try {$digest=Hex-Bytes $sha.ComputeHash($bytes)} finally {$sha.Dispose()}
  if ($digest -cne $policy.sha256) {throw 'hash'}
  $signature=Test-Signature $heldHandle (Get-FinalPath $heldHandle) $bytes $false $policy.production $policy.publisher
  $selfPath=[Diagnostics.Process]::GetCurrentProcess().MainModule.FileName
  $self=[IO.File]::Open($selfPath,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
  $selfHandle=$self.SafeFileHandle.DangerousGetHandle()
  if (!(Get-FinalPath $selfHandle).EndsWith('\System32\WindowsPowerShell\v1.0\powershell.exe',[StringComparison]::OrdinalIgnoreCase)) {throw 'self-path'}
  $selfIdentity=Get-HeldIdentity $selfHandle $false; [void](Get-HeldSecurity $selfHandle 'os')
  $selfCursor=[IO.Directory]::GetParent($selfPath); $selfRoot=$selfCursor.Parent.Parent.Parent.FullName.TrimEnd('\'); $selfRootSeen=$false
  while ($selfCursor) {
    $selfDirectory=$native::CreateFileW($selfCursor.FullName,0x80 -bor 0x20000,1,[IntPtr]::Zero,3,0x2200000,[IntPtr]::Zero)
    if ($selfDirectory -eq [IntPtr](-1)) {throw 'self-ancestor'}; $ancestorHandles.Add([pscustomobject]@{handle=$selfDirectory;role='os'})
    [void](Get-HeldIdentity $selfDirectory $true); [void](Get-HeldSecurity $selfDirectory 'os')
    if ($selfCursor.FullName.TrimEnd('\') -ieq $selfRoot) {$selfRootSeen=$true; break}; $selfCursor=$selfCursor.Parent
  }
  if (!$selfRootSeen) {throw 'self-root'}
  $selfCatalog=Get-SystemCatalogProof $selfHandle $selfRoot
  [Console]::Out.WriteLine((@{sha256=$digest;size=[int64]$bytes.Length;volumeSerial=$heldIdentity.volumeSerial;fileId128=$heldIdentity.fileId128;
    nodeDev=$heldIdentity.nodeDev;nodeIno=$heldIdentity.nodeIno;ownerSid=$security.ownerSid;daclProtected=$security.daclProtected;reparseTag=$heldIdentity.reparseTag;
    subject=$signature.subject;certificate=$signature.certificate;selfCertificate=$selfCatalog.signature.certificate;selfRootCertificate=$selfCatalog.signature.rootCertificate;
    selfSubject=$selfCatalog.signature.subject;selfCatalogName=$selfCatalog.name;selfCatalogSha256=$selfCatalog.sha256;
    selfCatalogVolumeSerial=$selfCatalog.volumeSerial;selfCatalogFileId128=$selfCatalog.fileId128}|ConvertTo-Json -Compress))
  [Console]::Out.Flush(); if ([Console]::In.ReadLine() -cne 'release') {throw 'release'}
  # Re-prove every retained capability after Node has initialized the bootstrap
  # and launcher. No catalog/member/ACL swap at any held barrier can be hidden
  # behind the earlier JSON record.
  $heldFinal=Get-HeldIdentity $heldHandle $false; $loadFinal=Get-HeldIdentity $loadHandle $false
  if ($heldFinal.volumeSerial -cne $heldIdentity.volumeSerial -or $heldFinal.fileId128 -cne $heldIdentity.fileId128 -or
      $loadFinal.volumeSerial -cne $loadIdentity.volumeSerial -or $loadFinal.fileId128 -cne $loadIdentity.fileId128) {throw 'final-identity'}
  [void](Get-HeldSecurity $heldHandle 'package'); [void](Get-HeldSecurity $loadHandle 'package')
  $finalBytes=Read-Held $held ([int64]$policy.size); $finalSha=[Security.Cryptography.SHA256]::Create()
  try {$finalDigest=Hex-Bytes $finalSha.ComputeHash($finalBytes)} finally {$finalSha.Dispose()}
  if ($finalDigest -cne $digest -or (Get-FinalPath $heldHandle) -cne (Get-FinalPath $loadHandle)) {throw 'final-bootstrap'}
  $selfFinal=Get-HeldIdentity $selfHandle $false; [void](Get-HeldSecurity $selfHandle 'os')
  if ($selfFinal.volumeSerial -cne $selfIdentity.volumeSerial -or $selfFinal.fileId128 -cne $selfIdentity.fileId128) {throw 'final-self'}
  foreach ($catalogLease in $catalogLeases) {
    $catalogHandle=$catalogLease.stream.SafeFileHandle.DangerousGetHandle()
    $catalogFinal=Get-HeldIdentity $catalogHandle $false; [void](Get-HeldSecurity $catalogHandle 'os')
    $catalogFinalPath=Get-FinalPath $catalogHandle
    if ($catalogFinal.volumeSerial -cne $catalogLease.volumeSerial -or $catalogFinal.fileId128 -cne $catalogLease.fileId128 -or
        !$catalogFinalPath.EndsWith($catalogLease.path,[StringComparison]::OrdinalIgnoreCase)) {throw 'final-catalog'}
    $catalogBytes=Read-Held $catalogLease.stream $catalogLease.length 33554432; $catalogSha=[Security.Cryptography.SHA256]::Create()
    try {$catalogDigest=Hex-Bytes $catalogSha.ComputeHash($catalogBytes)} finally {$catalogSha.Dispose()}
    if ($catalogDigest -cne $catalogLease.sha256) {throw 'final-catalog'}
  }
  foreach ($lease in $ancestorHandles) {[void](Get-HeldSecurity $lease.handle $lease.role)}
} finally {
  if ($self) {$self.Dispose()}
  foreach ($catalogLease in $catalogLeases) {
    if ($catalogLease.catalog -ne [IntPtr]::Zero) {[void]$native::CryptCATAdminReleaseCatalogContext($catalogLease.admin,$catalogLease.catalog,0)}
    if ($catalogLease.admin -ne [IntPtr]::Zero) {[void]$native::CryptCATAdminReleaseContext($catalogLease.admin,0)}
    $catalogLease.stream.Dispose()
  }
  foreach ($lease in $ancestorHandles) {[void]$native::CloseHandle($lease.handle)}; $load.Dispose(); $held.Dispose()
}
`;

const helperError = (stage: WindowsAuthorityCompileStage): WindowsAuthorityBootstrapError =>
  new WindowsAuthorityBootstrapError('MALFORMED_OUTPUT', WINDOWS_AUTHORITY_COMPILE_STAGES.indexOf(stage));

const decodeAuthenticatedSystemRoot = (record: unknown): string => {
  if (!Buffer.isBuffer(record) || record.length !== 2 + (520 * 2)) throw helperError('HELPER_IDENTITY');
  const length = record.readUInt16LE(0);
  if (length < 3 || length >= 520) throw helperError('HELPER_IDENTITY');
  const pathBytes = record.subarray(2, 2 + (length * 2));
  if (record.subarray(2 + (length * 2)).some(byte => byte !== 0)) throw helperError('HELPER_IDENTITY');
  const path = pathBytes.toString('utf16le');
  if (!/^[A-Za-z]:\\[^\0]+$/.test(path) || path.startsWith('\\\\') || path.includes('\0')
    || path.indexOf(':', 2) >= 0) throw helperError('HELPER_IDENTITY');
  return path;
};

const helperDirectory = (): string => {
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  if (resourcesPath && isAbsolute(resourcesPath)) return join(resourcesPath, 'windows-authority');
  return fileURLToPath(new URL('../build/windows-authority', import.meta.url));
};

const embeddedExpectedPublisher = (): string | undefined => {
  if (process.platform !== 'win32' || typeof __PROPR_DESKTOP_UPDATE_SIGNING_IDENTITY__ === 'undefined') return undefined;
  return __PROPR_DESKTOP_UPDATE_SIGNING_IDENTITY__ || undefined;
};

const embeddedExpectedSignerPins = (): readonly string[] => {
  if (process.platform !== 'win32' || typeof __PROPR_DESKTOP_WINDOWS_SIGNER_PINS__ === 'undefined') return [];
  return __PROPR_DESKTOP_WINDOWS_SIGNER_PINS__;
};

export const validateBootstrapIdentityRecordForTest = (
  value: unknown,
  policy: { size: number; sha256: string },
  nodeIdentity: { dev: string; ino: string },
): value is Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return exactRecordKeys(record, ['sha256', 'size', 'volumeSerial', 'fileId128', 'nodeDev', 'nodeIno',
    'ownerSid', 'daclProtected', 'reparseTag', 'subject', 'certificate', 'selfSubject', 'selfCertificate', 'selfRootCertificate',
    'selfCatalogName', 'selfCatalogSha256', 'selfCatalogVolumeSerial', 'selfCatalogFileId128'])
    && record.sha256 === policy.sha256 && record.size === policy.size
    && /^[a-f0-9]{16}$/.test(String(record.volumeSerial))
    && /^[a-f0-9]{32}$/.test(String(record.fileId128))
    && record.nodeDev === nodeIdentity.dev && record.nodeIno === nodeIdentity.ino
    && ['S-1-5-18', 'S-1-5-32-544', 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464']
      .includes(String(record.ownerSid))
    && record.daclProtected === true && record.reparseTag === '00000000'
    && typeof record.selfSubject === 'string' && typeof record.selfCertificate === 'string'
    && typeof record.selfRootCertificate === 'string'
    && typeof record.selfCatalogName === 'string' && record.selfCatalogName.length <= 260
    && /^[a-f0-9]{64}$/.test(String(record.selfCatalogSha256))
    && /^[a-f0-9]{16}$/.test(String(record.selfCatalogVolumeSerial))
    && /^[a-f0-9]{32}$/.test(String(record.selfCatalogFileId128))
    && MICROSOFT_SYSTEM_CATALOG_POLICY.some(approved => approved.member === 'powershell.exe'
      && approved.catalog === record.selfCatalogName && approved.catalogSha256 === record.selfCatalogSha256);
};

const acquireBootstrapPackageAuthority = async (
  path: string,
  policy: WindowsNativeLauncherPolicy,
  allowUnsignedValidation: boolean,
  nodeIdentity: { dev: string; ino: string },
  heldHandle: FileHandle,
): Promise<() => Promise<void>> => {
  if (process.platform !== 'win32' || (policy.trust !== 'production-signed' && !allowUnsignedValidation)) {
    throw helperError('HELPER_OWNER_DACL');
  }
  const loader = '$p=[Console]::In.ReadLine();$s=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($p));&([ScriptBlock]::Create($s))';
  const child = spawn(KERNEL_SYSTEM_POWERSHELL, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-Command', loader], {
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe', heldHandle.fd],
    // An explicit empty environment proves no hostile command/root variable is
    // authority. The verifier obtains System32 from its own authenticated image.
    env: {},
  });
  const childInput = child.stdin;
  const childOutput = child.stdout;
  const childError = child.stderr;
  if (!childInput || !childOutput || !childError) {
    if (!child.killed) child.kill();
    throw helperError('HELPER_OWNER_DACL');
  }
  let output = Buffer.alloc(0);
  let errorOutput = 0;
  const cleanup = (): void => { if (!child.killed) child.kill(); };
  const proofPromise = new Promise<Record<string, unknown>>((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => { cleanup(); rejectPromise(helperError('HELPER_OWNER_DACL')); }, 30_000);
    const reject = (): void => { clearTimeout(timer); cleanup(); rejectPromise(helperError('HELPER_OWNER_DACL')); };
    child.once('error', reject);
    child.once('exit', reject);
    childError.on('data', (chunk: Buffer) => {
      errorOutput += chunk.length;
      if (errorOutput > 0) reject();
    });
    childOutput.on('data', (chunk: Buffer) => {
      output = Buffer.concat([output, chunk]);
      if (output.length > 16 * 1024) { reject(); return; }
      const newline = output.indexOf(0x0a);
      if (newline < 0) return;
      if (output.subarray(newline + 1).some(byte => byte !== 0x0d && byte !== 0x0a)) { reject(); return; }
      clearTimeout(timer);
      try { resolvePromise(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(output.subarray(0, newline)))); }
      catch { reject(); }
    });
  });
  const wirePolicy = Buffer.from(JSON.stringify({
    path,
    size: policy.size,
    sha256: policy.sha256,
    production: policy.trust === 'production-signed',
    authorityRoot: dirname(path),
    nodeDev: nodeIdentity.dev,
    nodeIno: nodeIdentity.ino,
  }), 'utf8').toString('base64');
  childInput.write(`${Buffer.from(BOOTSTRAP_AUTHORITY_SCRIPT, 'utf8').toString('base64')}\n${wirePolicy}\n`);
  let record: Record<string, unknown>;
  try { record = await proofPromise; } catch (error) { cleanup(); throw error; }
  if (!validateBootstrapIdentityRecordForTest(record, policy, nodeIdentity)) {
    cleanup(); throw helperError('HELPER_IDENTITY');
  }
  try {
    const selfCertificate = new X509Certificate(Buffer.from(String(record.selfCertificate), 'base64'));
    const selfRoot = new X509Certificate(Buffer.from(String(record.selfRootCertificate), 'base64'));
    const selfCertificateSha256 = selfCertificate.fingerprint256.replaceAll(':', '').toLowerCase();
    const selfSpkiSha256 = createHash('sha256').update(
      selfCertificate.publicKey.export({ format: 'der', type: 'spki' }),
    ).digest('hex');
    const selfRootSpkiSha256 = createHash('sha256').update(
      selfRoot.publicKey.export({ format: 'der', type: 'spki' }),
    ).digest('hex');
    const approvedCatalog = MICROSOFT_SYSTEM_CATALOG_POLICY.some(approved =>
      approved.member === 'powershell.exe'
      && approved.catalog === record.selfCatalogName
      && approved.publisher === record.selfSubject
      && approved.certificateSha256 === selfCertificateSha256
      && approved.spkiSha256 === selfSpkiSha256
      && approved.catalogSha256 === record.selfCatalogSha256);
    if (!approvedCatalog || !MICROSOFT_SYSTEM_ROOT_SPKI_SHA256.has(selfRootSpkiSha256)) {
      throw new Error('untrusted verifier');
    }
  } catch { cleanup(); throw helperError('HELPER_OWNER_DACL'); }
  if (policy.trust === 'production-signed') {
    if (record.subject !== policy.publisher || typeof record.certificate !== 'string') {
      cleanup(); throw helperError('HELPER_OWNER_DACL');
    }
    let certificateSha256: string;
    let spkiSha256: string;
    try {
      const certificate = new X509Certificate(Buffer.from(record.certificate, 'base64'));
      certificateSha256 = certificate.fingerprint256.replaceAll(':', '').toLowerCase();
      spkiSha256 = createHash('sha256').update(
        certificate.publicKey.export({ format: 'der', type: 'spki' }),
      ).digest('hex');
    } catch { cleanup(); throw helperError('HELPER_OWNER_DACL'); }
    if (certificateSha256 !== policy.signerCertificateSha256 || spkiSha256 !== policy.signerSpkiSha256
      || !policy.signerPins.some(pin => pin === `certificate-sha256:${certificateSha256}`
        || pin === `spki-sha256:${spkiSha256}`)) {
      cleanup(); throw helperError('HELPER_OWNER_DACL');
    }
  }
  return async () => {
    childInput.end('release\n');
    await new Promise<void>((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => { cleanup(); rejectPromise(helperError('HELPER_OWNER_DACL')); }, 5_000);
      child.once('exit', (code, signal) => {
        clearTimeout(timer);
        if (code === 0 && signal === null && errorOutput === 0) resolvePromise();
        else rejectPromise(helperError('HELPER_OWNER_DACL'));
      });
    });
  };
};

const exactRecordKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));

export const parseWindowsAuthorityHelperManifestForTest = (bytes: Buffer): WindowsAuthorityHelperManifest => {
  if (!Buffer.isBuffer(bytes) || bytes.length <= 1 || bytes.length > HELPER_MANIFEST_BYTES
    || bytes[bytes.length - 1] !== 0x0a) throw helperError('MANIFEST');
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, -1)); }
  catch { throw helperError('MANIFEST'); }
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw helperError('MANIFEST'); }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw helperError('MANIFEST');
  const manifest = value as Record<string, unknown>;
  const compiler = manifest.compiler;
  const launcher = manifest.launcher;
  const bootstrap = manifest.bootstrap;
  if (!exactRecordKeys(manifest, HELPER_MANIFEST_KEYS)
    || typeof compiler !== 'object' || compiler === null || Array.isArray(compiler)
    || typeof launcher !== 'object' || launcher === null || Array.isArray(launcher)
    || typeof bootstrap !== 'object' || bootstrap === null || Array.isArray(bootstrap)
    || !exactRecordKeys(compiler as Record<string, unknown>, ['kind', 'framework'])
    || !exactRecordKeys(launcher as Record<string, unknown>, [
      'name', 'format', 'architecture', 'machine', 'size', 'sha256', 'trust', 'publisher', 'signerPins',
      'signerCertificateSha256', 'signerSpkiSha256',
    ])
    || !exactRecordKeys(bootstrap as Record<string, unknown>, [
      'name', 'format', 'architecture', 'machine', 'size', 'sha256', 'trust', 'publisher', 'signerPins',
      'signerCertificateSha256', 'signerSpkiSha256',
    ])
    || manifest.schemaVersion !== 1 || manifest.name !== HELPER_NAME || manifest.format !== 'PE32'
    || manifest.architecture !== 'anycpu' || manifest.machine !== 'I386' || manifest.clr !== true
    || !Number.isSafeInteger(manifest.size) || Number(manifest.size) <= 0 || Number(manifest.size) > HELPER_MAX_BYTES
    || !/^[a-f0-9]{64}$/.test(String(manifest.sha256))
    || !/^[a-f0-9]{64}$/.test(String(manifest.sourceSha256))
    || manifest.protocol !== 'propr-windows-authority-v1'
    || !['unsigned-validation', 'production-signed'].includes(String(manifest.trust))
    || (manifest.trust === 'unsigned-validation' && manifest.publisher !== null)
    || (manifest.trust === 'production-signed'
      && (typeof manifest.publisher !== 'string' || manifest.publisher.length <= 0 || manifest.publisher.length > 512))
    || !Array.isArray(manifest.signerPins) || manifest.signerPins.length > 16
    || manifest.signerPins.some(pin => typeof pin !== 'string'
      || !/^(?:certificate|spki)-sha256:[a-f0-9]{64}$/.test(pin))
    || new Set(manifest.signerPins).size !== manifest.signerPins.length
    || manifest.signerPins.join(',') !== [...manifest.signerPins].sort().join(',')
    || (manifest.trust === 'unsigned-validation'
      && (manifest.signerPins.length !== 0 || manifest.signerCertificateSha256 !== null
        || manifest.signerSpkiSha256 !== null))
    || (manifest.trust === 'production-signed'
      && (manifest.signerPins.length === 0
        || !/^[a-f0-9]{64}$/.test(String(manifest.signerCertificateSha256))
        || !/^[a-f0-9]{64}$/.test(String(manifest.signerSpkiSha256))
        || !manifest.signerPins.some(pin => pin === `certificate-sha256:${manifest.signerCertificateSha256}`
          || pin === `spki-sha256:${manifest.signerSpkiSha256}`)))
    || (launcher as Record<string, unknown>).name !== LAUNCHER_NAME
    || (launcher as Record<string, unknown>).format !== 'PE'
    || !['x64', 'arm64'].includes(String((launcher as Record<string, unknown>).architecture))
    || ((launcher as Record<string, unknown>).architecture === 'x64'
      ? (launcher as Record<string, unknown>).machine !== 'AMD64'
      : (launcher as Record<string, unknown>).machine !== 'ARM64')
    || !Number.isSafeInteger((launcher as Record<string, unknown>).size)
    || Number((launcher as Record<string, unknown>).size) <= 0
    || Number((launcher as Record<string, unknown>).size) > HELPER_MAX_BYTES
    || !/^[a-f0-9]{64}$/.test(String((launcher as Record<string, unknown>).sha256))
    || (launcher as Record<string, unknown>).trust !== manifest.trust
    || (launcher as Record<string, unknown>).publisher !== manifest.publisher
    || JSON.stringify((launcher as Record<string, unknown>).signerPins) !== JSON.stringify(manifest.signerPins)
    || (launcher as Record<string, unknown>).signerCertificateSha256 !== manifest.signerCertificateSha256
    || (launcher as Record<string, unknown>).signerSpkiSha256 !== manifest.signerSpkiSha256
    || (bootstrap as Record<string, unknown>).name !== BOOTSTRAP_NAME
    || (bootstrap as Record<string, unknown>).format !== 'PE'
    || (bootstrap as Record<string, unknown>).architecture !== (launcher as Record<string, unknown>).architecture
    || (bootstrap as Record<string, unknown>).machine !== (launcher as Record<string, unknown>).machine
    || !Number.isSafeInteger((bootstrap as Record<string, unknown>).size)
    || Number((bootstrap as Record<string, unknown>).size) <= 0
    || Number((bootstrap as Record<string, unknown>).size) > HELPER_MAX_BYTES
    || !/^[a-f0-9]{64}$/.test(String((bootstrap as Record<string, unknown>).sha256))
    || (bootstrap as Record<string, unknown>).trust !== manifest.trust
    || (bootstrap as Record<string, unknown>).publisher !== manifest.publisher
    || JSON.stringify((bootstrap as Record<string, unknown>).signerPins) !== JSON.stringify(manifest.signerPins)
    || (bootstrap as Record<string, unknown>).signerCertificateSha256 !== manifest.signerCertificateSha256
    || (bootstrap as Record<string, unknown>).signerSpkiSha256 !== manifest.signerSpkiSha256
    || (compiler as Record<string, unknown>).kind !== 'windows-fixed-system-dotnet-framework-csc-v1'
    || !/^(?:Framework64|Framework)-v4\.0\.30319$/.test(String((compiler as Record<string, unknown>).framework))) {
    throw helperError('MANIFEST');
  }
  return manifest as unknown as WindowsAuthorityHelperManifest;
};

export const inspectWindowsAuthorityHelperPeForTest = (bytes: Buffer): void => {
  if (!Buffer.isBuffer(bytes) || bytes.length < 512 || bytes.length > HELPER_MAX_BYTES
    || bytes.readUInt16LE(0) !== 0x5a4d) throw helperError('HELPER_HASH');
  const pe = bytes.readUInt32LE(0x3c);
  if (pe < 0x40 || pe + 248 > bytes.length || bytes.toString('ascii', pe, pe + 4) !== 'PE\0\0'
    || bytes.readUInt16LE(pe + 4) !== 0x14c || bytes.readUInt16LE(pe + 24) !== 0x10b) {
    throw helperError('HELPER_HASH');
  }
  const sectionCount = bytes.readUInt16LE(pe + 6);
  const optionalSize = bytes.readUInt16LE(pe + 20);
  const clrDirectory = pe + 24 + 96 + (14 * 8);
  const clrRva = bytes.readUInt32LE(clrDirectory);
  if (sectionCount <= 0 || sectionCount > 96 || optionalSize < 224
    || clrDirectory + 8 > pe + 24 + optionalSize || clrRva === 0
    || bytes.readUInt32LE(clrDirectory + 4) < 72) {
    throw helperError('HELPER_HASH');
  }
  const sectionTable = pe + 24 + optionalSize;
  let clrOffset = -1;
  for (let index = 0; index < sectionCount; index += 1) {
    const section = sectionTable + (index * 40);
    if (section + 40 > bytes.length) throw helperError('HELPER_HASH');
    const virtualSize = bytes.readUInt32LE(section + 8);
    const virtualAddress = bytes.readUInt32LE(section + 12);
    const rawSize = bytes.readUInt32LE(section + 16);
    const rawAddress = bytes.readUInt32LE(section + 20);
    const span = Math.max(virtualSize, rawSize);
    if (clrRva >= virtualAddress && clrRva < virtualAddress + span) {
      clrOffset = rawAddress + clrRva - virtualAddress;
    }
  }
  if (clrOffset < 0 || clrOffset + 20 > bytes.length) throw helperError('HELPER_HASH');
  const corFlags = bytes.readUInt32LE(clrOffset + 16);
  if ((corFlags & 0x1) === 0 || (corFlags & (0x2 | 0x10 | 0x20000)) !== 0) throw helperError('HELPER_HASH');
};

export const inspectWindowsNativeLauncherPeForTest = (bytes: Buffer, architecture: 'x64' | 'arm64'): void => {
  if (!Buffer.isBuffer(bytes) || bytes.length < 512 || bytes.length > HELPER_MAX_BYTES
    || bytes.readUInt16LE(0) !== 0x5a4d) throw helperError('HELPER_HASH');
  const pe = bytes.readUInt32LE(0x3c);
  const expectedMachine = architecture === 'arm64' ? 0xaa64 : 0x8664;
  if (pe < 0x40 || pe + 24 > bytes.length || bytes.toString('ascii', pe, pe + 4) !== 'PE\0\0'
    || bytes.readUInt16LE(pe + 4) !== expectedMachine) throw helperError('HELPER_HASH');
};

const readHeldExactly = async (handle: FileHandle, size: number, stage: WindowsAuthorityCompileStage): Promise<Buffer> => {
  const bytes = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const result = await handle.read(bytes, offset, size - offset, offset).catch(() => { throw helperError(stage); });
    if (result.bytesRead <= 0) throw helperError(stage);
    offset += result.bytesRead;
  }
  return bytes;
};

const proveCanonicalTree = async (root: string, target: string): Promise<{
  path: string;
  identity: { dev: bigint; ino: bigint; size: bigint; nlink: bigint };
}> => {
  const canonicalRoot = await realpath(root).catch(() => { throw helperError('HELPER_REPARSE'); });
  const canonicalTarget = await realpath(target).catch(() => { throw helperError('HELPER_REPARSE'); });
  const samePath = (left: string, right: string): boolean => process.platform === 'win32'
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
  if (!samePath(resolve(root), canonicalRoot) || !samePath(resolve(target), canonicalTarget)) throw helperError('HELPER_REPARSE');
  const inside = relative(canonicalRoot, canonicalTarget);
  if (!inside || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) throw helperError('HELPER_REPARSE');
  let cursor = canonicalRoot;
  for (const part of inside.split(sep)) {
    cursor = join(cursor, part);
    const stats = await lstat(cursor, { bigint: true }).catch(() => { throw helperError('HELPER_REPARSE'); });
    if (stats.isSymbolicLink() || (!stats.isDirectory() && cursor !== canonicalTarget)) throw helperError('HELPER_REPARSE');
  }
  const stats = await lstat(canonicalTarget, { bigint: true }).catch(() => { throw helperError('HELPER_REPARSE'); });
  return { path: canonicalTarget, identity: { dev: stats.dev, ino: stats.ino, size: stats.size, nlink: stats.nlink } };
};

const authenticateWindowsAuthorityHelper = async (
  directory = helperDirectory(),
  beforeOpenForTest?: () => void | Promise<void>,
  expectedPublisher = embeddedExpectedPublisher(),
  expectedSignerPins = embeddedExpectedSignerPins(),
  nativeLoadFaultForTest?: 'barrier-before-module-load-swap' | 'barrier-before-module-load-write'
    | 'barrier-before-module-load-delete',
  allowUnsignedBootstrapForValidation = expectedPublisher === undefined && directory === helperDirectory(),
): Promise<AuthenticatedWindowsAuthorityHelper> => {
  if (!isAbsolute(directory) || directory.indexOf(':', 2) >= 0) throw helperError('MANIFEST');
  const executableProof = await proveCanonicalTree(directory, join(directory, HELPER_NAME));
  const launcherProof = await proveCanonicalTree(directory, join(directory, LAUNCHER_NAME));
  const bootstrapProof = await proveCanonicalTree(directory, join(directory, BOOTSTRAP_NAME));
  const manifestProof = await proveCanonicalTree(directory, join(directory, HELPER_MANIFEST_NAME));
  await beforeOpenForTest?.();
  let executableHandle: FileHandle | undefined;
  let launcherHandle: FileHandle | undefined;
  let bootstrapHandle: FileHandle | undefined;
  let manifestHandle: FileHandle | undefined;
  try {
    manifestHandle = await open(manifestProof.path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
      .catch(() => { throw helperError('MANIFEST'); });
    const manifestStats = await manifestHandle.stat({ bigint: true });
    if (!manifestStats.isFile() || manifestStats.dev !== manifestProof.identity.dev || manifestStats.ino !== manifestProof.identity.ino
      || manifestStats.nlink !== 1n || manifestStats.size <= 1n
      || manifestStats.size > BigInt(HELPER_MANIFEST_BYTES)) throw helperError('MANIFEST');
    const manifest = parseWindowsAuthorityHelperManifestForTest(
      await readHeldExactly(manifestHandle, Number(manifestStats.size), 'MANIFEST'),
    );
    if (expectedPublisher
      ? manifest.trust !== 'production-signed' || manifest.publisher !== expectedPublisher
      : manifest.trust !== 'unsigned-validation' || manifest.publisher !== null) throw helperError('MANIFEST');
    if (expectedPublisher && JSON.stringify(manifest.signerPins) !== JSON.stringify(expectedSignerPins)) {
      throw helperError('MANIFEST');
    }
    executableHandle = await open(executableProof.path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
      .catch(() => { throw helperError('HELPER_OPEN'); });
    const before = await executableHandle.stat({ bigint: true });
    if (!before.isFile() || before.dev !== executableProof.identity.dev || before.ino !== executableProof.identity.ino
      || before.nlink !== 1n || before.size !== BigInt(manifest.size)) throw helperError('HELPER_IDENTITY');
    const bytes = await readHeldExactly(executableHandle, manifest.size, 'HELPER_HASH');
    inspectWindowsAuthorityHelperPeForTest(bytes);
    if (createHash('sha256').update(bytes).digest('hex') !== manifest.sha256) throw helperError('HELPER_HASH');
    const after = await executableHandle.stat({ bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.nlink !== after.nlink) throw helperError('HELPER_IDENTITY');
    launcherHandle = await open(launcherProof.path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
      .catch(() => { throw helperError('HELPER_OPEN'); });
    const launcherBefore = await launcherHandle.stat({ bigint: true });
    if (!launcherBefore.isFile() || launcherBefore.dev !== launcherProof.identity.dev
      || launcherBefore.ino !== launcherProof.identity.ino || launcherBefore.nlink !== 1n
      || launcherBefore.size !== BigInt(manifest.launcher.size)
      || manifest.launcher.architecture !== process.arch) throw helperError('HELPER_IDENTITY');
    const launcherBytes = await readHeldExactly(launcherHandle, manifest.launcher.size, 'HELPER_HASH');
    inspectWindowsNativeLauncherPeForTest(launcherBytes, manifest.launcher.architecture);
    if (createHash('sha256').update(launcherBytes).digest('hex') !== manifest.launcher.sha256) {
      throw helperError('HELPER_HASH');
    }
    const launcherAfter = await launcherHandle.stat({ bigint: true });
    if (launcherAfter.dev !== launcherBefore.dev || launcherAfter.ino !== launcherBefore.ino
      || launcherAfter.size !== launcherBefore.size || launcherAfter.nlink !== launcherBefore.nlink) {
      throw helperError('HELPER_IDENTITY');
    }
    bootstrapHandle = await open(bootstrapProof.path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
      .catch(() => { throw helperError('HELPER_OPEN'); });
    const bootstrapBefore = await bootstrapHandle.stat({ bigint: true });
    if (!bootstrapBefore.isFile() || bootstrapBefore.dev !== bootstrapProof.identity.dev
      || bootstrapBefore.ino !== bootstrapProof.identity.ino || bootstrapBefore.nlink !== 1n
      || bootstrapBefore.size !== BigInt(manifest.bootstrap.size)) throw helperError('HELPER_IDENTITY');
    const bootstrapBytes = await readHeldExactly(bootstrapHandle, manifest.bootstrap.size, 'HELPER_HASH');
    inspectWindowsNativeLauncherPeForTest(bootstrapBytes, manifest.bootstrap.architecture);
    if (createHash('sha256').update(bootstrapBytes).digest('hex') !== manifest.bootstrap.sha256) {
      throw helperError('HELPER_HASH');
    }
    const bootstrapAfter = await bootstrapHandle.stat({ bigint: true });
    if (bootstrapAfter.dev !== bootstrapBefore.dev || bootstrapAfter.ino !== bootstrapBefore.ino
      || bootstrapAfter.size !== bootstrapBefore.size || bootstrapAfter.nlink !== bootstrapBefore.nlink) {
      throw helperError('HELPER_IDENTITY');
    }
    // The kernel SystemRoot namespace selects and the OS-serviced policy
    // authenticates the verifier without consulting process environment roots.
    // Its held bootstrap lease spans N-API initialization and launcher loading.
    const releaseBootstrapAuthority = await acquireBootstrapPackageAuthority(
      bootstrapProof.path,
      manifest.bootstrap,
      allowUnsignedBootstrapForValidation,
      { dev: bootstrapBefore.dev.toString(), ino: bootstrapBefore.ino.toString() },
      bootstrapHandle,
    );
    let bootstrap: WindowsNativeBootstrap;
    let nativeLauncher: WindowsNativeLauncher;
    try {
      if (require.cache[bootstrapProof.path]) throw helperError('HELPER_OPEN');
      bootstrap = require(bootstrapProof.path) as WindowsNativeBootstrap;
      if (!bootstrap || typeof bootstrap.loadVerifiedModule !== 'function') throw helperError('HELPER_OPEN');
      nativeLauncher = bootstrap.loadVerifiedModule({
        path: launcherProof.path,
        size: manifest.launcher.size,
        sha256: manifest.launcher.sha256,
        production: manifest.launcher.trust === 'production-signed',
        authenticationMode: 'runtime',
        publisher: manifest.launcher.publisher,
        signerCertificateSha256: manifest.launcher.signerCertificateSha256,
        signerSpkiSha256: manifest.launcher.signerSpkiSha256,
        fault: nativeLoadFaultForTest ?? null,
      });
    } catch { throw helperError('HELPER_IDENTITY'); }
    finally { await releaseBootstrapAuthority(); }
    if (!nativeLauncher || typeof nativeLauncher.probeSystemDirectory !== 'function'
      || typeof nativeLauncher.protectPrivateDirectory !== 'function') throw helperError('HELPER_IDENTITY');
    let systemRoot: string;
    try {
      systemRoot = decodeAuthenticatedSystemRoot(nativeLauncher.probeSystemDirectory({
        systemRoot: '',
        windir: '',
        fault: null,
      }));
    } catch { throw helperError('HELPER_IDENTITY'); }
    return { executable: executableProof.path, systemRoot, executableHandle, launcherHandle, bootstrapHandle,
      manifestHandle, manifest, launcher: nativeLauncher };
  } catch (error) {
    await executableHandle?.close().catch(() => undefined);
    await launcherHandle?.close().catch(() => undefined);
    await bootstrapHandle?.close().catch(() => undefined);
    await manifestHandle?.close().catch(() => undefined);
    throw error;
  }
};

export const authenticateWindowsAuthorityHelperForTest = authenticateWindowsAuthorityHelper;

const activeSessionTempDirectories = new Set<string>();
let lastRemovedSessionTempDirectory: string | undefined;

const createPrivateSessionTempDirectory = async (helper: AuthenticatedWindowsAuthorityHelper): Promise<string> => {
  let created: string | undefined;
  try {
    const parent = tmpdir();
    if (!isAbsolute(parent) || parent.indexOf(':', 2) >= 0) throw helperError('TRANSPORT_SPAWN');
    created = await mkdtemp(join(parent, 'propr-windows-authority-session-'));
    const canonical = await realpath(created);
    const samePath = process.platform === 'win32'
      ? resolve(created).toLowerCase() === canonical.toLowerCase()
      : resolve(created) === canonical;
    const before = await lstat(canonical, { bigint: true });
    if (!samePath || !before.isDirectory() || before.isSymbolicLink()
      || helper.launcher.protectPrivateDirectory({ path: canonical }) !== true) {
      throw helperError('TRANSPORT_SPAWN');
    }
    const after = await lstat(canonical, { bigint: true });
    if (!after.isDirectory() || after.isSymbolicLink() || before.dev !== after.dev || before.ino !== after.ino) {
      throw helperError('TRANSPORT_SPAWN');
    }
    return canonical;
  } catch (error) {
    if (created) await rm(created, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
};

const spawnBroker = (
  helper: AuthenticatedWindowsAuthorityHelper,
  sessionTempDirectory: string,
): BrokerChild => {
  const child = spawn(helper.executable, ['--broker'], {
    shell: false,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd: sessionTempDirectory,
    env: {
      SystemRoot: helper.systemRoot,
      TEMP: sessionTempDirectory,
      TMP: sessionTempDirectory,
    },
  });
  if (!child.stdin || !child.stdout || !child.stderr) {
    if (!child.killed) child.kill();
    throw helperError('TRANSPORT_SPAWN');
  }
  return child as BrokerChild;
};

class WindowsAuthorityError extends Error {
  constructor(readonly reason: WindowsAuthorityReason, readonly scenario: number) {
    super(`Verified update cache authority inspection failed [win-authority:${reason}:${scenario}]`);
  }
}

export type WindowsAuthorityBootstrapFailureKind =
  | 'SPAWN_ERROR'
  | 'EXIT_NO_OUTPUT'
  | 'EXIT_AFTER_OUTPUT'
  | 'TIMEOUT'
  | 'MALFORMED_OUTPUT'
  | 'EXTRA_OUTPUT'
  | 'STAGE_CHANNEL'
  | 'WRITE_ERROR';

export class WindowsAuthorityBootstrapError extends WindowsAuthorityError {
  readonly stage: WindowsAuthorityCompileStage;

  constructor(readonly kind: WindowsAuthorityBootstrapFailureKind, stageIndex: number) {
    super('compile_load', stageIndex);
    this.stage = WINDOWS_AUTHORITY_COMPILE_STAGES[stageIndex] ?? 'TRANSPORT_SPAWN';
  }
}

const authorityError = (reason: WindowsAuthorityReason, scenario: number): WindowsAuthorityError =>
  new WindowsAuthorityError(reason, scenario);

const abortError = (): Error => Object.assign(new Error('Windows authority request aborted'), { name: 'AbortError' });

const throwIfAborted = (signal?: AbortSignal): void => {
  if (signal?.aborted) throw abortError();
};

const hasExactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));

const parseFailure = (value: unknown, expectedId?: string): Error | undefined => {
  if (typeof value !== 'object' || value === null) return undefined;
  const candidate = value as Record<string, unknown>;
  const keys = expectedId === undefined
    ? ['version', 'type', 'reason', 'scenario']
    : ['version', 'type', 'id', 'reason', 'scenario'];
  if (candidate.version !== WINDOWS_AUTHORITY_PROTOCOL_VERSION || candidate.type !== 'error'
    || !hasExactKeys(candidate, keys) || (expectedId !== undefined && candidate.id !== expectedId)
    || typeof candidate.reason !== 'string' || !reasonCodes.has(candidate.reason)
    || !Number.isInteger(candidate.scenario) || Number(candidate.scenario) < 0 || Number(candidate.scenario) > 99) {
    return undefined;
  }
  return authorityError(candidate.reason as WindowsAuthorityReason, Number(candidate.scenario));
};

const parseInspection = (
  value: unknown,
  directory: boolean,
  hashes: boolean,
): WindowsPrivatePathInspection | WindowsHeldVerification | undefined => {
  if (typeof value !== 'object' || value === null) return undefined;
  const candidate = value as Record<string, unknown>;
  if (candidate.version !== WINDOWS_AUTHORITY_PROTOCOL_VERSION
    || !/^[a-f0-9]{16}$/.test(String(candidate.volumeSerial))
    || !/^[a-f0-9]{32}$/.test(String(candidate.fileId128))
    || candidate.directory !== directory
    || !/^(0|[1-9]\d*)$/.test(String(candidate.links))
    || !/^(0|[1-9]\d*)$/.test(String(candidate.size))
    || (!hashes && !directory && BigInt(String(candidate.size)) > BigInt(BROKER_SETUP_FILE_BYTES))
    || !/^[a-f0-9]{8}$/.test(String(candidate.reparseTag))
    || candidate.reparseTag !== '00000000'
    || !/^S-1-(?:\d+-){1,14}\d+$/.test(String(candidate.ownerSid))
    || candidate.daclProtected !== true
    || !/^(0|[1-9]\d*)$/.test(String(candidate.aceCount))
    || candidate.inheritedWriteAces !== '0'
    || candidate.broadWriteAces !== '0'
    || (hashes && (!/^[a-f0-9]{64}$/.test(String(candidate.sha256))
      || !/^[a-f0-9]{40}$/.test(String(candidate.sha1))))) return undefined;
  const inspection: WindowsPrivatePathInspection = {
    identity: {
      platform: 'win32',
      volumeSerial: String(candidate.volumeSerial),
      fileId128: String(candidate.fileId128),
    },
    directory,
    links: String(candidate.links),
    size: String(candidate.size),
    reparseTag: String(candidate.reparseTag),
    ownerSid: String(candidate.ownerSid),
    daclProtected: true,
    aceCount: String(candidate.aceCount),
    inheritedWriteAces: '0',
    broadWriteAces: '0',
  };
  return hashes ? {
    ...inspection,
    sha256: String(candidate.sha256),
    sha1: String(candidate.sha1),
  } : inspection;
};

type BrokerRequestOperation = BrokerOperation | 'hold' | 'continue' | 'read' | 'verify' | 'close' | 'fault-stderr';
// After the authenticated image/challenge exchange, the persistent process
// accepts only four-byte-length-prefixed strict-UTF-8 versioned request frames. Node
// permits one in-flight frame at a time; a held capability owns the FIFO lease
// until close, so its native handle cannot be confused with another entry.
interface BrokerRequestFrame {
  version: typeof WINDOWS_AUTHORITY_PROTOCOL_VERSION;
  type: 'request';
  id: string;
  operation: BrokerRequestOperation;
  purpose: BrokerPurpose;
  path: string | null;
  directory: boolean | null;
  expectedBytes: number | null;
  expectedVolumeSerial: string | null;
  expectedFileId128: string | null;
  expectedSha256: string | null;
  challenge: string | null;
  barrier: string | null;
  offset: number | null;
  length: number | null;
}

interface FrameWaiter {
  resolve(value: Record<string, unknown>): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
  signal?: AbortSignal;
  abort?: () => void;
}

interface LockedArtifactProcess {
  session: WindowsAuthoritySession;
  exited: Promise<void>;
  challenge: string;
  heldId: string;
  purpose: BrokerPurpose;
  release(): void;
  timeout: NodeJS.Timeout;
}

let brokerSession: WindowsAuthoritySession | undefined;
let brokerStartup: Promise<WindowsAuthoritySession> | undefined;
let compileCount = 0;
let requestCount = 0;
let restartCount = 0;
let activeProcessCount = 0;
let activeAuthenticatedHandleSets = 0;
let lastClosedHeldId: string | undefined;
const brokerChildren = new Set<BrokerChild>();

const encodeProtocolFrame = (value: string): Buffer => {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length <= 0 || bytes.length > BROKER_REQUEST_LINE_BYTES) throw authorityError('request_protocol', 1);
  const prefix = Buffer.allocUnsafe(4);
  prefix.writeUInt32BE(bytes.length);
  return Buffer.concat([prefix, bytes]);
};

const decodeProtocolChunk = (buffered: Buffer, chunk: Buffer): {
  buffered: Buffer;
  frames: readonly Buffer[];
} => {
  let combined = buffered.length === 0 ? chunk : Buffer.concat([buffered, chunk]);
  const frames: Buffer[] = [];
  while (combined.length >= 4) {
    const length = combined.readUInt32BE(0);
    if (length <= 0 || length > BROKER_PROTOCOL_LINE_BYTES) throw authorityError('output_bound', 17);
    if (combined.length < 4 + length) break;
    frames.push(combined.subarray(4, 4 + length));
    combined = combined.subarray(4 + length);
  }
  if (combined.length > BROKER_PROTOCOL_LINE_BYTES + 4) throw authorityError('output_bound', 17);
  return { buffered: Buffer.from(combined), frames };
};

class WindowsAuthoritySession {
  readonly exited: Promise<void>;
  private terminalError: Error | undefined;
  private buffered: Buffer = Buffer.alloc(0);
  private waiter: FrameWaiter | undefined;
  private stderrBytes = 0;
  private stderrBuffered = '';
  private bootstrapStages: WindowsAuthorityCompileStage[] = WINDOWS_AUTHORITY_COMPILE_STAGES.slice(0, 4);
  private bootstrapReady = false;
  private bootstrapResolve!: () => void;
  private readonly bootstrapCompleted = new Promise<void>(resolve => { this.bootstrapResolve = resolve; });
  private inputBytes = 0;
  private outputBytes = 0;
  private frames = 0;
  private closing = false;
  private resourcesCleaned = false;

  constructor(
    readonly child: BrokerChild,
    private readonly sharedQueue = true,
    private readonly helper?: AuthenticatedWindowsAuthorityHelper,
    private readonly sessionTempDirectory?: string,
  ) {
    activeProcessCount++;
    if (helper) activeAuthenticatedHandleSets++;
    if (sessionTempDirectory) activeSessionTempDirectories.add(sessionTempDirectory);
    brokerChildren.add(child);
    child.stdout.on('data', (chunk: Buffer) => this.consume(chunk));
    child.stderr.on('data', (chunk: Buffer) => this.consumeBootstrapStage(chunk));
    child.stdin.on('error', () => this.invalidate(this.bootstrapReady
      ? authorityError('stdio_protocol', 16) : this.bootstrapError('WRITE_ERROR')));
    child.on('error', () => this.invalidate(this.bootstrapReady
      ? authorityError('process_exit', 19) : this.bootstrapError('SPAWN_ERROR')));
    this.exited = new Promise(resolve => child.once('close', code => { void (async () => {
      activeProcessCount--;
      brokerChildren.delete(child);
      const clean = this.closing && code === 0 && this.stderrBuffered === '' && this.buffered.length === 0;
      this.fail(clean ? authorityError('clean_shutdown', 15)
        : this.bootstrapReady ? authorityError('process_exit', 19)
          : this.bootstrapError(this.outputBytes === 0 ? 'EXIT_NO_OUTPUT' : 'EXIT_AFTER_OUTPUT'), false);
      if (brokerSession === this) brokerSession = undefined;
      await this.cleanupResources();
      resolve();
    })(); }));
    child.unref();
    (child.stdin as typeof child.stdin & { unref?(): void }).unref?.();
    (child.stdout as typeof child.stdout & { unref?(): void }).unref?.();
    (child.stderr as typeof child.stderr & { unref?(): void }).unref?.();
  }

  private async cleanupResources(): Promise<void> {
    if (this.resourcesCleaned) return;
    this.resourcesCleaned = true;
    if (this.helper) {
      await Promise.allSettled([
        this.helper.executableHandle.close(),
        this.helper.launcherHandle.close(),
        this.helper.bootstrapHandle.close(),
        this.helper.manifestHandle.close(),
      ]);
      activeAuthenticatedHandleSets--;
    }
    if (this.sessionTempDirectory) {
      await rm(this.sessionTempDirectory, { recursive: true, force: true }).catch(() => {
        try { rmSync(this.sessionTempDirectory!, { recursive: true, force: true }); } catch { /* bounded exit cleanup */ }
      });
      activeSessionTempDirectories.delete(this.sessionTempDirectory);
      lastRemovedSessionTempDirectory = this.sessionTempDirectory;
    }
  }

  private bootstrapError(kind: WindowsAuthorityBootstrapFailureKind = 'EXIT_NO_OUTPUT'): WindowsAuthorityBootstrapError {
    return new WindowsAuthorityBootstrapError(kind, this.bootstrapStages.length - 1);
  }

  private consumeBootstrapStage(chunk: Buffer): void {
    if (this.terminalError) return;
    this.stderrBytes += chunk.length;
    if (this.stderrBytes > BROKER_OUTPUT_BYTES || this.bootstrapReady) {
      return this.invalidate(authorityError(this.stderrBytes > BROKER_OUTPUT_BYTES ? 'output_bound' : 'stdio_protocol',
        this.stderrBytes > BROKER_OUTPUT_BYTES ? 17 : 16));
    }
    this.stderrBuffered += chunk.toString('ascii');
    while (this.stderrBuffered.includes('\n')) {
      const newline = this.stderrBuffered.indexOf('\n');
      const line = this.stderrBuffered.slice(0, newline).replace(/\r$/, '');
      this.stderrBuffered = this.stderrBuffered.slice(newline + 1);
      const match = /^PROPR_BOOTSTRAP (\d{2}) ([A-Z_]+)$/.exec(line);
      const expectedIndex = this.bootstrapStages.length;
      const expectedStage = WINDOWS_AUTHORITY_COMPILE_STAGES[expectedIndex];
      if (!match || Number(match[1]) !== expectedIndex || match[2] !== expectedStage) {
        return this.invalidate(this.bootstrapError('STAGE_CHANNEL'));
      }
      this.bootstrapStages.push(expectedStage);
      if (expectedStage === 'READY') this.bootstrapResolve();
    }
    if (this.stderrBuffered.length > 128) this.invalidate(this.bootstrapError('STAGE_CHANNEL'));
  }

  async requireBootstrapReady(timeoutMs: number): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      this.bootstrapCompleted,
      new Promise<void>((_resolve, reject) => {
        timer = setTimeout(() => {
          const error = this.bootstrapError('TIMEOUT');
          this.invalidate(error);
          reject(error);
        }, timeoutMs);
      }),
    ]).finally(() => { if (timer) clearTimeout(timer); });
    if (this.terminalError || this.stderrBuffered !== ''
      || this.bootstrapStages.length !== WINDOWS_AUTHORITY_COMPILE_STAGES.length) {
      throw this.terminalError ?? this.bootstrapError('STAGE_CHANNEL');
    }
    this.bootstrapReady = true;
  }

  currentBootstrapStage(): WindowsAuthorityCompileStage {
    return this.bootstrapStages[this.bootstrapStages.length - 1];
  }

  private consume(chunk: Buffer): void {
    if (this.terminalError) return;
    this.outputBytes += chunk.length;
    if (this.outputBytes > BROKER_MAX_OUTPUT_BYTES) return this.invalidate(authorityError('output_bound', 17));
    let decoded: ReturnType<typeof decodeProtocolChunk>;
    try { decoded = decodeProtocolChunk(this.buffered, chunk); } catch (error) {
      return this.invalidate(this.bootstrapReady
        ? (error instanceof Error ? error : authorityError('stdio_protocol', 16))
        : this.bootstrapError('MALFORMED_OUTPUT'));
    }
    this.buffered = decoded.buffered;
    for (const frame of decoded.frames) {
      if (!this.waiter) return this.invalidate(this.bootstrapReady
        ? authorityError('stdio_protocol', 16) : this.bootstrapError('EXTRA_OUTPUT'));
      let value: unknown;
      try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(frame)); } catch {
        return this.invalidate(this.bootstrapReady
          ? authorityError('stdio_protocol', 16) : this.bootstrapError('MALFORMED_OUTPUT'));
      }
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return this.invalidate(this.bootstrapReady
          ? authorityError('stdio_protocol', 16) : this.bootstrapError('MALFORMED_OUTPUT'));
      }
      const waiter = this.waiter;
      this.waiter = undefined;
      clearTimeout(waiter.timer);
      if (waiter.signal && waiter.abort) waiter.signal.removeEventListener('abort', waiter.abort);
      waiter.resolve(value as Record<string, unknown>);
    }
  }

  private fail(error: Error, kill: boolean): void {
    this.terminalError ??= error;
    if (this.waiter) {
      const waiter = this.waiter;
      this.waiter = undefined;
      clearTimeout(waiter.timer);
      if (waiter.signal && waiter.abort) waiter.signal.removeEventListener('abort', waiter.abort);
      waiter.reject(this.terminalError);
    }
    if (this.sharedQueue) rejectBrokerQueue(this.terminalError);
    if (kill && !this.child.killed) this.child.kill();
  }

  invalidate(error: Error): void { this.fail(error, true); }

  async receive(timeoutMs: number, signal?: AbortSignal, startup = false): Promise<Record<string, unknown>> {
    throwIfAborted(signal);
    if (this.terminalError) throw this.terminalError;
    if (this.waiter) throw authorityError('stdio_protocol', 16);
    return new Promise((resolve, reject) => {
      const waiter: FrameWaiter = {
        resolve,
        reject,
        signal,
        timer: setTimeout(() => this.invalidate(startup
          ? this.bootstrapError('TIMEOUT') : authorityError('timeout', 18)), timeoutMs),
      };
      if (signal) {
        waiter.abort = () => this.invalidate(abortError());
        signal.addEventListener('abort', waiter.abort, { once: true });
      }
      this.waiter = waiter;
    });
  }

  private async writeChunk(value: string | Buffer): Promise<void> {
    if (this.terminalError) throw this.terminalError;
    if (this.child.stdin.write(value)) return;
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        this.child.stdin.removeListener('drain', drained);
        this.child.stdin.removeListener('error', failed);
      };
      const drained = () => { cleanup(); resolve(); };
      const failed = () => { cleanup(); reject(this.terminalError ?? authorityError('stdio_protocol', 16)); };
      this.child.stdin.once('drain', drained);
      this.child.stdin.once('error', failed);
    });
  }

  async write(value: string | BrokerRequestFrame): Promise<void> {
    if (this.terminalError) throw this.terminalError;
    const frame = encodeProtocolFrame(typeof value === 'string' ? value : JSON.stringify(value));
    this.inputBytes += frame.length;
    if (this.inputBytes > BROKER_MAX_INPUT_BYTES || ++this.frames > BROKER_MAX_FRAMES) {
      this.invalidate(authorityError('output_bound', 17));
      throw authorityError('output_bound', 17);
    }
    await this.writeChunk(frame);
  }

  async writeRawForTest(chunks: readonly Buffer[]): Promise<void> {
    if (this.terminalError || chunks.length === 0
      || chunks.some(chunk => chunk.length === 0 || chunk.length > BROKER_REQUEST_LINE_BYTES + 4)) {
      throw authorityError('request_protocol', 1);
    }
    for (const chunk of chunks) await this.writeChunk(chunk);
  }

  async exchange(frame: BrokerRequestFrame, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const response = this.receive(BROKER_TIMEOUT_MS, signal);
    await this.write(frame);
    const value = await response;
    requestCount++;
    const failure = parseFailure(value, frame.id) ?? parseFailure(value);
    if (failure) throw failure;
    if (value.id !== frame.id) {
      this.invalidate(authorityError('stdio_protocol', 16));
      throw authorityError('stdio_protocol', 16);
    }
    return value;
  }

  async shutdown(): Promise<void> {
    if (this.child.exitCode === null) {
      this.closing = true;
      this.child.stdin.end();
    }
    let terminateTimer: NodeJS.Timeout | undefined;
    let boundTimer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.exited,
        new Promise<void>((_resolve, reject) => {
          terminateTimer = setTimeout(() => { if (!this.child.killed) this.child.kill(); }, BROKER_TIMEOUT_MS);
          boundTimer = setTimeout(() => reject(authorityError('process_exit', 19)), BROKER_TIMEOUT_MS * 2);
        }),
      ]);
    } finally {
      if (terminateTimer) clearTimeout(terminateTimer);
      if (boundTimer) clearTimeout(boundTimer);
    }
  }
}

const exactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean => hasExactKeys(value, keys);
const RESPONSE_INSPECTION_KEYS = Object.freeze([...INSPECTION_KEYS, 'id', 'challenge'] as const);

const requestFrame = (operation: BrokerRequestOperation, values: Partial<BrokerRequestFrame> = {}): BrokerRequestFrame => ({
  version: WINDOWS_AUTHORITY_PROTOCOL_VERSION,
  type: 'request',
  id: randomBytes(16).toString('hex'),
  operation,
  purpose: 'setup',
  path: null,
  directory: null,
  expectedBytes: null,
  expectedVolumeSerial: null,
  expectedFileId128: null,
  expectedSha256: null,
  challenge: null,
  barrier: null,
  offset: null,
  length: null,
  ...values,
});

interface StartBrokerOptions {
  countCompilation?: boolean;
  helperDirectory?: string;
  expectedPublisher?: string;
  allowUnsignedBootstrapForValidation?: boolean;
}

const startBroker = async (options: StartBrokerOptions = {}): Promise<WindowsAuthoritySession> => {
  const helper = await authenticateWindowsAuthorityHelper(
    options.helperDirectory,
    undefined,
    options.expectedPublisher ?? embeddedExpectedPublisher(),
    embeddedExpectedSignerPins(),
    undefined,
    options.allowUnsignedBootstrapForValidation,
  );
  let child: BrokerChild;
  let sessionTempDirectory: string | undefined;
  try {
    sessionTempDirectory = await createPrivateSessionTempDirectory(helper);
    child = spawnBroker(helper, sessionTempDirectory);
  } catch {
    if (sessionTempDirectory) await rm(sessionTempDirectory, { recursive: true, force: true }).catch(() => undefined);
    await helper.executableHandle.close().catch(() => undefined);
    await helper.launcherHandle.close().catch(() => undefined);
    await helper.bootstrapHandle.close().catch(() => undefined);
    await helper.manifestHandle.close().catch(() => undefined);
    throw new WindowsAuthorityBootstrapError('SPAWN_ERROR',
      WINDOWS_AUTHORITY_COMPILE_STAGES.indexOf('TRANSPORT_SPAWN'));
  }
  if (options.countCompilation !== false) {
    compileCount++;
    if (compileCount > 1) restartCount++;
  }
  const session = new WindowsAuthoritySession(
    child,
    options.countCompilation !== false,
    helper,
    sessionTempDirectory,
  );
  try {
    const challenge = randomBytes(16).toString('hex');
    const startupDeadline = Date.now() + BROKER_STARTUP_TIMEOUT_MS;
    const readyPromise = session.receive(BROKER_STARTUP_TIMEOUT_MS, undefined, true);
    try {
      await session.write(JSON.stringify({
        version: WINDOWS_AUTHORITY_PROTOCOL_VERSION,
        type: 'start',
        challenge,
        protocol: 'propr-windows-authority-v1',
      }));
    } catch (error) {
      session.invalidate(error instanceof Error ? error : authorityError('compile_load', 0));
      throw error;
    }
    const ready = await readyPromise;
    const failure = parseFailure(ready);
    if (failure) {
      session.invalidate(failure);
      throw failure;
    }
    await session.requireBootstrapReady(Math.max(1, startupDeadline - Date.now()));
    if (!exactKeys(ready, ['version', 'type', 'challenge', 'protocol', 'maxRequestBytes', 'nativeSmoke', 'compileCount',
      'imageVolumeSerial', 'imageFileId128', 'imageSha256'])
      || ready.version !== WINDOWS_AUTHORITY_PROTOCOL_VERSION || ready.type !== 'ready'
      || ready.challenge !== challenge || ready.protocol !== 'propr-windows-authority-v1'
      || ready.maxRequestBytes !== BROKER_REQUEST_LINE_BYTES || ready.nativeSmoke !== true || ready.compileCount !== 1
      || !/^[a-f0-9]{16}$/.test(String(ready.imageVolumeSerial))
      || !/^[a-f0-9]{32}$/.test(String(ready.imageFileId128))
      || ready.imageSha256 !== helper.manifest.sha256) {
      const error = new WindowsAuthorityBootstrapError('MALFORMED_OUTPUT', WINDOWS_AUTHORITY_COMPILE_STAGES.indexOf('READY'));
      session.invalidate(error);
      throw error;
    }
    return session;
  } catch (error) {
    session.invalidate(error instanceof Error ? error : authorityError('process_exit', 19));
    await session.shutdown().catch(() => undefined);
    throw error;
  }
};

const compileStageFromError = (error: unknown): WindowsAuthorityCompileStage => {
  if (error instanceof WindowsAuthorityError && error.reason === 'compile_load'
    && error.scenario >= 0 && error.scenario < WINDOWS_AUTHORITY_COMPILE_STAGES.length) {
    return WINDOWS_AUTHORITY_COMPILE_STAGES[error.scenario];
  }
  return 'TRANSPORT_SPAWN';
};

const runWindowsAuthorityCompileProbe = async (options: StartBrokerOptions = {}): Promise<WindowsAuthorityCompileStage> => {
  let session: WindowsAuthoritySession | undefined;
  try {
    session = await startBroker({ ...options, countCompilation: false });
    return 'READY';
  } catch (error) {
    return compileStageFromError(error);
  } finally {
    await session?.shutdown();
  }
};

/** Hosted smoke of the exact build-produced executable and READY handshake. */
export const probeWindowsAuthorityCompile = (): Promise<WindowsAuthorityCompileStage> =>
  runWindowsAuthorityCompileProbe();

export const probePackagedWindowsAuthorityHelper = (directory: string): Promise<WindowsAuthorityCompileStage> => {
  if (!isAbsolute(directory)) return Promise.reject(helperError('MANIFEST'));
  const expectedPublisher = process.env.PROPR_DESKTOP_PRODUCTION_RELEASE === '1'
    ? process.env.PROPR_DESKTOP_UPDATE_SIGNING_IDENTITY
    : undefined;
  if (process.env.PROPR_DESKTOP_PRODUCTION_RELEASE === '1' && !expectedPublisher) {
    return Promise.reject(helperError('MANIFEST'));
  }
  return runWindowsAuthorityCompileProbe({
    helperDirectory: directory,
    expectedPublisher,
    allowUnsignedBootstrapForValidation: process.env.PROPR_DESKTOP_PRODUCTION_RELEASE !== '1',
  });
};

/** Native-test-only corrupt-output classification; no compiler diagnostics leave the build boundary. */
export const probeWindowsAuthorityCompileFailureForTest = (): Promise<WindowsAuthorityCompileStage> =>
  Promise.resolve('BUILD_OUTPUT');

/** Native-test-only startup failure against the exact compiled production child. */
export const probeWindowsAuthorityStartupFailureForTest = async (): Promise<WindowsAuthorityReason> => {
  const helper = await authenticateWindowsAuthorityHelper();
  const sessionTempDirectory = await createPrivateSessionTempDirectory(helper);
  const session = new WindowsAuthoritySession(spawnBroker(helper, sessionTempDirectory), false, helper,
    sessionTempDirectory);
  try {
    const response = session.receive(BROKER_STARTUP_TIMEOUT_MS, undefined, true);
    await session.write(JSON.stringify({
      version: WINDOWS_AUTHORITY_PROTOCOL_VERSION,
      type: 'start',
      challenge: randomBytes(16).toString('hex'),
      protocol: 'invalid-protocol',
    }));
    await response;
    throw authorityError('stdio_protocol', 16);
  } catch (error) {
    if (error instanceof WindowsAuthorityError && error.reason === 'ready_protocol') return 'ready_protocol';
    if (error instanceof WindowsAuthorityError && error.reason === 'compile_load'
      && error.scenario === WINDOWS_AUTHORITY_COMPILE_STAGES.indexOf('READY')) return 'ready_protocol';
    if (error instanceof WindowsAuthorityBootstrapError
      && error.stage === 'PROTOCOL_INIT') return 'ready_protocol';
    throw error;
  } finally {
    await session.shutdown();
  }
};

/** Native-test-only live transport faults with short local deadlines and fixed diagnostics. */
export const injectWindowsAuthorityTransportFaultForTest = async (
  kind: 'stderr' | 'slowloris' | 'timeout',
): Promise<WindowsAuthorityReason> => {
  const session = await startBroker({ countCompilation: false });
  try {
    if (kind === 'stderr') {
      await session.exchange(requestFrame('fault-stderr'));
    } else {
      const response = session.receive(50);
      if (kind === 'slowloris') await session.writeRawForTest([Buffer.from([0, 0, 0, 100, 0x7b])]);
      await response;
    }
    throw authorityError('stdio_protocol', 16);
  } catch (error) {
    if (error instanceof WindowsAuthorityError) return error.reason;
    throw error;
  } finally { await session.shutdown(); }
};

const getBroker = async (): Promise<WindowsAuthoritySession> => {
  if (brokerSession) return brokerSession;
  brokerStartup ??= startBroker().then(session => {
    brokerSession = session;
    return session;
  }).finally(() => { brokerStartup = undefined; });
  return brokerStartup;
};

const retryableInfrastructureError = (error: unknown): boolean => error instanceof WindowsAuthorityError
  && ['ready_protocol', 'stdio_protocol', 'output_bound', 'timeout', 'process_exit', 'clean_shutdown'].includes(error.reason);

const withRestartOnce = async <T>(work: (session: WindowsAuthoritySession) => Promise<T>): Promise<T> => {
  let first: unknown;
  try { return await work(await getBroker()); } catch (error) { first = error; }
  if (!retryableInfrastructureError(first)) throw first;
  if (brokerSession) brokerSession.invalidate(first as Error);
  brokerSession = undefined;
  return work(await getBroker());
};

interface QueueEntry { signal?: AbortSignal; resolve(release: () => void): void; reject(error: Error): void; abort?: () => void }
const brokerQueue: QueueEntry[] = [];
let brokerLeaseActive = false;

const rejectBrokerQueue = (error: Error): void => {
  for (const entry of brokerQueue.splice(0)) {
    if (entry.signal && entry.abort) entry.signal.removeEventListener('abort', entry.abort);
    entry.reject(error);
  }
};

const dispatchLease = (): void => {
  if (brokerLeaseActive) return;
  const entry = brokerQueue.shift();
  if (!entry) return;
  if (entry.signal?.aborted) {
    entry.reject(abortError());
    dispatchLease();
    return;
  }
  brokerLeaseActive = true;
  if (entry.signal && entry.abort) entry.signal.removeEventListener('abort', entry.abort);
  let released = false;
  entry.resolve(() => {
    if (released) return;
    released = true;
    brokerLeaseActive = false;
    dispatchLease();
  });
};

const acquireLease = (signal?: AbortSignal): Promise<() => void> => {
  throwIfAborted(signal);
  if (brokerQueue.length >= BROKER_MAX_QUEUE_ENTRIES) return Promise.reject(authorityError('output_bound', 17));
  return new Promise((resolve, reject) => {
    const entry: QueueEntry = { signal, resolve, reject };
    if (signal) {
      entry.abort = () => {
        const index = brokerQueue.indexOf(entry);
        if (index >= 0) brokerQueue.splice(index, 1);
        reject(abortError());
      };
      signal.addEventListener('abort', entry.abort, { once: true });
    }
    brokerQueue.push(entry);
    dispatchLease();
  });
};

const runBroker = async (
  operation: BrokerOperation,
  path: string,
  directory: boolean,
  signal?: AbortSignal,
): Promise<WindowsPrivatePathInspection> => {
  const release = await acquireLease(signal);
  try {
    return await withRestartOnce(async session => {
      const request = requestFrame(operation, { purpose: 'setup', path, directory });
      const value = await session.exchange(request, signal);
      const inspected = parseInspection(value, directory, false);
      if (!inspected || value.type !== 'inspection' || value.challenge !== ''
        || !exactKeys(value, RESPONSE_INSPECTION_KEYS)) {
        session.invalidate(authorityError('stdio_protocol', 16));
        throw authorityError('stdio_protocol', 16);
      }
      return inspected;
    });
  } finally { release(); }
};

export const inspectWindowsPrivatePath = (
  path: string,
  directory = false,
  signal?: AbortSignal,
): Promise<WindowsPrivatePathInspection> => runBroker('inspect', path, directory, signal);

export const ensureWindowsPrivateDirectory = (
  path: string,
  signal?: AbortSignal,
): Promise<WindowsPrivatePathInspection> => runBroker('ensure-directory', path, true, signal);

export const protectWindowsPrivateDirectory = (
  path: string,
  signal?: AbortSignal,
): Promise<WindowsPrivatePathInspection> => runBroker('protect-directory', path, true, signal);

export const protectWindowsPrivateFile = (
  path: string,
  signal?: AbortSignal,
): Promise<WindowsPrivatePathInspection> => runBroker('protect-file', path, false, signal);

const openWindowsLockedArtifactAttempt = async (
  path: string,
  expectedBytes: number,
  expectedIdentity: WindowsFileIdentity,
  expectedSha256: string | undefined,
  beforeOpenForTest?: () => Promise<void>,
  signal?: AbortSignal,
  retry = true,
): Promise<WindowsLockedArtifact> => {
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 0 || expectedBytes > BROKER_ARTIFACT_BYTES
    || !/^[a-f0-9]{16}$/.test(expectedIdentity.volumeSerial)
    || !/^[a-f0-9]{32}$/.test(expectedIdentity.fileId128)) throw authorityError('request_protocol', 1);
  const release = await acquireLease(signal);
  let session: WindowsAuthoritySession | undefined;
  let capabilityChallenge = randomBytes(16).toString('hex');
  let acquisitionBarrierRan = false;
  try {
    const activeSession = session = await getBroker();
    const barrierChallenge = beforeOpenForTest ? randomBytes(16).toString('hex') : null;
    const hold = requestFrame('hold', {
      // A zero-byte protected file is a setup capability. Every nonempty held
      // file is an artifact capability, whether its hash is being learned or
      // checked against an already authenticated digest.
      purpose: expectedBytes === 0 ? 'setup' : 'artifact',
      path,
      expectedBytes,
      expectedVolumeSerial: expectedIdentity.volumeSerial,
      expectedFileId128: expectedIdentity.fileId128,
      expectedSha256: expectedSha256 ?? null,
      challenge: capabilityChallenge,
      barrier: barrierChallenge,
    });
    let responsePromise = activeSession.receive(BROKER_TIMEOUT_MS, signal);
    await activeSession.write(hold);
    let ready = await responsePromise;
    if (barrierChallenge) {
      if (!exactKeys(ready, ['version', 'type', 'id', 'challenge'])
        || ready.version !== WINDOWS_AUTHORITY_PROTOCOL_VERSION || ready.type !== 'before-open'
        || ready.id !== hold.id || ready.challenge !== barrierChallenge) throw authorityError('ready_protocol', 12);
      try {
        await beforeOpenForTest!();
        acquisitionBarrierRan = true;
      } catch (error) {
        activeSession.invalidate(abortError());
        throw error;
      }
      const continuation = requestFrame('continue', {
        id: hold.id,
        purpose: hold.purpose,
        challenge: capabilityChallenge,
        barrier: barrierChallenge,
      });
      responsePromise = activeSession.receive(BROKER_TIMEOUT_MS, signal);
      await activeSession.write(continuation);
      ready = await responsePromise;
    }
    requestCount++;
    const failure = parseFailure(ready, hold.id);
    if (failure) throw failure;
    const initial = parseInspection(ready, false, true) as WindowsHeldVerification | undefined;
    if (!initial || ready.type !== 'held' || ready.id !== hold.id || ready.challenge !== capabilityChallenge
      || !exactKeys(ready, RESPONSE_INSPECTION_KEYS)) throw authorityError('ready_protocol', 12);

    let closed = false;
    let commandQueue = Promise.resolve();
    const sameInitial = (candidate: WindowsHeldVerification): boolean =>
      candidate.identity.volumeSerial === initial.identity.volumeSerial
      && candidate.identity.fileId128 === initial.identity.fileId128
      && candidate.links === initial.links && candidate.size === initial.size
      && candidate.reparseTag === initial.reparseTag && candidate.ownerSid === initial.ownerSid
      && candidate.aceCount === initial.aceCount
      && candidate.inheritedWriteAces === initial.inheritedWriteAces
      && candidate.broadWriteAces === initial.broadWriteAces
      && candidate.sha256 === initial.sha256 && candidate.sha1 === initial.sha1;
    const exchangeHeld = async (operation: 'read' | 'verify' | 'close', values: Partial<BrokerRequestFrame>, requestSignal?: AbortSignal) => {
      let value!: Record<string, unknown>;
      const run = commandQueue.then(async () => {
        throwIfAborted(requestSignal);
        value = await activeSession.exchange(requestFrame(operation, {
          id: hold.id,
          purpose: hold.purpose,
          challenge: capabilityChallenge,
          ...values,
        }), requestSignal);
      });
      commandQueue = run.catch(() => undefined);
      await run;
      return value;
    };
    const heldTimeout = setTimeout(() => {
      activeSession.invalidate(authorityError('timeout', 18));
      release();
    }, BROKER_SESSION_TIMEOUT_MS);
    const capability: WindowsLockedArtifact = {
      inspection: initial,
      read: async (offset, length, requestSignal) => {
        if (closed || !Number.isSafeInteger(offset) || offset < 0
          || !Number.isSafeInteger(length) || length <= 0 || length > MAX_READ_BYTES
          || offset + length > Number(initial.size)) throw authorityError('request_protocol', 1);
        const result = await exchangeHeld('read', { offset, length }, requestSignal);
        if (result.type !== 'bytes' || result.id !== hold.id || result.challenge !== capabilityChallenge
          || typeof result.bytes !== 'string'
          || !exactKeys(result, ['version', 'type', 'id', 'challenge', 'bytes'])) {
          activeSession.invalidate(authorityError('stdio_protocol', 16));
          throw authorityError('held_read', 13);
        }
        const bytes = Buffer.from(result.bytes, 'base64');
        if (bytes.length !== length || bytes.toString('base64') !== result.bytes) {
          activeSession.invalidate(authorityError('stdio_protocol', 16));
          throw authorityError('held_read', 13);
        }
        return bytes;
      },
      verify: async requestSignal => {
        if (closed) throw authorityError('final_verify', 14);
        const challenge = randomBytes(16).toString('hex');
        const result = await exchangeHeld('verify', { barrier: challenge }, requestSignal);
        const verified = parseInspection(result, false, true) as WindowsHeldVerification | undefined;
        if (!verified || result.type !== 'verified' || result.id !== hold.id || result.challenge !== challenge
          || !exactKeys(result, RESPONSE_INSPECTION_KEYS) || !sameInitial(verified)) {
          activeSession.invalidate(authorityError('stdio_protocol', 16));
          throw authorityError('final_verify', 14);
        }
        return verified;
      },
      close: async requestSignal => {
        if (closed) return;
        closed = true;
        clearTimeout(heldTimeout);
        try {
          const result = await exchangeHeld('close', {}, requestSignal);
          const final = parseInspection(result, false, true) as WindowsHeldVerification | undefined;
          if (!final || result.type !== 'closed' || result.id !== hold.id || result.challenge !== ''
            || !exactKeys(result, RESPONSE_INSPECTION_KEYS) || !sameInitial(final)) {
            throw authorityError('final_verify', 14);
          }
          lastClosedHeldId = hold.id;
        } catch (error) {
          activeSession.invalidate(error instanceof Error ? error : authorityError('clean_shutdown', 15));
          throw error;
        } finally {
          lockedArtifactProcesses.delete(capability);
          release();
        }
      },
    };
    lockedArtifactProcesses.set(capability, {
      session: activeSession,
      exited: activeSession.exited,
      challenge: capabilityChallenge,
      heldId: hold.id,
      purpose: hold.purpose,
      release,
      timeout: heldTimeout,
    });
    activeSession.exited.then(() => {
      clearTimeout(heldTimeout);
      release();
    }).catch(() => {
      clearTimeout(heldTimeout);
      release();
    });
    return capability;
  } catch (error) {
    release();
    if (signal?.aborted && session) session.invalidate(abortError());
    if (retry && !acquisitionBarrierRan && retryableInfrastructureError(error)) {
      if (brokerSession) brokerSession.invalidate(error as Error);
      brokerSession = undefined;
      return openWindowsLockedArtifactAttempt(
        path,
        expectedBytes,
        expectedIdentity,
        expectedSha256,
        beforeOpenForTest,
        signal,
        false,
      );
    }
    throw error;
  }
};

export const openWindowsLockedArtifact = (
  path: string,
  expectedBytes: number,
  beforeOpenForTest?: () => Promise<void>,
  signal?: AbortSignal,
  expectedIdentity?: WindowsFileIdentity,
  expectedSha256?: string,
): Promise<WindowsLockedArtifact> => (async () => {
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 0 || expectedBytes > BROKER_ARTIFACT_BYTES) {
    throw authorityError('request_protocol', 1);
  }
  if (expectedSha256 !== undefined && !/^[a-f0-9]{64}$/.test(expectedSha256)) throw authorityError('request_protocol', 1);
  const setup = expectedIdentity ?? (await inspectWindowsPrivatePath(path)).identity;
  return openWindowsLockedArtifactAttempt(path, expectedBytes, setup, expectedSha256, beforeOpenForTest, signal);
})();

/** Native-test-only live protocol injection against the persistent child. */
export const injectWindowsAuthorityProtocolFaultForTest = async (
  kind: 'partial-frame' | 'extra-frame' | 'wrong-purpose' | 'wrong-identity',
  path: string,
  expectedBytes: number,
): Promise<WindowsAuthorityReason | 'accepted'> => {
  const setup = await inspectWindowsPrivatePath(path);
  const release = await acquireLease();
  try {
    const session = await getBroker();
    const inspect = requestFrame('inspect', { purpose: 'setup', path, directory: false });
    if (kind === 'partial-frame') {
      const response = session.receive(BROKER_TIMEOUT_MS);
      const frame = encodeProtocolFrame(JSON.stringify(inspect));
      const split = Math.floor(frame.length / 2);
      await session.writeRawForTest([frame.subarray(0, split), frame.subarray(split)]);
      const value = await response;
      const parsed = parseInspection(value, false, false);
      if (!parsed || value.id !== inspect.id || value.type !== 'inspection') throw authorityError('stdio_protocol', 16);
      return 'accepted';
    }
    if (kind === 'extra-frame') {
      const response = session.receive(BROKER_TIMEOUT_MS);
      const extra = requestFrame('inspect', {
        purpose: 'setup',
        path,
        directory: false,
      });
      await session.writeRawForTest([Buffer.concat([
        encodeProtocolFrame(JSON.stringify(inspect)),
        encodeProtocolFrame(JSON.stringify(extra)),
      ])]);
      await response;
      await session.exited;
      return 'stdio_protocol';
    }
    const request = kind === 'wrong-purpose'
      ? requestFrame('inspect', { purpose: 'artifact', path, directory: false })
      : requestFrame('hold', {
        purpose: 'setup',
        path,
        expectedBytes,
        expectedVolumeSerial: setup.identity.volumeSerial === '0000000000000000'
          ? 'ffffffffffffffff'
          : '0000000000000000',
        expectedFileId128: setup.identity.fileId128,
        expectedSha256: null,
        challenge: randomBytes(16).toString('hex'),
      });
    try {
      await session.exchange(request);
      throw authorityError('stdio_protocol', 16);
    } catch (error) {
      if (error instanceof WindowsAuthorityError) return error.reason;
      throw error;
    }
  } finally { release(); }
};

/** Native-test-only held-session ID/purpose confusion injection. */
export const injectWindowsAuthorityHeldFaultForTest = async (
  held: WindowsLockedArtifact,
  kind: 'wrong-id' | 'wrong-purpose' | 'stale-id',
): Promise<WindowsAuthorityReason> => {
  const process = lockedArtifactProcesses.get(held);
  if (!process) throw authorityError('request_protocol', 1);
  const frame = requestFrame('read', {
    id: kind === 'wrong-id' ? randomBytes(16).toString('hex')
      : kind === 'stale-id' ? (lastClosedHeldId ?? randomBytes(16).toString('hex')) : process.heldId,
    purpose: kind === 'wrong-purpose' ? (process.purpose === 'setup' ? 'artifact' : 'setup') : process.purpose,
    challenge: process.challenge,
    offset: 0,
    length: 1,
  });
  try {
    await process.session.exchange(frame);
    throw authorityError('stdio_protocol', 16);
  } catch (error) {
    if (!(error instanceof WindowsAuthorityError)) throw error;
    process.session.invalidate(error);
    await process.exited;
    clearTimeout(process.timeout);
    process.release();
    lockedArtifactProcesses.delete(held);
    return error.reason;
  }
};

/** Native-test-only crash injection used to prove that OS termination releases the exact target handle. */
export const crashWindowsLockedArtifactForTest = async (held: WindowsLockedArtifact): Promise<void> => {
  const process = lockedArtifactProcesses.get(held);
  if (!process) throw authorityError('request_protocol', 1);
  clearTimeout(process.timeout);
  process.session.invalidate(authorityError('process_exit', 19));
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      process.exited,
      new Promise<void>((_resolve, reject) => {
        timer = setTimeout(() => reject(authorityError('process_exit', 19)), BROKER_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
  process.release();
  lockedArtifactProcesses.delete(held);
};

export const windowsAuthorityBrokerStatsForTest = (): Readonly<{
  compileCount: number;
  requestCount: number;
  restartCount: number;
  activeProcessCount: number;
  activeAuthenticatedHandleSets: number;
  activeSessionTempDirectory: string | null;
  lastRemovedSessionTempDirectory: string | null;
  queuedEntries: number;
}> => Object.freeze({
  compileCount,
  requestCount,
  restartCount,
  activeProcessCount,
  activeAuthenticatedHandleSets,
  activeSessionTempDirectory: activeSessionTempDirectories.values().next().value ?? null,
  lastRemovedSessionTempDirectory: lastRemovedSessionTempDirectory ?? null,
  queuedEntries: brokerQueue.length,
});

/** Test-only framing probe; it shares the production incremental binary decoder. */
export const decodeWindowsAuthorityFramesForTest = (
  chunks: readonly Buffer[],
  expectedFrames = 1,
): readonly Readonly<Record<string, unknown>>[] => {
  let buffered: Buffer = Buffer.alloc(0);
  const frames: Record<string, unknown>[] = [];
  for (const chunk of chunks) {
    const decoded = decodeProtocolChunk(buffered, chunk);
    buffered = decoded.buffered;
    for (const frame of decoded.frames) {
      let value: unknown;
      try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(frame)); }
      catch { throw authorityError('stdio_protocol', 16); }
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw authorityError('stdio_protocol', 16);
      }
      frames.push(value as Record<string, unknown>);
    }
  }
  if (buffered.length !== 0 || frames.length !== expectedFrames) throw authorityError('stdio_protocol', 16);
  return frames;
};

export const encodeWindowsAuthorityFrameForTest = (value: string): Buffer => encodeProtocolFrame(value);

export const parseWindowsAuthorityStartupFailureForTest = (frame: unknown): Error =>
  parseFailure(frame) ?? authorityError('stdio_protocol', 16);

export const shutdownWindowsAuthorityBrokerForTest = async (): Promise<void> => {
  const session = brokerSession ?? await brokerStartup?.catch(() => undefined);
  brokerSession = undefined;
  if (session) await session.shutdown();
};

process.once('exit', () => {
  for (const child of brokerChildren) if (!child.killed) child.kill();
  for (const directory of activeSessionTempDirectories) {
    try { rmSync(directory, { recursive: true, force: true }); } catch { /* process teardown is already bounded */ }
  }
});

export const smokeWindowsUpdateAuthority = async (path: string): Promise<readonly string[]> => {
  const setup = await inspectWindowsPrivatePath(path);
  const exactBytes = Number(setup.size);
  if (!Number.isSafeInteger(exactBytes) || exactBytes <= 0) throw authorityError('type_link_size', 5);
  const held = await openWindowsLockedArtifact(path, exactBytes, undefined, undefined, setup.identity);
  try {
    if (!/^[a-f0-9]{16}$/.test(held.inspection.identity.volumeSerial)
      || !/^[a-f0-9]{32}$/.test(held.inspection.identity.fileId128)
      || !/^[a-f0-9]{64}$/.test(held.inspection.sha256)
      || !/^[a-f0-9]{40}$/.test(held.inspection.sha1)
      || held.inspection.daclProtected !== true
      || held.inspection.reparseTag !== '00000000') throw authorityError('ready_protocol', 12);
    await held.read(0, Math.min(1, Number(held.inspection.size)));
    const verified = await held.verify();
    if (verified.identity.fileId128 !== held.inspection.identity.fileId128
      || verified.sha256 !== held.inspection.sha256 || verified.sha1 !== held.inspection.sha1) {
      throw authorityError('final_verify', 14);
    }
  } finally {
    await held.close();
  }
  return Object.freeze([
    'compile-load',
    'owner-sid',
    'dacl-protection',
    'file-id-info',
    'same-handle-sha256-sha1',
    'reparse-query',
    'no-share-lock',
    'ready-protocol',
    'held-read',
    'clean-shutdown',
  ]);
};
