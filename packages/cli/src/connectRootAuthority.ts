import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fsyncSync,
  fstatSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readSync,
  realpathSync,
  rmSync,
  writeSync,
} from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { dirname, join, parse } from "node:path";
import { fileURLToPath } from "node:url";

const NATIVE_INSPECTION_MAX_BYTES = 128 * 1024;
const WINDOWS_SID = /^S-\d(?:-\d+)+$/;
const WINDOWS_TRUSTED_MUTATORS = new Set([
  "S-1-5-18", // NT AUTHORITY\\SYSTEM
  "S-1-5-32-544", // BUILTIN\\Administrators
]);

// FileSystemRights values which can alter an entry, its children, or its ACL.
const WINDOWS_MUTATING_RIGHTS = BigInt(
  0x00000002 // WriteData / CreateFiles
  | 0x00000004 // AppendData / CreateDirectories
  | 0x00000010 // WriteExtendedAttributes
  | 0x00000040 // DeleteSubdirectoriesAndFiles
  | 0x00000100 // WriteAttributes
  | 0x00010000 // Delete
  | 0x00040000 // ChangePermissions
  | 0x00080000 // TakeOwnership
);
const WINDOWS_GENERIC_MUTATING_RIGHTS = 0x50000000n; // GENERIC_WRITE | GENERIC_ALL
const WINDOWS_KNOWN_ALLOW_RIGHTS = 0xf01f01ffn;

export type ConnectAuthorityEntryKind = "ancestor" | "home" | "root" | "data" | "env";

export interface WindowsAclRuleInspection {
  readonly identitySid: string;
  readonly inherited: boolean;
  readonly accessType: "allow" | "deny";
  readonly appliesToSelf: boolean;
  /** Canonical base-10 representation of the unsigned 32-bit access mask. */
  readonly rights: string;
}

export interface WindowsAuthorityInspection {
  readonly index: number;
  readonly kind: "directory" | "file";
  readonly authorityKind: ConnectAuthorityEntryKind;
  readonly currentUserSid: string;
  readonly ownerSid: string;
  readonly daclProtected: boolean;
  readonly reparsePoint: boolean;
  readonly volumeSerialNumber: string;
  /** Full unsigned 128-bit FILE_ID_128 as a canonical decimal string. */
  readonly fileId: string;
  /** A second read from the same held handle after ACL inspection. */
  readonly verifiedVolumeSerialNumber: string;
  readonly verifiedFileId: string;
  readonly rules: readonly WindowsAclRuleInspection[];
}

export interface DarwinAuthorityInspection {
  readonly version: 1;
  readonly device: string;
  readonly file: string;
  readonly acl: string;
}

export interface StableAuthorityIdentity {
  readonly device: string;
  readonly file: string;
}

export type WindowsAuthorityPolicyReason =
  | "OWNER_MISMATCH"
  | "DACL_NOT_PROTECTED"
  | "REPARSE_POINT"
  | "UNKNOWN_RIGHTS"
  | "BROAD_WRITE"
  | "INHERITED_WRITE";

/** Redacted native diagnostic: an entry ordinal and fixed policy reason only. */
export class WindowsAuthorityPolicyError extends Error {
  constructor(
    readonly entryIndex: number,
    readonly policyReason: WindowsAuthorityPolicyReason,
  ) {
    super(`Windows native authority rejected entry ${entryIndex}: ${policyReason}`);
    this.name = "WindowsAuthorityPolicyError";
  }
}

export interface ConnectRootAuthorityInspector {
  inspectDarwinAcl(
    path: string,
    pinnedFd: number,
    expectedIdentity: StableAuthorityIdentity,
  ): DarwinAuthorityInspection;
  inspectWindowsAcl(
    path: string,
    expectedIdentity: StableAuthorityIdentity,
    pinnedFd?: number,
    kind?: ConnectAuthorityEntryKind,
  ): Promise<WindowsAuthorityInspection>;
  inspectWindowsAcls?(entries: readonly WindowsAuthorityTarget[]): Promise<readonly WindowsAuthorityInspection[]>;
}

export interface WindowsAuthorityTarget {
  readonly path: string;
  readonly kind: ConnectAuthorityEntryKind;
  readonly expectedIdentity: StableAuthorityIdentity;
  readonly pinnedFd: number;
}

export function stableAuthorityIdentity(fd: number): StableAuthorityIdentity {
  const stat = fstatSync(fd, { bigint: true });
  return { device: stat.dev.toString(10), file: stat.ino.toString(10) };
}

