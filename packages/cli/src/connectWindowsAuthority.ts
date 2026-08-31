import { spawnSync } from "node:child_process";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  realpathSync,
} from "node:fs";
import { win32 } from "node:path";
import { performance } from "node:perf_hooks";
import type {
  ConnectAuthorityEntryKind,
  WindowsAuthorityInspection,
  WindowsAuthorityTarget,
} from "./connectRootAuthority.js";

// Hosted alternate-user Windows can spend more than fifteen seconds entering
// the fixed PowerShell/Reflection.Emit boundary. Each production call gets one
// bounded cold-start allowance. The cumulative cap is a fixed four-process
// proof ceiling and is independent of the 32-entry input-schema bound.
export const WINDOWS_INSPECTION_TIMEOUT_MS = 60_000;
export const WINDOWS_INSPECTION_CUMULATIVE_TIMEOUT_MS = 240_000;
export const WINDOWS_NATIVE_TIMING_PROBE_TIMEOUT_MS = 60_000;
const WINDOWS_INSPECTION_MAX_BYTES = 128 * 1024;
const WINDOWS_NATIVE_PROBE_MAX_BYTES = 2 * 1024;
const WINDOWS_INSPECTION_MAX_ENTRIES = 32;
const GLOBAL_SYSTEM_ROOT = String.raw`\\?\GLOBALROOT\SystemRoot`;

export const WINDOWS_NATIVE_STAGE_CODES = Object.freeze([
  "resolver:env", "resolver:canonical", "resolver:global-open", "resolver:global-id",
  "spawn:create", "spawn:error", "spawn:timeout", "spawn:cumulative-timeout", "spawn:status", "spawn:stderr",
  "probe:entry", "probe:baseline", "probe:reflection-emit", "probe:win32", "probe:standard-handle", "probe:output",
  "broker:ps-version", "broker:job", "broker:fd", "broker:fd-duplicate", "broker:index-info-initial",
  "broker:security-info", "broker:acl", "broker:json", "broker:current-user-sid",
  "broker:index-info-revalidation", "broker:index-info-decode", "broker:index-info-compose", "broker:entry-format",
  "broker:entry-flags", "broker:entry-rules", "broker:entry-build",
  "parent:utf8", "parent:json-parse", "parent:json-canonical", "parent:document-shape",
  "parent:entry-count", "parent:entry-shape", "parent:json-shape", "parent:descriptor-bind", "parent:post-bind",
] as const);

export type WindowsNativeStageCode = (typeof WINDOWS_NATIVE_STAGE_CODES)[number];

const WINDOWS_NATIVE_STAGE_SET: ReadonlySet<string> = new Set(WINDOWS_NATIVE_STAGE_CODES);
const WINDOWS_NATIVE_DIAGNOSTIC_HOOK = Symbol.for("propr.test.windowsNativeDiagnostic");

export class WindowsNativeStageError extends Error {
  constructor(readonly stage: WindowsNativeStageCode) {
    super("Windows native authority inspection failed");
    this.name = "WindowsNativeStageError";
  }
}

export function reportWindowsNativeStage(stage: WindowsNativeStageCode): void {
  if (!WINDOWS_NATIVE_STAGE_SET.has(stage)) return;
  const hook = (globalThis as Record<symbol, unknown>)[WINDOWS_NATIVE_DIAGNOSTIC_HOOK];
  if (typeof hook !== "function") return;
  try { (hook as (value: string) => void)(stage); } catch { /* Diagnostics never alter production status. */ }
}

function stageError(stage: WindowsNativeStageCode): WindowsNativeStageError {
  return new WindowsNativeStageError(stage);
}

// Each production inspector receives exactly one already-open target as its
// standard-input HANDLE. Unlike Node extra stdio slots, STARTF_USESTDHANDLES is
// a documented Windows process boundary and GetStdHandle returns the inherited
// HANDLE directly. The script contains no process-creation API or external
// command; terminating powershell.exe therefore terminates the complete tree.
export const WINDOWS_INSPECTOR_CREATES_CHILD_PROCESSES = false;
export const WINDOWS_INSPECTOR_WRITES_FILESYSTEM = false;
export const WINDOWS_INSPECTOR_TRANSPORT = "inherited-standard-handle" as const;

export const WINDOWS_UNSIGNED_FIELD_DECODER_SOURCE = String.raw`
function Read-ProprUInt32([IntPtr]$pointer,[int]$offset){
  if(-not [BitConverter]::IsLittleEndian){exit $stage}
  $signed=[int32][Runtime.InteropServices.Marshal]::ReadInt32($pointer,$offset)
  $bytes=[BitConverter]::GetBytes($signed)
  [BitConverter]::ToUInt32($bytes,0)
}`;

export const WINDOWS_UINT64_COMPOSER_SOURCE = String.raw`
function Join-ProprUInt64([uint32]$low,[uint32]$high){
  if(-not [BitConverter]::IsLittleEndian){exit $stage}
  $bytes=New-Object byte[] 8
  [Array]::Copy([BitConverter]::GetBytes([uint32]$low),0,$bytes,0,4)
  [Array]::Copy([BitConverter]::GetBytes([uint32]$high),0,$bytes,4,4)
  [BitConverter]::ToUInt64($bytes,0)
}`;

