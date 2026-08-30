import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
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
  ): WindowsAuthorityInspection;
  inspectWindowsAcls?(entries: readonly WindowsAuthorityTarget[]): readonly WindowsAuthorityInspection[];
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
  x64: "5d775b1cfb53cbc451c548fba99899b70bd559ef8cbcfb2e25bbef2d137cca9c",
};

const WINDOWS_BOOTSTRAP_TIMEOUT_MS = 10_000;
const WINDOWS_BOOTSTRAP_SCRIPT = String.raw`
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class ProprNative {
  [StructLayout(LayoutKind.Sequential)] public struct FileIdInfo {
    public UInt64 Volume;
    public UInt64 FileIdLow;
    public UInt64 FileIdHigh;
  }
  [StructLayout(LayoutKind.Sequential)] public struct FileAttributeTagInfo {
    public UInt32 FileAttributes;
    public UInt32 ReparseTag;
  }
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]
  public static extern SafeFileHandle CreateFile(string name,uint access,uint share,IntPtr security,uint creation,uint flags,IntPtr template);
  [DllImport("kernel32.dll",SetLastError=true)]
  public static extern bool GetFileInformationByHandleEx(SafeFileHandle handle,int infoClass,out FileIdInfo info,uint size);
  [DllImport("kernel32.dll",EntryPoint="GetFileInformationByHandleEx",SetLastError=true)]
  public static extern bool GetFileAttributesByHandle(SafeFileHandle handle,int infoClass,out FileAttributeTagInfo info,uint size);
  [DllImport("msvcrt.dll",CallingConvention=CallingConvention.Cdecl)]
  public static extern IntPtr _get_osfhandle(int fd);
}
'@
function Fail { [Console]::Out.Write('{"version":1,"error":"unavailable"}'); exit 23 }
function Identity($handle) {
  $value=New-Object ProprNative+FileIdInfo
  if(![ProprNative]::GetFileInformationByHandleEx($handle,18,[ref]$value,24)){throw 'identity'}
  $number=([Numerics.BigInteger]$value.FileIdHigh*[Numerics.BigInteger]::Pow(2,64))+[Numerics.BigInteger]$value.FileIdLow
  $file=$number.ToString([Globalization.CultureInfo]::InvariantCulture)
  return @($value.Volume.ToString([Globalization.CultureInfo]::InvariantCulture),$file)
}
function RequireOrdinary($handle) {
  $value=New-Object ProprNative+FileAttributeTagInfo
  if(![ProprNative]::GetFileAttributesByHandle($handle,9,[ref]$value,8) -or ($value.FileAttributes -band 0x400) -ne 0){throw 'reparse'}
}
function Rule($sid,$directory) {
  $inherit=if($directory){[Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'}else{[Security.AccessControl.InheritanceFlags]::None}
  return [Security.AccessControl.FileSystemAccessRule]::new($sid,[Security.AccessControl.FileSystemRights]::FullControl,$inherit,[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow)
}
function Protect($path,$directory,$owner) {
  $security=if($directory){[Security.AccessControl.DirectorySecurity]::new()}else{[Security.AccessControl.FileSecurity]::new()}
  $security.SetOwner($owner)
  $security.SetAccessRuleProtection($true,$false)
  foreach($text in @($owner.Value,'S-1-5-18','S-1-5-32-544')){
    [void]$security.AddAccessRule((Rule ([Security.Principal.SecurityIdentifier]::new($text)) $directory))
  }
  if($directory){[IO.Directory]::SetAccessControl($path,$security)}else{[IO.File]::SetAccessControl($path,$security)}
}
function Verify($path,$directory,$owner) {
  $security=if($directory){[IO.Directory]::GetAccessControl($path)}else{[IO.File]::GetAccessControl($path)}
  if(!$security.AreAccessRulesProtected -or $security.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $owner.Value){throw 'acl'}
  $rules=@($security.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]))
  if($rules.Count -ne 3){throw 'acl'}
  $expected=@($owner.Value,'S-1-5-18','S-1-5-32-544')
  foreach($rule in $rules){
    if($rule.IsInherited -or $rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or
       [int64]$rule.FileSystemRights -ne 2032127 -or $rule.PropagationFlags -ne [Security.AccessControl.PropagationFlags]::None -or
       $expected -notcontains $rule.IdentityReference.Value){throw 'acl'}
    $flags=[int]$rule.InheritanceFlags
    if(($directory -and $flags -ne 3) -or (!$directory -and $flags -ne 0)){throw 'acl'}
  }
}
function Quote($value) {
  if($value -notmatch '[\s"]'){return $value}
  $builder=[Text.StringBuilder]::new();[void]$builder.Append('"');$slashes=0
  foreach($character in $value.ToCharArray()){
    if($character -eq '\'){$slashes++;continue}
    if($character -eq '"'){[void]$builder.Append(('\' * (2*$slashes+1)));[void]$builder.Append('"')}else{[void]$builder.Append(('\' * $slashes));[void]$builder.Append($character)}
    $slashes=0
  }
  [void]$builder.Append(('\' * (2*$slashes)));[void]$builder.Append('"');return $builder.ToString()
}
function Barrier($name) {
  if($env:PROPR_BOOTSTRAP_BOUNDARY -ne $name){return}
  $ready=$env:PROPR_BOOTSTRAP_READY;$continue=$env:PROPR_BOOTSTRAP_CONTINUE
  if([string]::IsNullOrEmpty($ready) -or [string]::IsNullOrEmpty($continue)){throw 'barrier'}
  [IO.File]::WriteAllText($ready,'ready',[Text.UTF8Encoding]::new($false))
  $watch=[Diagnostics.Stopwatch]::StartNew()
  while(![IO.File]::Exists($continue)){if($watch.ElapsedMilliseconds -gt 2500){throw 'barrier'};[Threading.Thread]::Sleep(10)}
}
try {
  $path=$env:PROPR_BOOTSTRAP_PATH;$directory=[IO.Path]::GetDirectoryName($path);$expected=$env:PROPR_BOOTSTRAP_SHA256
  if([string]::IsNullOrEmpty($path) -or [string]::IsNullOrEmpty($directory) -or $expected -notmatch '^[0-9a-f]{64}$'){throw 'input'}
  $dir=[ProprNative]::CreateFile($directory,0x00020000,1,[IntPtr]::Zero,3,0x02200000,[IntPtr]::Zero)
  if($dir.IsInvalid){throw 'directory'}
  RequireOrdinary $dir
  $file=[IO.FileStream]::new($path,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read,4096,[IO.FileOptions]::SequentialScan)
  RequireOrdinary $file.SafeFileHandle
  $before=Identity $file.SafeFileHandle
  $sha=[Security.Cryptography.SHA256]::Create();$actual=([BitConverter]::ToString($sha.ComputeHash($file))).Replace('-','').ToLowerInvariant();$file.Position=0
  if($actual -cne $expected){throw 'hash'}
  $owner=[Security.Principal.WindowsIdentity]::GetCurrent().User
  Protect $directory $true $owner;Protect $path $false $owner;Verify $directory $true $owner;Verify $path $false $owner
  $locked=Identity $file.SafeFileHandle
  if($before[0] -ne $locked[0] -or $before[1] -ne $locked[1]){throw 'replacement'}
  Barrier 'after-lock'
  $mode=$env:PROPR_BOOTSTRAP_MODE
  if($mode -eq 'inspect'){
    $kinds=@(ConvertFrom-Json $env:PROPR_BOOTSTRAP_KINDS)
    if($kinds.Count -lt 1 -or $kinds.Count -gt 64){throw 'arguments'}
    $arguments=[Collections.Generic.List[string]]::new();$arguments.Add('inspect-parent');$arguments.Add($PID.ToString([Globalization.CultureInfo]::InvariantCulture))
    for($index=0;$index -lt $kinds.Count;$index++){
      if(@('ancestor','home','root','data','env') -notcontains $kinds[$index]){throw 'arguments'}
      $handle=[ProprNative]::_get_osfhandle(3+$index);if($handle -eq [IntPtr](-1)){throw 'handle'}
      $arguments.Add($kinds[$index]);$arguments.Add($handle.ToInt64().ToString([Globalization.CultureInfo]::InvariantCulture))
    }
  } else {
    $arguments=@(ConvertFrom-Json $env:PROPR_BOOTSTRAP_ARGUMENTS)
    if($arguments.Count -lt 1 -or $arguments.Count -gt 130){throw 'arguments'}
  }
  $start=[Diagnostics.ProcessStartInfo]::new();$start.FileName=$path;$start.UseShellExecute=$false;$start.CreateNoWindow=$true;$start.RedirectStandardOutput=$true;$start.RedirectStandardError=$true
  $start.StandardOutputEncoding=[Text.UTF8Encoding]::new($false);$start.StandardErrorEncoding=[Text.UTF8Encoding]::new($false);$start.EnvironmentVariables.Clear()
  $start.Arguments=(@($arguments|ForEach-Object { Quote ([string]$_) }) -join ' ')
  Barrier 'before-launch'
  $process=[Diagnostics.Process]::new();$process.StartInfo=$start;if(!$process.Start()){throw 'launch'}
  Barrier 'during-launch'
  $outTask=$process.StandardOutput.ReadToEndAsync();$errTask=$process.StandardError.ReadToEndAsync()
  if(!$process.WaitForExit(5000)){try{$process.Kill()}catch{};throw 'timeout'};$process.WaitForExit()
  $stdout=$outTask.GetAwaiter().GetResult();$stderr=$errTask.GetAwaiter().GetResult()
  $bytes=[Text.Encoding]::UTF8.GetBytes($stdout)
  if($process.ExitCode -ne 0 -or $bytes.Length -gt 131072 -or [Text.Encoding]::UTF8.GetByteCount($stderr) -gt 131072){throw 'child'}
  $after=Identity $file.SafeFileHandle;$file.Position=0;$finalHash=([BitConverter]::ToString($sha.ComputeHash($file))).Replace('-','').ToLowerInvariant()
  Verify $directory $true $owner;Verify $path $false $owner
  if($before[0] -ne $after[0] -or $before[1] -ne $after[1] -or $finalHash -cne $expected){throw 'replacement'}
  $encoded=[Convert]::ToBase64String($bytes)
  [Console]::Out.Write('{"version":1,"status":0,"stdout":"'+$encoded+'","volumeSerialNumber":"'+$before[0]+'","fileId":"'+$before[1]+'","verifiedVolumeSerialNumber":"'+$after[0]+'","verifiedFileId":"'+$after[1]+'"}')
  $file.Dispose();$dir.Dispose();exit 0
} catch { try{if($file){$file.Dispose()}}catch{};try{if($dir){$dir.Dispose()}}catch{};Fail }
`;
const WINDOWS_BOOTSTRAP_ENCODED = Buffer.from(WINDOWS_BOOTSTRAP_SCRIPT, "utf16le").toString("base64");

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