function decodeBoundedUtf8(value: Buffer | string | null | undefined): string {
  const bytes = typeof value === "string" ? Buffer.from(value, "utf8") : (value ?? Buffer.alloc(0));
  if (bytes.byteLength > NATIVE_INSPECTION_MAX_BYTES) throw new Error("native authority inspection exceeded its limit");
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

const DARWIN_AUTHORITY_BROKER_SHA256: Readonly<Record<string, string>> = {
  arm64: "75fda2624bf093555e726b968401321fef61ea7ae0479f4c1892be0dfc6554c0",
  x64: "e5a49be0db85655b9ff1d0614de9d61defd41a0a1b2eff8f11571407f10d809b",
};

const WINDOWS_AUTHORITY_BROKER_SHA256: Readonly<Record<string, string>> = {
  x64: "2ba903761156ef39235347998201710335ebe4fc97e51420ed1d117d384ce1d7",
};

const WINDOWS_CAPABILITY_STARTUP_TIMEOUT_MS = 10_000;
const WINDOWS_BROKER_BATCH_TIMEOUT_MS = 5_000;
const WINDOWS_CAPABILITY_EXCHANGE_TIMEOUT_MS = 2_500;
const WINDOWS_CAPABILITY_STOP_TIMEOUT_MS = 2_500;
const WINDOWS_BROKER_REQUEST_MAX_BYTES = 4 * 1024;
const WINDOWS_CAPABILITY_RESPONSE_MAX_BYTES = 4 * 1024;
const WINDOWS_CAPABILITY_MAX_MESSAGES = 256;

export const WINDOWS_SUPERVISOR_STAGE_VALUES = [
  "PATH_NAME", "CHANNEL_CREATE", "TEMP_WORKSPACE_CREATE", "TEMP_WORKSPACE_DACL_APPLY",
  "TEMP_WORKSPACE_DACL_VERIFY", "SOURCE_READ", "SOURCE_UTF8", "SCRIPT_PARSE",
  "REFERENCE_LOAD", "TYPE_COMPILE", "ENTRYPOINT_RESOLUTION", "TEMP_WORKSPACE_CLEANUP",
  "PROTOCOL_INIT", "JOB_CREATE", "JOB_ASSIGN", "PARENT_OPEN", "PROCESS_DACL",
  "IMAGE_OPEN", "IMAGE_HASH", "IMAGE_IDENTITY", "OWNER_DACL", "REPARSE", "LOCK",
  "READY_FRAME", "PRE_CHALLENGE", "BATCH_LAUNCH", "FD_DUPLICATE", "BATCH_RESPONSE",
  "POST_CHALLENGE", "SHUTDOWN",
] as const;
export type WindowsSupervisorStage = typeof WINDOWS_SUPERVISOR_STAGE_VALUES[number];
const WINDOWS_SUPERVISOR_STAGES = new Set<WindowsSupervisorStage>(WINDOWS_SUPERVISOR_STAGE_VALUES);
const WINDOWS_PRE_PROTOCOL_STAGES = new Set<WindowsSupervisorStage>([
  "TEMP_WORKSPACE_CREATE", "TEMP_WORKSPACE_DACL_APPLY", "TEMP_WORKSPACE_DACL_VERIFY",
  "SOURCE_READ", "SOURCE_UTF8", "SCRIPT_PARSE", "REFERENCE_LOAD", "TYPE_COMPILE",
  "ENTRYPOINT_RESOLUTION", "TEMP_WORKSPACE_CLEANUP", "PROTOCOL_INIT",
]);

// The long-lived supervisor receives its private path, expected digest, and
// parent identity only through anonymous inherited stdio. Possession of those
// two unadvertised handles is the control capability; there is deliberately no
// environment/argv secret and no reconnectable IPC name.
const WINDOWS_SUPERVISOR_SCRIPT = String.raw`
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
$inputStream=[Console]::OpenStandardInput();$outputStream=[Console]::OpenStandardOutput()
$parent=[IntPtr]::Zero;$job=[IntPtr]::Zero;$file=$null;$dir=$null;$heldIdentity=$null;$expected=$null;$sequence=0;$ready=$false;$requestId=('0'*32)
function ExactKeys($value,[string[]]$keys) {
  if($null -eq $value){return $false};$names=@($value.PSObject.Properties.Name)
  if($names.Count -ne $keys.Count){return $false};foreach($key in $keys){if($names -cnotcontains $key){return $false}};return $true
}
function ReadExact($stream,[int]$count,[int]$timeout,[IntPtr]$parentHandle) {
  $bytes=New-Object byte[] $count;$offset=0;$watch=[Diagnostics.Stopwatch]::StartNew()
  while($offset -lt $count){
    $pending=$stream.BeginRead($bytes,$offset,$count-$offset,$null,$null)
    try {
      while(!$pending.AsyncWaitHandle.WaitOne(50)){
        if($watch.ElapsedMilliseconds -ge $timeout){throw 'timeout'}
        if($parentHandle -ne [IntPtr]::Zero -and [ProprSupervisorNative]::WaitForSingleObject($parentHandle,0) -ne 258){throw 'parent'}
      }
      $read=$stream.EndRead($pending);if($read -le 0){throw 'eof'};$offset+=$read
    } finally {try{$pending.AsyncWaitHandle.Close()}catch{}}
  };return $bytes
}
function ReadFrame($stream,[IntPtr]$parentHandle) {
  $header=ReadExact $stream 4 300000 $parentHandle;$length=[BitConverter]::ToUInt32($header,0)
  if($length -lt 2 -or $length -gt 4096){throw 'frame'}
  $body=ReadExact $stream ([int]$length) 2500 $parentHandle
  return ([Text.UTF8Encoding]::new($false,$true)).GetString($body)
}
function WriteFrame($stream,$value) {
  $body=[Text.Encoding]::UTF8.GetBytes(($value|ConvertTo-Json -Compress -Depth 4))
  if($body.Length -lt 2 -or $body.Length -gt 4096){throw 'frame'}
  $header=[BitConverter]::GetBytes([uint32]$body.Length);$stream.Write($header,0,4);$stream.Write($body,0,$body.Length);$stream.Flush()
}
function Identity($handle) {
  $value=New-Object ProprSupervisorNative+FileIdInfo
  if(![ProprSupervisorNative]::GetFileInformationByHandleEx($handle,18,[ref]$value,24)){throw 'identity'}
  $number=([Numerics.BigInteger]$value.FileIdHigh*[Numerics.BigInteger]::Pow(2,64))+[Numerics.BigInteger]$value.FileIdLow
  return @($value.Volume.ToString([Globalization.CultureInfo]::InvariantCulture),$number.ToString([Globalization.CultureInfo]::InvariantCulture))
}
function RequireOrdinary($handle) {
  $value=New-Object ProprSupervisorNative+FileAttributeTagInfo
  if(![ProprSupervisorNative]::GetFileAttributesByHandle($handle,9,[ref]$value,8) -or ($value.FileAttributes -band 0x400) -ne 0){throw 'reparse'}
}
function Rule($sid,$directory) {
  $inherit=if($directory){[Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'}else{[Security.AccessControl.InheritanceFlags]::None}
  return [Security.AccessControl.FileSystemAccessRule]::new($sid,[Security.AccessControl.FileSystemRights]::FullControl,$inherit,[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow)
}
function Protect($path,$directory,$owner) {
  $security=if($directory){[Security.AccessControl.DirectorySecurity]::new()}else{[Security.AccessControl.FileSecurity]::new()}
  $security.SetOwner($owner);$security.SetAccessRuleProtection($true,$false)
  foreach($text in @($owner.Value,'S-1-5-18','S-1-5-32-544')){[void]$security.AddAccessRule((Rule ([Security.Principal.SecurityIdentifier]::new($text)) $directory))}
  if($directory){[IO.Directory]::SetAccessControl($path,$security)}else{[IO.File]::SetAccessControl($path,$security)}
}
function Verify($path,$directory,$owner) {
  $security=if($directory){[IO.Directory]::GetAccessControl($path)}else{[IO.File]::GetAccessControl($path)}
  if(!$security.AreAccessRulesProtected -or $security.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $owner.Value){throw 'acl'}
  $rules=@($security.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]));if($rules.Count -ne 3){throw 'acl'}
  $expectedSids=@($owner.Value,'S-1-5-18','S-1-5-32-544')
  foreach($rule in $rules){
    if($rule.IsInherited -or $rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or [int64]$rule.FileSystemRights -ne 2032127 -or
       $rule.PropagationFlags -ne [Security.AccessControl.PropagationFlags]::None -or $expectedSids -notcontains $rule.IdentityReference.Value){throw 'acl'}
    $flags=[int]$rule.InheritanceFlags;if(($directory -and $flags -ne 3) -or (!$directory -and $flags -ne 0)){throw 'acl'}
  }
}
function HeldResponse($kind,$id,$sequence,$identity,$digest) {
  return [ordered]@{version=1;kind=$kind;requestId=$id;supervisorPid=$PID.ToString([Globalization.CultureInfo]::InvariantCulture);sequence=$sequence;
    volumeSerialNumber=$identity[0];fileId=$identity[1];sha256=$digest}
}
try {
  EnterStage 'REFERENCE_LOAD'
  foreach($requiredType in @([Runtime.InteropServices.Marshal],[Microsoft.Win32.SafeHandles.SafeFileHandle],[Security.AccessControl.DirectorySecurity])){if($null -eq $requiredType){throw 'reference'}}
  EnterStage 'TYPE_COMPILE'
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class ProprSupervisorNative {
  [StructLayout(LayoutKind.Sequential)] public struct FileIdInfo { public UInt64 Volume; public UInt64 FileIdLow; public UInt64 FileIdHigh; }
  [StructLayout(LayoutKind.Sequential)] public struct FileAttributeTagInfo { public UInt32 FileAttributes; public UInt32 ReparseTag; }
  [StructLayout(LayoutKind.Sequential)] public struct BasicLimits { public Int64 PerProcess; public Int64 PerJob; public UInt32 Flags; public UIntPtr MinWorking; public UIntPtr MaxWorking; public UInt32 Active; public UIntPtr Affinity; public UInt32 Priority; public UInt32 Scheduling; }
  [StructLayout(LayoutKind.Sequential)] public struct IoCounters { public UInt64 ReadOps; public UInt64 WriteOps; public UInt64 OtherOps; public UInt64 ReadBytes; public UInt64 WriteBytes; public UInt64 OtherBytes; }
  [StructLayout(LayoutKind.Sequential)] public struct ExtendedLimits { public BasicLimits Basic; public IoCounters Io; public UIntPtr ProcessMemory; public UIntPtr JobMemory; public UIntPtr PeakProcess; public UIntPtr PeakJob; }
  [DllImport("kernel32.dll",SetLastError=true)] public static extern bool GetFileInformationByHandleEx(SafeFileHandle handle,int infoClass,out FileIdInfo info,uint size);
  [DllImport("kernel32.dll",EntryPoint="GetFileInformationByHandleEx",SetLastError=true)] public static extern bool GetFileAttributesByHandle(SafeFileHandle handle,int infoClass,out FileAttributeTagInfo info,uint size);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] public static extern SafeFileHandle CreateFile(string name,uint access,uint share,IntPtr security,uint creation,uint flags,IntPtr template);
  [DllImport("msvcrt.dll",CallingConvention=CallingConvention.Cdecl)] public static extern IntPtr _get_osfhandle(int fd);
  [DllImport("msvcrt.dll",CallingConvention=CallingConvention.Cdecl)] public static extern int _close(int fd);
  [DllImport("kernel32.dll",SetLastError=true)] public static extern IntPtr OpenProcess(uint access,bool inherit,uint processId);
  [DllImport("kernel32.dll",SetLastError=true)] public static extern uint WaitForSingleObject(IntPtr handle,uint milliseconds);
  [DllImport("kernel32.dll",SetLastError=true)] public static extern IntPtr CreateJobObject(IntPtr security,string name);
  [DllImport("kernel32.dll",SetLastError=true)] public static extern bool SetInformationJobObject(IntPtr job,int infoClass,ref ExtendedLimits limits,uint size);
  [DllImport("kernel32.dll",SetLastError=true)] public static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
  [DllImport("kernel32.dll")] public static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll",SetLastError=true)] public static extern bool CloseHandle(IntPtr handle);
  [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool ConvertStringSecurityDescriptorToSecurityDescriptor(string text,uint revision,out IntPtr descriptor,out uint size);
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool GetSecurityDescriptorDacl(IntPtr descriptor,out bool present,out IntPtr dacl,out bool defaulted);
  [DllImport("advapi32.dll",SetLastError=true)] static extern uint SetSecurityInfo(IntPtr handle,int objectType,uint information,IntPtr owner,IntPtr group,IntPtr dacl,IntPtr sacl);
  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr memory);
  public static bool HardenCurrentProcess(string currentSid) {
    IntPtr descriptor = IntPtr.Zero;
    try {
      uint size; bool present; bool defaulted; IntPtr dacl;
      string sddl = "D:P(A;;0x00100001;;;" + currentSid + ")(A;;GA;;;SY)(A;;GA;;;BA)";
      if (!ConvertStringSecurityDescriptorToSecurityDescriptor(sddl,1,out descriptor,out size) ||
          !GetSecurityDescriptorDacl(descriptor,out present,out dacl,out defaulted) || !present) return false;
      return SetSecurityInfo(GetCurrentProcess(),6,0x80000004,IntPtr.Zero,IntPtr.Zero,dacl,IntPtr.Zero) == 0;
    } finally { if (descriptor != IntPtr.Zero) LocalFree(descriptor); }
  }
}
'@
  EnterStage 'ENTRYPOINT_RESOLUTION';if($null -eq ('ProprSupervisorNative' -as [type])){throw 'entrypoint'}
  CloseCompilerWorkspace
  EnterStage 'PROTOCOL_INIT';$initText=ReadFrame $inputStream ([IntPtr]::Zero);$init=$initText|ConvertFrom-Json
  if($init.requestId -is [string] -and $init.requestId -cmatch '^[0-9a-f]{32}$'){$requestId=$init.requestId}
  $testInit=ExactKeys $init @('version','kind','requestId','path','sha256','parentPid','testFailureStage')
  if($testInit){$global:ProprTestFailureStage=$init.testFailureStage;if(@('PATH_NAME','CHANNEL_CREATE','TEMP_WORKSPACE_CREATE','TEMP_WORKSPACE_DACL_APPLY','TEMP_WORKSPACE_DACL_VERIFY','SOURCE_READ','SOURCE_UTF8','SCRIPT_PARSE','REFERENCE_LOAD','TYPE_COMPILE','ENTRYPOINT_RESOLUTION','TEMP_WORKSPACE_CLEANUP','PROTOCOL_INIT','JOB_CREATE','JOB_ASSIGN','PARENT_OPEN','PROCESS_DACL','IMAGE_OPEN','IMAGE_HASH','IMAGE_IDENTITY','OWNER_DACL','REPARSE','LOCK','READY_FRAME','PRE_CHALLENGE','BATCH_LAUNCH','FD_DUPLICATE','BATCH_RESPONSE','POST_CHALLENGE','SHUTDOWN') -cnotcontains $global:ProprTestFailureStage){throw 'test-stage'}}
  if((!$testInit -and !(ExactKeys $init @('version','kind','requestId','path','sha256','parentPid'))) -or $init.version -ne 1 -or $init.kind -cne 'init' -or
     $init.requestId -cnotmatch '^[0-9a-f]{32}$' -or $init.path -isnot [string] -or $init.path.Length -lt 1 -or $init.path.Length -gt 1024 -or
     $init.path.IndexOf([char]0) -ge 0 -or $init.sha256 -cnotmatch '^[0-9a-f]{64}$' -or $init.parentPid -cnotmatch '^[1-9][0-9]{0,9}$'){throw 'init'}
  $requestId=$init.requestId;$path=$init.path;$expected=$init.sha256;EnterStage 'PATH_NAME';$directory=[IO.Path]::GetDirectoryName($path);if([string]::IsNullOrEmpty($directory)){throw 'path'}
  EnterStage 'IMAGE_OPEN';$raw=[ProprSupervisorNative]::_get_osfhandle(3);if($raw -eq [IntPtr](-1)){throw 'image'}
  $inherited=[Microsoft.Win32.SafeHandles.SafeFileHandle]::new($raw,$false)
  EnterStage 'REPARSE';RequireOrdinary $inherited;EnterStage 'IMAGE_IDENTITY';$inheritedIdentity=Identity $inherited
  EnterStage 'REPARSE';$dir=[ProprSupervisorNative]::CreateFile($directory,0x00020000,1,[IntPtr]::Zero,3,0x02200000,[IntPtr]::Zero);if($dir.IsInvalid){throw 'directory'};RequireOrdinary $dir
  EnterStage 'LOCK';$file=[IO.FileStream]::new($path,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read,4096,[IO.FileOptions]::SequentialScan)
  EnterStage 'REPARSE';RequireOrdinary $file.SafeFileHandle
  EnterStage 'IMAGE_IDENTITY';$heldIdentity=Identity $file.SafeFileHandle;if($heldIdentity[0] -ne $inheritedIdentity[0] -or $heldIdentity[1] -ne $inheritedIdentity[1]){throw 'identity'}
  EnterStage 'FD_DUPLICATE';if([ProprSupervisorNative]::_close(3) -ne 0){throw 'duplicate'};$inherited.Dispose()
  EnterStage 'IMAGE_HASH';$sha=[Security.Cryptography.SHA256]::Create();$actual=([BitConverter]::ToString($sha.ComputeHash($file))).Replace('-','').ToLowerInvariant();$file.Position=0;if($actual -cne $expected){throw 'hash'}
  EnterStage 'OWNER_DACL';$owner=[Security.Principal.WindowsIdentity]::GetCurrent().User;Protect $directory $true $owner;Protect $path $false $owner;Verify $directory $true $owner;Verify $path $false $owner
  EnterStage 'JOB_CREATE';$job=[ProprSupervisorNative]::CreateJobObject([IntPtr]::Zero,$null);if($job -eq [IntPtr]::Zero){throw 'job'}
  $basic=New-Object ProprSupervisorNative+BasicLimits;$basic.Flags=0x2000
  $limits=New-Object ProprSupervisorNative+ExtendedLimits;$limits.Basic=$basic
  EnterStage 'JOB_ASSIGN'
  if(![ProprSupervisorNative]::SetInformationJobObject($job,9,[ref]$limits,[Runtime.InteropServices.Marshal]::SizeOf($limits)) -or
     ![ProprSupervisorNative]::AssignProcessToJobObject($job,[ProprSupervisorNative]::GetCurrentProcess())){throw 'job'}
  EnterStage 'PARENT_OPEN';$parent=[ProprSupervisorNative]::OpenProcess(0x00100000,$false,[uint32]$init.parentPid);if($parent -eq [IntPtr]::Zero){throw 'parent'}
  EnterStage 'PROCESS_DACL';if(![ProprSupervisorNative]::HardenCurrentProcess($owner.Value)){throw 'process-dacl'}
  EnterStage 'READY_FRAME';$sequence=1;WriteFrame $outputStream (HeldResponse 'ready' $requestId $sequence $heldIdentity $expected);$ready=$true
  $seen=[Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal);[void]$seen.Add($requestId);$stopping=$false;$messages=0
  while(!$stopping -and $messages -lt ${WINDOWS_CAPABILITY_MAX_MESSAGES} -and [ProprSupervisorNative]::WaitForSingleObject($parent,0) -eq 258){
    EnterStage 'PRE_CHALLENGE';$requestText=ReadFrame $inputStream $parent;$request=$requestText|ConvertFrom-Json
    if(!(ExactKeys $request @('version','kind','requestId')) -or $request.version -ne 1 -or ($request.kind -cne 'challenge' -and $request.kind -cne 'stop') -or
       $request.requestId -cnotmatch '^[0-9a-f]{32}$' -or !$seen.Add([string]$request.requestId)){throw 'protocol'}
    $requestId=$request.requestId;$messages++;EnterStage 'IMAGE_IDENTITY';$held=Identity $file.SafeFileHandle;$file.Position=0;EnterStage 'IMAGE_HASH';$heldHash=([BitConverter]::ToString($sha.ComputeHash($file))).Replace('-','').ToLowerInvariant()
    EnterStage 'OWNER_DACL';Verify $directory $true $owner;Verify $path $false $owner
    if($held[0] -ne $heldIdentity[0] -or $held[1] -ne $heldIdentity[1] -or $heldHash -cne $expected){throw 'replacement'}
    EnterStage $(if($request.kind -ceq 'stop'){'SHUTDOWN'}else{'POST_CHALLENGE'});$sequence++;$responseKind=if($request.kind -ceq 'stop'){'stopped'}else{'ready'}
    WriteFrame $outputStream (HeldResponse $responseKind $requestId $sequence $heldIdentity $expected)
    if($request.kind -ceq 'stop'){$stopping=$true}
  }
  if(!$stopping){throw 'shutdown'}
  EnterStage 'SHUTDOWN';$held=Identity $file.SafeFileHandle;$file.Position=0;$heldHash=([BitConverter]::ToString($sha.ComputeHash($file))).Replace('-','').ToLowerInvariant()
  if($held[0] -ne $heldIdentity[0] -or $held[1] -ne $heldIdentity[1] -or $heldHash -cne $expected){throw 'replacement'}
  $file.Dispose();$dir.Dispose();[void][ProprSupervisorNative]::CloseHandle($parent);exit 0
} catch {
  try {
    if($ready -and $null -ne $heldIdentity -and $null -ne $expected){
      WriteFrame $outputStream ([ordered]@{version=1;kind='capability-error';requestId=$requestId;supervisorPid=$PID.ToString([Globalization.CultureInfo]::InvariantCulture);sequence=$sequence;
        volumeSerialNumber=$heldIdentity[0];fileId=$heldIdentity[1];sha256=$expected;stage=$global:ProprStage})
    } else {WriteFrame $outputStream ([ordered]@{version=1;kind='startup-error';requestId=$requestId;stage=$global:ProprStage})}
  } catch {}
  try{if($file){$file.Dispose()}}catch{};try{if($dir){$dir.Dispose()}}catch{};try{if($parent -ne [IntPtr]::Zero){[void][ProprSupervisorNative]::CloseHandle($parent)}}catch{};exit 23
}
`;
const WINDOWS_SUPERVISOR_SOURCE_MAX_BYTES = 64 * 1024;
const WINDOWS_SUPERVISOR_LOADER = String.raw`
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';$global:ProprStage='TEMP_WORKSPACE_CREATE';$global:ProprTestFailureStage=$null;$compilerWorkspace=$null;$workspaceVerified=$false;$workspaceRemoved=$false
function EnterStage([string]$value){$global:ProprStage=$value;if($global:ProprTestFailureStage -ceq $value){throw 'injected-stage-failure'}}
function WriteStartupFailure(){try{$body=[Text.Encoding]::UTF8.GetBytes(('{"version":1,"kind":"startup-error","requestId":"00000000000000000000000000000000","stage":"'+$global:ProprStage+'"}'));if($body.Length -gt 256){return};$out=[Console]::OpenStandardOutput();$header=[BitConverter]::GetBytes([uint32]$body.Length);$out.Write($header,0,4);$out.Write($body,0,$body.Length);$out.Flush()}catch{}}
function WorkspaceRule($sid){return [Security.AccessControl.FileSystemAccessRule]::new($sid,[Security.AccessControl.FileSystemRights]::FullControl,[Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit',[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow)}
function RequireWorkspaceOrdinary([string]$path){$attributes=[IO.File]::GetAttributes($path);if(($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or ($attributes -band [IO.FileAttributes]::Directory) -eq 0){throw 'workspace'}}
function VerifyWorkspace([string]$path,$owner){RequireWorkspaceOrdinary $path;$security=[IO.Directory]::GetAccessControl($path);if(!$security.AreAccessRulesProtected -or $security.GetOwner([Security.Principal.SecurityIdentifier]).Value -cne $owner.Value){throw 'workspace-acl'};$rules=@($security.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]));if($rules.Count -ne 3){throw 'workspace-acl'};$expected=@($owner.Value,'S-1-5-18','S-1-5-32-544');foreach($rule in $rules){if($rule.IsInherited -or $rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or [int64]$rule.FileSystemRights -ne 2032127 -or [int]$rule.InheritanceFlags -ne 3 -or $rule.PropagationFlags -ne [Security.AccessControl.PropagationFlags]::None -or $expected -cnotcontains $rule.IdentityReference.Value){throw 'workspace-acl'}}}
function CloseCompilerWorkspace(){if($script:workspaceRemoved -or $null -eq $script:compilerWorkspace){return};EnterStage 'TEMP_WORKSPACE_CLEANUP';if(!$script:workspaceVerified){throw 'workspace-unverified'};[GC]::Collect();[GC]::WaitForPendingFinalizers();RequireWorkspaceOrdinary $script:compilerWorkspace;[IO.Directory]::Delete($script:compilerWorkspace,$true);$script:workspaceRemoved=$true}
function FinalCompilerWorkspaceCleanup(){if($script:workspaceRemoved -or $null -eq $script:compilerWorkspace -or ![IO.Directory]::Exists($script:compilerWorkspace)){return};$attributes=[IO.File]::GetAttributes($script:compilerWorkspace);if(($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or !$script:workspaceVerified){[IO.Directory]::Delete($script:compilerWorkspace,$false)}else{[IO.Directory]::Delete($script:compilerWorkspace,$true)};$script:workspaceRemoved=$true}
function ReadExact($stream,[int]$count,$watch){$bytes=New-Object byte[] $count;$offset=0;while($offset -lt $count){$pending=$stream.BeginRead($bytes,$offset,$count-$offset,$null,$null);try{while(!$pending.AsyncWaitHandle.WaitOne(25)){if($watch.ElapsedMilliseconds -ge 10000){throw 'deadline'}};$read=$stream.EndRead($pending);if($read -le 0){throw 'eof'};$offset+=$read}finally{try{$pending.AsyncWaitHandle.Close()}catch{}}};return $bytes}
try{
  EnterStage 'TEMP_WORKSPACE_CREATE';$systemRoot=[IO.Path]::GetFullPath($env:SystemRoot);$tempRoot=[IO.Path]::GetFullPath([IO.Path]::Combine($systemRoot,'Temp'));if($tempRoot -cne [IO.Path]::Combine($systemRoot,'Temp') -or ![IO.Directory]::Exists($tempRoot)){throw 'temp-root'};RequireWorkspaceOrdinary $tempRoot
  $random=New-Object byte[] 32;$rng=[Security.Cryptography.RandomNumberGenerator]::Create();try{$rng.GetBytes($random)}finally{$rng.Dispose()};$name='propr-supervisor-'+$PID.ToString([Globalization.CultureInfo]::InvariantCulture)+'-'+([BitConverter]::ToString($random)).Replace('-','').ToLowerInvariant();$compilerWorkspace=[IO.Path]::Combine($tempRoot,$name);[void][IO.Directory]::CreateDirectory($compilerWorkspace);RequireWorkspaceOrdinary $compilerWorkspace
  EnterStage 'TEMP_WORKSPACE_DACL_APPLY';$owner=[Security.Principal.WindowsIdentity]::GetCurrent().User;$security=[Security.AccessControl.DirectorySecurity]::new();$security.SetOwner($owner);$security.SetAccessRuleProtection($true,$false);foreach($text in @($owner.Value,'S-1-5-18','S-1-5-32-544')){[void]$security.AddAccessRule((WorkspaceRule ([Security.Principal.SecurityIdentifier]::new($text)))};[IO.Directory]::SetAccessControl($compilerWorkspace,$security)
  EnterStage 'TEMP_WORKSPACE_DACL_VERIFY';VerifyWorkspace $compilerWorkspace $owner;$script:workspaceVerified=$true;[Environment]::SetEnvironmentVariable('TEMP',$compilerWorkspace,[EnvironmentVariableTarget]::Process);[Environment]::SetEnvironmentVariable('TMP',$compilerWorkspace,[EnvironmentVariableTarget]::Process);if($env:TEMP -cne $compilerWorkspace -or $env:TMP -cne $compilerWorkspace){throw 'workspace-env'}
  $stream=[Console]::OpenStandardInput();$watch=[Diagnostics.Stopwatch]::StartNew();EnterStage 'SOURCE_READ';$header=ReadExact $stream 4 $watch;$length=[BitConverter]::ToUInt32($header,0);if($length -lt 2 -or $length -gt ${WINDOWS_SUPERVISOR_SOURCE_MAX_BYTES}){throw 'source-length'};$sourceBytes=ReadExact $stream ([int]$length) $watch
  EnterStage 'SOURCE_UTF8';$source=([Text.UTF8Encoding]::new($false,$true)).GetString($sourceBytes)
  EnterStage 'SCRIPT_PARSE';$entrypoint=[ScriptBlock]::Create($source);if($null -eq $entrypoint){throw 'script'}
  &$entrypoint
}catch{WriteStartupFailure;exit 23}finally{$global:ProprTestFailureStage=$null;try{FinalCompilerWorkspaceCleanup}catch{};[Environment]::SetEnvironmentVariable('TEMP',$null,[EnvironmentVariableTarget]::Process);[Environment]::SetEnvironmentVariable('TMP',$null,[EnvironmentVariableTarget]::Process);Remove-Variable ProprStage,ProprTestFailureStage -Scope Global -ErrorAction SilentlyContinue}
`;

function windowsSupervisorLoader(testFailureStage?: WindowsSupervisorStage): string {
  if (!testFailureStage) return WINDOWS_SUPERVISOR_LOADER;
  return WINDOWS_SUPERVISOR_LOADER.replace(
    "$global:ProprTestFailureStage=$null",
    `$global:ProprTestFailureStage='${testFailureStage}'`,
  );
}

function encodeWindowsSupervisorSource(): Buffer {
  const payload = Buffer.from(WINDOWS_SUPERVISOR_SCRIPT, "utf8");
  if (payload.byteLength < 2 || payload.byteLength > WINDOWS_SUPERVISOR_SOURCE_MAX_BYTES) {
    throw new WindowsSupervisorStartupError("SOURCE_READ");
  }
  const frame = Buffer.allocUnsafe(payload.byteLength + 4);
  frame.writeUInt32LE(payload.byteLength, 0);
  payload.copy(frame, 4);
  return frame;
}

function authorityBrokerArtifact(platform: "darwin" | "win32", arch: string): {
  path: string;
  fd: number;
  identity: StableAuthorityIdentity;
  digest: string;
  bytes: Buffer;
} {
  const expected = platform === "darwin"
    ? DARWIN_AUTHORITY_BROKER_SHA256[arch]
    : WINDOWS_AUTHORITY_BROKER_SHA256[arch];
  if (!expected) throw new Error(`native authority inspection is not packaged for ${platform}-${arch}`);
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const relative = join(
    "prebuilds",
    `${platform}-${arch}`,
    `connect-authority-broker${platform === "win32" ? ".exe" : ""}`,
  );
  const candidates = [
    join(moduleDirectory, "native", relative),
    join(moduleDirectory, "..", "native", relative),
    join(moduleDirectory, "..", "..", "native", relative),
  ];
  for (const candidate of candidates) {
    let fd: number | undefined;
    try {
      fd = openSync(candidate, constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = fstatSync(fd, { bigint: true });
      const named = lstatSync(candidate, { bigint: true });
      if (
        !stat.isFile()
        || named.isSymbolicLink()
        || stat.dev !== named.dev
        || stat.ino !== named.ino
        || stat.size <= 0n
        || stat.size > BigInt(512 * 1024)
        || (platform === "darwin" && (
          (typeof process.getuid === "function" && stat.uid !== 0n && stat.uid !== BigInt(process.getuid()))
          || (stat.mode & 0o022n) !== 0n
        ))
      ) {
        closeSync(fd);
        fd = undefined;
        continue;
      }
      const bytes = readExactDescriptor(fd, Number(stat.size));
      const digest = createHash("sha256").update(bytes).digest("hex");
      if (digest !== expected) throw new Error("packaged native authority broker failed integrity verification");
      return {
        path: candidate,
        fd,
        identity: { device: stat.dev.toString(10), file: stat.ino.toString(10) },
        digest,
        bytes,
      };
    } catch (error) {
      if (fd !== undefined) closeSync(fd);
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  throw new Error(`packaged native authority broker is missing for ${platform}-${arch}`);
}

function readExactDescriptor(fd: number, size: number): Buffer {
  if (!Number.isSafeInteger(size) || size <= 0 || size > 512 * 1024) {
    throw new Error("packaged native authority broker failed integrity verification");
  }
  const bytes = Buffer.allocUnsafe(size);
  let offset = 0;
  while (offset < size) {
    const count = readSync(fd, bytes, offset, size - offset, offset);
    if (count <= 0) throw new Error("packaged native authority broker failed integrity verification");
    offset += count;
  }
  return bytes;
}

function revalidateAuthorityBroker(
  artifact: { path: string; fd: number; identity: StableAuthorityIdentity; digest: string; bytes: Buffer },
): void {
  const stat = fstatSync(artifact.fd, { bigint: true });
  if (
    !stat.isFile()
    || stat.dev.toString(10) !== artifact.identity.device
    || stat.ino.toString(10) !== artifact.identity.file
    || Number(stat.size) !== artifact.bytes.byteLength
    || createHash("sha256").update(readExactDescriptor(artifact.fd, artifact.bytes.byteLength)).digest("hex") !== artifact.digest
  ) throw new Error("packaged native authority broker was replaced");
}

function stageDarwinAuthorityBroker(artifact: ReturnType<typeof authorityBrokerArtifact>): {
  path: string;
  fd: number;
  directory: string;
} {
  const directory = mkdtempSync(join(tmpdir(), "propr-authority-capability-"));
  try {
    chmodSync(directory, 0o700);
    const path = join(directory, `broker-${randomUUID()}`);
    const writableFd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR, 0o500);
    try {
      let offset = 0;
      while (offset < artifact.bytes.byteLength) {
        const count = writeSync(writableFd, artifact.bytes, offset, artifact.bytes.byteLength - offset, offset);
        if (count <= 0) throw new Error("Darwin ACL authority inspection is unavailable");
        offset += count;
      }
      fsyncSync(writableFd);
      fchmodSync(writableFd, 0o500);
      const staged = fstatSync(writableFd, { bigint: true });
      if (!staged.isFile() || staged.size !== BigInt(artifact.bytes.byteLength)) {
        throw new Error("Darwin ACL authority inspection is unavailable");
      }
      closeSync(writableFd);
      const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const readable = fstatSync(fd, { bigint: true });
      if (readable.dev !== staged.dev || readable.ino !== staged.ino) {
        closeSync(fd);
        throw new Error("Darwin ACL authority inspection is unavailable");
      }
      return { path, fd, directory };
    } catch (error) {
      try { closeSync(writableFd); } catch { /* It was closed before the read-only reopen. */ }
      throw error;
    }
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}



function trustedWindowsSystemRoot(): string {
  // uv_os_get_passwd/GetUserProfileDirectoryW backs userInfo(), so this drive
  // does not come from caller-controlled SystemRoot, windir, or USERPROFILE.
  const driveRoot = parse(userInfo().homedir).root;
  if (!/^[A-Za-z]:\\$/.test(driveRoot)) {
    throw new Error("Windows system authority capability is unavailable");
  }
  const systemRoot = join(driveRoot, "Windows");
  try {
    const stat = lstatSync(systemRoot);
    if (
      !stat.isDirectory()
      || stat.isSymbolicLink()
      || realpathSync.native(systemRoot).toLowerCase() !== systemRoot.toLowerCase()
    ) throw new Error("untrusted system root");
  } catch {
    throw new Error("Windows system authority capability is unavailable");
  }
  return systemRoot;
}

function canonicalUint128(value: unknown): value is string {
  return typeof value === "string"
    && /^(?:0|[1-9]\d{0,38})$/.test(value)
    && BigInt(value) <= 0xffffffffffffffffffffffffffffffffn;
}

function stageWindowsAuthorityBroker(artifact: ReturnType<typeof authorityBrokerArtifact>): {
  path: string;
  fd: number;
  directoryFd: number;
  directory: string;
} {
  const directory = mkdtempSync(join(tmpdir(), "propr-authority-capability-"));
  const path = join(directory, `broker-${randomUUID()}.exe`);
  let writableFd: number | undefined;
  let stagedFd: number | undefined;
  let directoryFd: number | undefined;
  try {
    writableFd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR, 0o600);
    let offset = 0;
    while (offset < artifact.bytes.byteLength) {
      const count = writeSync(writableFd, artifact.bytes, offset, artifact.bytes.byteLength - offset, offset);
      if (count <= 0) throw new Error("Windows ACL authority inspection is unavailable");
      offset += count;
    }
    fsyncSync(writableFd);
    closeSync(writableFd);
    writableFd = undefined;

    revalidateAuthorityBroker(artifact);
    stagedFd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const staged = fstatSync(stagedFd, { bigint: true });
    const named = lstatSync(path, { bigint: true });
    if (
      !staged.isFile()
      || named.isSymbolicLink()
      || staged.dev !== named.dev
      || staged.ino !== named.ino
      || staged.size !== BigInt(artifact.bytes.byteLength)
      || createHash("sha256").update(readExactDescriptor(stagedFd, artifact.bytes.byteLength)).digest("hex") !== artifact.digest
    ) {
      closeSync(stagedFd);
      stagedFd = undefined;
      throw new Error("packaged native authority broker was replaced");
    }
    directoryFd = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    return { path, fd: stagedFd, directoryFd, directory };
  } catch (error) {
    if (writableFd !== undefined) closeSync(writableFd);
    if (stagedFd !== undefined) closeSync(stagedFd);
    if (directoryFd !== undefined) closeSync(directoryFd);
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

interface WindowsAuthorityCapability {
  readonly artifact: ReturnType<typeof authorityBrokerArtifact>;
  readonly staged: ReturnType<typeof stageWindowsAuthorityBroker>;
  readonly supervisor: ChildProcess;
  readonly channel: WindowsSupervisorChannel;
  heldIdentity?: { readonly volumeSerialNumber: string; readonly fileId: string };
  sequence: number;
  lastRequestId: string;
  alive: boolean;
  initialized: boolean;
  testFailureStage?: WindowsSupervisorStage;
}

export interface WindowsAuthorityCapabilityProbe {
  readonly args?: readonly string[];
  readonly onStaged?: (stagedPath: string) => void;
  readonly onSupervisorStarting?: (details: {
    readonly stagedPath: string;
    readonly environmentKeys: readonly string[];
    readonly loaderCommandLength: number;
  }) => void;
  readonly onSupervisorSpawned?: (stagedPath: string, supervisorPid: number) => void;
  readonly onRequestLocked?: (stagedPath: string, supervisorPid: number) => void | Promise<void>;
  readonly signal?: AbortSignal;
  /** Native-test-only failure injection; never set by production callers. */
  readonly testFailureStage?: WindowsSupervisorStage;
}

let windowsAuthorityCapability: WindowsAuthorityCapability | undefined;
let windowsAuthorityCleanupRegistered = false;
let windowsAuthorityQueue: Promise<void> = Promise.resolve();
let windowsAuthorityFailureGeneration = 0;

function supervisorExists(supervisor: ChildProcess): boolean {
  if (!supervisor.pid || supervisor.exitCode !== null || supervisor.signalCode !== null) return false;
  try {
    return supervisor.kill(0);
  } catch {
    return false;
  }
}

function enterWindowsParentStage(capability: Pick<WindowsAuthorityCapability, "testFailureStage">, stage: WindowsSupervisorStage): void {
  if (capability.testFailureStage === stage) throw new WindowsSupervisorStartupError(stage);
}

function atWindowsCapabilityStage<T>(
  capability: Pick<WindowsAuthorityCapability, "testFailureStage">,
  stage: WindowsSupervisorStage,
  operation: () => T,
): T {
  enterWindowsParentStage(capability, stage);
  try {
    return operation();
  } catch (error) {
    if (error instanceof WindowsSupervisorStartupError) throw error;
    throw new WindowsSupervisorStartupError(stage);
  }
}

function revalidateWindowsCapabilityFiles(capability: WindowsAuthorityCapability): void {
  const named = atWindowsCapabilityStage(capability, "PATH_NAME", () => {
    if (!capability.alive || !supervisorExists(capability.supervisor)) throw new Error("unavailable");
    return lstatSync(capability.staged.path, { bigint: true });
  });
  atWindowsCapabilityStage(capability, "REPARSE", () => {
    if (named.isSymbolicLink()) throw new Error("reparse");
  });
  atWindowsCapabilityStage(capability, "IMAGE_IDENTITY", () => {
    const staged = fstatSync(capability.staged.fd, { bigint: true });
    const artifact = fstatSync(capability.artifact.fd, { bigint: true });
    if (
      !staged.isFile()
      || staged.dev !== named.dev
      || staged.ino !== named.ino
      || staged.size !== BigInt(capability.artifact.bytes.byteLength)
      || !artifact.isFile()
      || artifact.dev.toString(10) !== capability.artifact.identity.device
      || artifact.ino.toString(10) !== capability.artifact.identity.file
      || artifact.size !== BigInt(capability.artifact.bytes.byteLength)
    ) throw new Error("identity");
  });
  atWindowsCapabilityStage(capability, "IMAGE_HASH", () => {
    if (
      createHash("sha256")
        .update(readExactDescriptor(capability.staged.fd, capability.artifact.bytes.byteLength))
        .digest("hex") !== capability.artifact.digest
      || createHash("sha256")
        .update(readExactDescriptor(capability.artifact.fd, capability.artifact.bytes.byteLength))
        .digest("hex") !== capability.artifact.digest
    ) throw new Error("hash");
  });
}

export class WindowsSupervisorStartupError extends Error {
  constructor(readonly stage: WindowsSupervisorStage) {
    super(`Windows system authority capability is unavailable (${stage})`);
    this.name = "WindowsSupervisorStartupError";
  }
}

export interface WindowsAuthorityStageTestResult {
  readonly version: 1;
  readonly status: "failed";
  readonly stage: WindowsSupervisorStage;
  readonly publicError: "Windows system authority capability is unavailable";
}

/** Resolve only a bounded production stage through a fixed-length cause chain. */
export function windowsAuthorityStageFromError(error: unknown): WindowsSupervisorStage | undefined {
  let current = error;
  for (let depth = 0; depth < 8 && current instanceof Error; depth += 1) {
    if (current instanceof WindowsSupervisorStartupError && WINDOWS_SUPERVISOR_STAGES.has(current.stage)) {
      return current.stage;
    }
    current = current.cause;
  }
  return undefined;
}

interface PendingSupervisorFrame {
  readonly resolve: (value: Buffer) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
  readonly signal?: AbortSignal;
  onAbort?: () => void;
}

class WindowsSupervisorChannel {
  private buffered = Buffer.alloc(0);
  private expectedLength: number | undefined;
  private pending: PendingSupervisorFrame | undefined;
  private settling: { readonly pending: PendingSupervisorFrame; readonly frame: Buffer; readonly immediate: NodeJS.Immediate } | undefined;
  private frameCount = 0;
  private invalidError: Error | undefined;
  private closing = false;

  constructor(readonly supervisor: ChildProcess) {
    if (!supervisor.stdin || !supervisor.stdout || !supervisor.stderr) {
      throw new WindowsSupervisorStartupError("CHANNEL_CREATE");
    }
    supervisor.stdout.on("data", (chunk: Buffer | string) => this.receive(Buffer.from(chunk)));
    supervisor.stdout.once("end", () => {
      if (!this.closing) this.invalidate(new WindowsSupervisorStartupError("CHANNEL_CREATE"));
    });
    supervisor.stdout.once("error", () => this.invalidate(new WindowsSupervisorStartupError("CHANNEL_CREATE")));
    supervisor.stdin.once("error", () => this.invalidate(new WindowsSupervisorStartupError("CHANNEL_CREATE")));
    supervisor.stderr.on("data", (chunk: Buffer | string) => {
      if (Buffer.byteLength(chunk) > 0) this.invalidate(new WindowsSupervisorStartupError("SCRIPT_PARSE"));
    });
    supervisor.stderr.once("error", () => this.invalidate(new WindowsSupervisorStartupError("SCRIPT_PARSE")));
    supervisor.once("error", () => this.invalidate(new WindowsSupervisorStartupError("CHANNEL_CREATE")));
    supervisor.once("exit", () => this.invalidate(new WindowsSupervisorStartupError(this.closing ? "SHUTDOWN" : "CHANNEL_CREATE")));
  }

  private receive(chunk: Buffer): void {
    if (this.invalidError || chunk.byteLength === 0) return;
    if (!this.pending || this.settling) {
      this.invalidate(new Error("Windows system authority capability emitted extra output"));
      return;
    }
    if (this.buffered.byteLength + chunk.byteLength > WINDOWS_CAPABILITY_RESPONSE_MAX_BYTES + 4) {
      this.invalidate(new Error("Windows system authority capability was malformed"));
      return;
    }
    this.buffered = Buffer.concat([this.buffered, chunk]);
    if (this.expectedLength === undefined && this.buffered.byteLength >= 4) {
      this.expectedLength = this.buffered.readUInt32LE(0);
      if (this.expectedLength < 2 || this.expectedLength > WINDOWS_CAPABILITY_RESPONSE_MAX_BYTES) {
        this.invalidate(new Error("Windows system authority capability was malformed"));
        return;
      }
    }
    if (this.expectedLength === undefined || this.buffered.byteLength < this.expectedLength + 4) return;
    if (this.buffered.byteLength !== this.expectedLength + 4) {
      this.invalidate(new Error("Windows system authority capability emitted extra output"));
      return;
    }
    this.frameCount += 1;
    if (this.frameCount > WINDOWS_CAPABILITY_MAX_MESSAGES + 1) {
      this.invalidate(new Error("Windows system authority capability exceeded its frame limit"));
      return;
    }
    const frame = this.buffered.subarray(4);
    this.buffered = Buffer.alloc(0);
    this.expectedLength = undefined;
    const pending = this.pending;
    this.pending = undefined;
    clearTimeout(pending.timer);
    if (pending.signal && pending.onAbort) pending.signal.removeEventListener("abort", pending.onAbort);
    const immediate = setImmediate(() => {
      if (this.settling?.pending !== pending) return;
      this.settling = undefined;
      pending.resolve(frame);
    });
    this.settling = { pending, frame, immediate };
  }

  invalidate(error: Error, poisonQueued = !this.closing): void {
    if (this.invalidError) return;
    this.invalidError = error;
    if (poisonQueued) windowsAuthorityFailureGeneration += 1;
    const pending = this.pending;
    this.pending = undefined;
    if (pending) {
      clearTimeout(pending.timer);
      if (pending.signal && pending.onAbort) pending.signal.removeEventListener("abort", pending.onAbort);
      pending.reject(error);
    }
    // A complete bounded frame already received from stdout wins the race with
    // the child's exit event. This is required for a startup-error frame to
    // carry its exact stage through the documented asynchronous stream.
    this.supervisor.stdin?.destroy();
    this.supervisor.stdout?.destroy();
    this.supervisor.stderr?.destroy();
  }

  async exchange(value: unknown, timeout: number, signal?: AbortSignal, prefix?: Buffer): Promise<Buffer> {
    if (this.invalidError) throw this.invalidError;
    if (this.pending || this.settling) throw new Error("Windows system authority capability request ordering failed");
    if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Windows authority request aborted");
    const response = new Promise<Buffer>((resolve, reject) => {
      const pending: PendingSupervisorFrame = {
        resolve,
        reject,
        signal,
        timer: setTimeout(() => this.invalidate(new Error("Windows system authority capability timed out")), timeout),
      };
      if (signal) {
        pending.onAbort = () => this.invalidate(
          signal.reason instanceof Error ? signal.reason : new Error("Windows authority request aborted"),
        );
        signal.addEventListener("abort", pending.onAbort, { once: true });
      }
      this.pending = pending;
    });
    try {
      const control = encodeControlFrame(value);
      await this.write(prefix ? Buffer.concat([prefix, control]) : control);
    } catch (error) {
      this.invalidate(error instanceof Error ? error : new Error("Windows system authority capability is unavailable"));
    }
    return response;
  }

  async write(bytes: Buffer): Promise<void> {
    if (this.invalidError || !this.supervisor.stdin || this.supervisor.stdin.destroyed) {
      throw this.invalidError ?? new Error("Windows system authority capability is unavailable");
    }
    await new Promise<void>((resolve, reject) => {
      const stream = this.supervisor.stdin!;
      let callbackDone = false;
      let drained = true;
      const finish = () => { if (callbackDone && drained) resolve(); };
      const accepted = stream.write(bytes, (error) => {
        if (error) reject(error);
        else { callbackDone = true; finish(); }
      });
      if (!accepted) {
        drained = false;
        stream.once("drain", () => { drained = true; finish(); });
      }
    });
  }

  beginShutdown(): void {
    this.closing = true;
  }
}

function encodeControlFrame(value: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(value), "utf8");
  if (payload.byteLength < 2 || payload.byteLength > WINDOWS_CAPABILITY_RESPONSE_MAX_BYTES) {
    throw new Error("Windows system authority capability was malformed");
  }
  const frame = Buffer.allocUnsafe(payload.byteLength + 4);
  frame.writeUInt32LE(payload.byteLength, 0);
  payload.copy(frame, 4);
  return frame;
}

async function exchangeWindowsCapability(
  capability: WindowsAuthorityCapability,
  requestId: string,
  operation: "challenge" | "stop",
  timeout = WINDOWS_CAPABILITY_EXCHANGE_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<Buffer> {
  if (!capability.alive || !supervisorExists(capability.supervisor)) {
    throw new Error("Windows system authority capability is unavailable");
  }
  return capability.channel.exchange({ version: 1, kind: operation, requestId }, timeout, signal);
}

function validateWindowsCapabilityResponse(
  capability: WindowsAuthorityCapability,
  operation: "challenge" | "stop",
  requestId: string,
  output: Buffer,
): void {
  const text = decodeBoundedUtf8(output);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("Windows system authority capability was malformed");
  }
  const heldIdentity = capability.heldIdentity;
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const failure = parsed as Record<string, unknown>;
    if (exactKeys(failure, [
      "version", "kind", "requestId", "supervisorPid", "sequence",
      "volumeSerialNumber", "fileId", "sha256", "stage",
    ]) && failure.version === 1 && failure.kind === "capability-error"
      && failure.requestId === requestId && failure.supervisorPid === String(capability.supervisor.pid)
      && failure.sequence === capability.sequence && heldIdentity
      && failure.volumeSerialNumber === heldIdentity.volumeSerialNumber
      && failure.fileId === heldIdentity.fileId && failure.sha256 === capability.artifact.digest
      && typeof failure.stage === "string" && WINDOWS_SUPERVISOR_STAGES.has(failure.stage as WindowsSupervisorStage)) {
      throw new WindowsSupervisorStartupError(failure.stage as WindowsSupervisorStage);
    }
  }
  if (
    !parsed
    || typeof parsed !== "object"
    || Array.isArray(parsed)
    || !exactKeys(parsed, [
      "version", "kind", "requestId", "supervisorPid", "sequence",
      "volumeSerialNumber", "fileId", "sha256",
    ])
  ) throw new Error("Windows system authority capability was malformed");
  const document = parsed as Record<string, unknown>;
  if (
    document.version !== 1
    || document.kind !== (operation === "stop" ? "stopped" : "ready")
    || document.requestId !== requestId
    || document.supervisorPid !== String(capability.supervisor.pid)
    || !Number.isInteger(document.sequence)
    || (document.sequence as number) < 1
    || document.sequence !== capability.sequence + 1
    || !canonicalUint64(document.volumeSerialNumber)
    || !canonicalUint128(document.fileId)
    || !heldIdentity
    || document.volumeSerialNumber !== heldIdentity.volumeSerialNumber
    || document.fileId !== heldIdentity.fileId
    || document.sha256 !== capability.artifact.digest
  ) throw new Error("Windows system authority capability was malformed");
  capability.sequence = document.sequence as number;
  capability.lastRequestId = requestId;
}

async function challengeWindowsCapability(
  capability: WindowsAuthorityCapability,
  operation: "challenge" | "stop" = "challenge",
  signal?: AbortSignal,
): Promise<void> {
  if (!capability.alive || !supervisorExists(capability.supervisor) || !capability.supervisor.pid) {
    throw new Error("Windows system authority capability is unavailable");
  }
  const requestId = randomBytes(16).toString("hex");
  const output = await exchangeWindowsCapability(capability, requestId, operation, undefined, signal);
  validateWindowsCapabilityResponse(capability, operation, requestId, output);
}

function closeWindowsCapabilityFiles(capability: WindowsAuthorityCapability): void {
  try { closeSync(capability.staged.fd); } catch { /* Already closed during failed acquisition. */ }
  try { closeSync(capability.staged.directoryFd); } catch { /* Already closed during failed acquisition. */ }
  try { closeSync(capability.artifact.fd); } catch { /* Already closed during failed acquisition. */ }
  try { rmSync(capability.staged.directory, { recursive: true, force: true }); } catch { /* Best effort after native close. */ }
}

async function waitForSupervisorExit(supervisor: ChildProcess, timeout: number): Promise<boolean> {
  if (!supervisorExists(supervisor)) return true;
  return new Promise((resolve) => {
    const timer = setTimeout(() => { cleanup(); resolve(false); }, timeout);
    const exited = () => { cleanup(); resolve(true); };
    const cleanup = () => { clearTimeout(timer); supervisor.removeListener("exit", exited); };
    supervisor.once("exit", exited);
  });
}

async function destroyWindowsAuthorityCapability(
  capability = windowsAuthorityCapability,
  requireGracefulShutdown = false,
): Promise<void> {
  if (!capability) {
    if (requireGracefulShutdown) throw new WindowsSupervisorStartupError("SHUTDOWN");
    return;
  }
  if (windowsAuthorityCapability === capability) windowsAuthorityCapability = undefined;
  let gracefulShutdown = false;
  if (capability.initialized && capability.alive && supervisorExists(capability.supervisor)) {
    capability.channel.beginShutdown();
    try {
      await challengeWindowsCapability(capability, "stop");
      gracefulShutdown = true;
    } catch { /* Channel failure falls through to forced reap. */ }
  }
  capability.alive = false;
  capability.supervisor.stdin?.end();
  let exited = await waitForSupervisorExit(capability.supervisor, WINDOWS_CAPABILITY_STOP_TIMEOUT_MS);
  if (!exited) {
    try { capability.supervisor.kill(); } catch { /* The OS also closes the lock when the parent exits. */ }
    exited = await waitForSupervisorExit(capability.supervisor, WINDOWS_CAPABILITY_STOP_TIMEOUT_MS);
  }
  capability.channel.invalidate(new WindowsSupervisorStartupError("SHUTDOWN"), false);
  closeWindowsCapabilityFiles(capability);
  if (requireGracefulShutdown && (!gracefulShutdown || !exited)) {
    throw new WindowsSupervisorStartupError("SHUTDOWN");
  }
}

async function acquireWindowsAuthorityCapability(
  probe?: Pick<WindowsAuthorityCapabilityProbe, "onStaged" | "onSupervisorStarting" | "onSupervisorSpawned" | "testFailureStage">,
  signal?: AbortSignal,
): Promise<WindowsAuthorityCapability> {
  if (windowsAuthorityCapability) {
    if (probe) throw new Error("Windows system authority capability is already active");
    try {
      revalidateWindowsCapabilityFiles(windowsAuthorityCapability);
      return windowsAuthorityCapability;
    } catch (error) {
      const stagedError = error instanceof WindowsSupervisorStartupError
        ? error
        : new WindowsSupervisorStartupError("IMAGE_IDENTITY");
      windowsAuthorityCapability.channel.invalidate(
        stagedError,
      );
      await destroyWindowsAuthorityCapability(windowsAuthorityCapability);
      throw stagedError;
    }
  }
  let artifact: ReturnType<typeof authorityBrokerArtifact>;
  try {
    artifact = authorityBrokerArtifact("win32", process.arch);
  } catch {
    throw new WindowsSupervisorStartupError("IMAGE_OPEN");
  }
  let staged: ReturnType<typeof stageWindowsAuthorityBroker> | undefined;
  let capability: WindowsAuthorityCapability | undefined;
  let supervisor: ChildProcess | undefined;
  let parentStage: WindowsSupervisorStage = "IMAGE_OPEN";
  try {
    staged = stageWindowsAuthorityBroker(artifact);
    probe?.onStaged?.(staged.path);
    parentStage = "CHANNEL_CREATE";
    if (probe?.testFailureStage === parentStage) throw new WindowsSupervisorStartupError(parentStage);
    const systemRoot = trustedWindowsSystemRoot();
    const supervisorEnvironment = { SystemRoot: systemRoot };
    const loader = windowsSupervisorLoader(
      probe?.testFailureStage && WINDOWS_PRE_PROTOCOL_STAGES.has(probe.testFailureStage)
        ? probe.testFailureStage
        : undefined,
    );
    probe?.onSupervisorStarting?.({
      stagedPath: staged.path,
      environmentKeys: Object.freeze(Object.keys(supervisorEnvironment)),
      loaderCommandLength: loader.length,
    });
    supervisor = spawn(join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
      "-Command", loader,
    ], {
      shell: false,
      windowsHide: true,
      env: supervisorEnvironment,
      stdio: ["pipe", "pipe", "pipe", staged.fd],
    });
    const channel = new WindowsSupervisorChannel(supervisor);
    supervisor.unref();
    (supervisor.stdin as typeof supervisor.stdin & { unref?: () => void } | null)?.unref?.();
    (supervisor.stdout as typeof supervisor.stdout & { unref?: () => void } | null)?.unref?.();
    (supervisor.stderr as typeof supervisor.stderr & { unref?: () => void } | null)?.unref?.();
    capability = {
      artifact,
      staged,
      supervisor,
      channel,
      sequence: 0,
      lastRequestId: "",
      alive: true,
      initialized: false,
      testFailureStage: probe?.testFailureStage,
    };
    supervisor.once("error", () => { capability!.alive = false; });
    supervisor.once("exit", () => { capability!.alive = false; });
    if (!supervisor.pid) throw new WindowsSupervisorStartupError("CHANNEL_CREATE");
    probe?.onSupervisorSpawned?.(staged.path, supervisor.pid);
    parentStage = "SOURCE_READ";
    const requestId = randomBytes(16).toString("hex");
    const output = await channel.exchange({
      version: 1,
      kind: "init",
      requestId,
      path: staged.path,
      sha256: artifact.digest,
      parentPid: String(process.pid),
      ...(probe?.testFailureStage === undefined ? {} : { testFailureStage: probe.testFailureStage }),
    }, WINDOWS_CAPABILITY_STARTUP_TIMEOUT_MS, signal, encodeWindowsSupervisorSource());
    let parsed: unknown;
    try {
      parsed = JSON.parse(decodeBoundedUtf8(output));
    } catch {
      throw new WindowsSupervisorStartupError("PROTOCOL_INIT");
    }
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const startup = parsed as Record<string, unknown>;
      const startupStage = typeof startup.stage === "string"
        && WINDOWS_SUPERVISOR_STAGES.has(startup.stage as WindowsSupervisorStage)
        ? startup.stage as WindowsSupervisorStage
        : undefined;
      if (exactKeys(startup, ["version", "kind", "requestId", "stage"])
        && startup.version === 1 && startup.kind === "startup-error" && startupStage
        && (startup.requestId === requestId
          || (startup.requestId === "0".repeat(32) && WINDOWS_PRE_PROTOCOL_STAGES.has(startupStage)))) {
        throw new WindowsSupervisorStartupError(startupStage);
      }
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !exactKeys(parsed, [
      "version", "kind", "requestId", "supervisorPid", "sequence", "volumeSerialNumber", "fileId", "sha256",
    ])) throw new WindowsSupervisorStartupError("READY_FRAME");
    const ready = parsed as Record<string, unknown>;
    if (ready.version !== 1 || ready.kind !== "ready" || ready.requestId !== requestId
      || ready.supervisorPid !== String(supervisor.pid) || ready.sequence !== 1
      || !canonicalUint64(ready.volumeSerialNumber) || !canonicalUint128(ready.fileId)
      || ready.sha256 !== artifact.digest) throw new WindowsSupervisorStartupError("READY_FRAME");
    capability.heldIdentity = {
      volumeSerialNumber: ready.volumeSerialNumber,
      fileId: ready.fileId,
    };
    capability.sequence = 1;
    capability.lastRequestId = requestId;
    capability.initialized = true;
    parentStage = "IMAGE_IDENTITY";
    revalidateWindowsCapabilityFiles(capability);
    windowsAuthorityCapability = capability;
    if (!windowsAuthorityCleanupRegistered) {
      windowsAuthorityCleanupRegistered = true;
      process.once("beforeExit", () => { void closeWindowsAuthorityCapability(); });
      process.once("exit", () => {
        const current = windowsAuthorityCapability;
        if (!current) return;
        current.channel.beginShutdown();
        current.supervisor.kill();
        closeWindowsCapabilityFiles(current);
      });
    }
    return capability;
  } catch (error) {
    if (capability) {
      capability.channel.invalidate(
        error instanceof Error ? error : new WindowsSupervisorStartupError(parentStage),
      );
      await destroyWindowsAuthorityCapability(capability);
    }
    else {
      if (supervisor) {
        try { supervisor.kill(); } catch { /* Failed startup may already have exited. */ }
        supervisor.stdin?.destroy();
        supervisor.stdout?.destroy();
        supervisor.stderr?.destroy();
      }
      if (staged) {
        try { closeSync(staged.fd); } catch { /* Acquisition cleanup. */ }
        try { closeSync(staged.directoryFd); } catch { /* Acquisition cleanup. */ }
        try { rmSync(staged.directory, { recursive: true, force: true }); } catch { /* Acquisition cleanup. */ }
      }
      closeSync(artifact.fd);
    }
    if (error instanceof WindowsSupervisorStartupError) throw error;
    throw new WindowsSupervisorStartupError(parentStage);
  }
}

function validWindowsBatchRequest(input: Buffer | undefined, targetCount: number): boolean {
  if (
    !input
    || targetCount < 1
    || targetCount > 64
    || input.byteLength === 0
    || input.byteLength > WINDOWS_BROKER_REQUEST_MAX_BYTES
    || input[input.byteLength - 1] !== 0x0a
  ) return false;
  for (const byte of input) {
    if (byte > 0x7f || byte === 0 || byte === 0x0d) return false;
  }
  const lines = input.toString("ascii").split("\n");
  if (
    lines.length !== targetCount + 5
    || lines.at(-1) !== ""
    || lines[0] !== "PROPR_AUTHORITY_V1"
    || !/^[0-9a-f]{32}$/.test(lines[1])
    || (lines[2] !== "inspect" && lines[2] !== "protect")
    || lines[3] !== String(targetCount)
  ) return false;
  const allowed = lines[2] === "inspect"
    ? new Set(["ancestor", "home", "root", "data", "env"])
    : new Set(["directory", "file"]);
  return lines.slice(4, -1).every((kind) => allowed.has(kind));
}

interface BoundedChildResult {
  readonly status: number;
  readonly stdout: Buffer;
  readonly stderr: Buffer;
}

async function runBoundedWindowsChild(
  path: string,
  args: readonly string[],
  targetFds: readonly number[],
  input: Buffer | undefined,
  signal?: AbortSignal,
): Promise<BoundedChildResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error("Windows authority batch timed out")), WINDOWS_BROKER_BATCH_TIMEOUT_MS);
  const onAbort = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const child = spawn(path, [...args], {
      shell: false,
      windowsHide: true,
      env: {},
      signal: controller.signal,
      stdio: [input ? "pipe" : "ignore", "pipe", "pipe", ...targetFds],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const collect = (target: Buffer[], kind: "stdout" | "stderr") => (chunk: Buffer | string) => {
      const bytes = Buffer.from(chunk);
      if (kind === "stdout") stdoutBytes += bytes.byteLength;
      else stderrBytes += bytes.byteLength;
      if (stdoutBytes > NATIVE_INSPECTION_MAX_BYTES || stderrBytes > NATIVE_INSPECTION_MAX_BYTES) {
        controller.abort(new Error("Windows authority batch exceeded its output limit"));
        return;
      }
      target.push(bytes);
    };
    child.stdout!.on("data", collect(stdout, "stdout"));
    child.stderr!.on("data", collect(stderr, "stderr"));
    const completion = new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.stdin?.once("error", reject);
      child.once("close", (code, closeSignal) => {
        if (code === null || closeSignal !== null) reject(controller.signal.reason ?? new Error("Windows authority batch failed"));
        else resolve(code);
      });
    });
    if (input) child.stdin!.end(input);
    const status = await completion;
    return { status, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) };
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", onAbort);
  }
}

