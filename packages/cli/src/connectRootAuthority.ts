import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
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
  x64: "2ba903761156ef39235347998201710335ebe4fc97e51420ed1d117d384ce1d7",
};

const WINDOWS_BOOTSTRAP_TIMEOUT_MS = 10_000;
const WINDOWS_BROKER_BATCH_TIMEOUT_MS = 5_000;
const WINDOWS_CAPABILITY_EXCHANGE_TIMEOUT_MS = 2_500;
const WINDOWS_CAPABILITY_STOP_TIMEOUT_MS = 2_500;
const WINDOWS_BROKER_REQUEST_MAX_BYTES = 4 * 1024;
const WINDOWS_CAPABILITY_RESPONSE_MAX_BYTES = 4 * 1024;
const WINDOWS_CAPABILITY_CLIENT_SCRIPT = String.raw`
const fs=require('node:fs');const net=require('node:net');
const path=process.env.PROPR_CAPABILITY_PIPE;
const request=process.env.PROPR_CAPABILITY_REQUEST;
if(!path||!request||Buffer.byteLength(request,'ascii')>512)process.exit(20);
let size=0;const chunks=[];let finished=false;
const finish=(code)=>{if(finished)return;finished=true;clearTimeout(deadline);if(code===0)fs.writeSync(1,Buffer.concat(chunks));process.exit(code)};
const socket=net.createConnection(path);
const deadline=setTimeout(()=>{socket.destroy();finish(21)},1500);
socket.once('connect',()=>socket.end(request+'\n','ascii'));
socket.on('data',(chunk)=>{size+=chunk.length;if(size>4096){socket.destroy();finish(22);return}chunks.push(chunk)});
socket.once('end',()=>finish(0));
socket.once('error',()=>finish(23));
`;
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
  [DllImport("kernel32.dll",SetLastError=true)]
  public static extern IntPtr OpenProcess(uint access,bool inherit,uint processId);
  [DllImport("kernel32.dll",SetLastError=true)]
  public static extern uint WaitForSingleObject(IntPtr handle,uint milliseconds);
  [DllImport("kernel32.dll",SetLastError=true)]
  public static extern bool CloseHandle(IntPtr handle);
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
function CapabilityMac($key,$value) {
  $algorithm=[Security.Cryptography.HMACSHA256]::new($key)
  try{return ([BitConverter]::ToString($algorithm.ComputeHash([Text.Encoding]::UTF8.GetBytes($value)))).Replace('-','').ToLowerInvariant()}
  finally{$algorithm.Dispose()}
}
function FixedHexEqual($left,$right) {
  if($left.Length -ne 64 -or $right.Length -ne 64){return $false}
  $difference=0
  for($index=0;$index -lt 64;$index++){$difference=$difference -bor (([int][char]$left[$index]) -bxor ([int][char]$right[$index]))}
  return $difference -eq 0
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
  if($mode -eq 'hold'){
    $pipeName=$env:PROPR_CAPABILITY_PIPE;$parentNonce=$env:PROPR_CAPABILITY_NONCE;$parentText=$env:PROPR_CAPABILITY_PARENT
    if($pipeName -cnotmatch '^propr-authority-[0-9a-f]{64}$' -or $parentNonce -cnotmatch '^[0-9a-f]{64}$' -or
       $parentText -notmatch '^[1-9][0-9]{0,9}$'){throw 'hold'}
    $parent=[ProprNative]::OpenProcess(0x00100000,$false,[uint32]$parentText);if($parent -eq [IntPtr]::Zero){throw 'parent'}
    Barrier 'during-startup'
    $after=Identity $file.SafeFileHandle;$file.Position=0;$finalHash=([BitConverter]::ToString($sha.ComputeHash($file))).Replace('-','').ToLowerInvariant()
    Verify $directory $true $owner;Verify $path $false $owner
    if($before[0] -ne $after[0] -or $before[1] -ne $after[1] -or $finalHash -cne $expected){throw 'replacement'}
    $pipeSecurity=[IO.Pipes.PipeSecurity]::new();$pipeSecurity.SetOwner($owner);$pipeSecurity.SetAccessRuleProtection($true,$false)
    foreach($text in @($owner.Value,'S-1-5-18','S-1-5-32-544')){
      $sid=[Security.Principal.SecurityIdentifier]::new($text)
      $rule=[IO.Pipes.PipeAccessRule]::new($sid,[IO.Pipes.PipeAccessRights]::FullControl,[Security.AccessControl.AccessControlType]::Allow)
      [void]$pipeSecurity.AddAccessRule($rule)
    }
    $capabilityKey=New-Object byte[] 32
    for($index=0;$index -lt 32;$index++){$capabilityKey[$index]=[Convert]::ToByte($parentNonce.Substring(2*$index,2),16)}
    $sequence=0;$stopping=$false
    while(!$stopping -and [ProprNative]::WaitForSingleObject($parent,0) -eq 258){
      $pipe=[IO.Pipes.NamedPipeServerStream]::new($pipeName,[IO.Pipes.PipeDirection]::InOut,1,[IO.Pipes.PipeTransmissionMode]::Byte,[IO.Pipes.PipeOptions]::Asynchronous,4096,4096,$pipeSecurity)
      try {
        $pending=$pipe.BeginWaitForConnection($null,$null)
        try {
          while(!$pending.AsyncWaitHandle.WaitOne(50)){
            if([ProprNative]::WaitForSingleObject($parent,0) -ne 258){throw 'parent'}
          }
          $pipe.EndWaitForConnection($pending)
        } finally { try{$pending.AsyncWaitHandle.Close()}catch{} }
        $bytes=[Collections.Generic.List[byte]]::new();$complete=$false
        while(!$complete){
          $chunk=New-Object byte[] 128;$reading=$pipe.BeginRead($chunk,0,$chunk.Length,$null,$null)
          try {
            if(!$reading.AsyncWaitHandle.WaitOne(1000)){throw 'protocol'}
            $count=$pipe.EndRead($reading);if($count -le 0){throw 'protocol'}
          } finally { try{$reading.AsyncWaitHandle.Close()}catch{} }
          for($index=0;$index -lt $count;$index++){
            $value=$chunk[$index]
            if($value -eq 10){if($index -ne $count-1){throw 'protocol'};$complete=$true;break}
            if($value -lt 0x20 -or $value -gt 0x7e -or $bytes.Count -ge 512){throw 'protocol'}
            $bytes.Add($value)
          }
        }
        $request=[Text.Encoding]::ASCII.GetString($bytes.ToArray());$parts=$request.Split([char]'|')
        if($parts.Count -ne 4 -or $parts[0] -cne 'PROPR_CAPABILITY_V1' -or $parts[1] -cnotmatch '^[0-9a-f]{64}$' -or
           ($parts[2] -cne 'challenge' -and $parts[2] -cne 'stop') -or $parts[3] -cnotmatch '^[0-9a-f]{64}$'){continue}
        $requestMac=CapabilityMac $capabilityKey ('request|'+$parts[1]+'|'+$parts[2])
        if(!(FixedHexEqual $requestMac $parts[3])){continue}
        $held=Identity $file.SafeFileHandle;$file.Position=0;$heldHash=([BitConverter]::ToString($sha.ComputeHash($file))).Replace('-','').ToLowerInvariant()
        Verify $directory $true $owner;Verify $path $false $owner
        if($before[0] -ne $held[0] -or $before[1] -ne $held[1] -or $heldHash -cne $expected){throw 'replacement'}
        $sequence++
        $kind=if($parts[2] -ceq 'stop'){'stopped'}else{'ready'}
        $pidText=$PID.ToString([Globalization.CultureInfo]::InvariantCulture);$sequenceText=$sequence.ToString([Globalization.CultureInfo]::InvariantCulture)
        $responseMac=CapabilityMac $capabilityKey ('response|'+$kind+'|'+$parts[1]+'|'+$pidText+'|'+$sequenceText+'|'+$before[0]+'|'+$before[1]+'|'+$expected)
        $response='{"version":1,"kind":"'+$kind+'","challenge":"'+$parts[1]+'","supervisorPid":"'+$pidText+'","sequence":'+$sequenceText+',"volumeSerialNumber":"'+$before[0]+'","fileId":"'+$before[1]+'","sha256":"'+$expected+'","mac":"'+$responseMac+'"}' + [char]10
        $responseBytes=[Text.Encoding]::UTF8.GetBytes($response);$pipe.Write($responseBytes,0,$responseBytes.Length);$pipe.Flush()
        try{$pipe.WaitForPipeDrain()}catch{}
        if($parts[2] -ceq 'stop'){$stopping=$true}
      } catch {
        if([ProprNative]::WaitForSingleObject($parent,0) -ne 258){$stopping=$true}
        elseif($_.Exception.Message -ne 'protocol'){throw}
      } finally { try{$pipe.Dispose()}catch{} }
    }
    [void][ProprNative]::CloseHandle($parent)
    $after=Identity $file.SafeFileHandle;$file.Position=0;$finalHash=([BitConverter]::ToString($sha.ComputeHash($file))).Replace('-','').ToLowerInvariant()
    Verify $directory $true $owner;Verify $path $false $owner
    if($before[0] -ne $after[0] -or $before[1] -ne $after[1] -or $finalHash -cne $expected){throw 'replacement'}
    $file.Dispose();$dir.Dispose()
    try{[IO.File]::Delete($path)}catch{};try{[IO.Directory]::Delete($directory)}catch{}
    exit 0
  }
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
  readonly boundary: "after-lock" | "before-launch" | "during-launch" | "during-startup";
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

interface WindowsBootstrapResult {
  readonly output: Buffer;
  readonly volumeSerialNumber: string;
  readonly fileId: string;
}

function runWindowsAuthorityBroker(
  path: string,
  digest: string,
  args: readonly string[],
  targetFds: readonly number[] = [],
  barrier?: WindowsBootstrapBarrier,
): WindowsBootstrapResult {
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
  return {
    output,
    volumeSerialNumber: document.volumeSerialNumber,
    fileId: document.fileId,
  };
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
    return runWindowsAuthorityBroker(path, artifact.digest, probe.args ?? ["ping"], [], probe.barrier).output;
  } finally {
    if (fd !== undefined) closeSync(fd);
    closeSync(artifact.fd);
    rmSync(directory, { recursive: true, force: true });
  }
}