// Reflection.Emit keeps the fixed P/Invoke surface in memory. Add-Type and its
// writable compiler workspace are deliberately absent.
export const WINDOWS_INSPECTION_SOURCE = String.raw`
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
Set-StrictMode -Version 2
${WINDOWS_UNSIGNED_FIELD_DECODER_SOURCE}
${WINDOWS_UINT64_COMPOSER_SOURCE}
$stage=71
$privateHandle=[IntPtr]::Zero
$privateHandleOwned=$false
try {
  if($PSVersionTable.PSVersion.Major-ne 5-or $PSVersionTable.PSVersion.Minor-ne 1-or
     $PSVersionTable.PSEdition-ne 'Desktop'-or -not [Environment]::Is64BitProcess){exit $stage}
  $assembly=[AppDomain]::CurrentDomain.DefineDynamicAssembly(
    (New-Object Reflection.AssemblyName('ProprReadOnlyAuthorityAssembly')),
    [Reflection.Emit.AssemblyBuilderAccess]::Run)
  $module=$assembly.DefineDynamicModule('ProprReadOnlyAuthorityModule')
  $builder=$module.DefineType('ProprReadOnlyAuthority',[Reflection.TypeAttributes]'Public,Abstract,Sealed')
  function Add-NativeMethod($name,$library,$returnType,[Type[]]$parameters,$nativeConvention){
    $method=$builder.DefinePInvokeMethod($name,$library,
      [Reflection.MethodAttributes]'Public,Static,PinvokeImpl',[Reflection.CallingConventions]::Standard,
      $returnType,$parameters,$nativeConvention,[Runtime.InteropServices.CharSet]::Unicode)
    $method.SetImplementationFlags($method.GetMethodImplementationFlags()-bor [Reflection.MethodImplAttributes]::PreserveSig)
  }
  $winapi=[Runtime.InteropServices.CallingConvention]::Winapi
  $intptr=[IntPtr];$intptrRef=$intptr.MakeByRefType();$uint=[uint32];$uintRef=$uint.MakeByRefType();$ushortRef=([uint16]).MakeByRefType();$boolRef=([bool]).MakeByRefType()
  Add-NativeMethod 'GetStdHandle' 'kernel32.dll' $intptr @([int]) $winapi
  Add-NativeMethod 'DuplicateHandle' 'kernel32.dll' ([bool]) @($intptr,$intptr,$intptr,$intptrRef,$uint,[bool],$uint) $winapi
  Add-NativeMethod 'CloseHandle' 'kernel32.dll' ([bool]) @($intptr) $winapi
  Add-NativeMethod 'GetFileInformationByHandle' 'kernel32.dll' ([bool]) @($intptr,$intptr) $winapi
  Add-NativeMethod 'GetSecurityInfo' 'advapi32.dll' $uint @($intptr,$uint,$uint,$intptrRef,$intptrRef,$intptrRef,$intptrRef,$intptrRef) $winapi
  Add-NativeMethod 'GetSecurityDescriptorControl' 'advapi32.dll' ([bool]) @($intptr,$ushortRef,$uintRef) $winapi
  Add-NativeMethod 'GetAclInformation' 'advapi32.dll' ([bool]) @($intptr,$intptr,$uint,$uint) $winapi
  Add-NativeMethod 'GetAce' 'advapi32.dll' ([bool]) @($intptr,$uint,$intptrRef) $winapi
  Add-NativeMethod 'LocalFree' 'kernel32.dll' $intptr @($intptr) $winapi
  Add-NativeMethod 'IsProcessInJob' 'kernel32.dll' ([bool]) @($intptr,$intptr,$boolRef) $winapi
  Add-NativeMethod 'GetCurrentProcess' 'kernel32.dll' $intptr @() $winapi
  $null=$builder.CreateType()
  $stage=72
  $inJob=$false
  if(-not [ProprReadOnlyAuthority]::IsProcessInJob([ProprReadOnlyAuthority]::GetCurrentProcess(),[IntPtr]::Zero,[ref]$inJob)){exit $stage}
  $stage=73
  $originalHandle=[ProprReadOnlyAuthority]::GetStdHandle(-10)
  if($originalHandle-eq [IntPtr](-1)-or $originalHandle-eq [IntPtr](-2)-or $originalHandle-eq [IntPtr]::Zero){exit $stage}
  $stage=80
  if(-not [ProprReadOnlyAuthority]::DuplicateHandle(
    [ProprReadOnlyAuthority]::GetCurrentProcess(),$originalHandle,
    [ProprReadOnlyAuthority]::GetCurrentProcess(),[ref]$privateHandle,0,$false,2)){exit $stage}
  $privateHandleOwned=$true
  if($privateHandle-eq [IntPtr](-1)-or $privateHandle-eq [IntPtr](-2)-or $privateHandle-eq [IntPtr]::Zero){exit $stage}
  $stage=74
  $before=[Runtime.InteropServices.Marshal]::AllocHGlobal(52)
  if(-not [ProprReadOnlyAuthority]::GetFileInformationByHandle($privateHandle,$before)){exit $stage}
  $stage=78
  $current=[Security.Principal.WindowsIdentity]::GetCurrent().User
  if($null-eq $current){exit $stage}
  $currentSid=$current.Value
  $stage=75
  $owner=[IntPtr]::Zero;$group=[IntPtr]::Zero;$dacl=[IntPtr]::Zero;$sacl=[IntPtr]::Zero;$descriptor=[IntPtr]::Zero
  try {
    if([ProprReadOnlyAuthority]::GetSecurityInfo($privateHandle,1,5,[ref]$owner,[ref]$group,[ref]$dacl,[ref]$sacl,[ref]$descriptor)-ne 0){exit $stage}
    if($owner-eq [IntPtr]::Zero-or $dacl-eq [IntPtr]::Zero-or $descriptor-eq [IntPtr]::Zero){exit $stage}
    $ownerSid=(New-Object Security.Principal.SecurityIdentifier($owner)).Value
    $control=[uint16]0;$revision=[uint32]0
    if(-not [ProprReadOnlyAuthority]::GetSecurityDescriptorControl($descriptor,[ref]$control,[ref]$revision)){exit $stage}
    $stage=76
    $aclInfo=[Runtime.InteropServices.Marshal]::AllocHGlobal(12)
    if(-not [ProprReadOnlyAuthority]::GetAclInformation($dacl,$aclInfo,12,2)){exit $stage}
    $aceCount=Read-ProprUInt32 $aclInfo 0
    $aclBytes=Read-ProprUInt32 $aclInfo 4
    if($aceCount-gt 128-or $aclBytes-lt 8-or $aclBytes-gt 65535){exit $stage}
    $aclRevision=[Runtime.InteropServices.Marshal]::ReadByte($dacl,0)
    if(($aclRevision-ne 2-and $aclRevision-ne 4)-or [Runtime.InteropServices.Marshal]::ReadByte($dacl,1)-ne 0){exit $stage}
    $rules=New-Object Collections.Generic.List[object]
    for($aceIndex=0;$aceIndex-lt $aceCount;$aceIndex++){
      $ace=[IntPtr]::Zero
      if(-not [ProprReadOnlyAuthority]::GetAce($dacl,$aceIndex,[ref]$ace)-or $ace-eq [IntPtr]::Zero){exit $stage}
      $aceType=[Runtime.InteropServices.Marshal]::ReadByte($ace,0);$flags=[Runtime.InteropServices.Marshal]::ReadByte($ace,1)
      $aceSize=[uint16][Runtime.InteropServices.Marshal]::ReadInt16($ace,2)
      if(($aceType-ne 0-and $aceType-ne 1)-or ($flags-band 0xE0)-ne 0-or $aceSize-lt 16-or $aceSize-gt 4096){exit $stage}
      $mask=Read-ProprUInt32 $ace 4
      $sidPointer=[IntPtr]::Add($ace,8);$sid=New-Object Security.Principal.SecurityIdentifier($sidPointer)
      if($sid.BinaryLength-gt ($aceSize-8)){exit $stage}
      $rules.Add([pscustomobject][ordered]@{
        identitySid=$sid.Value;inherited=[bool](($flags-band 0x10)-ne 0)
        accessType=$(if($aceType-eq 0){'allow'}else{'deny'});appliesToSelf=[bool](($flags-band 8)-eq 0)
        rights=$mask.ToString([Globalization.CultureInfo]::InvariantCulture)
      })
    }
  } finally {if($descriptor-ne [IntPtr]::Zero){$null=[ProprReadOnlyAuthority]::LocalFree($descriptor)}}
  $stage=79
  $after=[Runtime.InteropServices.Marshal]::AllocHGlobal(52)
  if(-not [ProprReadOnlyAuthority]::GetFileInformationByHandle($privateHandle,$after)){exit $stage}
  $stage=81
  $beforeVolume=Read-ProprUInt32 $before 28
  $afterVolume=Read-ProprUInt32 $after 28
  $beforeHigh=Read-ProprUInt32 $before 44;$beforeLow=Read-ProprUInt32 $before 48
  $afterHigh=Read-ProprUInt32 $after 44;$afterLow=Read-ProprUInt32 $after 48
  $stage=82
  $beforeId=Join-ProprUInt64 $beforeLow $beforeHigh
  if($beforeId-isnot [uint64]){exit $stage}
  $afterId=Join-ProprUInt64 $afterLow $afterHigh
  if($afterId-isnot [uint64]){exit $stage}
  $stage=84
  $beforeVolumeDecimal=$beforeVolume.ToString([Globalization.CultureInfo]::InvariantCulture)
  $afterVolumeDecimal=$afterVolume.ToString([Globalization.CultureInfo]::InvariantCulture)
  $beforeIdDecimal=$beforeId.ToString([Globalization.CultureInfo]::InvariantCulture)
  $afterIdDecimal=$afterId.ToString([Globalization.CultureInfo]::InvariantCulture)
  if($beforeVolumeDecimal-isnot [string]-or $beforeVolumeDecimal.Length-eq 0-or $beforeVolumeDecimal.Length-gt 10-or $beforeVolumeDecimal-cnotmatch '^(0|[1-9][0-9]*)$'){exit $stage}
  if($afterVolumeDecimal-isnot [string]-or $afterVolumeDecimal.Length-eq 0-or $afterVolumeDecimal.Length-gt 10-or $afterVolumeDecimal-cnotmatch '^(0|[1-9][0-9]*)$'){exit $stage}
  if($beforeIdDecimal-isnot [string]-or $beforeIdDecimal.Length-eq 0-or $beforeIdDecimal.Length-gt 20-or $beforeIdDecimal-cnotmatch '^(0|[1-9][0-9]*)$'){exit $stage}
  if($afterIdDecimal-isnot [string]-or $afterIdDecimal.Length-eq 0-or $afterIdDecimal.Length-gt 20-or $afterIdDecimal-cnotmatch '^(0|[1-9][0-9]*)$'){exit $stage}
  $stage=85
  $daclProtected=[bool](($control-band 0x1000)-ne 0)
  $reparsePoint=[bool](([Runtime.InteropServices.Marshal]::ReadInt32($before,0)-band 0x400)-ne 0)
  if($daclProtected-isnot [bool]-or $reparsePoint-isnot [bool]){exit $stage}
  $stage=86
  [object[]]$rulesArray=$rules.ToArray()
  if($rulesArray-isnot [object[]]-or $rulesArray.Count-ne $rules.Count-or $rulesArray.Count-gt 128){exit $stage}
  for($ruleIndex=0;$ruleIndex-lt $rulesArray.Count;$ruleIndex++){
    if(-not [object]::ReferenceEquals($rulesArray[$ruleIndex],$rules[$ruleIndex])){exit $stage}
  }
  $stage=83
  $entry=[pscustomobject][ordered]@{
    index=__PROPR_INDEX__;kind='__PROPR_ENTRY_KIND__';authorityKind='__PROPR_AUTHORITY_KIND__';currentUserSid=$currentSid;ownerSid=$ownerSid
    daclProtected=$daclProtected;reparsePoint=$reparsePoint
    volumeSerialNumber=$beforeVolumeDecimal
    fileId=$beforeIdDecimal
    verifiedVolumeSerialNumber=$afterVolumeDecimal
    verifiedFileId=$afterIdDecimal;rules=$rulesArray
  }
  $stage=77
  $json=ConvertTo-Json ([pscustomobject][ordered]@{version=1;entries=@($entry)}) -Compress -Depth 5
  if([Text.Encoding]::UTF8.GetByteCount($json)-gt 131072){exit $stage}
  [Console]::OutputEncoding=New-Object Text.UTF8Encoding($false,$true)
  [Console]::Out.Write($json)
  exit 0
}catch{exit $stage}
finally {if($privateHandleOwned){$null=[ProprReadOnlyAuthority]::CloseHandle($privateHandle)}}
`;