async function runCachedWindowsAuthorityBroker(
  args: readonly string[],
  targetFds: readonly number[],
  failureMessage: string,
  input?: Buffer,
  onRequestLocked?: (stagedPath: string, supervisorPid: number) => void | Promise<void>,
  signal?: AbortSignal,
): Promise<Buffer> {
  const batch = args.length === 1 && args[0] === "batch-v1";
  const probe = args.length === 1 && (args[0] === "ping" || args[0] === "ping-hold");
  if (
    (!batch && !probe)
    || targetFds.some((fd) => !Number.isInteger(fd) || fd < 0)
    || (probe && (targetFds.length !== 0 || input !== undefined))
    || (batch && !validWindowsBatchRequest(input, targetFds.length))
  ) throw new Error(failureMessage);
  const capability = await acquireWindowsAuthorityCapability(undefined, signal);
  let stage: WindowsSupervisorStage = "PRE_CHALLENGE";
  try {
    revalidateWindowsCapabilityFiles(capability);
    await challengeWindowsCapability(capability, "challenge", signal);
    await onRequestLocked?.(capability.staged.path, capability.supervisor.pid!);
    if (!supervisorExists(capability.supervisor)) throw new Error(failureMessage);
    stage = "BATCH_LAUNCH";
    enterWindowsParentStage(capability, stage);
    let result: BoundedChildResult;
    try {
      result = await runBoundedWindowsChild(capability.staged.path, args, targetFds, input, signal);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      throw new WindowsSupervisorStartupError(code === "EBADF" || code === "EINVAL" ? "FD_DUPLICATE" : "BATCH_LAUNCH");
    }
    stage = "BATCH_RESPONSE";
    enterWindowsParentStage(capability, stage);
    if (result.status !== 0) {
      throw new WindowsSupervisorStartupError("BATCH_RESPONSE");
    }
    stage = "POST_CHALLENGE";
    await challengeWindowsCapability(capability, "challenge", signal);
    revalidateWindowsCapabilityFiles(capability);
    stage = "BATCH_RESPONSE";
    if (result.stderr.byteLength !== 0) throw new WindowsSupervisorStartupError(stage);
    return result.stdout;
  } catch (error) {
    capability.channel.invalidate(
      error instanceof Error ? error : new WindowsSupervisorStartupError(stage),
    );
    await destroyWindowsAuthorityCapability(capability);
    throw new Error(failureMessage, {
      cause: error instanceof WindowsSupervisorStartupError ? error : new WindowsSupervisorStartupError(stage),
    });
  }
}