/** Native-test seam proving an existing replaced stage fails full bootstrap authentication before launch. */
export function exerciseWindowsAuthorityExistingStageForNativeTest(
  path: string,
  args: readonly string[],
): Buffer {
  if (process.platform !== "win32") throw new Error("Windows bootstrap stage probe requires Windows");
  const artifact = authorityBrokerArtifact("win32", process.arch);
  try {
    return runWindowsAuthorityBroker(path, artifact.digest, args).output;
  } finally {
    closeSync(artifact.fd);
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

interface WindowsAuthorityCapability {
  readonly artifact: ReturnType<typeof authorityBrokerArtifact>;
  readonly staged: ReturnType<typeof stageWindowsAuthorityBroker>;
  readonly pipeName: string;
  readonly pipePath: string;
  readonly parentNonce: string;
  readonly heldIdentity: { readonly volumeSerialNumber: string; readonly fileId: string };
  readonly supervisor: ChildProcess;
  sequence: number;
  alive: boolean;
  busy: boolean;
}

export interface WindowsAuthorityCapabilityProbe {
  readonly args?: readonly string[];
  readonly acquisitionBarrier?: WindowsBootstrapBarrier;
  readonly onStaged?: (stagedPath: string) => void;
  readonly onSupervisorStarting?: (details: {
    readonly stagedPath: string;
    readonly pipePath: string;
    readonly parentNonce: string;
  }) => void;
  readonly onRequestLocked?: (stagedPath: string, supervisorPid: number) => void;
}

let windowsAuthorityCapability: WindowsAuthorityCapability | undefined;
let windowsAuthorityCleanupRegistered = false;

function waitBriefly(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function supervisorExists(supervisor: ChildProcess): boolean {
  if (!supervisor.pid || supervisor.exitCode !== null || supervisor.signalCode !== null) return false;
  try {
    process.kill(supervisor.pid, 0);
    return true;
  } catch {
    return false;
  }
}

function revalidateWindowsCapabilityFiles(capability: WindowsAuthorityCapability): void {
  if (!capability.alive || !supervisorExists(capability.supervisor)) {
    throw new Error("Windows system authority capability is unavailable");
  }
  const staged = fstatSync(capability.staged.fd, { bigint: true });
  const named = lstatSync(capability.staged.path, { bigint: true });
  if (
    !staged.isFile()
    || named.isSymbolicLink()
    || staged.dev !== named.dev
    || staged.ino !== named.ino
    || staged.size !== BigInt(capability.artifact.bytes.byteLength)
    || createHash("sha256")
      .update(readExactDescriptor(capability.staged.fd, capability.artifact.bytes.byteLength))
      .digest("hex") !== capability.artifact.digest
  ) throw new Error("Windows system authority capability is unavailable");
  revalidateAuthorityBroker(capability.artifact);
}

class WindowsCapabilityTransportError extends Error {}

function exchangeWindowsCapability(
  capability: WindowsAuthorityCapability,
  parentNonce: string,
  challenge: string,
  operation: "challenge" | "stop",
  suffix = "",
): Buffer {
  const requestMac = createHmac("sha256", Buffer.from(parentNonce, "hex"))
    .update(`request|${challenge}|${operation}`, "utf8")
    .digest("hex");
  const request = `PROPR_CAPABILITY_V1|${challenge}|${operation}|${requestMac}${suffix}`;
  if (Buffer.byteLength(request, "ascii") > 512) throw new Error("Windows system authority capability is unavailable");
  const result = spawnSync(process.execPath, ["--no-warnings", "-e", WINDOWS_CAPABILITY_CLIENT_SCRIPT], {
    shell: false,
    windowsHide: true,
    encoding: "buffer",
    env: {
      SystemRoot: trustedWindowsSystemRoot(),
      PROPR_CAPABILITY_PIPE: capability.pipePath,
      PROPR_CAPABILITY_REQUEST: request,
    },
    timeout: WINDOWS_CAPABILITY_EXCHANGE_TIMEOUT_MS,
    maxBuffer: WINDOWS_CAPABILITY_RESPONSE_MAX_BYTES,
  });
  if (result.status !== 0 || result.error || result.signal || (result.stderr?.byteLength ?? 0) !== 0) {
    throw new WindowsCapabilityTransportError("Windows system authority capability is unavailable");
  }
  const output = result.stdout ?? Buffer.alloc(0);
  if (output.byteLength === 0 || output.byteLength > WINDOWS_CAPABILITY_RESPONSE_MAX_BYTES) {
    throw new WindowsCapabilityTransportError("Windows system authority capability is unavailable");
  }
  return output;
}

function challengeWindowsCapability(
  capability: WindowsAuthorityCapability,
  operation: "challenge" | "stop" = "challenge",
): void {
  if (!capability.alive || !supervisorExists(capability.supervisor) || !capability.supervisor.pid) {
    throw new Error("Windows system authority capability is unavailable");
  }
  const challenge = randomBytes(32).toString("hex");
  const output = exchangeWindowsCapability(capability, capability.parentNonce, challenge, operation);
  const text = decodeBoundedUtf8(output);
  if (!text.endsWith("\n") || text.slice(0, -1).includes("\n") || text.includes("\r")) {
    throw new Error("Windows system authority capability was malformed");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(0, -1));
  } catch {
    throw new Error("Windows system authority capability was malformed");
  }
  if (
    !parsed
    || typeof parsed !== "object"
    || Array.isArray(parsed)
    || !exactKeys(parsed, [
      "version", "kind", "challenge", "supervisorPid", "sequence",
      "volumeSerialNumber", "fileId", "sha256", "mac",
    ])
  ) throw new Error("Windows system authority capability was malformed");
  const document = parsed as Record<string, unknown>;
  if (
    document.version !== 1
    || document.kind !== (operation === "stop" ? "stopped" : "ready")
    || document.challenge !== challenge
    || document.supervisorPid !== String(capability.supervisor.pid)
    || !Number.isInteger(document.sequence)
    || (document.sequence as number) < 1
    || document.sequence !== capability.sequence + 1
    || !canonicalUint64(document.volumeSerialNumber)
    || !canonicalUint128(document.fileId)
    || document.volumeSerialNumber !== capability.heldIdentity.volumeSerialNumber
    || document.fileId !== capability.heldIdentity.fileId
    || document.sha256 !== capability.artifact.digest
    || typeof document.mac !== "string"
    || !/^[0-9a-f]{64}$/.test(document.mac)
  ) throw new Error("Windows system authority capability was malformed");
  const expectedMac = createHmac("sha256", Buffer.from(capability.parentNonce, "hex"))
    .update([
      "response", document.kind, document.challenge, document.supervisorPid, String(document.sequence),
      document.volumeSerialNumber, document.fileId, document.sha256,
    ].join("|"), "utf8")
    .digest();
  if (!timingSafeEqual(expectedMac, Buffer.from(document.mac, "hex"))) {
    throw new Error("Windows system authority capability was malformed");
  }
  capability.sequence = document.sequence as number;
}

function destroyWindowsAuthorityCapability(capability = windowsAuthorityCapability): void {
  if (!capability) return;
  if (windowsAuthorityCapability === capability) windowsAuthorityCapability = undefined;
  if (capability.alive && supervisorExists(capability.supervisor)) {
    try { challengeWindowsCapability(capability, "stop"); } catch { /* Authentication failure falls through to forced reap. */ }
  }
  capability.alive = false;
  const deadline = Date.now() + WINDOWS_CAPABILITY_STOP_TIMEOUT_MS;
  while (supervisorExists(capability.supervisor) && Date.now() < deadline) waitBriefly(10);
  if (supervisorExists(capability.supervisor)) {
    try { capability.supervisor.kill(); } catch { /* The OS also closes the lock when the parent exits. */ }
    const killDeadline = Date.now() + WINDOWS_CAPABILITY_STOP_TIMEOUT_MS;
    while (supervisorExists(capability.supervisor) && Date.now() < killDeadline) waitBriefly(10);
  }
  try { closeSync(capability.staged.fd); } catch { /* Already closed during failed acquisition. */ }
  try { closeSync(capability.staged.directoryFd); } catch { /* Already closed during failed acquisition. */ }
  try { closeSync(capability.artifact.fd); } catch { /* Already closed during failed acquisition. */ }
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      rmSync(capability.staged.directory, { recursive: true, force: true });
      break;
    } catch {
      if (attempt === 19) break;
      waitBriefly(10);
    }
  }
}