export const WINDOWS_NATIVE_PROBE_MILESTONES = Object.freeze([
  "entry-ps51-desktop-x64",
  "constant-json",
  "reflection-emit",
  "harmless-win32",
  "standard-handle-identity",
] as const);

export type WindowsNativeProbeMilestone = (typeof WINDOWS_NATIVE_PROBE_MILESTONES)[number];

export const WINDOWS_NATIVE_TIMING_BUCKETS = Object.freeze([
  "under-5s", "5-to-15s", "15-to-30s", "30-to-45s", "45-to-60s", "at-least-60s",
] as const);

export type WindowsNativeTimingBucket = (typeof WINDOWS_NATIVE_TIMING_BUCKETS)[number];

export const WINDOWS_NATIVE_TIMING_PROBE_SOURCE = String.raw`
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
Set-StrictMode -Version 2
${WINDOWS_UNSIGNED_FIELD_DECODER_SOURCE}
${WINDOWS_UINT64_COMPOSER_SOURCE}
$clock=[Diagnostics.Stopwatch]::StartNew()
function Write-ProprMilestone([string]$name){
  $elapsed=$clock.ElapsedMilliseconds
  $bucket=if($elapsed-lt 5000){'under-5s'}elseif($elapsed-lt 15000){'5-to-15s'}elseif($elapsed-lt 30000){'15-to-30s'}elseif($elapsed-lt 45000){'30-to-45s'}elseif($elapsed-lt 60000){'45-to-60s'}else{'at-least-60s'}
  [Console]::Out.WriteLine(('PROPR_NATIVE_PROBE_V1|{0}|{1}' -f $name,$bucket))
  [Console]::Out.Flush()
}
$stage=91
try {
  if($PSVersionTable.PSVersion.Major-ne 5-or $PSVersionTable.PSVersion.Minor-ne 1-or
     $PSVersionTable.PSEdition-ne 'Desktop'-or -not [Environment]::Is64BitProcess){exit $stage}
  Write-ProprMilestone 'entry-ps51-desktop-x64'
  $stage=92
  $baseline='{"version":1,"baseline":"constant"}'
  if($baseline-ne '{"version":1,"baseline":"constant"}'){exit $stage}
  Write-ProprMilestone 'constant-json'
  $stage=93
  $assembly=[AppDomain]::CurrentDomain.DefineDynamicAssembly(
    (New-Object Reflection.AssemblyName('ProprNativeTimingProbeAssembly')),
    [Reflection.Emit.AssemblyBuilderAccess]::Run)
  $module=$assembly.DefineDynamicModule('ProprNativeTimingProbeModule')
  $builder=$module.DefineType('ProprNativeTimingProbe',[Reflection.TypeAttributes]'Public,Abstract,Sealed')
  function Add-ProprNativeMethod($name,$returnType,[Type[]]$parameters){
    $method=$builder.DefinePInvokeMethod($name,'kernel32.dll',
      [Reflection.MethodAttributes]'Public,Static,PinvokeImpl',[Reflection.CallingConventions]::Standard,
      $returnType,$parameters,[Runtime.InteropServices.CallingConvention]::Winapi,[Runtime.InteropServices.CharSet]::Unicode)
    $method.SetImplementationFlags($method.GetMethodImplementationFlags()-bor [Reflection.MethodImplAttributes]::PreserveSig)
  }
  $intptr=[IntPtr]
  Add-ProprNativeMethod 'GetCurrentProcessId' ([uint32]) @()
  Add-ProprNativeMethod 'GetStdHandle' $intptr @([int])
  Add-ProprNativeMethod 'GetFileInformationByHandle' ([bool]) @($intptr,$intptr)
  $null=$builder.CreateType()
  Write-ProprMilestone 'reflection-emit'
  $stage=94
  if([ProprNativeTimingProbe]::GetCurrentProcessId()-eq 0){exit $stage}
  Write-ProprMilestone 'harmless-win32'
  $stage=95
  $handle=[ProprNativeTimingProbe]::GetStdHandle(-10)
  if($handle-eq [IntPtr](-1)-or $handle-eq [IntPtr](-2)-or $handle-eq [IntPtr]::Zero){exit $stage}
  $info=[Runtime.InteropServices.Marshal]::AllocHGlobal(52)
  if(-not [ProprNativeTimingProbe]::GetFileInformationByHandle($handle,$info)){exit $stage}
  $probeVolume=Read-ProprUInt32 $info 28
  $probeHigh=Read-ProprUInt32 $info 44;$probeLow=Read-ProprUInt32 $info 48
  $probeId=Join-ProprUInt64 $probeLow $probeHigh
  if($probeId-isnot [uint64]){exit $stage}
  $probeVolumeDecimal=$probeVolume.ToString([Globalization.CultureInfo]::InvariantCulture)
  $probeIdDecimal=$probeId.ToString([Globalization.CultureInfo]::InvariantCulture)
  if($probeVolumeDecimal-isnot [string]-or $probeVolumeDecimal.Length-eq 0-or $probeVolumeDecimal.Length-gt 10-or $probeVolumeDecimal-cnotmatch '^(0|[1-9][0-9]*)$'){exit $stage}
  if($probeIdDecimal-isnot [string]-or $probeIdDecimal.Length-eq 0-or $probeIdDecimal.Length-gt 20-or $probeIdDecimal-cnotmatch '^(0|[1-9][0-9]*)$'){exit $stage}
  Write-ProprMilestone 'standard-handle-identity'
  exit 0
}catch{exit $stage}
`;