async function runWindowsAuthorityBatch(
  operation: "inspect" | "protect",
  kinds: readonly string[],
  targetFds: readonly number[],
  failureMessage: string,
  signal?: AbortSignal,
): Promise<{ readonly output: Buffer; readonly requestId: string }> {
  if (kinds.length === 0 || kinds.length > 64 || kinds.length !== targetFds.length) {
    throw new Error(failureMessage);
  }
  const requestId = randomUUID().replaceAll("-", "");
  const input = Buffer.from([
    "PROPR_AUTHORITY_V1", requestId, operation, String(kinds.length), ...kinds, "",
  ].join("\n"), "ascii");
  if (input.byteLength > WINDOWS_BROKER_REQUEST_MAX_BYTES) throw new Error(failureMessage);
  return {
    output: await runCachedWindowsAuthorityBroker(["batch-v1"], targetFds, failureMessage, input, undefined, signal),
    requestId,
  };
}

function enqueueWindowsAuthority<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  const generation = windowsAuthorityFailureGeneration;
  const result = windowsAuthorityQueue.then(async () => {
    if (generation !== windowsAuthorityFailureGeneration) {
      throw new Error("Windows system authority capability is unavailable");
    }
    if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Windows authority request aborted");
    return operation();
  });
  windowsAuthorityQueue = result.then(() => undefined, () => undefined);
  return result;
}

