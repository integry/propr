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

const BROKER_TIMEOUT_MS = 10_000;
const BROKER_STARTUP_TIMEOUT_MS = 60_000;
const BROKER_SESSION_TIMEOUT_MS = 10 * 60_000;
const BROKER_OUTPUT_BYTES = 16 * 1024;
const BROKER_PROTOCOL_LINE_BYTES = 2 * 1024 * 1024;
const BROKER_SOURCE_BYTES = 256 * 1024;
const BROKER_REQUEST_LINE_BYTES = 16 * 1024;
const BROKER_MAX_FRAMES = 8192;
const BROKER_MAX_INPUT_BYTES = 64 * 1024 * 1024;
const BROKER_MAX_OUTPUT_BYTES = 2 * 1024 * 1024 * 1024;
const BROKER_MAX_QUEUE_ENTRIES = 256;
const MAX_READ_BYTES = 1024 * 1024;
const reasonCodes = new Set<string>(WINDOWS_AUTHORITY_REASON_CODES);
const INSPECTION_KEYS = Object.freeze([
  'version', 'type', 'volumeSerial', 'fileId128', 'directory', 'links', 'size', 'reparseTag',
  'ownerSid', 'daclProtected', 'aceCount', 'inheritedWriteAces', 'broadWriteAces', 'sha256', 'sha1',
] as const);
const lockedArtifactProcesses = new WeakMap<WindowsLockedArtifact, LockedArtifactProcess>();

