import { randomBytes } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { isAbsolute, join } from 'node:path';

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
  read(offset: number, length: number): Promise<Buffer>;
  verify(): Promise<WindowsHeldVerification>;
  close(): Promise<void>;
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

const BROKER_TIMEOUT_MS = 10_000;
const BROKER_SESSION_TIMEOUT_MS = 10 * 60_000;
const BROKER_OUTPUT_BYTES = 16 * 1024;
const BROKER_PROTOCOL_LINE_BYTES = 2 * 1024 * 1024;
const BROKER_SOURCE_BYTES = 256 * 1024;
const MAX_READ_BYTES = 1024 * 1024;
const reasonCodes = new Set<string>(WINDOWS_AUTHORITY_REASON_CODES);
const INSPECTION_KEYS = Object.freeze([
  'version', 'type', 'volumeSerial', 'fileId128', 'directory', 'links', 'size', 'reparseTag',
  'ownerSid', 'daclProtected', 'aceCount', 'inheritedWriteAces', 'broadWriteAces', 'sha256', 'sha1',
] as const);
const HELD_INSPECTION_KEYS = Object.freeze([...INSPECTION_KEYS, 'challenge'] as const);
const lockedArtifactProcesses = new WeakMap<WindowsLockedArtifact, {
  child: ChildProcessWithoutNullStreams;
  exited: Promise<void>;
}>();

