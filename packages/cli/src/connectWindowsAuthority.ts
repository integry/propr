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
import type {
  ConnectAuthorityEntryKind,
  WindowsAuthorityInspection,
  WindowsAuthorityTarget,
} from "./connectRootAuthority.js";

const WINDOWS_INSPECTION_TIMEOUT_MS = 5_000;
// These diagnostic-only probes pay the hosted Windows PowerShell cold-start
// cost independently. This does not alter the production inspection bound.
const WINDOWS_HOSTED_ASSUMPTION_TIMEOUT_MS = 15_000;
const WINDOWS_INSPECTION_MAX_BYTES = 128 * 1024;
const WINDOWS_INSPECTION_MAX_ENTRIES = 32;
const GLOBAL_SYSTEM_ROOT = String.raw`\\?\GLOBALROOT\SystemRoot`;

export const WINDOWS_NATIVE_STAGE_CODES = Object.freeze([
  "resolver:env", "resolver:canonical", "resolver:global-open", "resolver:global-id",
  "spawn:create", "spawn:error", "spawn:timeout", "spawn:status", "spawn:stderr",
  "broker:ps-version", "broker:job", "broker:fd", "broker:index-info",
  "broker:security-info", "broker:acl", "broker:json",
  "parent:utf8", "parent:json-shape", "parent:descriptor-bind", "parent:post-bind",
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
export const WINDOWS_INSPECTOR_TRANSPORT = "inherited-standard-handle" as const;

// Reflection.Emit keeps the fixed P/Invoke surface in memory. Add-Type and its
// writable compiler workspace are deliberately absent.
export const WINDOWS_INSPECTION_SOURCE = String.raw`
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
Set-StrictMode -Version 2
$stage=71
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
  $handle=[ProprReadOnlyAuthority]::GetStdHandle(-10)
  if($handle-eq [IntPtr](-1)-or $handle-eq [IntPtr](-2)-or $handle-eq [IntPtr]::Zero){exit $stage}
  $stage=74
  $before=[Runtime.InteropServices.Marshal]::AllocHGlobal(52)
  if(-not [ProprReadOnlyAuthority]::GetFileInformationByHandle($handle,$before)){exit $stage}
  $current=[Security.Principal.WindowsIdentity]::GetCurrent().User
  if($null-eq $current){exit $stage}
  $currentSid=$current.Value
  $stage=75
  $owner=[IntPtr]::Zero;$group=[IntPtr]::Zero;$dacl=[IntPtr]::Zero;$sacl=[IntPtr]::Zero;$descriptor=[IntPtr]::Zero
  try {
    if([ProprReadOnlyAuthority]::GetSecurityInfo($handle,1,5,[ref]$owner,[ref]$group,[ref]$dacl,[ref]$sacl,[ref]$descriptor)-ne 0){exit $stage}
    if($owner-eq [IntPtr]::Zero-or $dacl-eq [IntPtr]::Zero-or $descriptor-eq [IntPtr]::Zero){exit $stage}
    $ownerSid=(New-Object Security.Principal.SecurityIdentifier($owner)).Value
    $control=[uint16]0;$revision=[uint32]0
    if(-not [ProprReadOnlyAuthority]::GetSecurityDescriptorControl($descriptor,[ref]$control,[ref]$revision)){exit $stage}
    $stage=76
    $aclInfo=[Runtime.InteropServices.Marshal]::AllocHGlobal(12)
    if(-not [ProprReadOnlyAuthority]::GetAclInformation($dacl,$aclInfo,12,2)){exit $stage}
    $aceCount=[uint32][Runtime.InteropServices.Marshal]::ReadInt32($aclInfo,0)
    $aclBytes=[uint32][Runtime.InteropServices.Marshal]::ReadInt32($aclInfo,4)
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
      $mask=[uint32][Runtime.InteropServices.Marshal]::ReadInt32($ace,4)
      $sidPointer=[IntPtr]::Add($ace,8);$sid=New-Object Security.Principal.SecurityIdentifier($sidPointer)
      if($sid.BinaryLength-gt ($aceSize-8)){exit $stage}
      $rules.Add([pscustomobject][ordered]@{
        identitySid=$sid.Value;inherited=[bool](($flags-band 0x10)-ne 0)
        accessType=$(if($aceType-eq 0){'allow'}else{'deny'});appliesToSelf=[bool](($flags-band 8)-eq 0)
        rights=$mask.ToString([Globalization.CultureInfo]::InvariantCulture)
      })
    }
  } finally {if($descriptor-ne [IntPtr]::Zero){$null=[ProprReadOnlyAuthority]::LocalFree($descriptor)}}
  $stage=74
  $after=[Runtime.InteropServices.Marshal]::AllocHGlobal(52)
  if(-not [ProprReadOnlyAuthority]::GetFileInformationByHandle($handle,$after)){exit $stage}
  $beforeVolume=[uint32][Runtime.InteropServices.Marshal]::ReadInt32($before,28)
  $afterVolume=[uint32][Runtime.InteropServices.Marshal]::ReadInt32($after,28)
  $beforeHigh=[uint32][Runtime.InteropServices.Marshal]::ReadInt32($before,44);$beforeLow=[uint32][Runtime.InteropServices.Marshal]::ReadInt32($before,48)
  $afterHigh=[uint32][Runtime.InteropServices.Marshal]::ReadInt32($after,44);$afterLow=[uint32][Runtime.InteropServices.Marshal]::ReadInt32($after,48)
  $beforeId=([uint64]$beforeHigh*4294967296)+[uint64]$beforeLow
  $afterId=([uint64]$afterHigh*4294967296)+[uint64]$afterLow
  $entry=[pscustomobject][ordered]@{
    index=__PROPR_INDEX__;kind='__PROPR_ENTRY_KIND__';authorityKind='__PROPR_AUTHORITY_KIND__';currentUserSid=$currentSid;ownerSid=$ownerSid
    daclProtected=[bool](($control-band 0x1000)-ne 0);reparsePoint=[bool](([Runtime.InteropServices.Marshal]::ReadInt32($before,0)-band 0x400)-ne 0)
    volumeSerialNumber=$beforeVolume.ToString([Globalization.CultureInfo]::InvariantCulture)
    fileId=$beforeId.ToString([Globalization.CultureInfo]::InvariantCulture)
    verifiedVolumeSerialNumber=$afterVolume.ToString([Globalization.CultureInfo]::InvariantCulture)
    verifiedFileId=$afterId.ToString([Globalization.CultureInfo]::InvariantCulture);rules=@($rules)
  }
  $stage=77
  $json=ConvertTo-Json ([pscustomobject][ordered]@{version=1;entries=@($entry)}) -Compress -Depth 5
  if([Text.Encoding]::UTF8.GetByteCount($json)-gt 131072){exit $stage}
  [Console]::OutputEncoding=New-Object Text.UTF8Encoding($false,$true)
  [Console]::Out.Write($json)
  exit 0
}catch{exit $stage}
`;

const WINDOWS_EXTRA_STDIO_ASSUMPTION_SOURCE = String.raw`
$ErrorActionPreference='Stop';Set-StrictMode -Version 2
try {
  $assembly=[AppDomain]::CurrentDomain.DefineDynamicAssembly((New-Object Reflection.AssemblyName('ProprExtraStdioAssumptionAssembly')),[Reflection.Emit.AssemblyBuilderAccess]::Run)
  $module=$assembly.DefineDynamicModule('ProprExtraStdioAssumptionModule');$builder=$module.DefineType('ProprExtraStdioAssumption',[Reflection.TypeAttributes]'Public,Abstract,Sealed')
  function Add-NativeMethod($name,$library,$returnType,[Type[]]$parameters,$convention){$method=$builder.DefinePInvokeMethod($name,$library,[Reflection.MethodAttributes]'Public,Static,PinvokeImpl',[Reflection.CallingConventions]::Standard,$returnType,$parameters,$convention,[Runtime.InteropServices.CharSet]::Unicode);$method.SetImplementationFlags($method.GetMethodImplementationFlags()-bor [Reflection.MethodImplAttributes]::PreserveSig)}
  $winapi=[Runtime.InteropServices.CallingConvention]::Winapi;$cdecl=[Runtime.InteropServices.CallingConvention]::Cdecl;$intptr=[IntPtr]
  Add-NativeMethod '_get_osfhandle' 'msvcrt.dll' $intptr @([int]) $cdecl
  Add-NativeMethod 'GetFileInformationByHandle' 'kernel32.dll' ([bool]) @($intptr,$intptr) $winapi
  $null=$builder.CreateType()
  $fdHandle=[ProprExtraStdioAssumption]::_get_osfhandle(3);$info=[Runtime.InteropServices.Marshal]::AllocHGlobal(52)
  $extraStdio=if($fdHandle-ne [IntPtr](-1)-and $fdHandle-ne [IntPtr](-2)-and $fdHandle-ne [IntPtr]::Zero-and [ProprExtraStdioAssumption]::GetFileInformationByHandle($fdHandle,$info)){'usable'}else{'unusable'}
  $json=ConvertTo-Json ([pscustomobject][ordered]@{version=1;extraStdio=$extraStdio}) -Compress
  [Console]::OutputEncoding=New-Object Text.UTF8Encoding($false,$true);[Console]::Out.Write($json);exit 0
}catch{exit 81}
`;

const WINDOWS_JOB_CONTAINMENT_ASSUMPTION_SOURCE = String.raw`
$ErrorActionPreference='Stop';Set-StrictMode -Version 2
try {
  $assembly=[AppDomain]::CurrentDomain.DefineDynamicAssembly((New-Object Reflection.AssemblyName('ProprJobContainmentAssumptionAssembly')),[Reflection.Emit.AssemblyBuilderAccess]::Run)
  $module=$assembly.DefineDynamicModule('ProprJobContainmentAssumptionModule');$builder=$module.DefineType('ProprJobContainmentAssumption',[Reflection.TypeAttributes]'Public,Abstract,Sealed')
  function Add-NativeMethod($name,$library,$returnType,[Type[]]$parameters,$convention){$method=$builder.DefinePInvokeMethod($name,$library,[Reflection.MethodAttributes]'Public,Static,PinvokeImpl',[Reflection.CallingConventions]::Standard,$returnType,$parameters,$convention,[Runtime.InteropServices.CharSet]::Unicode);$method.SetImplementationFlags($method.GetMethodImplementationFlags()-bor [Reflection.MethodImplAttributes]::PreserveSig)}
  $winapi=[Runtime.InteropServices.CallingConvention]::Winapi;$intptr=[IntPtr];$boolRef=([bool]).MakeByRefType()
  Add-NativeMethod 'IsProcessInJob' 'kernel32.dll' ([bool]) @($intptr,$intptr,$boolRef) $winapi
  Add-NativeMethod 'GetCurrentProcess' 'kernel32.dll' $intptr @() $winapi
  $null=$builder.CreateType()
  $contained=$false
  if(-not [ProprJobContainmentAssumption]::IsProcessInJob([ProprJobContainmentAssumption]::GetCurrentProcess(),[IntPtr]::Zero,[ref]$contained)){exit 82}
  $json=ConvertTo-Json ([pscustomobject][ordered]@{version=1;alreadyContained=[bool]$contained}) -Compress
  [Console]::OutputEncoding=New-Object Text.UTF8Encoding($false,$true);[Console]::Out.Write($json);exit 0
}catch{exit 82}
`;

// This process is intentionally sacrificial: no other observation depends on
// it producing JSON after assigning itself to a kill-on-close job.
const WINDOWS_NESTED_JOB_ASSUMPTION_SOURCE = String.raw`
$ErrorActionPreference='Stop';Set-StrictMode -Version 2
try {
  $assembly=[AppDomain]::CurrentDomain.DefineDynamicAssembly((New-Object Reflection.AssemblyName('ProprNestedJobAssumptionAssembly')),[Reflection.Emit.AssemblyBuilderAccess]::Run)
  $module=$assembly.DefineDynamicModule('ProprNestedJobAssumptionModule');$builder=$module.DefineType('ProprNestedJobAssumption',[Reflection.TypeAttributes]'Public,Abstract,Sealed')
  function Add-NativeMethod($name,$library,$returnType,[Type[]]$parameters,$convention){$method=$builder.DefinePInvokeMethod($name,$library,[Reflection.MethodAttributes]'Public,Static,PinvokeImpl',[Reflection.CallingConventions]::Standard,$returnType,$parameters,$convention,[Runtime.InteropServices.CharSet]::Unicode);$method.SetImplementationFlags($method.GetMethodImplementationFlags()-bor [Reflection.MethodImplAttributes]::PreserveSig)}
  $winapi=[Runtime.InteropServices.CallingConvention]::Winapi;$intptr=[IntPtr]
  Add-NativeMethod 'CreateJobObject' 'kernel32.dll' $intptr @($intptr,[string]) $winapi
  Add-NativeMethod 'SetInformationJobObject' 'kernel32.dll' ([bool]) @($intptr,[int],$intptr,[uint32]) $winapi
  Add-NativeMethod 'AssignProcessToJobObject' 'kernel32.dll' ([bool]) @($intptr,$intptr) $winapi
  Add-NativeMethod 'GetCurrentProcess' 'kernel32.dll' $intptr @() $winapi
  $null=$builder.CreateType()
  $job=[ProprNestedJobAssumption]::CreateJobObject([IntPtr]::Zero,$null);if($job-eq [IntPtr]::Zero){exit 83}
  $jobInfo=[Runtime.InteropServices.Marshal]::AllocHGlobal(144);for($offset=0;$offset-lt 144;$offset++){[Runtime.InteropServices.Marshal]::WriteByte($jobInfo,$offset,0)}
  [Runtime.InteropServices.Marshal]::WriteInt32($jobInfo,16,0x2000)
  if(-not [ProprNestedJobAssumption]::SetInformationJobObject($job,9,$jobInfo,144)){exit 83}
  if(-not [ProprNestedJobAssumption]::AssignProcessToJobObject($job,[ProprNestedJobAssumption]::GetCurrentProcess())){exit 83}
  exit 0
}catch{exit 83}
`;

interface HeldExecutable {
  readonly path: string;
  readonly systemRoot: string;
  readonly fd: number;
  readonly device: string;
  readonly file: string;
}

export interface WindowsHostedAssumptionProof {
  readonly version: 1;
  readonly extraStdio: "usable" | "unusable" | "timeout";
  readonly alreadyContained: boolean | "failed" | "timeout";
  readonly nestedJob: "succeeded" | "failed" | "timeout";
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
  try { parsed = JSON.parse(text); } catch { throw stageError("parent:json-shape"); }
  if (JSON.stringify(parsed) !== text || !parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw stageError("parent:json-shape");
  }
  const document = parsed as Record<string, unknown>;
  if (Object.keys(document).sort().join(",") !== "entries,version" || document.version !== 1
    || !Array.isArray(document.entries) || document.entries.length > WINDOWS_INSPECTION_MAX_ENTRIES) {
    throw stageError("parent:json-shape");
  }
  return document.entries as WindowsAuthorityInspection[];
}

function brokerFailureStage(status: number | null): WindowsNativeStageCode {
  const stages: Readonly<Record<number, WindowsNativeStageCode>> = {
    71: "broker:ps-version", 72: "broker:job", 73: "broker:fd", 74: "broker:index-info",
    75: "broker:security-info", 76: "broker:acl", 77: "broker:json",
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

function spawnPowerShell(
  executable: HeldExecutable,
  source: string,
  stdin: "ignore" | number,
  extraFd?: number,
  timeout = WINDOWS_INSPECTION_TIMEOUT_MS,
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
      env: { SystemRoot: executable.systemRoot, WINDIR: executable.systemRoot },
      timeout,
      killSignal: "SIGKILL",
      maxBuffer: WINDOWS_INSPECTION_MAX_BYTES,
      stdio: extraFd === undefined ? [stdin, "pipe", "pipe"] : [stdin, "pipe", "pipe", extraFd],
    });
  } catch { throw stageError("spawn:create"); }
}

interface HostedProbeProcessResult {
  readonly error?: Error;
  readonly signal: NodeJS.Signals | null;
  readonly status: number | null;
  readonly stdout?: Buffer | string | null;
  readonly stderr?: Buffer | string | null;
}

function byteLength(value: Buffer | string | null | undefined): number {
  return typeof value === "string" ? Buffer.byteLength(value, "utf8") : (value?.byteLength ?? 0);
}

function hostedProbeDisposition(result: HostedProbeProcessResult): "complete" | "failed" | "timeout" {
  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code;
    if (code === "ETIMEDOUT") return "timeout";
    if (code === "ENOBUFS") return "failed";
    throw stageError("spawn:error");
  }
  if (result.signal || result.status !== 0 || byteLength(result.stderr) !== 0) return "failed";
  return "complete";
}