function acquireWindowsAuthorityCapability(
  probe?: Pick<WindowsAuthorityCapabilityProbe, "acquisitionBarrier" | "onStaged" | "onSupervisorStarting">,
): WindowsAuthorityCapability {
  if (windowsAuthorityCapability) {
    if (probe) throw new Error("Windows system authority capability is already active");
    try {
      revalidateWindowsCapabilityFiles(windowsAuthorityCapability);
      return windowsAuthorityCapability;
    } catch {
      destroyWindowsAuthorityCapability(windowsAuthorityCapability);
      throw new Error("Windows system authority capability is unavailable");
    }
  }
  const artifact = authorityBrokerArtifact("win32", process.arch);
  let staged: ReturnType<typeof stageWindowsAuthorityBroker> | undefined;
  let capability: WindowsAuthorityCapability | undefined;
  try {
    staged = stageWindowsAuthorityBroker(artifact);
    probe?.onStaged?.(staged.path);
    const authenticated = runWindowsAuthorityBroker(staged.path, artifact.digest, ["ping"]);
    const pipeName = `propr-authority-${randomBytes(32).toString("hex")}`;
    const pipePath = `\\\\.\\pipe\\${pipeName}`;
    const parentNonce = randomBytes(32).toString("hex");
    probe?.onSupervisorStarting?.({ stagedPath: staged.path, pipePath, parentNonce });
    const systemRoot = trustedWindowsSystemRoot();
    const supervisor = spawn(join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
      "-EncodedCommand", WINDOWS_BOOTSTRAP_ENCODED,
    ], {
      shell: false,
      windowsHide: true,
      env: {
        SystemRoot: systemRoot,
        PROPR_BOOTSTRAP_PATH: staged.path,
        PROPR_BOOTSTRAP_SHA256: artifact.digest,
        PROPR_BOOTSTRAP_MODE: "hold",
        PROPR_CAPABILITY_PIPE: pipeName,
        PROPR_CAPABILITY_NONCE: parentNonce,
        PROPR_CAPABILITY_PARENT: String(process.pid),
        ...(probe?.acquisitionBarrier ? {
          PROPR_BOOTSTRAP_BOUNDARY: probe.acquisitionBarrier.boundary,
          PROPR_BOOTSTRAP_READY: probe.acquisitionBarrier.readyPath,
          PROPR_BOOTSTRAP_CONTINUE: probe.acquisitionBarrier.continuePath,
        } : {}),
      },
      stdio: "ignore",
    });
    supervisor.unref();
    capability = {
      artifact,
      staged,
      pipeName,
      pipePath,
      parentNonce,
      heldIdentity: {
        volumeSerialNumber: authenticated.volumeSerialNumber,
        fileId: authenticated.fileId,
      },
      supervisor,
      sequence: 0,
      alive: true,
      busy: false,
    };
    supervisor.once("error", () => { capability!.alive = false; });
    supervisor.once("exit", () => { capability!.alive = false; });
    const deadline = Date.now() + WINDOWS_BOOTSTRAP_TIMEOUT_MS;
    while (true) {
      if (!supervisorExists(supervisor) || Date.now() >= deadline) throw new Error("Windows system authority capability is unavailable");
      try {
        challengeWindowsCapability(capability);
        break;
      } catch (error) {
        if (!(error instanceof WindowsCapabilityTransportError)) throw error;
        waitBriefly(10);
      }
    }
    revalidateWindowsCapabilityFiles(capability);
    windowsAuthorityCapability = capability;
    if (!windowsAuthorityCleanupRegistered) {
      windowsAuthorityCleanupRegistered = true;
      process.once("beforeExit", () => destroyWindowsAuthorityCapability());
      process.once("exit", () => destroyWindowsAuthorityCapability());
    }
    return capability;
  } catch {
    if (capability) destroyWindowsAuthorityCapability(capability);
    else {
      if (staged) {
        try { closeSync(staged.fd); } catch { /* Acquisition cleanup. */ }
        try { closeSync(staged.directoryFd); } catch { /* Acquisition cleanup. */ }
        try { rmSync(staged.directory, { recursive: true, force: true }); } catch { /* Acquisition cleanup. */ }
      }
      closeSync(artifact.fd);
    }
    throw new Error("Windows system authority capability is unavailable");
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

function runCachedWindowsAuthorityBroker(
  args: readonly string[],
  targetFds: readonly number[],
  failureMessage: string,
  input?: Buffer,
  onRequestLocked?: (stagedPath: string, supervisorPid: number) => void,
): Buffer {
  const batch = args.length === 1 && args[0] === "batch-v1";
  const probe = args.length === 1 && (args[0] === "ping" || args[0] === "ping-hold");
  if (
    (!batch && !probe)
    || targetFds.some((fd) => !Number.isInteger(fd) || fd < 0)
    || (probe && (targetFds.length !== 0 || input !== undefined))
    || (batch && !validWindowsBatchRequest(input, targetFds.length))
  ) throw new Error(failureMessage);
  const capability = acquireWindowsAuthorityCapability();
  if (capability.busy) throw new Error(failureMessage);
  capability.busy = true;
  try {
    revalidateWindowsCapabilityFiles(capability);
    challengeWindowsCapability(capability);
    onRequestLocked?.(capability.staged.path, capability.supervisor.pid!);
    if (!supervisorExists(capability.supervisor)) throw new Error(failureMessage);
    const result = spawnSync(capability.staged.path, [...args], {
      shell: false,
      windowsHide: true,
      encoding: "buffer",
      env: {},
      timeout: WINDOWS_BROKER_BATCH_TIMEOUT_MS,
      maxBuffer: NATIVE_INSPECTION_MAX_BYTES,
      input,
      stdio: [input ? "pipe" : "ignore", "pipe", "pipe", ...targetFds],
    });
    challengeWindowsCapability(capability);
    revalidateWindowsCapabilityFiles(capability);
    if (result.status !== 0 || result.error || result.signal || (result.stderr?.byteLength ?? 0) !== 0) {
      throw new Error(failureMessage);
    }
    return result.stdout ?? Buffer.alloc(0);
  } catch {
    destroyWindowsAuthorityCapability(capability);
    throw new Error(failureMessage);
  } finally {
    capability.busy = false;
  }
}

function runWindowsAuthorityBatch(
  operation: "inspect" | "protect",
  kinds: readonly string[],
  targetFds: readonly number[],
  failureMessage: string,
): { readonly output: Buffer; readonly requestId: string } {
  if (kinds.length === 0 || kinds.length > 64 || kinds.length !== targetFds.length) {
    throw new Error(failureMessage);
  }
  const requestId = randomUUID().replaceAll("-", "");
  const input = Buffer.from([
    "PROPR_AUTHORITY_V1", requestId, operation, String(kinds.length), ...kinds, "",
  ].join("\n"), "ascii");
  if (input.byteLength > WINDOWS_BROKER_REQUEST_MAX_BYTES) throw new Error(failureMessage);
  return {
    output: runCachedWindowsAuthorityBroker(["batch-v1"], targetFds, failureMessage, input),
    requestId,
  };
}

/** Explicit shutdown seam used by app/CLI lifecycle and native leak tests. */
export function closeWindowsAuthorityCapability(): void {
  destroyWindowsAuthorityCapability();
}

/** Native-test seam for unauthenticated, stale, and extra-input control attempts. */
export function exerciseWindowsAuthorityCapabilityControlForNativeTest(
  probe: {
    readonly nonce: "current" | "stale";
    readonly operation: "challenge" | "stop";
    readonly extra?: string;
  },
): Buffer {
  if (process.platform !== "win32") throw new Error("Windows capability control probe requires Windows");
  const capability = acquireWindowsAuthorityCapability();
  const nonce = probe.nonce === "current"
    ? capability.parentNonce
    : (capability.parentNonce === "0".repeat(64) ? "1".repeat(64) : "0".repeat(64));
  return exchangeWindowsCapability(
    capability,
    nonce,
    randomBytes(32).toString("hex"),
    probe.operation,
    probe.extra ?? "",
  );
}

/** Native-test seam for locked-image, serialization, restart, and cleanup evidence. */
export function exerciseWindowsAuthorityCapabilityForNativeTest(
  probe: WindowsAuthorityCapabilityProbe = {},
): { readonly output: Buffer; readonly stagedPath: string; readonly directory: string; readonly supervisorPid: number } {
  if (process.platform !== "win32") throw new Error("Windows capability probe requires Windows");
  if (probe.acquisitionBarrier || probe.onStaged || probe.onSupervisorStarting) closeWindowsAuthorityCapability();
  const capability = acquireWindowsAuthorityCapability(
    probe.acquisitionBarrier || probe.onStaged || probe.onSupervisorStarting ? probe : undefined,
  );
  if (!capability.supervisor.pid) throw new Error("Windows capability probe is unavailable");
  const output = runCachedWindowsAuthorityBroker(
    probe.args ?? ["ping"],
    [],
    "Windows capability probe is unavailable",
    undefined,
    probe.onRequestLocked,
  );
  return {
    output,
    stagedPath: capability.staged.path,
    directory: capability.staged.directory,
    supervisorPid: capability.supervisor.pid,
  };
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
  for (const entry of entries) {
    if (!Number.isInteger(entry.pinnedFd) || entry.pinnedFd < 0) {
      throw new Error("Windows ACL authority inspection is unavailable");
    }
  }
  const batch = runWindowsAuthorityBatch(
    "inspect",
    entries.map((entry) => entry.kind),
    entries.map((entry) => entry.pinnedFd),
    "Windows ACL authority inspection is unavailable",
  );
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
    const batch = runWindowsAuthorityBatch(
      "protect",
      entries.map((entry) => entry.kind),
      held,
      "Windows setup authority could not be established",
    );
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
  } catch {
    throw new Error("Windows setup authority could not be established");
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
