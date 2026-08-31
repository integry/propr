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
const WINDOWS_INSPECTION_MAX_BYTES = 128 * 1024;
const WINDOWS_INSPECTION_MAX_ENTRIES = 32;
const GLOBAL_SYSTEM_ROOT = String.raw`\\?\GLOBALROOT\SystemRoot`;

// PowerShell 5.1's Add-Type compiler requires a writable temporary directory.
// Define the fixed P/Invoke surface with Reflection.Emit instead so discovery
// remains entirely in memory and performs no filesystem mutation.
const WINDOWS_INSPECTION_SOURCE = String.raw`
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
Set-StrictMode -Version 2
try {
  if($PSVersionTable.PSVersion.Major-ne 5-or $PSVersionTable.PSVersion.Minor-ne 1-or
     $PSVersionTable.PSEdition-ne 'Desktop'-or -not [Environment]::Is64BitProcess){exit 70}
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
  $winapi=[Runtime.InteropServices.CallingConvention]::Winapi;$cdecl=[Runtime.InteropServices.CallingConvention]::Cdecl
  $intptr=[IntPtr];$intptrRef=$intptr.MakeByRefType();$uint=[uint32];$uintRef=$uint.MakeByRefType();$ushortRef=([uint16]).MakeByRefType()
  Add-NativeMethod '_get_osfhandle' 'msvcrt.dll' $intptr @([int]) $cdecl
  Add-NativeMethod 'GetFileInformationByHandle' 'kernel32.dll' ([bool]) @($intptr,$intptr) $winapi
  Add-NativeMethod 'GetSecurityInfo' 'advapi32.dll' $uint @($intptr,$uint,$uint,$intptrRef,$intptrRef,$intptrRef,$intptrRef,$intptrRef) $winapi
  Add-NativeMethod 'GetSecurityDescriptorControl' 'advapi32.dll' ([bool]) @($intptr,$ushortRef,$uintRef) $winapi
  Add-NativeMethod 'GetAclInformation' 'advapi32.dll' ([bool]) @($intptr,$intptr,$uint,$uint) $winapi
  Add-NativeMethod 'GetAce' 'advapi32.dll' ([bool]) @($intptr,$uint,$intptrRef) $winapi
  Add-NativeMethod 'LocalFree' 'kernel32.dll' $intptr @($intptr) $winapi
  Add-NativeMethod 'CreateJobObject' 'kernel32.dll' $intptr @($intptr,[string]) $winapi
  Add-NativeMethod 'SetInformationJobObject' 'kernel32.dll' ([bool]) @($intptr,[int],$intptr,$uint) $winapi
  Add-NativeMethod 'AssignProcessToJobObject' 'kernel32.dll' ([bool]) @($intptr,$intptr) $winapi
  Add-NativeMethod 'GetCurrentProcess' 'kernel32.dll' $intptr @() $winapi
  $null=$builder.CreateType()
  $job=[ProprReadOnlyAuthority]::CreateJobObject([IntPtr]::Zero,$null)
  if($job-eq [IntPtr]::Zero){exit 70}
  $jobInfo=[Runtime.InteropServices.Marshal]::AllocHGlobal(144)
  for($offset=0;$offset-lt 144;$offset++){[Runtime.InteropServices.Marshal]::WriteByte($jobInfo,$offset,0)}
  [Runtime.InteropServices.Marshal]::WriteInt32($jobInfo,16,0x2000)
  if(-not [ProprReadOnlyAuthority]::SetInformationJobObject($job,9,$jobInfo,144)){exit 70}
  if(-not [ProprReadOnlyAuthority]::AssignProcessToJobObject($job,[ProprReadOnlyAuthority]::GetCurrentProcess())){exit 70}
  $current=[Security.Principal.WindowsIdentity]::GetCurrent().User
  if($null-eq $current){exit 70}
  $currentSid=$current.Value
  $specs=__PROPR_SPECS__
  $entries=New-Object Collections.Generic.List[object]
  $totalAces=0
  foreach($spec in $specs){
    $index=[int]$spec[0];$entryKind=[string]$spec[1];$authorityKind=[string]$spec[2];$fd=3+$index
    $handle=[ProprReadOnlyAuthority]::_get_osfhandle($fd)
    if($handle-eq [IntPtr](-1)-or $handle-eq [IntPtr](-2)-or $handle-eq [IntPtr]::Zero){exit 70}
    $before=[Runtime.InteropServices.Marshal]::AllocHGlobal(52)
    if(-not [ProprReadOnlyAuthority]::GetFileInformationByHandle($handle,$before)){exit 70}
    $owner=[IntPtr]::Zero;$group=[IntPtr]::Zero;$dacl=[IntPtr]::Zero;$sacl=[IntPtr]::Zero;$descriptor=[IntPtr]::Zero
    try {
      if([ProprReadOnlyAuthority]::GetSecurityInfo($handle,1,5,[ref]$owner,[ref]$group,[ref]$dacl,[ref]$sacl,[ref]$descriptor)-ne 0){exit 70}
      if($owner-eq [IntPtr]::Zero-or $dacl-eq [IntPtr]::Zero-or $descriptor-eq [IntPtr]::Zero){exit 70}
      $ownerSid=(New-Object Security.Principal.SecurityIdentifier($owner)).Value
      $control=[uint16]0;$revision=[uint32]0
      if(-not [ProprReadOnlyAuthority]::GetSecurityDescriptorControl($descriptor,[ref]$control,[ref]$revision)){exit 70}
      $aclInfo=[Runtime.InteropServices.Marshal]::AllocHGlobal(12)
      if(-not [ProprReadOnlyAuthority]::GetAclInformation($dacl,$aclInfo,12,2)){exit 70}
      $aceCount=[uint32][Runtime.InteropServices.Marshal]::ReadInt32($aclInfo,0)
      $aclBytes=[uint32][Runtime.InteropServices.Marshal]::ReadInt32($aclInfo,4)
      if($aceCount-gt 128-or $aclBytes-lt 8-or $aclBytes-gt 65535){exit 70}
      $aclRevision=[Runtime.InteropServices.Marshal]::ReadByte($dacl,0)
      if(($aclRevision-ne 2-and $aclRevision-ne 4)-or [Runtime.InteropServices.Marshal]::ReadByte($dacl,1)-ne 0){exit 70}
      $rules=New-Object Collections.Generic.List[object]
      for($aceIndex=0;$aceIndex-lt $aceCount;$aceIndex++){
        $ace=[IntPtr]::Zero
        if(-not [ProprReadOnlyAuthority]::GetAce($dacl,$aceIndex,[ref]$ace)-or $ace-eq [IntPtr]::Zero){exit 70}
        $aceType=[Runtime.InteropServices.Marshal]::ReadByte($ace,0);$flags=[Runtime.InteropServices.Marshal]::ReadByte($ace,1)
        $aceSize=[uint16][Runtime.InteropServices.Marshal]::ReadInt16($ace,2)
        if(($aceType-ne 0-and $aceType-ne 1)-or ($flags-band 0xE0)-ne 0-or $aceSize-lt 16-or $aceSize-gt 4096){exit 70}
        $mask=[uint32][Runtime.InteropServices.Marshal]::ReadInt32($ace,4)
        $sidPointer=[IntPtr]::Add($ace,8);$sid=New-Object Security.Principal.SecurityIdentifier($sidPointer)
        if($sid.BinaryLength-gt ($aceSize-8)){exit 70}
        $rules.Add([pscustomobject][ordered]@{
          identitySid=$sid.Value;inherited=[bool](($flags-band 0x10)-ne 0)
          accessType=$(if($aceType-eq 0){'allow'}else{'deny'});appliesToSelf=[bool](($flags-band 8)-eq 0)
          rights=$mask.ToString([Globalization.CultureInfo]::InvariantCulture)
        })
        $totalAces++;if($totalAces-gt 512){exit 70}
      }
    } finally {if($descriptor-ne [IntPtr]::Zero){$null=[ProprReadOnlyAuthority]::LocalFree($descriptor)}}
    $after=[Runtime.InteropServices.Marshal]::AllocHGlobal(52)
    if(-not [ProprReadOnlyAuthority]::GetFileInformationByHandle($handle,$after)){exit 70}
    $beforeVolume=[uint32][Runtime.InteropServices.Marshal]::ReadInt32($before,28)
    $afterVolume=[uint32][Runtime.InteropServices.Marshal]::ReadInt32($after,28)
    $beforeHigh=[uint32][Runtime.InteropServices.Marshal]::ReadInt32($before,44);$beforeLow=[uint32][Runtime.InteropServices.Marshal]::ReadInt32($before,48)
    $afterHigh=[uint32][Runtime.InteropServices.Marshal]::ReadInt32($after,44);$afterLow=[uint32][Runtime.InteropServices.Marshal]::ReadInt32($after,48)
    $beforeId=([uint64]$beforeHigh*4294967296)+[uint64]$beforeLow
    $afterId=([uint64]$afterHigh*4294967296)+[uint64]$afterLow
    $entries.Add([pscustomobject][ordered]@{
      index=$index;kind=$entryKind;authorityKind=$authorityKind;currentUserSid=$currentSid;ownerSid=$ownerSid
      daclProtected=[bool](($control-band 0x1000)-ne 0);reparsePoint=[bool](([Runtime.InteropServices.Marshal]::ReadInt32($before,0)-band 0x400)-ne 0)
      volumeSerialNumber=$beforeVolume.ToString([Globalization.CultureInfo]::InvariantCulture)
      fileId=$beforeId.ToString([Globalization.CultureInfo]::InvariantCulture)
      verifiedVolumeSerialNumber=$afterVolume.ToString([Globalization.CultureInfo]::InvariantCulture)
      verifiedFileId=$afterId.ToString([Globalization.CultureInfo]::InvariantCulture);rules=@($rules)
    })
  }
  $document=[pscustomobject][ordered]@{version=1;entries=@($entries)}
  $json=ConvertTo-Json $document -Compress -Depth 5
  if([Text.Encoding]::UTF8.GetByteCount($json)-gt 131072){exit 70}
  [Console]::OutputEncoding=New-Object Text.UTF8Encoding($false,$true)
  [Console]::Out.Write($json)
  exit 0
}catch{exit 70}
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
  if (process.platform !== "win32" || process.arch === "ia32") throw new Error("unavailable");
  const suppliedRoot = process.env.SystemRoot;
  const suppliedWindir = process.env.WINDIR;
  if (!suppliedRoot || !suppliedWindir || !ordinaryDosPath(suppliedRoot) || !ordinaryDosPath(suppliedWindir)) {
    throw new Error("unavailable");
  }
  const canonicalSupplied = realpathSync.native(suppliedRoot);
  const canonicalWindir = realpathSync.native(suppliedWindir);
  if (
    !ordinaryDosPath(canonicalSupplied)
    || !sameWindowsPath(canonicalSupplied, canonicalWindir)
    || !sameWindowsPath(suppliedRoot, canonicalSupplied)
    || !sameWindowsPath(suppliedWindir, canonicalWindir)
  ) throw new Error("unavailable");
  const path = win32.join(canonicalSupplied, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const canonicalPath = realpathSync.native(path);
  const named = lstatSync(path, { bigint: true });
  if (!sameWindowsPath(path, canonicalPath) || !named.isFile() || named.isSymbolicLink()) throw new Error("unavailable");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let globalFd: number | undefined;
  try {
    const held = fstatSync(fd, { bigint: true });
    globalFd = openSync(
      `${GLOBAL_SYSTEM_ROOT}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    const global = fstatSync(globalFd, { bigint: true });
    if (!held.isFile() || !global.isFile() || held.dev !== named.dev || held.ino !== named.ino
      || held.dev !== global.dev || held.ino !== global.ino) throw new Error("unavailable");
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
    namedFd = openSync(executable.path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const held = fstatSync(executable.fd, { bigint: true });
    const named = fstatSync(namedFd, { bigint: true });
    if (
      !held.isFile() || !named.isFile()
      || held.dev.toString(10) !== executable.device || held.ino.toString(10) !== executable.file
      || named.dev.toString(10) !== executable.device || named.ino.toString(10) !== executable.file
    ) throw new Error("unavailable");
  } finally {
    if (namedFd !== undefined) closeSync(namedFd);
  }
}