// One broker implementation is used for both one-shot directory authority and
// held artifact capabilities. In held mode every fact, byte, and digest comes
// from the single CreateFileW handle opened with OPEN_REPARSE_POINT and sharing
// that denies write/delete/replace for the entire session.
const WINDOWS_AUTHORITY_BROKER = String.raw`
$ErrorActionPreference = 'Stop'
function Write-ProprFailure([string]$code, [int]$scenario) {
  [Console]::Out.WriteLine((@{ version = 1; type = 'error'; reason = $code; scenario = $scenario } | ConvertTo-Json -Compress))
  [Console]::Out.Flush()
}
try {
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using Microsoft.Win32.SafeHandles;

public sealed class BrokerFailure : Exception {
  public readonly string Code;
  public readonly int Scenario;
  public BrokerFailure(string code, int scenario) : base(code) { Code = code; Scenario = scenario; }
}

public sealed class InspectionResult {
  public int version = 1;
  public string type = "inspection";
  public string volumeSerial;
  public string fileId128;
  public bool directory;
  public string links;
  public string size;
  public string reparseTag;
  public string ownerSid;
  public bool daclProtected;
  public string aceCount;
  public string inheritedWriteAces;
  public string broadWriteAces;
  public string sha256;
  public string sha1;
}

public sealed class SecurityResult {
  public string ownerSid;
  public int aceCount;
}

public static class ProprUpdateAuthority {
  const uint DELETE = 0x00010000;
  const uint READ_CONTROL = 0x00020000;
  const uint GENERIC_READ = 0x80000000;
  const uint FILE_READ_ATTRIBUTES = 0x00000080;
  const uint FILE_SHARE_READ = 0x00000001;
  const uint FILE_SHARE_WRITE = 0x00000002;
  const uint FILE_SHARE_DELETE = 0x00000004;
  const uint OPEN_EXISTING = 3;
  const uint FILE_FLAG_BACKUP_SEMANTICS = 0x02000000;
  const uint FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000;
  const uint FILE_ATTRIBUTE_REPARSE_POINT = 0x00000400;
  const uint ERROR_SHARING_VIOLATION = 32;
  const uint FILE_BEGIN = 0;
  const int FileStandardInfo = 1;
  const int FileAttributeTagInfo = 9;
  const int FileIdInfo = 18;
  const int SE_FILE_OBJECT = 1;
  const int OWNER_SECURITY_INFORMATION = 0x00000001;
  const int DACL_SECURITY_INFORMATION = 0x00000004;
  const int WRITE_AUTHORITY = unchecked((int)0x500D0156);
  const int MAX_SECURITY_DESCRIPTOR = 65536;
  const int MAX_READ = 1048576;

  [StructLayout(LayoutKind.Sequential)]
  struct FILE_STANDARD_INFO {
    public long AllocationSize;
    public long EndOfFile;
    public uint NumberOfLinks;
    [MarshalAs(UnmanagedType.U1)] public bool DeletePending;
    [MarshalAs(UnmanagedType.U1)] public bool Directory;
  }

  [StructLayout(LayoutKind.Sequential)]
  struct FILE_ATTRIBUTE_TAG_INFO { public uint FileAttributes; public uint ReparseTag; }

  [StructLayout(LayoutKind.Sequential)]
  struct FILE_ID_INFO {
    public ulong VolumeSerialNumber;
    [MarshalAs(UnmanagedType.ByValArray, SizeConst = 16)] public byte[] FileId;
  }

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern SafeFileHandle CreateFileW(string name, uint access, uint share, IntPtr security,
    uint disposition, uint flags, IntPtr template);

  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool GetFileInformationByHandleEx(SafeFileHandle handle, int infoClass,
    IntPtr information, uint size);

  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool SetFilePointerEx(SafeFileHandle handle, long distance, out long position, uint method);

  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool ReadFile(SafeFileHandle handle, byte[] buffer, uint requested, out uint read, IntPtr overlapped);

  [DllImport("advapi32.dll", SetLastError = true)]
  static extern uint GetSecurityInfo(SafeFileHandle handle, int objectType, int securityInfo,
    out IntPtr owner, out IntPtr group, out IntPtr dacl, out IntPtr sacl, out IntPtr descriptor);

  [DllImport("kernel32.dll")]
  static extern IntPtr LocalFree(IntPtr memory);

  [DllImport("advapi32.dll")]
  static extern uint GetSecurityDescriptorLength(IntPtr descriptor);

  static T ReadInfo<T>(SafeFileHandle handle, int infoClass, string code, int scenario) where T : struct {
    int size = Marshal.SizeOf(typeof(T));
    IntPtr memory = Marshal.AllocHGlobal(size);
    try {
      if (!GetFileInformationByHandleEx(handle, infoClass, memory, (uint)size)) {
        throw new BrokerFailure(code, scenario);
      }
      return (T)Marshal.PtrToStructure(memory, typeof(T));
    } finally { Marshal.FreeHGlobal(memory); }
  }

  static SecurityResult VerifySecurity(SafeFileHandle handle) {
    IntPtr owner, group, dacl, sacl, descriptor;
    uint error = GetSecurityInfo(handle, SE_FILE_OBJECT,
      OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
      out owner, out group, out dacl, out sacl, out descriptor);
    if (error != 0 || descriptor == IntPtr.Zero) throw new BrokerFailure("owner_sid", 6);
    try {
      int length = checked((int)GetSecurityDescriptorLength(descriptor));
      if (length <= 0 || length > MAX_SECURITY_DESCRIPTOR) throw new BrokerFailure("owner_sid", 6);
      byte[] bytes = new byte[length];
      Marshal.Copy(descriptor, bytes, 0, length);
      RawSecurityDescriptor security = new RawSecurityDescriptor(bytes, 0);
      WindowsIdentity identity = WindowsIdentity.GetCurrent(TokenAccessLevels.Query);
      SecurityIdentifier current = identity.User;
      if (current == null || security.Owner == null || !security.Owner.Equals(current)) {
        throw new BrokerFailure("owner_sid", 6);
      }
      if ((security.ControlFlags & ControlFlags.DiscretionaryAclProtected) == 0
        || security.DiscretionaryAcl == null) {
        throw new BrokerFailure("dacl_protection", 7);
      }
      SecurityIdentifier system = new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null);
      SecurityIdentifier administrators = new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null);
      int aceCount = 0;
      foreach (GenericAce generic in security.DiscretionaryAcl) {
        aceCount++;
        if ((generic.AceFlags & AceFlags.Inherited) != 0) throw new BrokerFailure("dacl_ace", 8);
        QualifiedAce qualified = generic as QualifiedAce;
        KnownAce known = generic as KnownAce;
        if (qualified == null || known == null || qualified.AceQualifier != AceQualifier.AccessAllowed) continue;
        SecurityIdentifier sid = known.SecurityIdentifier;
        bool trusted = sid != null && (sid.Equals(current) || sid.Equals(system) || sid.Equals(administrators));
        if (!trusted && (known.AccessMask & WRITE_AUTHORITY) != 0) throw new BrokerFailure("dacl_ace", 8);
      }
      return new SecurityResult { ownerSid = current.Value, aceCount = aceCount };
    } finally { LocalFree(descriptor); }
  }

  static SafeFileHandle OpenPinned(string path, bool readBytes) {
    uint access = READ_CONTROL | FILE_READ_ATTRIBUTES | (readBytes ? GENERIC_READ : 0);
    SafeFileHandle handle = CreateFileW(path, access, FILE_SHARE_READ, IntPtr.Zero, OPEN_EXISTING,
      FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, IntPtr.Zero);
    if (handle.IsInvalid) {
      handle.Dispose();
      throw new BrokerFailure("open_handle", 2);
    }
    return handle;
  }

  static void ProveNoShareLock(string path) {
    SafeFileHandle competing = CreateFileW(path, DELETE, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
      IntPtr.Zero, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, IntPtr.Zero);
    if (!competing.IsInvalid) {
      competing.Dispose();
      throw new BrokerFailure("no_share_lock", 10);
    }
    int error = Marshal.GetLastWin32Error();
    competing.Dispose();
    if ((uint)error != ERROR_SHARING_VIOLATION) throw new BrokerFailure("no_share_lock", 10);
  }

  static byte[] ReadAt(SafeFileHandle handle, long offset, int length, string code, int scenario) {
    long position;
    if (!SetFilePointerEx(handle, offset, out position, FILE_BEGIN) || position != offset) {
      throw new BrokerFailure(code, scenario);
    }
    byte[] bytes = new byte[length];
    int total = 0;
    while (total < length) {
      byte[] chunk = new byte[length - total];
      uint count;
      if (!ReadFile(handle, chunk, (uint)chunk.Length, out count, IntPtr.Zero) || count == 0) {
        throw new BrokerFailure(code, scenario);
      }
      Buffer.BlockCopy(chunk, 0, bytes, total, (int)count);
      total += (int)count;
    }
    return bytes;
  }

  static string[] Hash(SafeFileHandle handle, long size) {
    using (SHA256 sha256 = SHA256.Create())
    using (SHA1 sha1 = SHA1.Create()) {
      byte[] chunk = new byte[Math.Min(MAX_READ, (int)Math.Min(size, MAX_READ))];
      long offset = 0;
      while (offset < size) {
        int length = (int)Math.Min(chunk.Length, size - offset);
        byte[] bytes = ReadAt(handle, offset, length, "hash_read", 11);
        sha256.TransformBlock(bytes, 0, bytes.Length, null, 0);
        sha1.TransformBlock(bytes, 0, bytes.Length, null, 0);
        offset += bytes.Length;
      }
      sha256.TransformFinalBlock(new byte[0], 0, 0);
      sha1.TransformFinalBlock(new byte[0], 0, 0);
      return new string[] {
        BitConverter.ToString(sha256.Hash).Replace("-", "").ToLowerInvariant(),
        BitConverter.ToString(sha1.Hash).Replace("-", "").ToLowerInvariant()
      };
    }
  }

  static InspectionResult InspectHandle(SafeFileHandle handle, bool expectedDirectory, long maxBytes, bool hash) {
    FILE_ATTRIBUTE_TAG_INFO attributes = ReadInfo<FILE_ATTRIBUTE_TAG_INFO>(handle, FileAttributeTagInfo, "reparse_query", 3);
    if ((attributes.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0 || attributes.ReparseTag != 0) {
      throw new BrokerFailure("reparse_point", 4);
    }
    FILE_STANDARD_INFO standard = ReadInfo<FILE_STANDARD_INFO>(handle, FileStandardInfo, "type_link_size", 5);
    if (standard.DeletePending || standard.Directory != expectedDirectory || (!standard.Directory && standard.NumberOfLinks != 1)
      || (!standard.Directory && (standard.EndOfFile <= 0 || standard.EndOfFile > maxBytes))) {
      throw new BrokerFailure("type_link_size", 5);
    }
    SecurityResult security = VerifySecurity(handle);
    FILE_ID_INFO identity = ReadInfo<FILE_ID_INFO>(handle, FileIdInfo, "file_id_info", 9);
    byte[] fileId = identity.FileId;
    if (fileId == null || fileId.Length != 16) throw new BrokerFailure("file_id_info", 9);
    InspectionResult result = new InspectionResult {
      volumeSerial = identity.VolumeSerialNumber.ToString("x16"),
      fileId128 = BitConverter.ToString(fileId).Replace("-", "").ToLowerInvariant(),
      directory = standard.Directory,
      links = standard.NumberOfLinks.ToString(),
      size = standard.EndOfFile.ToString(),
      reparseTag = attributes.ReparseTag.ToString("x8"),
      ownerSid = security.ownerSid,
      daclProtected = true,
      aceCount = security.aceCount.ToString(),
      inheritedWriteAces = "0",
      broadWriteAces = "0"
    };
    if (hash) {
      string[] hashes = Hash(handle, standard.EndOfFile);
      result.sha256 = hashes[0];
      result.sha1 = hashes[1];
    }
    return result;
  }

  static bool Same(InspectionResult left, InspectionResult right) {
    return left.volumeSerial == right.volumeSerial && left.fileId128 == right.fileId128
      && left.directory == right.directory && left.links == right.links && left.size == right.size
      && left.reparseTag == right.reparseTag && left.ownerSid == right.ownerSid
      && left.daclProtected == right.daclProtected && left.aceCount == right.aceCount
      && left.inheritedWriteAces == right.inheritedWriteAces && left.broadWriteAces == right.broadWriteAces
      && left.sha256 == right.sha256 && left.sha1 == right.sha1;
  }

  static string PrivateSddl() {
    string owner = WindowsIdentity.GetCurrent(TokenAccessLevels.Query).User.Value;
    return "O:" + owner + "G:" + owner + "D:P(A;;FA;;;" + owner + ")(A;;FA;;;SY)(A;;FA;;;BA)";
  }

  public static InspectionResult Inspect(string path, bool expectedDirectory) {
    using (SafeFileHandle handle = OpenPinned(path, false)) {
      return InspectHandle(handle, expectedDirectory, long.MaxValue, false);
    }
  }

  public static InspectionResult EnsureDirectory(string path) {
    if (!Directory.Exists(path)) {
      DirectorySecurity security = new DirectorySecurity();
      security.SetSecurityDescriptorSddlForm(PrivateSddl());
      new DirectoryInfo(path).Create(security);
    }
    return Inspect(path, true);
  }

  public static InspectionResult ProtectDirectory(string path) {
    DirectorySecurity security = new DirectorySecurity();
    security.SetSecurityDescriptorSddlForm(PrivateSddl());
    Directory.SetAccessControl(path, security);
    return Inspect(path, true);
  }

  public static InspectionResult ProtectFile(string path) {
    FileSecurity security = new FileSecurity();
    security.SetSecurityDescriptorSddlForm(PrivateSddl());
    File.SetAccessControl(path, security);
    return Inspect(path, false);
  }

  static void EmitInspection(string type, string challenge, InspectionResult value) {
    Console.Out.WriteLine("{\"version\":1,\"type\":\"" + type + "\",\"challenge\":\"" + challenge
      + "\",\"volumeSerial\":\"" + value.volumeSerial + "\",\"fileId128\":\"" + value.fileId128
      + "\",\"directory\":false,\"links\":\"" + value.links + "\",\"size\":\"" + value.size
      + "\",\"reparseTag\":\"" + value.reparseTag + "\",\"ownerSid\":\"" + value.ownerSid
      + "\",\"daclProtected\":true,\"aceCount\":\"" + value.aceCount
      + "\",\"inheritedWriteAces\":\"0\",\"broadWriteAces\":\"0\",\"sha256\":\""
      + value.sha256 + "\",\"sha1\":\"" + value.sha1 + "\"}");
    Console.Out.Flush();
  }

  static void EmitFailure(BrokerFailure failure) {
    Console.Out.WriteLine("{\"version\":1,\"type\":\"error\",\"reason\":\"" + failure.Code
      + "\",\"scenario\":" + failure.Scenario.ToString() + "}");
    Console.Out.Flush();
  }

  public static void Hold(string path, long maxBytes, string readyChallenge) {
    SafeFileHandle handle = null;
    try {
      handle = OpenPinned(path, true);
      InspectionResult initial = InspectHandle(handle, false, maxBytes, true);
      ProveNoShareLock(path);
      EmitInspection("ready", readyChallenge, initial);
      string line;
      while ((line = Console.In.ReadLine()) != null) {
        string[] fields = line.Split('|');
        if (fields.Length == 1 && fields[0] == "close") {
          InspectionResult final = InspectHandle(handle, false, maxBytes, true);
          if (!Same(initial, final)) throw new BrokerFailure("final_verify", 14);
          EmitInspection("closed", "", final);
          return;
        }
        if (fields.Length == 2 && fields[0] == "verify" && fields[1].Length == 32) {
          InspectionResult verified = InspectHandle(handle, false, maxBytes, true);
          if (!Same(initial, verified)) throw new BrokerFailure("final_verify", 14);
          EmitInspection("verified", fields[1], verified);
          continue;
        }
        if (fields.Length == 3 && fields[0] == "read") {
          long offset;
          int length;
          if (!Int64.TryParse(fields[1], out offset) || !Int32.TryParse(fields[2], out length)
            || offset < 0 || length <= 0 || length > MAX_READ || offset + length > Int64.Parse(initial.size)) {
            throw new BrokerFailure("request_protocol", 1);
          }
          byte[] bytes = ReadAt(handle, offset, length, "held_read", 13);
          Console.Out.WriteLine("{\"version\":1,\"type\":\"bytes\",\"bytes\":\""
            + Convert.ToBase64String(bytes) + "\"}");
          Console.Out.Flush();
          continue;
        }
        throw new BrokerFailure("request_protocol", 1);
      }
      throw new BrokerFailure("clean_shutdown", 15);
    } catch (BrokerFailure failure) {
      EmitFailure(failure);
    } catch {
      EmitFailure(new BrokerFailure("stdio_protocol", 16));
    } finally {
      if (handle != null) handle.Dispose();
    }
  }
}
'@ -Language CSharp
} catch {
  Write-ProprFailure 'compile_load' 0
  exit 0
}

try {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line -or $line.Length -gt 16384) { throw 'request' }
  $request = $line | ConvertFrom-Json
  if ($request.operation -eq 'hold') {
    if ($null -ne $request.beforeOpenChallenge) {
      $beforeOpenChallenge = [string]$request.beforeOpenChallenge
      if ($beforeOpenChallenge -notmatch '^[a-f0-9]{32}$') { throw 'request' }
      [Console]::Out.WriteLine((@{ version = 1; type = 'before-open'; challenge = $beforeOpenChallenge } | ConvertTo-Json -Compress))
      [Console]::Out.Flush()
      $continue = [Console]::In.ReadLine()
      if ($continue -ne ('open|' + $beforeOpenChallenge)) { throw 'request' }
    }
    [ProprUpdateAuthority]::Hold([string]$request.path, [Int64]$request.maxBytes, [string]$request.challenge)
    exit 0
  }
  if ($request.operation -eq 'inspect') {
    $result = [ProprUpdateAuthority]::Inspect([string]$request.path, [bool]$request.directory)
  } elseif ($request.operation -eq 'ensure-directory') {
    $result = [ProprUpdateAuthority]::EnsureDirectory([string]$request.path)
  } elseif ($request.operation -eq 'protect-directory') {
    $result = [ProprUpdateAuthority]::ProtectDirectory([string]$request.path)
  } elseif ($request.operation -eq 'protect-file') {
    $result = [ProprUpdateAuthority]::ProtectFile([string]$request.path)
  } else { throw 'request' }
  [Console]::Out.WriteLine(($result | ConvertTo-Json -Compress))
  [Console]::Out.Flush()
} catch {
  $failure = $_.Exception
  while ($null -ne $failure.InnerException) { $failure = $failure.InnerException }
  if ($failure -is [BrokerFailure]) { Write-ProprFailure $failure.Code $failure.Scenario }
  else { Write-ProprFailure 'request_protocol' 1 }
}
`;