/** Explicit shutdown seam used by app/CLI lifecycle and native leak tests. */
export function closeWindowsAuthorityCapability(
  options: { readonly requireGracefulShutdown?: boolean } = {},
): Promise<void> {
  return enqueueWindowsAuthority(() => destroyWindowsAuthorityCapability(
    undefined,
    options.requireGracefulShutdown === true,
  ));
}

/**
 * Native-test seam which injects at a real production call site and requires
 * the exact stage to traverse the supervisor's asynchronous framed channel or
 * its production caller. No pathname, SID, source text, or raw error escapes.
 */
export function exerciseWindowsAuthorityStageFailureForNativeTest(
  requestedStage: WindowsSupervisorStage,
): Promise<WindowsAuthorityStageTestResult> {
  if (process.platform !== "win32") throw new Error("Windows stage probe requires Windows");
  if (!WINDOWS_SUPERVISOR_STAGES.has(requestedStage)) throw new Error("unknown Windows authority stage");
  return enqueueWindowsAuthority(async () => {
    await destroyWindowsAuthorityCapability();
    const fixture = mkdtempSync(join(userInfo().homedir, "propr-authority-stage-"));
    const file = join(fixture, "empty");
    let fileFd: number | undefined;
    let directoryFd: number | undefined;
    try {
      const created = openSync(file, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR, 0o600);
      closeSync(created);
      directoryFd = openSync(fixture, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      fileFd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const revalidationStage = requestedStage === "PATH_NAME"
          || requestedStage === "REPARSE"
          || requestedStage === "IMAGE_HASH"
          || requestedStage === "IMAGE_IDENTITY";
        const capability = await acquireWindowsAuthorityCapability({
          testFailureStage: revalidationStage ? undefined : requestedStage,
        });
        if (revalidationStage) {
          capability.testFailureStage = requestedStage;
          revalidateWindowsCapabilityFiles(capability);
        } else if (requestedStage === "SHUTDOWN") {
          await runWindowsAuthorityBatch("protect", ["directory", "file"], [directoryFd, fileFd], "stage probe failed");
          await challengeWindowsCapability(capability, "stop");
        } else {
          await runWindowsAuthorityBatch("protect", ["directory", "file"], [directoryFd, fileFd], "stage probe failed");
        }
        throw new Error("Windows authority stage injection did not fire");
      } catch (error) {
        if (windowsAuthorityStageFromError(error) !== requestedStage) {
          throw new Error("Windows authority stage injection was not preserved", { cause: error });
        }
        return {
          version: 1,
          status: "failed",
          stage: requestedStage,
          publicError: "Windows system authority capability is unavailable",
        };
      }
    } finally {
      await destroyWindowsAuthorityCapability();
      if (fileFd !== undefined) closeSync(fileFd);
      if (directoryFd !== undefined) closeSync(directoryFd);
      rmSync(fixture, { recursive: true, force: true });
    }
  });
}