interface WindowsBootstrapBarrier {
  readonly boundary: "after-lock" | "before-launch" | "during-launch";
  readonly readyPath: string;
  readonly continuePath: string;
}

export interface WindowsAuthorityBootstrapProbe {
  readonly args?: readonly string[];
  readonly barrier?: WindowsBootstrapBarrier;
  readonly onStaged?: (stagedPath: string) => void;
}

function trustedWindowsSystemRoot(): string {
  // uv_os_get_passwd/GetUserProfileDirectoryW backs userInfo(), so this drive
  // does not come from caller-controlled SystemRoot, windir, or USERPROFILE.
  const driveRoot = parse(userInfo().homedir).root;
  if (!/^[A-Za-z]:\\$/.test(driveRoot)) {
    throw new Error("Windows system authority bootstrap is unavailable");
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
    throw new Error("Windows system authority bootstrap is unavailable");
  }
  return systemRoot;
}

function canonicalUint128(value: unknown): value is string {
  return typeof value === "string"
    && /^(?:0|[1-9]\d{0,38})$/.test(value)
    && BigInt(value) <= 0xffffffffffffffffffffffffffffffffn;
}

function runWindowsAuthorityBroker(
  path: string,
  digest: string,
  args: readonly string[],
  targetFds: readonly number[] = [],
  barrier?: WindowsBootstrapBarrier,
): Buffer {
  validateWindowsBrokerPath(path);
  if (!/^[0-9a-f]{64}$/.test(digest) || args.length === 0 || args.length > 130 || targetFds.length > 64) {
    throw new Error("Windows system authority bootstrap is unavailable");
  }
  const inspect = args[0] === "inspect";
  if ((inspect && args.length !== targetFds.length + 1) || (!inspect && targetFds.length !== 0)) {
    throw new Error("Windows system authority bootstrap is unavailable");
  }
  const systemRoot = trustedWindowsSystemRoot();
  const environment: NodeJS.ProcessEnv = {
    SystemRoot: systemRoot,
    PROPR_BOOTSTRAP_PATH: path,
    PROPR_BOOTSTRAP_SHA256: digest,
    PROPR_BOOTSTRAP_MODE: inspect ? "inspect" : "arguments",
    ...(inspect
      ? { PROPR_BOOTSTRAP_KINDS: JSON.stringify(args.slice(1)) }
      : { PROPR_BOOTSTRAP_ARGUMENTS: JSON.stringify(args) }),
    ...(barrier ? {
      PROPR_BOOTSTRAP_BOUNDARY: barrier.boundary,
      PROPR_BOOTSTRAP_READY: barrier.readyPath,
      PROPR_BOOTSTRAP_CONTINUE: barrier.continuePath,
    } : {}),
  };
  const result = spawnSync(join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
    "-EncodedCommand", WINDOWS_BOOTSTRAP_ENCODED,
  ], {
    shell: false,
    windowsHide: true,
    encoding: "buffer",
    env: environment,
    timeout: WINDOWS_BOOTSTRAP_TIMEOUT_MS,
    maxBuffer: NATIVE_INSPECTION_MAX_BYTES * 2,
    stdio: ["ignore", "pipe", "pipe", ...targetFds],
  });
  if (result.status !== 0 || result.error || result.signal) {
    throw new Error("Windows system authority bootstrap is unavailable");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeBoundedUtf8(result.stdout).trim());
  } catch {
    throw new Error("Windows system authority bootstrap was malformed");
  }
  if (
    !parsed
    || typeof parsed !== "object"
    || Array.isArray(parsed)
    || !exactKeys(parsed, [
      "version", "status", "stdout", "volumeSerialNumber", "fileId",
      "verifiedVolumeSerialNumber", "verifiedFileId",
    ])
  ) throw new Error("Windows system authority bootstrap was malformed");
  const document = parsed as Record<string, unknown>;
  if (
    document.version !== 1
    || document.status !== 0
    || typeof document.stdout !== "string"
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(document.stdout)
    || !canonicalUint64(document.volumeSerialNumber)
    || !canonicalUint128(document.fileId)
    || !canonicalUint64(document.verifiedVolumeSerialNumber)
    || !canonicalUint128(document.verifiedFileId)
    || BigInt(document.volumeSerialNumber) !== BigInt(document.verifiedVolumeSerialNumber)
    || BigInt(document.fileId) !== BigInt(document.verifiedFileId)
  ) throw new Error("Windows system authority bootstrap was malformed");
  const output = Buffer.from(document.stdout, "base64");
  if (output.byteLength > NATIVE_INSPECTION_MAX_BYTES || output.toString("base64") !== document.stdout) {
    throw new Error("Windows system authority bootstrap was malformed");
  }
  return output;
}