// One broker implementation is used for both one-shot directory authority and
// held artifact capabilities. In held mode every fact, byte, and digest comes
// from the single CreateFileW handle opened with OPEN_REPARSE_POINT and sharing
// that denies write/delete/replace for the entire session.
const WINDOWS_AUTHORITY_BROKER = String.raw`
$ErrorActionPreference = 'Stop'
function Write-ProprFailure([string]$code, [int]$scenario, [string]$id = '') {
  $frame = @{ version = 1; type = 'error'; reason = $code; scenario = $scenario }
  if ($id -ne '') { $frame.id = $id }
  [Console]::Out.WriteLine(($frame | ConvertTo-Json -Compress))
  [Console]::Out.Flush()
}
try {
Add-Type -TypeDefinition @'
using System;
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
      SecurityIdentifier current;
      using (WindowsIdentity identity = WindowsIdentity.GetCurrent(TokenAccessLevels.Query)) {
        current = identity.User;
      }
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
    using (WindowsIdentity identity = WindowsIdentity.GetCurrent(TokenAccessLevels.Query)) {
      string owner = identity.User.Value;
      return "O:" + owner + "G:" + owner + "D:P(A;;FA;;;" + owner + ")(A;;FA;;;SY)(A;;FA;;;BA)";
    }
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

  public sealed class HeldArtifact : IDisposable {
    SafeFileHandle handle;
    readonly long maxBytes;
    readonly InspectionResult initial;

    public HeldArtifact(string path, long maximumBytes) {
      maxBytes = maximumBytes;
      handle = OpenPinned(path, true);
      try {
        initial = InspectHandle(handle, false, maxBytes, true);
        ProveNoShareLock(path);
      } catch {
        handle.Dispose();
        handle = null;
        throw;
      }
    }

    void RequireOpen() {
      if (handle == null || handle.IsClosed || handle.IsInvalid) throw new BrokerFailure("clean_shutdown", 15);
    }

    public InspectionResult Initial { get { RequireOpen(); return initial; } }

    public byte[] Read(long offset, int length) {
      RequireOpen();
      if (offset < 0 || length <= 0 || length > MAX_READ || offset + length > Int64.Parse(initial.size)) {
        throw new BrokerFailure("request_protocol", 1);
      }
      return ReadAt(handle, offset, length, "held_read", 13);
    }

    public InspectionResult Verify() {
      RequireOpen();
      InspectionResult verified = InspectHandle(handle, false, maxBytes, true);
      if (!Same(initial, verified)) throw new BrokerFailure("final_verify", 14);
      return verified;
    }

    public InspectionResult CloseVerified() {
      try { return Verify(); }
      finally { Dispose(); }
    }

    public void Dispose() {
      if (handle == null) return;
      handle.Dispose();
      handle = null;
    }
  }

  public static HeldArtifact OpenHeld(string path, long maxBytes) {
    if (maxBytes <= 0) throw new BrokerFailure("request_protocol", 1);
    return new HeldArtifact(path, maxBytes);
  }

  public static void Smoke() {
    string root = Path.Combine(Path.GetTempPath(), "propr-win-authority-smoke-" + Guid.NewGuid().ToString("N"));
    HeldArtifact held = null;
    try {
      EnsureDirectory(root);
      string artifact = Path.Combine(root, "smoke.bin");
      File.WriteAllBytes(artifact, new byte[] { 0x50 });
      ProtectFile(artifact);
      held = OpenHeld(artifact, 1);
      if (held.Read(0, 1)[0] != 0x50) throw new BrokerFailure("held_read", 13);
      held.CloseVerified();
      held = null;
      File.Delete(artifact);
      Directory.Delete(root);
    } finally {
      if (held != null) held.Dispose();
      try { if (Directory.Exists(root)) Directory.Delete(root, true); } catch { }
    }
  }
}
'@ -Language CSharp
} catch {
  Write-ProprFailure 'compile_load' 0
  exit 0
}

function Write-ProprFrame($frame) {
  [Console]::Out.WriteLine(($frame | ConvertTo-Json -Compress))
  [Console]::Out.Flush()
}

function Test-ProprFields($value, [string[]]$fields) {
  if ($null -eq $value) { return $false }
  $names = @($value.PSObject.Properties.Name)
  if ($names.Count -ne $fields.Count) { return $false }
  foreach ($field in $fields) { if ($names -notcontains $field) { return $false } }
  return $true
}

function Write-ProprInspection([string]$type, [string]$id, [string]$challenge, $value) {
  Write-ProprFrame @{
    version = 1; type = $type; id = $id; challenge = $challenge
    volumeSerial = $value.volumeSerial; fileId128 = $value.fileId128
    directory = $value.directory; links = $value.links; size = $value.size
    reparseTag = $value.reparseTag; ownerSid = $value.ownerSid
    daclProtected = $value.daclProtected; aceCount = $value.aceCount
    inheritedWriteAces = $value.inheritedWriteAces; broadWriteAces = $value.broadWriteAces
    sha256 = $value.sha256; sha1 = $value.sha1
  }
}

$startFields = @('version', 'type', 'challenge', 'protocol')
$requestFields = @('version', 'type', 'id', 'operation', 'path', 'directory', 'maxBytes', 'challenge', 'barrier', 'offset', 'length')
$held = $null
$heldChallenge = ''
$frameCount = 0
$inputBytes = 0L
try {
  $startLine = [Console]::In.ReadLine()
  if ($null -eq $startLine -or [Text.Encoding]::UTF8.GetByteCount($startLine) -gt 16384) { throw 'start' }
  $start = $startLine | ConvertFrom-Json
  if (-not (Test-ProprFields $start $startFields) -or $start.version -ne 1 -or $start.type -ne 'start'
    -or $start.protocol -ne 'propr-windows-authority-v1' -or [string]$start.challenge -notmatch '^[a-f0-9]{32}$') { throw 'start' }
  [ProprUpdateAuthority]::Smoke()
  Write-ProprFrame @{ version = 1; type = 'ready'; challenge = [string]$start.challenge
    protocol = 'propr-windows-authority-v1'; maxRequestBytes = 16384; nativeSmoke = $true; compileCount = 1 }

  while ($true) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line) { break }
    $frameCount++
    $inputBytes += [Text.Encoding]::UTF8.GetByteCount($line) + 1
    if ($frameCount -gt 8192 -or $inputBytes -gt 67108864
      -or [Text.Encoding]::UTF8.GetByteCount($line) -gt 16384) { throw 'bound' }
    $id = ''
    $operation = ''
    try {
      $request = $line | ConvertFrom-Json
      if (-not (Test-ProprFields $request $requestFields) -or $request.version -ne 1 -or $request.type -ne 'request'
        -or [string]$request.id -notmatch '^[a-f0-9]{32}$') { throw 'request' }
      $id = [string]$request.id
      $operation = [string]$request.operation
      if ($operation -eq 'hold') {
        $requestPath = [string]$request.path
        if ($null -ne $held -or $requestPath -eq '' -or $requestPath.Length -gt 8192
          -or [string]$request.challenge -notmatch '^[a-f0-9]{32}$') { throw 'request' }
        $maximum = [Convert]::ToInt64($request.maxBytes)
        if ($maximum -le 0) { throw 'request' }
        if ($null -ne $request.barrier) {
          $barrier = [string]$request.barrier
          if ($barrier -notmatch '^[a-f0-9]{32}$') { throw 'request' }
          Write-ProprFrame @{ version = 1; type = 'before-open'; id = $id; challenge = $barrier }
          $continueLine = [Console]::In.ReadLine()
          $frameCount++
          if ($null -eq $continueLine -or [Text.Encoding]::UTF8.GetByteCount($continueLine) -gt 16384
            -or $frameCount -gt 8192) { throw 'request' }
          $inputBytes += [Text.Encoding]::UTF8.GetByteCount($continueLine) + 1
          if ($inputBytes -gt 67108864) { throw 'bound' }
          $continue = $continueLine | ConvertFrom-Json
          if (-not (Test-ProprFields $continue $requestFields) -or $continue.version -ne 1 -or $continue.type -ne 'request'
            -or $continue.id -ne $id -or $continue.operation -ne 'continue' -or $continue.challenge -ne $request.challenge
            -or $continue.barrier -ne $barrier) { throw 'request' }
        }
        $held = [ProprUpdateAuthority]::OpenHeld($requestPath, $maximum)
        $heldChallenge = [string]$request.challenge
        Write-ProprInspection 'held' $id $heldChallenge $held.Initial
      } elseif ($operation -eq 'read') {
        if ($null -eq $held -or $request.challenge -ne $heldChallenge) { throw 'request' }
        $offset = [Convert]::ToInt64($request.offset)
        $length = [Convert]::ToInt32($request.length)
        $bytes = $held.Read($offset, $length)
        Write-ProprFrame @{ version = 1; type = 'bytes'; id = $id; challenge = $heldChallenge
          bytes = [Convert]::ToBase64String($bytes) }
      } elseif ($operation -eq 'verify') {
        if ($null -eq $held -or $request.challenge -ne $heldChallenge -or [string]$request.barrier -notmatch '^[a-f0-9]{32}$') { throw 'request' }
        Write-ProprInspection 'verified' $id ([string]$request.barrier) ($held.Verify())
      } elseif ($operation -eq 'close') {
        if ($null -eq $held -or $request.challenge -ne $heldChallenge) { throw 'request' }
        $final = $held.CloseVerified()
        $held = $null
        $heldChallenge = ''
        Write-ProprInspection 'closed' $id '' $final
      } elseif ($null -ne $held) {
        throw 'request'
      } elseif ($operation -eq 'inspect') {
        Write-ProprInspection 'inspection' $id '' ([ProprUpdateAuthority]::Inspect([string]$request.path, [bool]$request.directory))
      } elseif ($operation -eq 'ensure-directory') {
        Write-ProprInspection 'inspection' $id '' ([ProprUpdateAuthority]::EnsureDirectory([string]$request.path))
      } elseif ($operation -eq 'protect-directory') {
        Write-ProprInspection 'inspection' $id '' ([ProprUpdateAuthority]::ProtectDirectory([string]$request.path))
      } elseif ($operation -eq 'protect-file') {
        Write-ProprInspection 'inspection' $id '' ([ProprUpdateAuthority]::ProtectFile([string]$request.path))
      } else { throw 'request' }
    } catch {
      if ($null -ne $held) { $held.Dispose(); $held = $null; $heldChallenge = '' }
      $failure = $_.Exception
      while ($null -ne $failure.InnerException) { $failure = $failure.InnerException }
      if ($failure -is [BrokerFailure]) { Write-ProprFailure $failure.Code $failure.Scenario $id }
      else { Write-ProprFailure 'request_protocol' 1 $id }
    }
  }
} catch {
  if ($null -ne $held) { $held.Dispose() }
  $failure = $_.Exception
  while ($null -ne $failure.InnerException) { $failure = $failure.InnerException }
  if ($failure -is [BrokerFailure]) { Write-ProprFailure $failure.Code $failure.Scenario }
  elseif ($frameCount -gt 8192 -or $inputBytes -gt 67108864) { Write-ProprFailure 'output_bound' 17 }
  else { Write-ProprFailure 'ready_protocol' 12 }
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

class WindowsAuthorityError extends Error {
  constructor(readonly reason: WindowsAuthorityReason, readonly scenario: number) {
    super(`Verified update cache authority inspection failed [win-authority:${reason}:${scenario}]`);
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

type BrokerRequestOperation = BrokerOperation | 'hold' | 'continue' | 'read' | 'verify' | 'close';
// After the bounded source and authenticated ready exchange, the persistent
// process accepts only these newline-delimited versioned request frames. Node
// permits one in-flight frame at a time; a held capability owns the FIFO lease
// until close, so its native handle cannot be confused with another entry.
interface BrokerRequestFrame {
  version: typeof WINDOWS_AUTHORITY_PROTOCOL_VERSION;
  type: 'request';
  id: string;
  operation: BrokerRequestOperation;
  path: string | null;
  directory: boolean | null;
  maxBytes: number | null;
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
  release(): void;
  timeout: NodeJS.Timeout;
}

let brokerSession: WindowsAuthoritySession | undefined;
let brokerStartup: Promise<WindowsAuthoritySession> | undefined;
let compileCount = 0;
let requestCount = 0;
let restartCount = 0;
let activeProcessCount = 0;
const brokerChildren = new Set<ChildProcessWithoutNullStreams>();

const decodeProtocolChunk = (buffered: string, chunk: string): {
  buffered: string;
  lines: readonly string[];
} => {
  let combined = buffered + chunk;
  const lines: string[] = [];
  while (combined.includes('\n')) {
    const newline = combined.indexOf('\n');
    const raw = combined.slice(0, newline);
    combined = combined.slice(newline + 1);
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (!line || /[\r\n]/.test(line)) throw authorityError('stdio_protocol', 16);
    if (Buffer.byteLength(line) > BROKER_PROTOCOL_LINE_BYTES) throw authorityError('output_bound', 17);
    lines.push(line);
  }
  if (Buffer.byteLength(combined) > BROKER_PROTOCOL_LINE_BYTES) throw authorityError('output_bound', 17);
  return { buffered: combined, lines };
};

class WindowsAuthoritySession {
  readonly exited: Promise<void>;
  private terminalError: Error | undefined;
  private buffered = '';
  private waiter: FrameWaiter | undefined;
  private stderrBytes = 0;
  private inputBytes = 0;
  private outputBytes = 0;
  private frames = 0;
  private closing = false;

  constructor(readonly child: ChildProcessWithoutNullStreams) {
    activeProcessCount++;
    brokerChildren.add(child);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.consume(chunk));
    child.stderr.on('data', (chunk: Buffer) => {
      this.stderrBytes += chunk.length;
      this.invalidate(authorityError(this.stderrBytes > BROKER_OUTPUT_BYTES ? 'output_bound' : 'process_exit',
        this.stderrBytes > BROKER_OUTPUT_BYTES ? 17 : 19));
    });
    child.stdin.on('error', () => this.invalidate(authorityError('stdio_protocol', 16)));
    child.on('error', () => this.invalidate(authorityError('process_exit', 19)));
    this.exited = new Promise(resolve => child.once('close', code => {
      activeProcessCount--;
      brokerChildren.delete(child);
      const clean = this.closing && code === 0 && this.stderrBytes === 0 && this.buffered === '';
      this.fail(clean ? authorityError('clean_shutdown', 15) : authorityError('process_exit', 19), false);
      if (brokerSession === this) brokerSession = undefined;
      resolve();
    }));
    child.unref();
    (child.stdin as typeof child.stdin & { unref?(): void }).unref?.();
    (child.stdout as typeof child.stdout & { unref?(): void }).unref?.();
    (child.stderr as typeof child.stderr & { unref?(): void }).unref?.();
  }

  private consume(chunk: string): void {
    if (this.terminalError) return;
    this.outputBytes += Buffer.byteLength(chunk);
    if (this.outputBytes > BROKER_MAX_OUTPUT_BYTES) return this.invalidate(authorityError('output_bound', 17));
    let decoded: ReturnType<typeof decodeProtocolChunk>;
    try { decoded = decodeProtocolChunk(this.buffered, chunk); } catch (error) {
      return this.invalidate(error instanceof Error ? error : authorityError('stdio_protocol', 16));
    }
    this.buffered = decoded.buffered;
    for (const line of decoded.lines) {
      if (!this.waiter) return this.invalidate(authorityError('stdio_protocol', 16));
      let value: unknown;
      try { value = JSON.parse(line); } catch { return this.invalidate(authorityError('stdio_protocol', 16)); }
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return this.invalidate(authorityError('stdio_protocol', 16));
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
    if (kill && !this.child.killed) this.child.kill();
  }

  invalidate(error: Error): void { this.fail(error, true); }

  async receive(timeoutMs: number, signal?: AbortSignal): Promise<Record<string, unknown>> {
    throwIfAborted(signal);
    if (this.terminalError) throw this.terminalError;
    if (this.waiter) throw authorityError('stdio_protocol', 16);
    return new Promise((resolve, reject) => {
      const waiter: FrameWaiter = {
        resolve,
        reject,
        signal,
        timer: setTimeout(() => this.invalidate(authorityError('timeout', 18)), timeoutMs),
      };
      if (signal) {
        waiter.abort = () => this.invalidate(abortError());
        signal.addEventListener('abort', waiter.abort, { once: true });
      }
      this.waiter = waiter;
    });
  }

  write(value: string | BrokerRequestFrame): void {
    if (this.terminalError) throw this.terminalError;
    const line = typeof value === 'string' ? value : JSON.stringify(value);
    const bytes = Buffer.byteLength(line) + 1;
    if (typeof value !== 'string' && bytes > BROKER_REQUEST_LINE_BYTES) {
      throw authorityError('request_protocol', 1);
    }
    this.inputBytes += bytes;
    if (this.inputBytes > BROKER_MAX_INPUT_BYTES || ++this.frames > BROKER_MAX_FRAMES) {
      this.invalidate(authorityError('output_bound', 17));
      throw authorityError('output_bound', 17);
    }
    this.child.stdin.write(`${line}\n`);
  }

  async exchange(frame: BrokerRequestFrame, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const response = this.receive(BROKER_TIMEOUT_MS, signal);
    this.write(frame);
    const value = await response;
    requestCount++;
    const failure = parseFailure(value, frame.id);
    if (failure) throw failure;
    if (value.id !== frame.id) {
      this.invalidate(authorityError('stdio_protocol', 16));
      throw authorityError('stdio_protocol', 16);
    }
    return value;
  }

  async shutdown(): Promise<void> {
    if (this.child.exitCode !== null) return;
    this.closing = true;
    this.child.stdin.end();
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.exited,
        new Promise<void>(resolve => {
          timer = setTimeout(() => { this.child.kill(); resolve(); }, BROKER_TIMEOUT_MS);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
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
  path: null,
  directory: null,
  maxBytes: null,
  challenge: null,
  barrier: null,
  offset: null,
  length: null,
  ...values,
});

const startBroker = async (): Promise<WindowsAuthoritySession> => {
  const source = brokerSource();
  let child: ChildProcessWithoutNullStreams;
  try { child = spawnBroker(); } catch { throw authorityError('compile_load', 0); }
  compileCount++;
  if (compileCount > 1) restartCount++;
  const session = new WindowsAuthoritySession(child);
  const challenge = randomBytes(16).toString('hex');
  const readyPromise = session.receive(BROKER_STARTUP_TIMEOUT_MS);
  session.write(source);
  session.write(JSON.stringify({
    version: WINDOWS_AUTHORITY_PROTOCOL_VERSION,
    type: 'start',
    challenge,
    protocol: 'propr-windows-authority-v1',
  }));
  const ready = await readyPromise;
  const failure = parseFailure(ready);
  if (failure) {
    session.invalidate(failure);
    throw failure;
  }
  if (!exactKeys(ready, ['version', 'type', 'challenge', 'protocol', 'maxRequestBytes', 'nativeSmoke', 'compileCount'])
    || ready.version !== WINDOWS_AUTHORITY_PROTOCOL_VERSION || ready.type !== 'ready'
    || ready.challenge !== challenge || ready.protocol !== 'propr-windows-authority-v1'
    || ready.maxRequestBytes !== BROKER_REQUEST_LINE_BYTES || ready.nativeSmoke !== true || ready.compileCount !== 1) {
    session.invalidate(authorityError('ready_protocol', 12));
    throw authorityError('ready_protocol', 12);
  }
  return session;
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
      const request = requestFrame(operation, { path, directory });
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
  maxBytes = 1024 * 1024 * 1024,
  beforeOpenForTest?: () => Promise<void>,
  signal?: AbortSignal,
  retry = true,
): Promise<WindowsLockedArtifact> => {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw authorityError('request_protocol', 1);
  const release = await acquireLease(signal);
  let session: WindowsAuthoritySession;
  let capabilityChallenge = randomBytes(16).toString('hex');
  let acquisitionBarrierRan = false;
  try {
    session = await getBroker();
    const barrierChallenge = beforeOpenForTest ? randomBytes(16).toString('hex') : null;
    const hold = requestFrame('hold', {
      path,
      maxBytes,
      challenge: capabilityChallenge,
      barrier: barrierChallenge,
    });
    let responsePromise = session.receive(BROKER_TIMEOUT_MS, signal);
    session.write(hold);
    let ready = await responsePromise;
    if (barrierChallenge) {
      if (!exactKeys(ready, ['version', 'type', 'id', 'challenge'])
        || ready.version !== WINDOWS_AUTHORITY_PROTOCOL_VERSION || ready.type !== 'before-open'
        || ready.id !== hold.id || ready.challenge !== barrierChallenge) throw authorityError('ready_protocol', 12);
      try {
        await beforeOpenForTest!();
        acquisitionBarrierRan = true;
      } catch (error) {
        session.invalidate(abortError());
        throw error;
      }
      const continuation = requestFrame('continue', {
        id: hold.id,
        challenge: capabilityChallenge,
        barrier: barrierChallenge,
      });
      responsePromise = session.receive(BROKER_TIMEOUT_MS, signal);
      session.write(continuation);
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
        value = await session.exchange(requestFrame(operation, { challenge: capabilityChallenge, ...values }), requestSignal);
      });
      commandQueue = run.catch(() => undefined);
      await run;
      return value;
    };
    const heldTimeout = setTimeout(() => {
      session.invalidate(authorityError('timeout', 18));
      release();
    }, BROKER_SESSION_TIMEOUT_MS);
    const capability: WindowsLockedArtifact = {
      inspection: initial,
      read: async (offset, length, requestSignal) => {
        if (closed || !Number.isSafeInteger(offset) || offset < 0
          || !Number.isSafeInteger(length) || length <= 0 || length > MAX_READ_BYTES
          || offset + length > Number(initial.size)) throw authorityError('request_protocol', 1);
        const result = await exchangeHeld('read', { offset, length }, requestSignal);
        if (result.type !== 'bytes' || result.challenge !== capabilityChallenge
          || typeof result.bytes !== 'string'
          || !exactKeys(result, ['version', 'type', 'id', 'challenge', 'bytes'])) {
          session.invalidate(authorityError('stdio_protocol', 16));
          throw authorityError('held_read', 13);
        }
        const bytes = Buffer.from(result.bytes, 'base64');
        if (bytes.length !== length || bytes.toString('base64') !== result.bytes) {
          session.invalidate(authorityError('stdio_protocol', 16));
          throw authorityError('held_read', 13);
        }
        return bytes;
      },
      verify: async requestSignal => {
        if (closed) throw authorityError('final_verify', 14);
        const challenge = randomBytes(16).toString('hex');
        const result = await exchangeHeld('verify', { barrier: challenge }, requestSignal);
        const verified = parseInspection(result, false, true) as WindowsHeldVerification | undefined;
        if (!verified || result.type !== 'verified' || result.challenge !== challenge
          || !exactKeys(result, RESPONSE_INSPECTION_KEYS) || !sameInitial(verified)) {
          session.invalidate(authorityError('stdio_protocol', 16));
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
          if (!final || result.type !== 'closed' || result.challenge !== ''
            || !exactKeys(result, RESPONSE_INSPECTION_KEYS) || !sameInitial(final)) {
            throw authorityError('final_verify', 14);
          }
        } catch (error) {
          session.invalidate(error instanceof Error ? error : authorityError('clean_shutdown', 15));
          throw error;
        } finally {
          lockedArtifactProcesses.delete(capability);
          release();
        }
      },
    };
    lockedArtifactProcesses.set(capability, { session, exited: session.exited, release, timeout: heldTimeout });
    session.exited.then(() => {
      clearTimeout(heldTimeout);
      release();
    }).catch(() => {
      clearTimeout(heldTimeout);
      release();
    });
    return capability;
  } catch (error) {
    release();
    if (retry && !acquisitionBarrierRan && retryableInfrastructureError(error)) {
      if (brokerSession) brokerSession.invalidate(error as Error);
      brokerSession = undefined;
      return openWindowsLockedArtifactAttempt(path, maxBytes, beforeOpenForTest, signal, false);
    }
    throw error;
  }
};

export const openWindowsLockedArtifact = (
  path: string,
  maxBytes = 1024 * 1024 * 1024,
  beforeOpenForTest?: () => Promise<void>,
  signal?: AbortSignal,
): Promise<WindowsLockedArtifact> => openWindowsLockedArtifactAttempt(
  path,
  maxBytes,
  beforeOpenForTest,
  signal,
);

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
  queuedEntries: number;
}> => Object.freeze({
  compileCount,
  requestCount,
  restartCount,
  activeProcessCount,
  queuedEntries: brokerQueue.length,
});

/** Test-only framing probe; it shares the production incremental line decoder. */
export const decodeWindowsAuthorityFramesForTest = (
  chunks: readonly string[],
  expectedFrames = 1,
): readonly Readonly<Record<string, unknown>>[] => {
  let buffered = '';
  const frames: Record<string, unknown>[] = [];
  for (const chunk of chunks) {
    const decoded = decodeProtocolChunk(buffered, chunk);
    buffered = decoded.buffered;
    for (const line of decoded.lines) {
      let value: unknown;
      try { value = JSON.parse(line); } catch { throw authorityError('stdio_protocol', 16); }
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw authorityError('stdio_protocol', 16);
      }
      frames.push(value as Record<string, unknown>);
    }
  }
  if (buffered !== '' || frames.length !== expectedFrames) throw authorityError('stdio_protocol', 16);
  return frames;
};

export const parseWindowsAuthorityStartupFailureForTest = (frame: unknown): Error =>
  parseFailure(frame) ?? authorityError('stdio_protocol', 16);

export const shutdownWindowsAuthorityBrokerForTest = async (): Promise<void> => {
  const session = brokerSession ?? await brokerStartup?.catch(() => undefined);
  brokerSession = undefined;
  if (session) await session.shutdown();
};

process.once('exit', () => {
  for (const child of brokerChildren) if (!child.killed) child.kill();
});

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