/** Native-test seam for replay, framing, EOF, and response-binding failures. */
export function exerciseWindowsAuthorityCapabilityControlForNativeTest(
  probe: {
    readonly mode: "replay" | "wrong-request-id" | "wrong-identity" | "malformed" | "extra-frame" | "partial-frame" | "eof" | "unparsed-response";
  },
): Promise<Buffer> {
  if (process.platform !== "win32") throw new Error("Windows capability control probe requires Windows");
  return enqueueWindowsAuthority(async () => {
  const capability = await acquireWindowsAuthorityCapability();
  if (probe.mode === "eof" || probe.mode === "partial-frame") {
    if (probe.mode === "partial-frame") await capability.channel.write(Buffer.from([8, 0, 0, 0, 0x7b]));
    capability.supervisor.stdin?.end();
    await destroyWindowsAuthorityCapability(capability);
    throw new Error("Windows system authority capability was malformed");
  }
  if (probe.mode === "replay") {
    try {
      const output = await exchangeWindowsCapability(capability, capability.lastRequestId, "challenge");
      void output;
    } finally {
      await destroyWindowsAuthorityCapability(capability);
    }
    throw new Error("Windows system authority capability was malformed");
  }
  if (probe.mode === "malformed") {
    const frame = encodeControlFrame({
      version: 1, kind: "challenge", requestId: randomBytes(16).toString("hex"), extra: true,
    });
    try {
      await capability.channel.exchange(JSON.parse(frame.subarray(4).toString("utf8")), WINDOWS_CAPABILITY_EXCHANGE_TIMEOUT_MS);
    } finally {
      await destroyWindowsAuthorityCapability(capability);
    }
    throw new Error("Windows system authority capability was malformed");
  }
  const requestId = randomBytes(16).toString("hex");
  if (probe.mode === "extra-frame") {
    const first = encodeControlFrame({ version: 1, kind: "challenge", requestId });
    const second = encodeControlFrame({ version: 1, kind: "challenge", requestId: randomBytes(16).toString("hex") });
    await capability.channel.write(Buffer.concat([first, second]));
    await destroyWindowsAuthorityCapability(capability);
    const output = Buffer.alloc(0);
    throw new Error(`Windows system authority capability emitted extra output (${output.byteLength})`);
  }
  const output = await exchangeWindowsCapability(capability, requestId, "challenge");
  if (probe.mode === "unparsed-response") {
    await destroyWindowsAuthorityCapability(capability);
    return output;
  }
  if (probe.mode === "wrong-request-id" || probe.mode === "wrong-identity") {
    const heldIdentity = capability.heldIdentity;
    try {
      if (probe.mode === "wrong-identity" && heldIdentity) {
        capability.heldIdentity = {
          volumeSerialNumber: heldIdentity.volumeSerialNumber,
          fileId: heldIdentity.fileId === "0" ? "1" : "0",
        };
      }
      validateWindowsCapabilityResponse(
        capability,
        "challenge",
        probe.mode === "wrong-request-id" ? randomBytes(16).toString("hex") : requestId,
        output,
      );
    } finally {
      capability.heldIdentity = heldIdentity;
      await destroyWindowsAuthorityCapability(capability);
    }
    throw new Error("Windows system authority capability was malformed");
  }
  return output;
  });
}