/** Native-test seam for deterministic staged-name attacks; production callers never use it. */
export function exerciseWindowsAuthorityBootstrapForNativeTest(
  probe: WindowsAuthorityBootstrapProbe,
): Buffer {
  if (process.platform !== "win32") throw new Error("Windows bootstrap probe requires Windows");
  const artifact = authorityBrokerArtifact("win32", process.arch);
  const directory = mkdtempSync(join(tmpdir(), "propr-authority-probe-"));
  const path = join(directory, `broker-${randomUUID()}.exe`);
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR, 0o600);
    let offset = 0;
    while (offset < artifact.bytes.byteLength) {
      const count = writeSync(fd, artifact.bytes, offset, artifact.bytes.byteLength - offset, offset);
      if (count <= 0) throw new Error("Windows bootstrap probe is unavailable");
      offset += count;
    }
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    probe.onStaged?.(path);
    return runWindowsAuthorityBroker(path, artifact.digest, probe.args ?? ["ping"], [], probe.barrier);
  } finally {
    if (fd !== undefined) closeSync(fd);
    closeSync(artifact.fd);
    rmSync(directory, { recursive: true, force: true });
  }
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

function nativeWindowsAcls(entries: readonly WindowsAuthorityTarget[]): readonly WindowsAuthorityInspection[] {
  if (entries.length === 0 || entries.length > 64) {
    throw new Error("Windows ACL authority inspection is unavailable");
  }
  const artifact = authorityBrokerArtifact("win32", process.arch);
  let capability: ReturnType<typeof stageWindowsAuthorityBroker> | undefined;
  const args = ["inspect"];
  let argumentCharacters = args[0].length;
  for (const entry of entries) {
    if (!Number.isInteger(entry.pinnedFd) || entry.pinnedFd < 0) {
      throw new Error("Windows ACL authority inspection is unavailable");
    }
    argumentCharacters += entry.kind.length + 1;
    if (argumentCharacters > 24_000) throw new Error("Windows ACL authority inspection is unavailable");
    args.push(entry.kind);
  }
  let output: Buffer;
  try {
    capability = stageWindowsAuthorityBroker(artifact);
    output = runWindowsAuthorityBroker(
      capability.path,
      artifact.digest,
      args,
      entries.map((entry) => entry.pinnedFd),
    );
    const staged = fstatSync(capability.fd, { bigint: true });
    const named = lstatSync(capability.path, { bigint: true });
    if (
      !staged.isFile()
      || named.isSymbolicLink()
      || staged.dev !== named.dev
      || staged.ino !== named.ino
      || staged.size !== BigInt(artifact.bytes.byteLength)
      || createHash("sha256").update(readExactDescriptor(capability.fd, artifact.bytes.byteLength)).digest("hex") !== artifact.digest
    ) throw new Error("packaged native authority broker was replaced");
    revalidateAuthorityBroker(artifact);
  } finally {
    if (capability !== undefined) {
      closeSync(capability.fd);
      closeSync(capability.directoryFd);
      rmSync(capability.directory, { recursive: true, force: true });
    }
    closeSync(artifact.fd);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeBoundedUtf8(output).trim());
  } catch {
    throw new Error("Windows ACL authority inspection was malformed");
  }
  if (
    !parsed
    || typeof parsed !== "object"
    || Array.isArray(parsed)
    || !exactKeys(parsed, ["version", "entries"])
  ) throw new Error("Windows ACL authority inspection was malformed");
  const document = parsed as Record<string, unknown>;
  if (document.version !== 1 || !Array.isArray(document.entries) || document.entries.length !== entries.length) {
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

function nativeWindowsAcl(
  path: string,
  expectedIdentity: StableAuthorityIdentity,
  pinnedFd?: number,
  kind: ConnectAuthorityEntryKind = "env",
): WindowsAuthorityInspection {
  if (pinnedFd === undefined) throw new Error("Windows ACL authority inspection is unavailable");
  return nativeWindowsAcls([{ path, kind, expectedIdentity, pinnedFd }])[0];
}

/** Establish the same narrowly documented DACL used by a new Windows stack. */
export function protectWindowsSetupEntry(path: string, kind: "directory" | "file"): void {
  protectWindowsSetupEntries([{ path, kind }]);
}

/** Protect a complete setup group in one bounded native broker process. */
export function protectWindowsSetupEntries(
  entries: readonly { readonly path: string; readonly kind: "directory" | "file" }[],
): void {
  if (process.platform !== "win32" || entries.length === 0) return;
  if (entries.length > 64) throw new Error("Windows setup authority could not be established");
  const artifact = authorityBrokerArtifact("win32", process.arch);
  let capability: ReturnType<typeof stageWindowsAuthorityBroker> | undefined;
  const args = ["protect"];
  let argumentCharacters = args[0].length;
  for (const entry of entries) {
    validateWindowsBrokerPath(entry.path);
    argumentCharacters += entry.kind.length + entry.path.length + 2;
    if (argumentCharacters > 24_000) throw new Error("Windows setup authority could not be established");
    args.push(entry.kind, entry.path);
  }
  let output: Buffer;
  try {
    capability = stageWindowsAuthorityBroker(artifact);
    output = runWindowsAuthorityBroker(capability.path, artifact.digest, args);
    revalidateAuthorityBroker(artifact);
  } finally {
    if (capability !== undefined) {
      closeSync(capability.fd);
      closeSync(capability.directoryFd);
      rmSync(capability.directory, { recursive: true, force: true });
    }
    closeSync(artifact.fd);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeBoundedUtf8(output).trim());
  } catch {
    throw new Error("Windows setup authority could not be established");
  }
  if (
    !parsed
    || typeof parsed !== "object"
    || Array.isArray(parsed)
    || !exactKeys(parsed, ["version", "protected"])
    || (parsed as Record<string, unknown>).version !== 1
    || (parsed as Record<string, unknown>).protected !== entries.length
  ) throw new Error("Windows setup authority could not be established");
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

export function assertNativeEntryAuthority(
  inspector: ConnectRootAuthorityInspector,
  platform: NodeJS.Platform,
  path: string,
  kind: ConnectAuthorityEntryKind,
  pinnedFd: number,
): void {
  const before = stableAuthorityIdentity(pinnedFd);
  if (platform === "darwin") {
    const inspection = inspector.inspectDarwinAcl(path, pinnedFd, before);
    assertDarwinInspectionShape(inspection);
    if (inspection.device !== before.device || inspection.file !== before.file) {
      throw new Error("Darwin authority inspection did not match the pinned object");
    }
    assertSafeDarwinAclOutput(inspection.acl);
  } else if (platform === "win32") {
    const inspection = inspector.inspectWindowsAcl(path, before, pinnedFd, kind);
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
export function assertNativeWindowsEntriesAuthority(
  inspector: ConnectRootAuthorityInspector,
  entries: readonly { path: string; kind: ConnectAuthorityEntryKind; pinnedFd: number }[],
): void {
  const targets = entries.map((entry) => ({
    path: entry.path,
    kind: entry.kind,
    expectedIdentity: stableAuthorityIdentity(entry.pinnedFd),
    pinnedFd: entry.pinnedFd,
  }));
  const batched = inspector.inspectWindowsAcls !== undefined;
  const inspections = inspector.inspectWindowsAcls
    ? inspector.inspectWindowsAcls(targets)
    : targets.map((target) => inspector.inspectWindowsAcl(
      target.path, target.expectedIdentity, target.pinnedFd, target.kind,
    ));
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