interface HeldExecutable {
  readonly path: string;
  readonly systemRoot: string;
  readonly fd: number;
  readonly device: string;
  readonly file: string;
}

function sameWindowsPath(left: string, right: string): boolean {
  return win32.normalize(left).toLowerCase() === win32.normalize(right).toLowerCase();
}

function ordinaryDosPath(value: string): boolean {
  return value.length >= 4
    && value.length < 32_768
    && /^[A-Za-z]:\\[^\0\r\n]+$/.test(value)
    && !value.split("\\").some((part) => part === "." || part === "..");
}

function resolveWindowsPowerShell(): HeldExecutable {
  if (process.platform !== "win32" || process.arch === "ia32") throw stageError("resolver:env");
  const suppliedRoot = process.env.SystemRoot;
  const suppliedWindir = process.env.WINDIR;
  if (!suppliedRoot || !suppliedWindir || !ordinaryDosPath(suppliedRoot) || !ordinaryDosPath(suppliedWindir)) {
    throw stageError("resolver:env");
  }
  let canonicalSupplied: string;
  let canonicalWindir: string;
  try {
    canonicalSupplied = realpathSync.native(suppliedRoot);
    canonicalWindir = realpathSync.native(suppliedWindir);
  } catch { throw stageError("resolver:canonical"); }
  if (
    !ordinaryDosPath(canonicalSupplied)
    || !sameWindowsPath(canonicalSupplied, canonicalWindir)
    || !sameWindowsPath(suppliedRoot, canonicalSupplied)
    || !sameWindowsPath(suppliedWindir, canonicalWindir)
  ) throw stageError("resolver:canonical");
  const path = win32.join(canonicalSupplied, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  let canonicalPath: string;
  try { canonicalPath = realpathSync.native(path); } catch { throw stageError("resolver:canonical"); }
  let named: ReturnType<typeof lstatSync>;
  try { named = lstatSync(path, { bigint: true }); } catch { throw stageError("resolver:canonical"); }
  if (!sameWindowsPath(path, canonicalPath) || !named.isFile() || named.isSymbolicLink()) {
    throw stageError("resolver:canonical");
  }
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); } catch { throw stageError("resolver:canonical"); }
  let globalFd: number | undefined;
  try {
    const held = fstatSync(fd, { bigint: true });
    try {
      globalFd = openSync(
        `${GLOBAL_SYSTEM_ROOT}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
    } catch { throw stageError("resolver:global-open"); }
    const global = fstatSync(globalFd, { bigint: true });
    if (!held.isFile() || !global.isFile() || held.dev !== named.dev || held.ino !== named.ino
      || held.dev !== global.dev || held.ino !== global.ino) throw stageError("resolver:global-id");
    return { path, systemRoot: canonicalSupplied, fd, device: held.dev.toString(10), file: held.ino.toString(10) };
  } catch (error) {
    closeSync(fd);
    throw error;
  } finally {
    if (globalFd !== undefined) closeSync(globalFd);
  }
}

function revalidateWindowsPowerShell(executable: HeldExecutable): void {
  let namedFd: number | undefined;
  try {
    try { namedFd = openSync(executable.path, constants.O_RDONLY | constants.O_NOFOLLOW); } catch {
      throw stageError("resolver:global-id");
    }
    const held = fstatSync(executable.fd, { bigint: true });
    const named = fstatSync(namedFd, { bigint: true });
    if (
      !held.isFile() || !named.isFile()
      || held.dev.toString(10) !== executable.device || held.ino.toString(10) !== executable.file
      || named.dev.toString(10) !== executable.device || named.ino.toString(10) !== executable.file
    ) throw stageError("resolver:global-id");
  } finally {
    if (namedFd !== undefined) closeSync(namedFd);
  }
}

function strictUtf8(value: Buffer | string | null | undefined): string {
  const bytes = typeof value === "string" ? Buffer.from(value, "utf8") : (value ?? Buffer.alloc(0));
  if (bytes.byteLength === 0 || bytes.byteLength > WINDOWS_INSPECTION_MAX_BYTES) {
    throw stageError("parent:utf8");
  }
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch {
    throw stageError("parent:utf8");
  }
}

export function parseWindowsInspectionDocument(value: Buffer | string): readonly WindowsAuthorityInspection[] {
  const text = strictUtf8(value);
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw stageError("parent:json-parse"); }
  if (JSON.stringify(parsed) !== text) throw stageError("parent:json-canonical");
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw stageError("parent:document-shape");
  }
  const document = parsed as Record<string, unknown>;
  if (Object.keys(document).sort().join(",") !== "entries,version" || document.version !== 1
    || !Array.isArray(document.entries) || document.entries.length > WINDOWS_INSPECTION_MAX_ENTRIES) {
    throw stageError("parent:document-shape");
  }
  return document.entries as WindowsAuthorityInspection[];
}

export function windowsBrokerFailureStage(status: number | null): WindowsNativeStageCode {
  const stages: Readonly<Record<number, WindowsNativeStageCode>> = {
    71: "broker:ps-version", 72: "broker:job", 73: "broker:fd", 74: "broker:index-info-initial",
    75: "broker:security-info", 76: "broker:acl", 77: "broker:json",
    78: "broker:current-user-sid", 79: "broker:index-info-revalidation", 80: "broker:fd-duplicate",
    81: "broker:index-info-decode", 82: "broker:index-info-compose", 83: "broker:entry-build",
    84: "broker:entry-format", 85: "broker:entry-flags", 86: "broker:entry-rules",
  };
  return status === null ? "spawn:status" : (stages[status] ?? "spawn:status");
}

function inspectionSource(target: WindowsAuthorityTarget, index: number): string {
  const entryKind = target.kind === "env" ? "file" : "directory";
  return WINDOWS_INSPECTION_SOURCE
    .replace("__PROPR_INDEX__", String(index))
    .replace("__PROPR_ENTRY_KIND__", entryKind)
    .replace("__PROPR_AUTHORITY_KIND__", target.kind);
}

/** The fixed inspector receives no caller-controlled executable/module/profile/temp authority. */
export function windowsPowerShellEnvironment(systemRoot: string): Readonly<Record<string, string>> {
  if (!ordinaryDosPath(systemRoot)) throw stageError("resolver:env");
  return Object.freeze({ SystemRoot: systemRoot, WINDIR: systemRoot });
}

function spawnPowerShell(
  executable: HeldExecutable,
  source: string,
  stdin: "ignore" | number,
  timeout = WINDOWS_INSPECTION_TIMEOUT_MS,
  maxBuffer = WINDOWS_INSPECTION_MAX_BYTES,
) {
  const encoded = Buffer.from(source, "utf16le").toString("base64");
  if (encoded.length > 28_000) throw stageError("spawn:create");
  try {
    return spawnSync(executable.path, [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded,
    ], {
      shell: false,
      windowsHide: true,
      encoding: "buffer",
      cwd: win32.dirname(executable.path),
      env: windowsPowerShellEnvironment(executable.systemRoot),
      timeout,
      killSignal: "SIGKILL",
      maxBuffer,
      stdio: [stdin, "pipe", "pipe"],
    });
  } catch { throw stageError("spawn:create"); }
}

export interface WindowsNativeProbeRecord {
  readonly milestone: WindowsNativeProbeMilestone;
  readonly timingBucket: WindowsNativeTimingBucket;
}

export interface WindowsNativeTimingProof {
  readonly version: 1;
  readonly outcome: "complete" | "timeout";
  readonly lastMilestone: WindowsNativeProbeMilestone | "none";
  readonly timingBucket: WindowsNativeTimingBucket;
  /** Present only after complete strict-prefix validation; timeout diagnostics retain only the last token. */
  readonly milestones: readonly WindowsNativeProbeRecord[];
}

export function windowsNativeTimingBucket(elapsedMs: number): WindowsNativeTimingBucket {
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) throw stageError("probe:output");
  if (elapsedMs < 5_000) return "under-5s";
  if (elapsedMs < 15_000) return "5-to-15s";
  if (elapsedMs < 30_000) return "15-to-30s";
  if (elapsedMs < 45_000) return "30-to-45s";
  if (elapsedMs < 60_000) return "45-to-60s";
  return "at-least-60s";
}

export function parseWindowsNativeProbeOutput(
  value: Buffer | string | null | undefined,
  allowTruncatedFinalToken = false,
): readonly WindowsNativeProbeRecord[] {
  const bytes = typeof value === "string"
    ? Buffer.from(value, "utf8")
    : (value ?? Buffer.alloc(0));
  if (bytes.byteLength > WINDOWS_NATIVE_PROBE_MAX_BYTES) throw stageError("probe:output");
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch {
    throw stageError("probe:output");
  }
  if (text.length === 0) return [];
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  else if (allowTruncatedFinalToken) lines.pop();
  else throw stageError("probe:output");
  if (lines.length > WINDOWS_NATIVE_PROBE_MILESTONES.length) throw stageError("probe:output");
  const records: WindowsNativeProbeRecord[] = [];
  let priorBucket = -1;
  for (let index = 0; index < lines.length; index += 1) {
    const milestone = WINDOWS_NATIVE_PROBE_MILESTONES[index];
    const prefix = `PROPR_NATIVE_PROBE_V1|${milestone}|`;
    if (!lines[index].startsWith(prefix)) throw stageError("probe:output");
    const timingBucket = lines[index].slice(prefix.length);
    const bucketIndex = (WINDOWS_NATIVE_TIMING_BUCKETS as readonly string[]).indexOf(timingBucket);
    if (bucketIndex < priorBucket || bucketIndex < 0) throw stageError("probe:output");
    priorBucket = bucketIndex;
    records.push({ milestone, timingBucket: timingBucket as WindowsNativeTimingBucket });
  }
  return records;
}

function assertSpawnSuccess(result: ReturnType<typeof spawnSync>): void {
  if (result.error) {
    if ((result.error as NodeJS.ErrnoException).code === "ETIMEDOUT") throw stageError("spawn:timeout");
    throw stageError("spawn:error");
  }
  if (result.signal) throw stageError(result.signal === "SIGKILL" ? "spawn:timeout" : "spawn:status");
  if (result.status !== 0) throw stageError(windowsBrokerFailureStage(result.status));
  const stderrBytes = typeof result.stderr === "string"
    ? Buffer.byteLength(result.stderr, "utf8")
    : (result.stderr?.byteLength ?? 0);
  if (stderrBytes !== 0) throw stageError("spawn:stderr");
}

export function windowsInspectionTimeoutForElapsed(elapsedMs: number): number {
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) throw stageError("spawn:cumulative-timeout");
  const remaining = WINDOWS_INSPECTION_CUMULATIVE_TIMEOUT_MS - Math.floor(elapsedMs);
  if (remaining <= 0) throw stageError("spawn:cumulative-timeout");
  return Math.min(WINDOWS_INSPECTION_TIMEOUT_MS, remaining);
}

export function runWindowsReadOnlyInspection(
  targets: readonly WindowsAuthorityTarget[],
): readonly WindowsAuthorityInspection[] {
  if (targets.length < 1 || targets.length > WINDOWS_INSPECTION_MAX_ENTRIES) {
    throw stageError("parent:entry-count");
  }
  const executable = resolveWindowsPowerShell();
  const inspections: WindowsAuthorityInspection[] = [];
  let totalOutputBytes = 0;
  const inspectionStarted = performance.now();
  try {
    for (let index = 0; index < targets.length; index += 1) {
      const target = targets[index];
      const timeout = windowsInspectionTimeoutForElapsed(performance.now() - inspectionStarted);
      const result = spawnPowerShell(executable, inspectionSource(target, index), target.pinnedFd, timeout);
      assertSpawnSuccess(result);
      totalOutputBytes += typeof result.stdout === "string"
        ? Buffer.byteLength(result.stdout, "utf8")
        : (result.stdout?.byteLength ?? 0);
      if (totalOutputBytes > WINDOWS_INSPECTION_MAX_BYTES) throw stageError("parent:utf8");
      const entries = parseWindowsInspectionDocument(result.stdout ?? Buffer.alloc(0));
      if (entries.length !== 1) throw stageError("parent:entry-count");
      const entry = entries[0];
      try {
        if (
          entry.index !== index
          || entry.kind !== (target.kind === "env" ? "file" : "directory")
          || entry.authorityKind !== target.kind
          || BigInt(entry.volumeSerialNumber) !== BigInt(target.expectedIdentity.device)
          || BigInt(entry.fileId) !== BigInt(target.expectedIdentity.file)
          || BigInt(entry.volumeSerialNumber) !== BigInt(entry.verifiedVolumeSerialNumber)
          || BigInt(entry.fileId) !== BigInt(entry.verifiedFileId)
        ) throw new Error();
      } catch { throw stageError("parent:descriptor-bind"); }
      const after = fstatSync(target.pinnedFd, { bigint: true });
      if (after.dev.toString(10) !== target.expectedIdentity.device || after.ino.toString(10) !== target.expectedIdentity.file) {
        throw stageError("parent:post-bind");
      }
      inspections.push(entry);
    }
    revalidateWindowsPowerShell(executable);
    return inspections;
  } finally {
    closeSync(executable.fd);
  }
}

function probeFailureStage(status: number | null): WindowsNativeStageCode {
  const stages: Readonly<Record<number, WindowsNativeStageCode>> = {
    91: "probe:entry",
    92: "probe:baseline",
    93: "probe:reflection-emit",
    94: "probe:win32",
    95: "probe:standard-handle",
  };
  return status === null ? "spawn:status" : (stages[status] ?? "spawn:status");
}

export function runWindowsNativeTimingProbe(targetFd: number): WindowsNativeTimingProof {
  const executable = resolveWindowsPowerShell();
  try {
    const started = performance.now();
    const result = spawnPowerShell(
      executable,
      WINDOWS_NATIVE_TIMING_PROBE_SOURCE,
      targetFd,
      WINDOWS_NATIVE_TIMING_PROBE_TIMEOUT_MS,
      WINDOWS_NATIVE_PROBE_MAX_BYTES,
    );
    const elapsed = performance.now() - started;
    const timedOut = (result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT";
    const records = parseWindowsNativeProbeOutput(result.stdout, timedOut);
    const stderrBytes = typeof result.stderr === "string"
      ? Buffer.byteLength(result.stderr, "utf8")
      : (result.stderr?.byteLength ?? 0);
    if (stderrBytes !== 0) throw stageError("spawn:stderr");
    if (timedOut) {
      const proof: WindowsNativeTimingProof = {
        version: 1,
        outcome: "timeout",
        lastMilestone: records.at(-1)?.milestone ?? "none",
        timingBucket: windowsNativeTimingBucket(elapsed),
        milestones: [],
      };
      revalidateWindowsPowerShell(executable);
      return proof;
    }
    if (result.error) throw stageError("spawn:error");
    if (result.signal) throw stageError("spawn:status");
    if (result.status !== 0) throw stageError(probeFailureStage(result.status));
    if (
      records.length !== WINDOWS_NATIVE_PROBE_MILESTONES.length
      || records.some((record, index) => record.milestone !== WINDOWS_NATIVE_PROBE_MILESTONES[index])
    ) throw stageError("probe:output");
    const proof: WindowsNativeTimingProof = {
      version: 1,
      outcome: "complete",
      lastMilestone: "standard-handle-identity",
      // Script buckets separate the in-process stages; this parent bucket also
      // includes executable startup before the first token can be written.
      timingBucket: windowsNativeTimingBucket(elapsed),
      milestones: records,
    };
    revalidateWindowsPowerShell(executable);
    return proof;
  } finally {
    closeSync(executable.fd);
  }
}

export function windowsInspectionEntryKind(kind: ConnectAuthorityEntryKind): "directory" | "file" {
  return kind === "env" ? "file" : "directory";
}