/** Native-test seam for locked-image, serialization, restart, and cleanup evidence. */
export function exerciseWindowsAuthorityCapabilityForNativeTest(
  probe: WindowsAuthorityCapabilityProbe = {},
): Promise<{
  readonly output: Buffer;
  readonly stagedPath: string;
  readonly directory: string;
  readonly supervisorPid: number;
  readonly stage: "READY_FRAME";
}> {
  if (process.platform !== "win32") throw new Error("Windows capability probe requires Windows");
  return enqueueWindowsAuthority(async () => {
  if (probe.onStaged || probe.onSupervisorStarting || probe.onSupervisorSpawned) await destroyWindowsAuthorityCapability();
  const capability = await acquireWindowsAuthorityCapability(
    probe.onStaged || probe.onSupervisorStarting || probe.onSupervisorSpawned ? probe : undefined,
    probe.signal,
  );
  if (!capability.supervisor.pid) throw new Error("Windows capability probe is unavailable");
  const output = await runCachedWindowsAuthorityBroker(
    probe.args ?? ["ping"],
    [],
    "Windows capability probe is unavailable",
    undefined,
    probe.onRequestLocked,
    probe.signal,
  );
  return {
    output,
    stagedPath: capability.staged.path,
    directory: capability.staged.directory,
    supervisorPid: capability.supervisor.pid,
    stage: "READY_FRAME",
  };
  }, probe.signal);
}

function nativeDarwinAcl(
  _path: string,
  pinnedFd: number,
  _expectedIdentity: StableAuthorityIdentity,
): DarwinAuthorityInspection {
  if (!Number.isInteger(pinnedFd) || pinnedFd < 0) throw new Error("Darwin ACL authority inspection is unavailable");
  const artifact = authorityBrokerArtifact("darwin", process.arch);
  let capability: ReturnType<typeof stageDarwinAuthorityBroker>;
  try {
    capability = stageDarwinAuthorityBroker(artifact);
  } catch (error) {
    closeSync(artifact.fd);
    throw error;
  }
  let result: ReturnType<typeof spawnSync>;
  try {
    result = spawnSync(capability.path, [], {
      shell: false,
      windowsHide: true,
      encoding: "buffer",
      env: {},
      timeout: 5000,
      maxBuffer: NATIVE_INSPECTION_MAX_BYTES,
      // fd 3 is the caller's already-held object. The broker uses only fstat and
      // acl_get_fd_np/acl_to_text on this inherited descriptor.
      stdio: ["ignore", "pipe", "pipe", pinnedFd],
    });
    const staged = fstatSync(capability.fd, { bigint: true });
    if (
      !staged.isFile()
      || staged.size !== BigInt(artifact.bytes.byteLength)
      || createHash("sha256").update(readExactDescriptor(capability.fd, artifact.bytes.byteLength)).digest("hex") !== artifact.digest
    ) throw new Error("packaged native authority broker was replaced");
    revalidateAuthorityBroker(artifact);
  } finally {
    closeSync(capability.fd);
    rmSync(capability.directory, { recursive: true, force: true });
    closeSync(artifact.fd);
  }
  if (result.status !== 0 || result.error || result.signal) {
    throw new Error("Darwin ACL authority inspection is unavailable");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeBoundedUtf8(result.stdout).trim());
  } catch {
    throw new Error("Darwin ACL authority inspection was malformed");
  }
  assertDarwinInspectionShape(parsed);
  return parsed;
}

function validateWindowsBrokerPath(path: string): void {
  if (!path || path.includes("\0") || path.length > 32_000) {
    throw new Error("Windows system authority inspection is unavailable");
  }
}

async function nativeWindowsAcls(entries: readonly WindowsAuthorityTarget[]): Promise<readonly WindowsAuthorityInspection[]> {
  if (entries.length === 0 || entries.length > 64) {
    throw new Error("Windows ACL authority inspection is unavailable");
  }
  for (const entry of entries) {
    if (!Number.isInteger(entry.pinnedFd) || entry.pinnedFd < 0) {
      throw new Error("Windows ACL authority inspection is unavailable");
    }
  }
  const batch = await enqueueWindowsAuthority(() => runWindowsAuthorityBatch(
    "inspect",
    entries.map((entry) => entry.kind),
    entries.map((entry) => entry.pinnedFd),
    "Windows ACL authority inspection is unavailable",
  ));
  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeBoundedUtf8(batch.output).trim());
  } catch {
    throw new Error("Windows ACL authority inspection was malformed");
  }
  if (
    !parsed
    || typeof parsed !== "object"
    || Array.isArray(parsed)
    || !exactKeys(parsed, ["version", "requestId", "entries"])
  ) throw new Error("Windows ACL authority inspection was malformed");
  const document = parsed as Record<string, unknown>;
  if (
    document.version !== 1
    || document.requestId !== batch.requestId
    || !Array.isArray(document.entries)
    || document.entries.length !== entries.length
  ) {
    throw new Error("Windows ACL authority inspection was malformed");
  }
  for (let index = 0; index < document.entries.length; index += 1) {
    const inspection = document.entries[index];
    assertWindowsInspectionShape(inspection);
    const target = entries[index];
    if (
      inspection.index !== index
      || inspection.authorityKind !== target.kind
      || inspection.kind !== (target.kind === "env" ? "file" : "directory")
      || BigInt(inspection.volumeSerialNumber) !== BigInt(inspection.verifiedVolumeSerialNumber)
      || BigInt(inspection.fileId) !== BigInt(inspection.verifiedFileId)
    ) throw new Error("Windows ACL authority inspection was malformed");
  }
  return document.entries;
}

async function nativeWindowsAcl(
  path: string,
  expectedIdentity: StableAuthorityIdentity,
  pinnedFd?: number,
  kind: ConnectAuthorityEntryKind = "env",
): Promise<WindowsAuthorityInspection> {
  if (pinnedFd === undefined) throw new Error("Windows ACL authority inspection is unavailable");
  return (await nativeWindowsAcls([{ path, kind, expectedIdentity, pinnedFd }]))[0];
}

/** Establish the same narrowly documented DACL used by a new Windows stack. */
export async function protectWindowsSetupEntry(path: string, kind: "directory" | "file"): Promise<void> {
  await protectWindowsSetupEntries([{ path, kind }]);
}

/** Protect a complete setup group in one bounded native broker process. */
export async function protectWindowsSetupEntries(
  entries: readonly { readonly path: string; readonly kind: "directory" | "file" }[],
): Promise<void> {
  if (process.platform !== "win32" || entries.length === 0) return;
  if (entries.length > 64) throw new Error("Windows setup authority could not be established");
  for (const entry of entries) {
    validateWindowsBrokerPath(entry.path);
  }
  const held: number[] = [];
  const identities: StableAuthorityIdentity[] = [];
  try {
    for (const entry of entries) {
      const fd = openSync(entry.path, constants.O_RDONLY | constants.O_NOFOLLOW
        | (entry.kind === "directory" ? constants.O_DIRECTORY : 0));
      const pinned = fstatSync(fd, { bigint: true });
      const named = lstatSync(entry.path, { bigint: true });
      if (
        named.isSymbolicLink()
        || pinned.dev !== named.dev
        || pinned.ino !== named.ino
        || (entry.kind === "directory") !== pinned.isDirectory()
      ) {
        closeSync(fd);
        throw new Error("Windows setup authority could not be established");
      }
      held.push(fd);
      identities.push(stableAuthorityIdentity(fd));
    }
    const batch = await enqueueWindowsAuthority(() => runWindowsAuthorityBatch(
      "protect",
      entries.map((entry) => entry.kind),
      held,
      "Windows setup authority could not be established",
    ));
    let parsed: unknown;
    try {
      parsed = JSON.parse(decodeBoundedUtf8(batch.output).trim());
    } catch {
      throw new Error("Windows setup authority could not be established");
    }
    if (
      !parsed
      || typeof parsed !== "object"
      || Array.isArray(parsed)
      || !exactKeys(parsed, ["version", "requestId", "protected", "entries"])
    ) throw new Error("Windows setup authority could not be established");
    const document = parsed as Record<string, unknown>;
    if (
      document.version !== 1
      || document.requestId !== batch.requestId
      || document.protected !== entries.length
      || !Array.isArray(document.entries)
      || document.entries.length !== entries.length
    ) throw new Error("Windows setup authority could not be established");
    for (let index = 0; index < entries.length; index += 1) {
      const inspection = document.entries[index];
      assertWindowsInspectionShape(inspection);
      const kind = entries[index].kind === "directory" ? "root" : "env";
      if (
        inspection.index !== index
        || inspection.authorityKind !== kind
        || inspection.kind !== entries[index].kind
        || BigInt(inspection.volumeSerialNumber) !== BigInt(inspection.verifiedVolumeSerialNumber)
        || BigInt(inspection.fileId) !== BigInt(inspection.verifiedFileId)
      ) throw new Error("Windows setup authority could not be established");
      assertSafeWindowsAuthority(inspection, kind);
      const after = stableAuthorityIdentity(held[index]);
      if (after.device !== identities[index].device || after.file !== identities[index].file) {
        throw new Error("Windows setup authority could not be established");
      }
    }
  } catch (error) {
    throw new Error("Windows setup authority could not be established", { cause: error });
  } finally {
    for (const fd of held) closeSync(fd);
  }
}