// The command line is constant and contains neither the broker nor request data.
// The bounded UTF-8 broker is authenticated by this process and transported over
// inherited stdin before the versioned request stream begins.
const POWERSHELL_STDIN_BOOTSTRAP = String.raw`$ErrorActionPreference='Stop';try{$line=[Console]::In.ReadLine();if($null -eq $line -or $line.Length -gt 349528){throw 'source'};$bytes=[Convert]::FromBase64String($line);if($bytes.Length -le 0 -or $bytes.Length -gt 262144){throw 'source'};$utf8=New-Object System.Text.UTF8Encoding($false,$true);$source=$utf8.GetString($bytes);& ([ScriptBlock]::Create($source))}catch{[Console]::Out.WriteLine('{"version":1,"type":"error","reason":"compile_load","scenario":0}');[Console]::Out.Flush()}`;

const brokerSource = (): string => {
  const bytes = Buffer.from(WINDOWS_AUTHORITY_BROKER, 'utf8');
  if (bytes.length <= 0 || bytes.length > BROKER_SOURCE_BYTES) throw authorityError('compile_load', 0);
  return bytes.toString('base64');
};

const windowsPowerShellPath = (): string => {
  const systemRoot = process.env.SystemRoot;
  if (!systemRoot || !isAbsolute(systemRoot)) throw authorityError('compile_load', 0);
  return join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
};