function powershellSpecs(targets: readonly WindowsAuthorityTarget[]): string {
  const records = targets.map((target, index) => {
    const entryKind = target.kind === "env" ? "file" : "directory";
    return `@(${index},'${entryKind}','${target.kind}')`;
  });
  return `@(${records.join(",")})`;
}

function strictUtf8(value: Buffer | string | null | undefined): string {
  const bytes = typeof value === "string" ? Buffer.from(value, "utf8") : (value ?? Buffer.alloc(0));
  if (bytes.byteLength === 0 || bytes.byteLength > WINDOWS_INSPECTION_MAX_BYTES) throw new Error("malformed");
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

export function parseWindowsInspectionDocument(value: Buffer | string): readonly WindowsAuthorityInspection[] {
  const text = strictUtf8(value);
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new Error("malformed"); }
  if (JSON.stringify(parsed) !== text || !parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("malformed");
  }
  const document = parsed as Record<string, unknown>;
  if (Object.keys(document).sort().join(",") !== "entries,version" || document.version !== 1
    || !Array.isArray(document.entries) || document.entries.length > WINDOWS_INSPECTION_MAX_ENTRIES) {
    throw new Error("malformed");
  }
  return document.entries as WindowsAuthorityInspection[];
}

export function runWindowsReadOnlyInspection(
  targets: readonly WindowsAuthorityTarget[],
): readonly WindowsAuthorityInspection[] {
  if (targets.length < 1 || targets.length > WINDOWS_INSPECTION_MAX_ENTRIES) throw new Error("unavailable");
  const executable = resolveWindowsPowerShell();
  try {
    const source = WINDOWS_INSPECTION_SOURCE.replace("__PROPR_SPECS__", powershellSpecs(targets));
    const encoded = Buffer.from(source, "utf16le").toString("base64");
    if (encoded.length > 28_000) throw new Error("unavailable");
    const result = spawnSync(executable.path, [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded,
    ], {
      shell: false,
      windowsHide: true,
      encoding: "buffer",
      cwd: win32.dirname(executable.path),
      env: { SystemRoot: executable.systemRoot, WINDIR: executable.systemRoot },
      timeout: WINDOWS_INSPECTION_TIMEOUT_MS,
      killSignal: "SIGKILL",
      maxBuffer: WINDOWS_INSPECTION_MAX_BYTES,
      stdio: ["ignore", "pipe", "pipe", ...targets.map((target) => target.pinnedFd)],
    });
    revalidateWindowsPowerShell(executable);
    if (result.error || result.signal || result.status !== 0 || (result.stderr?.byteLength ?? 0) !== 0) {
      throw new Error("unavailable");
    }
    return parseWindowsInspectionDocument(result.stdout ?? Buffer.alloc(0));
  } finally {
    closeSync(executable.fd);
  }
}

export function windowsInspectionEntryKind(kind: ConnectAuthorityEntryKind): "directory" | "file" {
  return kind === "env" ? "file" : "directory";
}