export const nativeConnectRootAuthorityInspector: ConnectRootAuthorityInspector = {
  inspectDarwinAcl: nativeDarwinAcl,
  inspectWindowsAcl: nativeWindowsAcl,
  inspectWindowsAcls: nativeWindowsAcls,
};

function exactKeys(value: object, expected: readonly string[]): boolean {
  return Object.keys(value).sort().join(",") === [...expected].sort().join(",");
}

function canonicalUint64(value: unknown): value is string {
  return typeof value === "string"
    && /^(?:0|[1-9]\d{0,19})$/.test(value)
    && BigInt(value) <= 0xffffffffffffffffn;
}

function assertDarwinInspectionShape(value: unknown): asserts value is DarwinAuthorityInspection {
  if (
    !value
    || typeof value !== "object"
    || Array.isArray(value)
    || !exactKeys(value, ["version", "device", "file", "acl"])
  ) throw new Error("Darwin ACL authority inspection was malformed");
  const record = value as Record<string, unknown>;
  if (
    record.version !== 1
    || !canonicalUint64(record.device)
    || !canonicalUint64(record.file)
    || typeof record.acl !== "string"
    || Buffer.byteLength(record.acl, "utf8") > 24 * 1024
  ) throw new Error("Darwin ACL authority inspection was malformed");
}

function assertWindowsInspectionShape(value: unknown): asserts value is WindowsAuthorityInspection {
  if (
    !value
    || typeof value !== "object"
    || Array.isArray(value)
    || !exactKeys(value, [
      "index", "kind", "authorityKind", "currentUserSid", "ownerSid", "daclProtected", "reparsePoint",
      "volumeSerialNumber", "fileId", "verifiedVolumeSerialNumber", "verifiedFileId", "rules",
    ])
  ) throw new Error("Windows ACL authority inspection was malformed");
  const record = value as Record<string, unknown>;
  if (
    !Number.isInteger(record.index)
    || (record.index as number) < 0
    || (record.index as number) >= 64
    || (record.kind !== "directory" && record.kind !== "file")
    || !["ancestor", "home", "root", "data", "env"].includes(record.authorityKind as string)
    || typeof record.currentUserSid !== "string"
    || !WINDOWS_SID.test(record.currentUserSid)
    || typeof record.ownerSid !== "string"
    || !WINDOWS_SID.test(record.ownerSid)
    || typeof record.daclProtected !== "boolean"
    || typeof record.reparsePoint !== "boolean"
    || typeof record.volumeSerialNumber !== "string"
    || !/^(?:0|[1-9]\d{0,19})$/.test(record.volumeSerialNumber)
    || typeof record.fileId !== "string"
    || !/^(?:0|[1-9]\d{0,38})$/.test(record.fileId)
    || BigInt(record.fileId) > 0xffffffffffffffffffffffffffffffffn
    || typeof record.verifiedVolumeSerialNumber !== "string"
    || !/^(?:0|[1-9]\d{0,19})$/.test(record.verifiedVolumeSerialNumber)
    || BigInt(record.verifiedVolumeSerialNumber) > 0xffffffffffffffffn
    || typeof record.verifiedFileId !== "string"
    || !/^(?:0|[1-9]\d{0,38})$/.test(record.verifiedFileId)
    || BigInt(record.verifiedFileId) > 0xffffffffffffffffffffffffffffffffn
    || !Array.isArray(record.rules)
    || record.rules.length > 256
  ) throw new Error("Windows ACL authority inspection was malformed");
  for (const rule of record.rules) {
    if (
      !rule
      || typeof rule !== "object"
      || Array.isArray(rule)
      || !exactKeys(rule, ["identitySid", "inherited", "accessType", "appliesToSelf", "rights"])
    ) throw new Error("Windows ACL authority inspection was malformed");
    const item = rule as Record<string, unknown>;
    if (
      typeof item.identitySid !== "string"
      || !WINDOWS_SID.test(item.identitySid)
      || typeof item.inherited !== "boolean"
      || (item.accessType !== "allow" && item.accessType !== "deny")
      || typeof item.appliesToSelf !== "boolean"
      || typeof item.rights !== "string"
      || !/^(?:0|[1-9]\d{0,9})$/.test(item.rights)
      || BigInt(item.rights) > 0xffffffffn
    ) throw new Error("Windows ACL authority inspection was malformed");
  }
}

/** Apply the same fail-closed policy to native results and deterministic fixtures. */
export function assertSafeWindowsAuthority(
  inspection: WindowsAuthorityInspection,
  kind: ConnectAuthorityEntryKind,
): void {
  assertWindowsInspectionShape(inspection);
  const trustedOwners = new Set([inspection.currentUserSid, ...WINDOWS_TRUSTED_MUTATORS]);
  const terminal = kind !== "ancestor";
  const protectedTerminal = kind !== "ancestor" && kind !== "home";
  if (
    (terminal && inspection.ownerSid !== inspection.currentUserSid)
    || (!terminal && !trustedOwners.has(inspection.ownerSid))
  ) throw new WindowsAuthorityPolicyError(inspection.index, "OWNER_MISMATCH");
  if (inspection.reparsePoint) {
    throw new WindowsAuthorityPolicyError(inspection.index, "REPARSE_POINT");
  }

  for (const rule of inspection.rules) {
    if (rule.accessType !== "allow" || !rule.appliesToSelf) continue;
    const rights = BigInt(rule.rights);
    if ((rights & ~WINDOWS_KNOWN_ALLOW_RIGHTS) !== 0n) {
      throw new WindowsAuthorityPolicyError(inspection.index, "UNKNOWN_RIGHTS");
    }
    const mutates = (rights & (WINDOWS_MUTATING_RIGHTS | WINDOWS_GENERIC_MUTATING_RIGHTS)) !== 0n;
    if (!mutates) continue;
    // OS ancestry commonly inherits grants for the same narrowly trusted
    // user/SYSTEM/Administrators set. Terminal setup/config entries must be
    // protected and explicit; an ancestor may inherit only those principals.
    if (!trustedOwners.has(rule.identitySid)) {
      throw new WindowsAuthorityPolicyError(inspection.index, "BROAD_WRITE");
    }
    if (protectedTerminal && rule.inherited) {
      throw new WindowsAuthorityPolicyError(inspection.index, "INHERITED_WRITE");
    }
  }
  if (protectedTerminal && !inspection.daclProtected) {
    throw new WindowsAuthorityPolicyError(inspection.index, "DACL_NOT_PROTECTED");
  }
}

const DARWIN_READ_ONLY_ACL_PERMISSIONS = new Set([
  "execute",
  "list",
  "read",
  "readattr",
  "readextattr",
  "readsecurity",
  "search",
  "synchronize",
]);
const DARWIN_MUTATING_ACL_PERMISSIONS = new Set([
  "add_file",
  "add_subdirectory",
  "append",
  "chown",
  "delete",
  "delete_child",
  "write",
  "writeattr",
  "writeextattr",
  "writesecurity",
]);
const DARWIN_ACL_FLAGS = new Set(["directory_inherit", "file_inherit", "inherited", "limit_inherit", "only_inherit"]);

/** Reject malformed ACL output and every ACL allow entry carrying mutation authority. */
export function assertSafeDarwinAclOutput(output: string): void {
  if (!output || Buffer.byteLength(output, "utf8") > 24 * 1024 || output.includes("\0")) {
    throw new Error("Darwin ACL authority inspection was malformed");
  }
  const lines = output.replace(/\n$/, "").split("\n");
  if (!/^!#acl 1(?: (?:defer_inherit|no_inherit)(?:,(?:defer_inherit|no_inherit))*)?$/.test(lines[0])) {
    throw new Error("Darwin ACL authority inspection was malformed");
  }
  for (const line of lines.slice(1)) {
    const fields = line.split(":");
    if (
      fields.length !== 6
      || (fields[0] !== "user" && fields[0] !== "group")
      || !/^[0-9A-F]{8}(?:-[0-9A-F]{4}){3}-[0-9A-F]{12}$/.test(fields[1])
      || fields[2].length > 255
      || !/^(?:|0|[1-9]\d{0,9})$/.test(fields[3])
    ) throw new Error("Darwin ACL authority inspection was malformed");
    const disposition = fields[4].split(",");
    if (disposition[0] !== "allow" && disposition[0] !== "deny") {
      throw new Error("Darwin ACL authority inspection was malformed");
    }
    if (disposition.slice(1).some((flag) => !DARWIN_ACL_FLAGS.has(flag))) {
      throw new Error("Darwin ACL authority inspection was malformed");
    }
    const permissions = fields[5].split(",");
    for (const permission of permissions) {
      if (disposition[0] === "allow" && DARWIN_MUTATING_ACL_PERMISSIONS.has(permission)) {
        throw new Error("Darwin ACL grants unexpected write authority");
      }
      if (!DARWIN_READ_ONLY_ACL_PERMISSIONS.has(permission) && !DARWIN_MUTATING_ACL_PERMISSIONS.has(permission)) {
        throw new Error("Darwin ACL authority inspection was malformed");
      }
    }
  }
}

export async function assertNativeEntryAuthority(
  inspector: ConnectRootAuthorityInspector,
  platform: NodeJS.Platform,
  path: string,
  kind: ConnectAuthorityEntryKind,
  pinnedFd: number,
): Promise<void> {
  const before = stableAuthorityIdentity(pinnedFd);
  if (platform === "darwin") {
    const inspection = inspector.inspectDarwinAcl(path, pinnedFd, before);
    assertDarwinInspectionShape(inspection);
    if (inspection.device !== before.device || inspection.file !== before.file) {
      throw new Error("Darwin authority inspection did not match the pinned object");
    }
    assertSafeDarwinAclOutput(inspection.acl);
  } else if (platform === "win32") {
    const inspection = await inspector.inspectWindowsAcl(path, before, pinnedFd, kind);
    assertWindowsInspectionShape(inspection);
    if (
      inspection.index !== 0
      || inspection.authorityKind !== kind
      || BigInt(inspection.volumeSerialNumber) !== BigInt(inspection.verifiedVolumeSerialNumber)
      || BigInt(inspection.fileId) !== BigInt(inspection.verifiedFileId)
    ) throw new Error("Windows authority inspection did not match the pinned object");
    assertSafeWindowsAuthority(inspection, kind);
  }
  const after = stableAuthorityIdentity(pinnedFd);
  if (before.device !== after.device || before.file !== after.file) {
    throw new Error("native authority target changed during inspection");
  }
}

/** Inspect all Windows entries in one process and bind every result to its held descriptor identity. */
export async function assertNativeWindowsEntriesAuthority(
  inspector: ConnectRootAuthorityInspector,
  entries: readonly { path: string; kind: ConnectAuthorityEntryKind; pinnedFd: number }[],
): Promise<void> {
  const targets = entries.map((entry) => ({
    path: entry.path,
    kind: entry.kind,
    expectedIdentity: stableAuthorityIdentity(entry.pinnedFd),
    pinnedFd: entry.pinnedFd,
  }));
  const batched = inspector.inspectWindowsAcls !== undefined;
  const inspections = inspector.inspectWindowsAcls
    ? await inspector.inspectWindowsAcls(targets)
    : await Promise.all(targets.map((target) => inspector.inspectWindowsAcl(
      target.path, target.expectedIdentity, target.pinnedFd, target.kind,
    )));
  if (inspections.length !== targets.length) throw new Error("Windows ACL authority inspection was malformed");
  for (let index = 0; index < targets.length; index += 1) {
    const target = targets[index];
    const inspection = inspections[index];
    assertWindowsInspectionShape(inspection);
    if (
      inspection.index !== (batched ? index : 0)
      || inspection.authorityKind !== target.kind
      || inspection.kind !== (target.kind === "env" ? "file" : "directory")
      || BigInt(inspection.volumeSerialNumber) !== BigInt(inspection.verifiedVolumeSerialNumber)
      || BigInt(inspection.fileId) !== BigInt(inspection.verifiedFileId)
    ) throw new Error("Windows authority inspection did not match the pinned object");
    assertSafeWindowsAuthority(inspection, target.kind);
    const after = stableAuthorityIdentity(entries[index].pinnedFd);
    if (after.device !== target.expectedIdentity.device || after.file !== target.expectedIdentity.file) {
      throw new Error("native authority target changed during inspection");
    }
  }
}