const spawnBroker = (): ChildProcessWithoutNullStreams => spawn(windowsPowerShellPath(), [
  '-NoLogo',
  '-NoProfile',
  '-NonInteractive',
  '-ExecutionPolicy',
  'Bypass',
  '-Command',
  POWERSHELL_STDIN_BOOTSTRAP,
], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });

const authorityError = (reason: WindowsAuthorityReason, scenario: number): Error =>
  new Error(`Verified update cache authority inspection failed [win-authority:${reason}:${scenario}]`);

const hasExactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));

const parseFailure = (value: unknown): Error | undefined => {
  if (typeof value !== 'object' || value === null) return undefined;
  const candidate = value as Record<string, unknown>;
  if (candidate.version !== WINDOWS_AUTHORITY_PROTOCOL_VERSION || candidate.type !== 'error'
    || !hasExactKeys(candidate, ['version', 'type', 'reason', 'scenario'])
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

const runBroker = async (
  operation: BrokerOperation,
  path: string,
  directory: boolean,
): Promise<WindowsPrivatePathInspection> => new Promise((resolve, reject) => {
  let child: ChildProcessWithoutNullStreams;
  try { child = spawnBroker(); } catch { reject(authorityError('compile_load', 0)); return; }
  let stdout = Buffer.alloc(0);
  let stderrBytes = 0;
  let settled = false;
  const fail = (reason: WindowsAuthorityReason, scenario: number): void => {
    if (settled) return;
    settled = true;
    reject(authorityError(reason, scenario));
  };
  const timeout = setTimeout(() => {
    child.kill();
    fail('timeout', 18);
  }, BROKER_TIMEOUT_MS);
  child.stdout.on('data', (chunk: Buffer) => {
    if (stdout.length + chunk.length > BROKER_OUTPUT_BYTES) {
      child.kill();
      fail('output_bound', 17);
      return;
    }
    stdout = Buffer.concat([stdout, chunk]);
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderrBytes += chunk.length;
    if (stderrBytes > BROKER_OUTPUT_BYTES) fail('output_bound', 17);
    else fail('process_exit', 19);
    child.kill();
  });
  child.stdin.on('error', () => fail('stdio_protocol', 16));
  child.on('error', () => fail('process_exit', 19));
  child.on('close', code => {
    clearTimeout(timeout);
    if (settled) return;
    if (code !== 0 || stderrBytes !== 0) return fail('process_exit', 19);
    const output = stdout.toString('utf8');
    if (!/^\{[^\r\n]*\}\r?\n$/.test(output)) return fail('stdio_protocol', 16);
    let value: unknown;
    try { value = JSON.parse(output.slice(0, output.endsWith('\r\n') ? -2 : -1)); } catch { return fail('stdio_protocol', 16); }
    const brokerFailure = parseFailure(value);
    if (brokerFailure) {
      settled = true;
      reject(brokerFailure);
      return;
    }
    const inspected = parseInspection(value, directory, false);
    if (!inspected || (value as Record<string, unknown>).type !== 'inspection'
      || !hasExactKeys(value as Record<string, unknown>, INSPECTION_KEYS)) return fail('stdio_protocol', 16);
    settled = true;
    resolve(inspected);
  });
  child.stdin.end(`${brokerSource()}\n${JSON.stringify({ operation, path, directory })}\n`);
});

export const inspectWindowsPrivatePath = (path: string, directory = false): Promise<WindowsPrivatePathInspection> =>
  runBroker('inspect', path, directory);

export const ensureWindowsPrivateDirectory = (path: string): Promise<WindowsPrivatePathInspection> =>
  runBroker('ensure-directory', path, true);

export const protectWindowsPrivateDirectory = (path: string): Promise<WindowsPrivatePathInspection> =>
  runBroker('protect-directory', path, true);

export const protectWindowsPrivateFile = (path: string): Promise<WindowsPrivatePathInspection> =>
  runBroker('protect-file', path, false);

export const openWindowsLockedArtifact = async (
  path: string,
  maxBytes = 1024 * 1024 * 1024,
  beforeOpenForTest?: () => Promise<void>,
): Promise<WindowsLockedArtifact> => {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw authorityError('request_protocol', 1);
  let child: ChildProcessWithoutNullStreams;
  try { child = spawnBroker(); } catch { throw authorityError('compile_load', 0); }
  const readyChallenge = randomBytes(16).toString('hex');
  const beforeOpenChallenge = beforeOpenForTest ? randomBytes(16).toString('hex') : undefined;
  child.stdin.write(`${brokerSource()}\n${JSON.stringify({
    operation: 'hold', path, maxBytes, challenge: readyChallenge, beforeOpenChallenge,
  })}\n`);

  let buffered = '';
  let stderrBytes = 0;
  let processClosed = false;
  let terminalError: Error | undefined;
  let totalStdoutBytes = 0;
  const lines: string[] = [];
  const waiters: Array<{ resolve: (line: string) => void; reject: (error: Error) => void }> = [];
  const rejectWaiters = (error: Error): void => {
    terminalError ??= error;
    while (waiters.length) waiters.shift()!.reject(terminalError);
  };
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    totalStdoutBytes += Buffer.byteLength(chunk);
    const sessionOutputLimit = Math.min(Number.MAX_SAFE_INTEGER, Math.ceil(maxBytes * 8 / 3) + BROKER_PROTOCOL_LINE_BYTES);
    if (totalStdoutBytes > sessionOutputLimit) {
      child.kill();
      rejectWaiters(authorityError('output_bound', 17));
      return;
    }
    buffered += chunk;
    if (Buffer.byteLength(buffered) > BROKER_PROTOCOL_LINE_BYTES) {
      child.kill();
      rejectWaiters(authorityError('output_bound', 17));
      return;
    }
    while (buffered.includes('\n')) {
      const newline = buffered.indexOf('\n');
      const rawLine = buffered.slice(0, newline);
      const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
      if (!line || /[\r\n]/.test(line)) {
        child.kill();
        rejectWaiters(authorityError('stdio_protocol', 16));
        return;
      }
      buffered = buffered.slice(newline + 1);
      const waiter = waiters.shift();
      if (waiter) waiter.resolve(line);
      else if (lines.length === 0) lines.push(line);
      else {
        child.kill();
        rejectWaiters(authorityError('stdio_protocol', 16));
      }
    }
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderrBytes += chunk.length;
    if (stderrBytes > BROKER_OUTPUT_BYTES) {
      child.kill();
      rejectWaiters(authorityError('output_bound', 17));
    } else {
      child.kill();
      rejectWaiters(authorityError('process_exit', 19));
    }
  });
  child.stdin.on('error', () => rejectWaiters(authorityError('stdio_protocol', 16)));
  child.on('error', () => rejectWaiters(authorityError('process_exit', 19)));
  const exited = new Promise<void>(resolve => child.on('close', code => {
    processClosed = true;
    if (code !== 0 || stderrBytes !== 0 || buffered) {
      rejectWaiters(authorityError('process_exit', 19));
    } else {
      rejectWaiters(authorityError('clean_shutdown', 15));
    }
    resolve();
  }));
  const sessionTimeout = setTimeout(() => {
    child.kill();
    rejectWaiters(authorityError('timeout', 18));
  }, BROKER_SESSION_TIMEOUT_MS);
  exited.finally(() => clearTimeout(sessionTimeout)).catch(() => undefined);

  const readLine = (): Promise<string> => new Promise((resolve, reject) => {
    if (lines.length) return resolve(lines.shift()!);
    if (terminalError) return reject(terminalError);
    const timer = setTimeout(() => {
      child.kill();
      reject(authorityError('timeout', 18));
    }, BROKER_TIMEOUT_MS);
    waiters.push({
      resolve: line => { clearTimeout(timer); resolve(line); },
      reject: error => { clearTimeout(timer); reject(error); },
    });
  });

  const parseLine = async (): Promise<Record<string, unknown>> => {
    let value: unknown;
    try { value = JSON.parse(await readLine()); } catch (error) {
      if (error instanceof Error && error.message.includes('[win-authority:')) throw error;
      throw authorityError('stdio_protocol', 16);
    }
    const brokerFailure = parseFailure(value);
    if (brokerFailure) throw brokerFailure;
    if (typeof value !== 'object' || value === null) throw authorityError('stdio_protocol', 16);
    return value as Record<string, unknown>;
  };

  let queue = Promise.resolve();
  const exchange = async (command: string): Promise<Record<string, unknown>> => {
    let result!: Record<string, unknown>;
    const run = queue.then(async () => {
      if (processClosed || terminalError) throw terminalError ?? authorityError('process_exit', 19);
      child.stdin.write(`${command}\n`);
      result = await parseLine();
    });
    queue = run.catch(() => undefined);
    await run;
    return result;
  };

  if (beforeOpenForTest) {
    let barrier: Record<string, unknown>;
    try { barrier = await parseLine(); } catch (error) {
      child.kill();
      throw error;
    }
    if (barrier.version !== WINDOWS_AUTHORITY_PROTOCOL_VERSION || barrier.type !== 'before-open'
      || barrier.challenge !== beforeOpenChallenge || Object.keys(barrier).length !== 3) {
      child.kill();
      throw authorityError('ready_protocol', 12);
    }
    try {
      await beforeOpenForTest();
      child.stdin.write(`open|${beforeOpenChallenge}\n`);
    } catch (error) {
      child.stdin.end();
      child.kill();
      throw error;
    }
  }

  let ready: Record<string, unknown>;
  try { ready = await parseLine(); } catch (error) {
    child.kill();
    throw error;
  }
  const initial = parseInspection(ready, false, true) as WindowsHeldVerification | undefined;
  if (!initial || ready.type !== 'ready' || ready.challenge !== readyChallenge
    || !hasExactKeys(ready, HELD_INSPECTION_KEYS)) {
    child.kill();
    throw authorityError('ready_protocol', 12);
  }

  let closed = false;
  const sameInitial = (candidate: WindowsHeldVerification): boolean =>
    candidate.identity.volumeSerial === initial.identity.volumeSerial
    && candidate.identity.fileId128 === initial.identity.fileId128
    && candidate.links === initial.links && candidate.size === initial.size
    && candidate.reparseTag === initial.reparseTag && candidate.ownerSid === initial.ownerSid
    && candidate.aceCount === initial.aceCount
    && candidate.inheritedWriteAces === initial.inheritedWriteAces
    && candidate.broadWriteAces === initial.broadWriteAces
    && candidate.sha256 === initial.sha256 && candidate.sha1 === initial.sha1;

  const capability: WindowsLockedArtifact = {
    inspection: initial,
    read: async (offset, length) => {
      if (closed || !Number.isSafeInteger(offset) || offset < 0
        || !Number.isSafeInteger(length) || length <= 0 || length > MAX_READ_BYTES
        || offset + length > Number(initial.size)) throw authorityError('request_protocol', 1);
      const result = await exchange(`read|${offset}|${length}`);
      if (result.version !== WINDOWS_AUTHORITY_PROTOCOL_VERSION || result.type !== 'bytes'
        || typeof result.bytes !== 'string' || !hasExactKeys(result, ['version', 'type', 'bytes'])) {
        throw authorityError('held_read', 13);
      }
      const bytes = Buffer.from(result.bytes, 'base64');
      if (bytes.length !== length || bytes.toString('base64') !== result.bytes) throw authorityError('held_read', 13);
      return bytes;
    },
    verify: async () => {
      if (closed) throw authorityError('final_verify', 14);
      const challenge = randomBytes(16).toString('hex');
      const result = await exchange(`verify|${challenge}`);
      const verified = parseInspection(result, false, true) as WindowsHeldVerification | undefined;
      if (!verified || result.type !== 'verified' || result.challenge !== challenge
        || !hasExactKeys(result, HELD_INSPECTION_KEYS) || !sameInitial(verified)) {
        throw authorityError('final_verify', 14);
      }
      return verified;
    },
    close: async () => {
      if (closed) return;
      closed = true;
      let result: Record<string, unknown>;
      try {
        result = await exchange('close');
        const final = parseInspection(result, false, true) as WindowsHeldVerification | undefined;
        if (!final || result.type !== 'closed' || result.challenge !== ''
          || !hasExactKeys(result, HELD_INSPECTION_KEYS)
          || !sameInitial(final)) throw authorityError('final_verify', 14);
        child.stdin.end();
        await Promise.race([
          exited,
          new Promise<void>((_resolve, reject) => setTimeout(
            () => reject(authorityError('clean_shutdown', 15)),
            BROKER_TIMEOUT_MS,
          )),
        ]);
      } catch (error) {
        child.kill();
        throw error;
      }
    },
  };
  lockedArtifactProcesses.set(capability, { child, exited });
  return capability;
};

/** Native-test-only crash injection used to prove that an OS-terminated broker releases its handle. */
export const crashWindowsLockedArtifactForTest = async (held: WindowsLockedArtifact): Promise<void> => {
  const process = lockedArtifactProcesses.get(held);
  if (!process) throw authorityError('request_protocol', 1);
  process.child.kill();
  await Promise.race([
    process.exited,
    new Promise<void>((_resolve, reject) => setTimeout(
      () => reject(authorityError('process_exit', 19)),
      BROKER_TIMEOUT_MS,
    )),
  ]);
  lockedArtifactProcesses.delete(held);
};

export const smokeWindowsUpdateAuthority = async (path: string): Promise<readonly string[]> => {
  const held = await openWindowsLockedArtifact(path, 1024 * 1024);
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