function hostedProbeDocument(result: HostedProbeProcessResult): Record<string, unknown> | null {
  const bytes = typeof result.stdout === "string"
    ? Buffer.from(result.stdout, "utf8")
    : (result.stdout ?? Buffer.alloc(0));
  if (bytes.byteLength === 0 || bytes.byteLength > WINDOWS_INSPECTION_MAX_BYTES) return null;
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { return null; }
  try {
    const parsed: unknown = JSON.parse(text);
    if (JSON.stringify(parsed) !== text || !parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch { return null; }
}

export function interpretWindowsHostedAssumptionResults(
  extraStdioResult: HostedProbeProcessResult,
  containmentResult: HostedProbeProcessResult,
  nestedJobResult: HostedProbeProcessResult,
): WindowsHostedAssumptionProof {
  const extraDisposition = hostedProbeDisposition(extraStdioResult);
  const containmentDisposition = hostedProbeDisposition(containmentResult);
  const nestedDisposition = hostedProbeDisposition(nestedJobResult);
  const extraDocument = extraDisposition === "complete" ? hostedProbeDocument(extraStdioResult) : null;
  const containmentDocument = containmentDisposition === "complete" ? hostedProbeDocument(containmentResult) : null;
  const extraStdio = extraDisposition === "timeout"
    ? "timeout"
    : (extraDocument
      && Object.keys(extraDocument).sort().join(",") === "extraStdio,version"
      && extraDocument.version === 1
      && (extraDocument.extraStdio === "usable" || extraDocument.extraStdio === "unusable")
      ? extraDocument.extraStdio
      : "unusable");
  const alreadyContained = containmentDisposition === "timeout"
    ? "timeout"
    : (containmentDocument
      && Object.keys(containmentDocument).sort().join(",") === "alreadyContained,version"
      && containmentDocument.version === 1
      && typeof containmentDocument.alreadyContained === "boolean"
      ? containmentDocument.alreadyContained
      : "failed");
  const nestedJob = nestedDisposition === "timeout"
    ? "timeout"
    : (nestedDisposition === "complete" && byteLength(nestedJobResult.stdout) === 0 ? "succeeded" : "failed");
  return { version: 1, extraStdio, alreadyContained, nestedJob };
}

function assertSpawnSuccess(result: ReturnType<typeof spawnSync>): void {
  if (result.error) {
    if ((result.error as NodeJS.ErrnoException).code === "ETIMEDOUT") throw stageError("spawn:timeout");
    throw stageError("spawn:error");
  }
  if (result.signal) throw stageError(result.signal === "SIGKILL" ? "spawn:timeout" : "spawn:status");
  if (result.status !== 0) throw stageError(brokerFailureStage(result.status));
  const stderrBytes = typeof result.stderr === "string"
    ? Buffer.byteLength(result.stderr, "utf8")
    : (result.stderr?.byteLength ?? 0);
  if (stderrBytes !== 0) throw stageError("spawn:stderr");
}

export function runWindowsReadOnlyInspection(
  targets: readonly WindowsAuthorityTarget[],
): readonly WindowsAuthorityInspection[] {
  if (targets.length < 1 || targets.length > WINDOWS_INSPECTION_MAX_ENTRIES) {
    throw stageError("parent:json-shape");
  }
  const executable = resolveWindowsPowerShell();
  const inspections: WindowsAuthorityInspection[] = [];
  let totalOutputBytes = 0;
  try {
    for (let index = 0; index < targets.length; index += 1) {
      const target = targets[index];
      const result = spawnPowerShell(executable, inspectionSource(target, index), target.pinnedFd);
      assertSpawnSuccess(result);
      totalOutputBytes += typeof result.stdout === "string"
        ? Buffer.byteLength(result.stdout, "utf8")
        : (result.stdout?.byteLength ?? 0);
      if (totalOutputBytes > WINDOWS_INSPECTION_MAX_BYTES) throw stageError("parent:utf8");
      const entries = parseWindowsInspectionDocument(result.stdout ?? Buffer.alloc(0));
      if (entries.length !== 1) throw stageError("parent:json-shape");
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

export function runWindowsHostedAssumptionProbe(targetFd: number): WindowsHostedAssumptionProof {
  const executable = resolveWindowsPowerShell();
  try {
    const extraStdioResult = spawnPowerShell(
      executable, WINDOWS_EXTRA_STDIO_ASSUMPTION_SOURCE, "ignore", targetFd,
      WINDOWS_HOSTED_ASSUMPTION_TIMEOUT_MS,
    );
    const containmentResult = spawnPowerShell(
      executable, WINDOWS_JOB_CONTAINMENT_ASSUMPTION_SOURCE, "ignore", undefined,
      WINDOWS_HOSTED_ASSUMPTION_TIMEOUT_MS,
    );
    const nestedJobResult = spawnPowerShell(
      executable, WINDOWS_NESTED_JOB_ASSUMPTION_SOURCE, "ignore", undefined,
      WINDOWS_HOSTED_ASSUMPTION_TIMEOUT_MS,
    );
    const proof = interpretWindowsHostedAssumptionResults(extraStdioResult, containmentResult, nestedJobResult);
    revalidateWindowsPowerShell(executable);
    return proof;
  } finally {
    closeSync(executable.fd);
  }
}

export function windowsInspectionEntryKind(kind: ConnectAuthorityEntryKind): "directory" | "file" {
  return kind === "env" ? "file" : "directory";
}
