import { randomBytes } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { isAbsolute, join } from 'node:path';
import { TextDecoder } from 'node:util';

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
  'TRANSPORT_SPAWN',
  'SOURCE_LENGTH',
  'SOURCE_READ',
  'SOURCE_UTF8',
  'SCRIPT_PARSE',
  'REFERENCE_LOAD',
  'TYPE_COMPILE',
  'ENTRYPOINT_RESOLVE',
  'PROTOCOL_INIT',
  'READY',
] as const);
export type WindowsAuthorityCompileStage = typeof WINDOWS_AUTHORITY_COMPILE_STAGES[number];

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
const BROKER_ARTIFACT_BYTES = 1024 * 1024 * 1024;
const BROKER_SETUP_FILE_BYTES = 1024 * 1024 * 1024 + 64 * 1024;
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
// Strict UTF-8 fragmentation sentinel: π🙂
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Web.Script.Serialization;
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
  const int MAX_REQUEST = 16384;
  const int MAX_JSON = 2097152;
  const int MAX_FRAMES = 8192;
  const long MAX_INPUT = 67108864L;
  static readonly string CURRENT_USER_SID = WindowsIdentity.GetCurrent(TokenAccessLevels.Query).User.Value;
  static readonly UTF8Encoding STRICT_UTF8 = new UTF8Encoding(false, true);
  static readonly JavaScriptSerializer JSON = new JavaScriptSerializer { MaxJsonLength = MAX_JSON };

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
      SecurityIdentifier current = new SecurityIdentifier(CURRENT_USER_SID);
      if (security.Owner == null || !security.Owner.Equals(current)) {
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

  static InspectionResult InspectHandle(SafeFileHandle handle, bool expectedDirectory, string purpose, long expectedBytes) {
    FILE_ATTRIBUTE_TAG_INFO attributes = ReadInfo<FILE_ATTRIBUTE_TAG_INFO>(handle, FileAttributeTagInfo, "reparse_query", 3);
    if ((attributes.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0 || attributes.ReparseTag != 0) {
      throw new BrokerFailure("reparse_point", 4);
    }
    FILE_STANDARD_INFO standard = ReadInfo<FILE_STANDARD_INFO>(handle, FileStandardInfo, "type_link_size", 5);
    bool setup = purpose == "setup";
    bool artifact = purpose == "artifact";
    if (standard.DeletePending || standard.Directory != expectedDirectory || (!standard.Directory && standard.NumberOfLinks != 1)
      || (standard.Directory && (!setup || expectedBytes != 0))
      || (!standard.Directory && setup && (expectedBytes != 0 || standard.EndOfFile < 0 || standard.EndOfFile > 1073807360L))
      || (!standard.Directory && artifact && (expectedBytes <= 0 || standard.EndOfFile != expectedBytes))
      || (!setup && !artifact)) {
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
    if (artifact) {
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
    return "O:" + CURRENT_USER_SID + "G:" + CURRENT_USER_SID + "D:P(A;;FA;;;" + CURRENT_USER_SID
      + ")(A;;FA;;;SY)(A;;FA;;;BA)";
  }

  public static InspectionResult Inspect(string path, bool expectedDirectory) {
    using (SafeFileHandle handle = OpenPinned(path, false)) {
      return InspectHandle(handle, expectedDirectory, "setup", 0);
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
    long expectedBytes;
    InspectionResult initial;

    public HeldArtifact(string path, long exactBytes, string expectedVolumeSerial, string expectedFileId128,
      string purpose, string expectedSha256) {
      expectedBytes = exactBytes;
      handle = OpenPinned(path, true);
      try {
        initial = InspectHandle(handle, false, "artifact", expectedBytes);
        if (initial.volumeSerial != expectedVolumeSerial || initial.fileId128 != expectedFileId128) {
          throw new BrokerFailure("final_verify", 14);
        }
        if (purpose == "artifact" && initial.sha256 != expectedSha256) {
          throw new BrokerFailure("hash_read", 11);
        }
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
      InspectionResult verified = InspectHandle(handle, false, "artifact", expectedBytes);
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

  public static HeldArtifact OpenHeld(string path, long expectedBytes, string expectedVolumeSerial, string expectedFileId128,
    string purpose, string expectedSha256) {
    if (expectedBytes <= 0 || expectedBytes > 1073741824L || expectedVolumeSerial == null || expectedFileId128 == null
      || (purpose != "setup" && purpose != "artifact")
      || (purpose == "artifact" && (expectedSha256 == null || expectedSha256.Length != 64))
      || (purpose == "setup" && expectedSha256 != null)) {
      throw new BrokerFailure("request_protocol", 1);
    }
    return new HeldArtifact(path, expectedBytes, expectedVolumeSerial, expectedFileId128, purpose, expectedSha256);
  }

  public static void Smoke() {
    string root = Path.Combine(Path.GetTempPath(), "propr-win-authority-smoke-" + Guid.NewGuid().ToString("N"));
    HeldArtifact held = null;
    try {
      EnsureDirectory(root);
      string artifact = Path.Combine(root, "smoke.bin");
      File.WriteAllBytes(artifact, new byte[] { 0x50 });
      ProtectFile(artifact);
      InspectionResult setup = Inspect(artifact, false);
      held = OpenHeld(artifact, 1, setup.volumeSerial, setup.fileId128, "setup", null);
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
  static readonly string[] START_FIELDS = { "version", "type", "challenge", "protocol" };
  static readonly string[] REQUEST_FIELDS = { "version", "type", "id", "operation", "purpose", "path",
    "directory", "expectedBytes", "expectedVolumeSerial", "expectedFileId128", "expectedSha256", "challenge",
    "barrier", "offset", "length" };

  static Dictionary<string, object> Frame(params object[] values) {
    Dictionary<string, object> frame = new Dictionary<string, object>();
    for (int index = 0; index < values.Length; index += 2) frame[(string)values[index]] = values[index + 1];
    return frame;
  }

  static void WriteFrame(Dictionary<string, object> frame) {
    Console.Out.WriteLine(JSON.Serialize(frame));
    Console.Out.Flush();
  }

  static void WriteFailure(string code, int scenario, string id) {
    Dictionary<string, object> frame = Frame("version", 1, "type", "error", "reason", code, "scenario", scenario);
    if (!String.IsNullOrEmpty(id)) frame["id"] = id;
    WriteFrame(frame);
  }

  static void WriteInspection(string type, string id, string challenge, InspectionResult value) {
    WriteFrame(Frame("version", 1, "type", type, "id", id, "challenge", challenge,
      "volumeSerial", value.volumeSerial, "fileId128", value.fileId128, "directory", value.directory,
      "links", value.links, "size", value.size, "reparseTag", value.reparseTag, "ownerSid", value.ownerSid,
      "daclProtected", value.daclProtected, "aceCount", value.aceCount,
      "inheritedWriteAces", value.inheritedWriteAces, "broadWriteAces", value.broadWriteAces,
      "sha256", value.sha256, "sha1", value.sha1));
  }

  static bool ExactFields(Dictionary<string, object> value, string[] fields) {
    if (value == null || value.Count != fields.Length) return false;
    foreach (string field in fields) if (!value.ContainsKey(field)) return false;
    return true;
  }

  static bool NullFields(Dictionary<string, object> value, params string[] fields) {
    foreach (string field in fields) if (!value.ContainsKey(field) || value[field] != null) return false;
    return true;
  }

  static string Text(Dictionary<string, object> value, string field) {
    object item;
    return value.TryGetValue(field, out item) && item is string ? (string)item : null;
  }

  static bool IsBool(Dictionary<string, object> value, string field, bool expected) {
    object item;
    return value.TryGetValue(field, out item) && item is bool && (bool)item == expected;
  }

  static long Integer(Dictionary<string, object> value, string field) {
    object item;
    if (!value.TryGetValue(field, out item) || item == null) throw new BrokerFailure("request_protocol", 1);
    try { return Convert.ToInt64(item); } catch { throw new BrokerFailure("request_protocol", 1); }
  }

  static bool Hex(string value, int length) {
    if (value == null || value.Length != length) return false;
    foreach (char character in value) if (!((character >= '0' && character <= '9') || (character >= 'a' && character <= 'f'))) return false;
    return true;
  }

  static string ReadLineBounded(Stream input, ref long inputBytes) {
    MemoryStream bytes = new MemoryStream();
    while (true) {
      int next = input.ReadByte();
      if (next < 0) return bytes.Length == 0 ? null : throwProtocol();
      inputBytes++;
      if (inputBytes > MAX_INPUT || bytes.Length > MAX_REQUEST) throw new BrokerFailure("output_bound", 17);
      if (next == 10) break;
      if (next == 13 || bytes.Length == MAX_REQUEST) throw new BrokerFailure("request_protocol", 1);
      bytes.WriteByte((byte)next);
    }
    if (bytes.Length == 0) throw new BrokerFailure("request_protocol", 1);
    try { return STRICT_UTF8.GetString(bytes.ToArray()); }
    catch { throw new BrokerFailure("request_protocol", 1); }
  }

  static string throwProtocol() { throw new BrokerFailure("request_protocol", 1); }

  static Dictionary<string, object> ReadObject(Stream input, ref long inputBytes) {
    string line = ReadLineBounded(input, ref inputBytes);
    if (line == null) return null;
    try { return JSON.Deserialize<Dictionary<string, object>>(line); }
    catch { throw new BrokerFailure("request_protocol", 1); }
  }

  static BrokerFailure Innermost(Exception error) {
    while (error.InnerException != null) error = error.InnerException;
    return error as BrokerFailure;
  }

  public static void Initialize() { Smoke(); }

  public static void Serve() {
    Stream input = Console.OpenStandardInput();
    long inputBytes = 0;
    int frameCount = 0;
    Dictionary<string, object> start = ReadObject(input, ref inputBytes);
    if (!ExactFields(start, START_FIELDS) || Integer(start, "version") != 1 || Text(start, "type") != "start"
      || Text(start, "protocol") != "propr-windows-authority-v1" || !Hex(Text(start, "challenge"), 32)) {
      throw new BrokerFailure("ready_protocol", 12);
    }
    WriteFrame(Frame("version", 1, "type", "ready", "challenge", Text(start, "challenge"),
      "protocol", "propr-windows-authority-v1", "maxRequestBytes", MAX_REQUEST,
      "nativeSmoke", true, "compileCount", 1));

    HeldArtifact held = null;
    string heldChallenge = "";
    string heldId = "";
    string heldPurpose = "";
    try {
      while (true) {
        Dictionary<string, object> request = ReadObject(input, ref inputBytes);
        if (request == null) break;
        if (++frameCount > MAX_FRAMES) throw new BrokerFailure("output_bound", 17);
        string id = "";
        try {
          if (!ExactFields(request, REQUEST_FIELDS) || Integer(request, "version") != 1
            || Text(request, "type") != "request" || !Hex(Text(request, "id"), 32)) throwProtocol();
          id = Text(request, "id");
          string operation = Text(request, "operation");
          string purpose = Text(request, "purpose");
          if (operation == "hold") {
            string path = Text(request, "path");
            if (held != null || String.IsNullOrEmpty(path) || path.Length > 8192
              || (purpose != "setup" && purpose != "artifact") || !NullFields(request, "directory", "offset", "length")
              || !Hex(Text(request, "challenge"), 32) || !Hex(Text(request, "expectedVolumeSerial"), 16)
              || !Hex(Text(request, "expectedFileId128"), 32)
              || (purpose == "artifact" && !Hex(Text(request, "expectedSha256"), 64))
              || (purpose == "setup" && request["expectedSha256"] != null)) throwProtocol();
            long expectedBytes = Integer(request, "expectedBytes");
            if (expectedBytes <= 0) throwProtocol();
            if (request["barrier"] != null) {
              string barrier = Text(request, "barrier");
              if (!Hex(barrier, 32)) throwProtocol();
              WriteFrame(Frame("version", 1, "type", "before-open", "id", id, "challenge", barrier));
              Dictionary<string, object> continuation = ReadObject(input, ref inputBytes);
              if (++frameCount > MAX_FRAMES || !ExactFields(continuation, REQUEST_FIELDS)
                || Integer(continuation, "version") != 1 || Text(continuation, "type") != "request"
                || Text(continuation, "id") != id || Text(continuation, "operation") != "continue"
                || Text(continuation, "purpose") != purpose || Text(continuation, "challenge") != Text(request, "challenge")
                || Text(continuation, "barrier") != barrier || !NullFields(continuation, "path", "directory", "expectedBytes",
                  "expectedVolumeSerial", "expectedFileId128", "expectedSha256", "offset", "length")) throwProtocol();
            }
            held = OpenHeld(path, expectedBytes, Text(request, "expectedVolumeSerial"), Text(request, "expectedFileId128"),
              purpose, Text(request, "expectedSha256"));
            heldChallenge = Text(request, "challenge"); heldId = id; heldPurpose = purpose;
            WriteInspection("held", id, heldChallenge, held.Initial);
          } else if (operation == "read") {
            if (held == null || id != heldId || purpose != heldPurpose || Text(request, "challenge") != heldChallenge
              || !NullFields(request, "path", "directory", "expectedBytes", "expectedVolumeSerial", "expectedFileId128",
                "expectedSha256", "barrier")) throwProtocol();
            byte[] bytes = held.Read(Integer(request, "offset"), checked((int)Integer(request, "length")));
            WriteFrame(Frame("version", 1, "type", "bytes", "id", id, "challenge", heldChallenge,
              "bytes", Convert.ToBase64String(bytes)));
          } else if (operation == "verify") {
            if (held == null || id != heldId || purpose != heldPurpose || Text(request, "challenge") != heldChallenge
              || !Hex(Text(request, "barrier"), 32) || !NullFields(request, "path", "directory", "expectedBytes",
                "expectedVolumeSerial", "expectedFileId128", "expectedSha256", "offset", "length")) throwProtocol();
            WriteInspection("verified", id, Text(request, "barrier"), held.Verify());
          } else if (operation == "close") {
            if (held == null || id != heldId || purpose != heldPurpose || Text(request, "challenge") != heldChallenge
              || !NullFields(request, "path", "directory", "expectedBytes", "expectedVolumeSerial", "expectedFileId128",
                "expectedSha256", "barrier", "offset", "length")) throwProtocol();
            InspectionResult final = held.CloseVerified(); held = null; heldChallenge = ""; heldId = ""; heldPurpose = "";
            WriteInspection("closed", id, "", final);
          } else if (held != null) {
            throwProtocol();
          } else if (operation == "inspect") {
            if (purpose != "setup" || request["path"] == null || !(request["directory"] is bool)
              || !NullFields(request, "expectedBytes", "expectedVolumeSerial", "expectedFileId128", "expectedSha256",
                "challenge", "barrier", "offset", "length")) throwProtocol();
            WriteInspection("inspection", id, "", Inspect(Text(request, "path"), (bool)request["directory"]));
          } else if (operation == "ensure-directory" || operation == "protect-directory" || operation == "protect-file") {
            bool expectedDirectory = operation != "protect-file";
            if (purpose != "setup" || !IsBool(request, "directory", expectedDirectory)
              || !NullFields(request, "expectedBytes", "expectedVolumeSerial", "expectedFileId128", "expectedSha256",
                "challenge", "barrier", "offset", "length")) throwProtocol();
            InspectionResult result = operation == "ensure-directory" ? EnsureDirectory(Text(request, "path"))
              : operation == "protect-directory" ? ProtectDirectory(Text(request, "path")) : ProtectFile(Text(request, "path"));
            WriteInspection("inspection", id, "", result);
          } else throwProtocol();
        } catch (Exception error) {
          if (held != null) { held.Dispose(); held = null; heldChallenge = ""; heldId = ""; heldPurpose = ""; }
          BrokerFailure failure = Innermost(error);
          WriteFailure(failure == null ? "request_protocol" : failure.Code, failure == null ? 1 : failure.Scenario, id);
        }
      }
    } catch (Exception error) {
      BrokerFailure failure = Innermost(error);
      WriteFailure(failure == null ? "request_protocol" : failure.Code, failure == null ? 1 : failure.Scenario, "");
    } finally { if (held != null) held.Dispose(); }
  }
}
`;

// This fixed loader is the only command-line payload. It opens stdin once as a
// binary stream, consumes an eight-byte hexadecimal length and exactly that many
// raw UTF-8 C# bytes, compiles once, then transfers the same stream to Serve().
const POWERSHELL_BINARY_LOADER = String.raw`
$ErrorActionPreference='Stop'
$inputStream=[Console]::OpenStandardInput()
$inject=[Environment]::GetEnvironmentVariable('PROPR_WINDOWS_AUTHORITY_TEST_STAGE')
function Set-ProprStage([int]$index,[string]$name){
  [Console]::Error.WriteLine(('PROPR_BOOTSTRAP {0:D2} {1}' -f $index,$name));[Console]::Error.Flush()
  if($inject -eq $name){throw 'injected'}
}
function Read-ProprExact([int]$count){
  $bytes=New-Object byte[] $count;$offset=0
  while($offset -lt $count){$read=$inputStream.Read($bytes,$offset,$count-$offset);if($read -le 0){throw 'eof'};$offset+=$read}
  return ,$bytes
}
try {
  Set-ProprStage 1 'SOURCE_LENGTH'
  $prefix=Read-ProprExact 8
  $lengthText=[Text.Encoding]::ASCII.GetString($prefix)
  if($lengthText -cnotmatch '^[0-9A-F]{8}$'){throw 'length'}
  $length=[Convert]::ToInt32($lengthText,16)
  if($length -le 0 -or $length -gt 262144){throw 'length'}
  Set-ProprStage 2 'SOURCE_READ'
  $sourceBytes=Read-ProprExact $length
  Set-ProprStage 3 'SOURCE_UTF8'
  $source=(New-Object Text.UTF8Encoding($false,$true)).GetString($sourceBytes)
  Set-ProprStage 4 'SCRIPT_PARSE'
  $compiler=[ScriptBlock]::Create('param($source) Add-Type -TypeDefinition $source -Language CSharp -ReferencedAssemblies ''System.Web.Extensions.dll'' -CompilerOptions ''/langversion:5''')
  Set-ProprStage 5 'REFERENCE_LOAD'
  $null=[Reflection.Assembly]::Load('System.Web.Extensions, Version=4.0.0.0, Culture=neutral, PublicKeyToken=31BF3856AD364E35')
  Set-ProprStage 6 'TYPE_COMPILE'
  & $compiler $source
  Set-ProprStage 7 'ENTRYPOINT_RESOLVE'
  $type=[ProprUpdateAuthority]
  $initialize=$type.GetMethod('Initialize',[Reflection.BindingFlags]'Public,Static')
  $serve=$type.GetMethod('Serve',[Reflection.BindingFlags]'Public,Static')
  if($null -eq $initialize -or $null -eq $serve){throw 'entrypoint'}
  Set-ProprStage 8 'PROTOCOL_INIT'
  $null=$initialize.Invoke($null,@())
  Set-ProprStage 9 'READY'
  $null=$serve.Invoke($null,@())
} catch { exit 70 }
`;

const POWERSHELL_BINARY_LOADER_ENCODED = Buffer.from(POWERSHELL_BINARY_LOADER, 'utf16le').toString('base64');

const brokerSource = (): Buffer => {
  const bytes = Buffer.from(WINDOWS_AUTHORITY_BROKER, 'utf8');
  if (bytes.length <= 0 || bytes.length > BROKER_SOURCE_BYTES) throw authorityError('compile_load', 0);
  return bytes;
};

const sourcePrefix = (bytes: number): Buffer => Buffer.from(bytes.toString(16).toUpperCase().padStart(8, '0'), 'ascii');

/** Pure test seam for the loader's exact incremental prefix/source contract. */
export const decodeWindowsAuthoritySourceForTest = (chunks: readonly Buffer[]): string => {
  const prefix = Buffer.alloc(8);
  let prefixBytes = 0;
  let expected: number | undefined;
  const source: Buffer[] = [];
  let sourceBytes = 0;
  for (const chunk of chunks) {
    if (!Buffer.isBuffer(chunk) || chunk.length === 0) throw authorityError('compile_load', expected === undefined ? 1 : 2);
    let offset = 0;
    if (prefixBytes < prefix.length) {
      const copied = Math.min(prefix.length - prefixBytes, chunk.length);
      chunk.copy(prefix, prefixBytes, 0, copied);
      prefixBytes += copied;
      offset += copied;
      if (prefixBytes === prefix.length) {
        const length = prefix.toString('ascii');
        if (!/^[0-9A-F]{8}$/.test(length)) throw authorityError('compile_load', 1);
        expected = Number.parseInt(length, 16);
        if (expected <= 0 || expected > BROKER_SOURCE_BYTES) throw authorityError('compile_load', 1);
      }
    }
    if (offset < chunk.length) {
      if (expected === undefined || sourceBytes + chunk.length - offset > expected) throw authorityError('compile_load', 2);
      source.push(chunk.subarray(offset));
      sourceBytes += chunk.length - offset;
    }
  }
  if (prefixBytes !== prefix.length) throw authorityError('compile_load', 1);
  if (expected === undefined || sourceBytes !== expected) throw authorityError('compile_load', 2);
  try { return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(source)); }
  catch { throw authorityError('compile_load', 3); }
};

export const encodeWindowsAuthoritySourceForTest = (source: string): Buffer => {
  const bytes = Buffer.from(source, 'utf8');
  return Buffer.concat([sourcePrefix(bytes.length), bytes]);
};

const windowsPowerShellPath = (): string => {
  const systemRoot = process.env.SystemRoot;
  if (!systemRoot || !isAbsolute(systemRoot)) throw authorityError('compile_load', 0);
  return join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
};

const spawnPowerShell = (injectedStage?: WindowsAuthorityCompileStage): ChildProcessWithoutNullStreams => {
  const env = { ...process.env };
  delete env.PROPR_WINDOWS_AUTHORITY_TEST_STAGE;
  if (injectedStage && injectedStage !== 'TRANSPORT_SPAWN') {
    env.PROPR_WINDOWS_AUTHORITY_TEST_STAGE = injectedStage;
  }
  return spawn(windowsPowerShellPath(), [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-EncodedCommand',
    POWERSHELL_BINARY_LOADER_ENCODED,
  ], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env });
};

const spawnBroker = (injectedStage?: WindowsAuthorityCompileStage): ChildProcessWithoutNullStreams =>
  spawnPowerShell(injectedStage);

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
  private stderrBuffered = '';
  private bootstrapStages: WindowsAuthorityCompileStage[] = ['TRANSPORT_SPAWN'];
  private bootstrapReady = false;
  private bootstrapResolve!: () => void;
  private readonly bootstrapCompleted = new Promise<void>(resolve => { this.bootstrapResolve = resolve; });
  private inputBytes = 0;
  private outputBytes = 0;
  private frames = 0;
  private closing = false;

  constructor(readonly child: ChildProcessWithoutNullStreams, private readonly sharedQueue = true) {
    activeProcessCount++;
    brokerChildren.add(child);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.consume(chunk));
    child.stderr.on('data', (chunk: Buffer) => this.consumeBootstrapStage(chunk));
    child.stdin.on('error', () => this.invalidate(this.bootstrapReady
      ? authorityError('stdio_protocol', 16) : this.bootstrapError('WRITE_ERROR')));
    child.on('error', () => this.invalidate(this.bootstrapReady
      ? authorityError('process_exit', 19) : this.bootstrapError('SPAWN_ERROR')));
    this.exited = new Promise(resolve => child.once('close', code => {
      activeProcessCount--;
      brokerChildren.delete(child);
      const clean = this.closing && code === 0 && this.stderrBuffered === '' && this.buffered === '';
      this.fail(clean ? authorityError('clean_shutdown', 15)
        : this.bootstrapReady ? authorityError('process_exit', 19)
          : this.bootstrapError(this.outputBytes === 0 ? 'EXIT_NO_OUTPUT' : 'EXIT_AFTER_OUTPUT'), false);
      if (brokerSession === this) brokerSession = undefined;
      resolve();
    }));
    child.unref();
    (child.stdin as typeof child.stdin & { unref?(): void }).unref?.();
    (child.stdout as typeof child.stdout & { unref?(): void }).unref?.();
    (child.stderr as typeof child.stderr & { unref?(): void }).unref?.();
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

  private consume(chunk: string): void {
    if (this.terminalError) return;
    this.outputBytes += Buffer.byteLength(chunk);
    if (this.outputBytes > BROKER_MAX_OUTPUT_BYTES) return this.invalidate(authorityError('output_bound', 17));
    let decoded: ReturnType<typeof decodeProtocolChunk>;
    try { decoded = decodeProtocolChunk(this.buffered, chunk); } catch (error) {
      return this.invalidate(this.bootstrapReady
        ? (error instanceof Error ? error : authorityError('stdio_protocol', 16))
        : this.bootstrapError('MALFORMED_OUTPUT'));
    }
    this.buffered = decoded.buffered;
    for (const line of decoded.lines) {
      if (!this.waiter) return this.invalidate(this.bootstrapReady
        ? authorityError('stdio_protocol', 16) : this.bootstrapError('EXTRA_OUTPUT'));
      let value: unknown;
      try { value = JSON.parse(line); } catch {
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

  async writeBootstrap(source: Buffer, chunks?: readonly number[]): Promise<void> {
    if (source.length <= 0 || source.length > BROKER_SOURCE_BYTES) throw authorityError('compile_load', 1);
    const payload = Buffer.concat([sourcePrefix(source.length), source]);
    this.inputBytes += payload.length;
    if (this.inputBytes > BROKER_MAX_INPUT_BYTES) throw authorityError('output_bound', 17);
    if (!chunks) return this.writeChunk(payload);
    let offset = 0;
    for (const size of chunks) {
      if (!Number.isInteger(size) || size <= 0 || offset + size > payload.length) throw authorityError('request_protocol', 1);
      await this.writeChunk(payload.subarray(offset, offset += size));
    }
    if (offset !== payload.length) await this.writeChunk(payload.subarray(offset));
  }

  async write(value: string | BrokerRequestFrame): Promise<void> {
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
    await this.writeChunk(`${line}\n`);
  }

  async writeRawForTest(chunks: readonly string[]): Promise<void> {
    if (this.terminalError || chunks.length === 0
      || chunks.some(chunk => chunk.length === 0 || Buffer.byteLength(chunk) > BROKER_REQUEST_LINE_BYTES)) {
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
  source?: Buffer;
  injectedStage?: WindowsAuthorityCompileStage;
  countCompilation?: boolean;
  bootstrapChunks?: readonly number[];
}

const startBroker = async (options: StartBrokerOptions = {}): Promise<WindowsAuthoritySession> => {
  const source = options.source ?? brokerSource();
  let child: ChildProcessWithoutNullStreams;
  try {
    if (options.injectedStage === 'TRANSPORT_SPAWN') throw new Error('injected');
    child = spawnBroker(options.injectedStage);
  } catch { throw new WindowsAuthorityBootstrapError('SPAWN_ERROR', 0); }
  if (options.countCompilation !== false) {
    compileCount++;
    if (compileCount > 1) restartCount++;
  }
  const session = new WindowsAuthoritySession(child, options.countCompilation !== false);
  const challenge = randomBytes(16).toString('hex');
  const startupDeadline = Date.now() + BROKER_STARTUP_TIMEOUT_MS;
  const readyPromise = session.receive(BROKER_STARTUP_TIMEOUT_MS, undefined, true);
  try {
    await session.writeBootstrap(source, options.bootstrapChunks);
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
  await session.requireBootstrapReady(Math.max(1, startupDeadline - Date.now()));
  const failure = parseFailure(ready);
  if (failure) {
    session.invalidate(failure);
    throw failure;
  }
  if (!exactKeys(ready, ['version', 'type', 'challenge', 'protocol', 'maxRequestBytes', 'nativeSmoke', 'compileCount'])
    || ready.version !== WINDOWS_AUTHORITY_PROTOCOL_VERSION || ready.type !== 'ready'
    || ready.challenge !== challenge || ready.protocol !== 'propr-windows-authority-v1'
    || ready.maxRequestBytes !== BROKER_REQUEST_LINE_BYTES || ready.nativeSmoke !== true || ready.compileCount !== 1) {
    const error = new WindowsAuthorityBootstrapError('MALFORMED_OUTPUT', WINDOWS_AUTHORITY_COMPILE_STAGES.indexOf('READY'));
    session.invalidate(error);
    throw error;
  }
  return session;
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

/** Hosted smoke of the exact production source, loader, native initialization, and READY handshake. */
export const probeWindowsAuthorityCompile = (): Promise<WindowsAuthorityCompileStage> =>
  runWindowsAuthorityCompileProbe();

/** Native-test-only negative compile probe; no source or compiler diagnostics leave the child. */
export const probeWindowsAuthorityCompileFailureForTest = (): Promise<WindowsAuthorityCompileStage> =>
  runWindowsAuthorityCompileProbe({ source: Buffer.from('public class Invalid {', 'utf8') });

/** Native-test-only failure injection at each fixed startup boundary. */
export const probeWindowsAuthorityBootstrapStageForTest = (stage: WindowsAuthorityCompileStage): Promise<WindowsAuthorityCompileStage> =>
  runWindowsAuthorityCompileProbe({ injectedStage: stage });

/** Native-test-only byte-at-a-time transport across every production source boundary. */
export const probeWindowsAuthorityFragmentedSourceForTest = (): Promise<WindowsAuthorityCompileStage> => {
  const source = brokerSource();
  return runWindowsAuthorityCompileProbe({
    source,
    bootstrapChunks: Array.from({ length: source.length + 8 }, () => 1),
  });
};

/** Native-test-only malformed startup transport; the child receives no mutable path or command-line source. */
export const probeWindowsAuthorityRawSourceFailureForTest = async (
  kind: 'partial-prefix' | 'partial-source' | 'oversize' | 'invalid-utf8' | 'trailing-source',
): Promise<WindowsAuthorityCompileStage> => {
  const exact = brokerSource();
  const payload = kind === 'partial-prefix' ? Buffer.from('0000', 'ascii')
    : kind === 'partial-source' ? Buffer.concat([Buffer.from('00000004', 'ascii'), Buffer.from('ab')])
      : kind === 'oversize' ? Buffer.from('00040001', 'ascii')
        : kind === 'invalid-utf8' ? Buffer.concat([Buffer.from('00000002', 'ascii'), Buffer.from([0xc3, 0x28])])
          : Buffer.concat([sourcePrefix(exact.length), exact, Buffer.from('X')]);
  const session = new WindowsAuthoritySession(spawnBroker(), false);
  const response = session.receive(BROKER_STARTUP_TIMEOUT_MS, undefined, true);
  session.child.stdin.end(payload);
  try {
    await response;
    throw authorityError('stdio_protocol', 16);
  } catch (error) {
    return compileStageFromError(error);
  } finally {
    if (session.child.exitCode === null) session.child.kill();
    await session.exited;
  }
};

/** Native-test-only startup failure against an exact-source production child. */
export const probeWindowsAuthorityStartupFailureForTest = async (): Promise<WindowsAuthorityReason> => {
  const session = new WindowsAuthoritySession(spawnBroker(), false);
  try {
    const response = session.receive(BROKER_STARTUP_TIMEOUT_MS, undefined, true);
    await session.writeBootstrap(brokerSource());
    await session.write(JSON.stringify({
      version: WINDOWS_AUTHORITY_PROTOCOL_VERSION,
      type: 'start',
      challenge: randomBytes(16).toString('hex'),
      protocol: 'invalid-protocol',
    }));
    await response;
    throw authorityError('stdio_protocol', 16);
  } catch (error) {
    if (error instanceof WindowsAuthorityError && error.reason === 'compile_load'
      && error.scenario === WINDOWS_AUTHORITY_COMPILE_STAGES.indexOf('READY')) return 'ready_protocol';
    throw error;
  } finally {
    await session.shutdown();
  }
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
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes <= 0 || expectedBytes > BROKER_ARTIFACT_BYTES
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
      purpose: expectedSha256 ? 'artifact' : 'setup',
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
        if (result.type !== 'bytes' || result.challenge !== capabilityChallenge
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
        if (!verified || result.type !== 'verified' || result.challenge !== challenge
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
          if (!final || result.type !== 'closed' || result.challenge !== ''
            || !exactKeys(result, RESPONSE_INSPECTION_KEYS) || !sameInitial(final)) {
            throw authorityError('final_verify', 14);
          }
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
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes <= 0 || expectedBytes > BROKER_ARTIFACT_BYTES) {
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
      const line = `${JSON.stringify(inspect)}\n`;
      const split = Math.floor(line.length / 2);
      await session.writeRawForTest([line.slice(0, split), line.slice(split)]);
      const value = await response;
      const parsed = parseInspection(value, false, false);
      if (!parsed || value.id !== inspect.id || value.type !== 'inspection') throw authorityError('stdio_protocol', 16);
      return 'accepted';
    }
    if (kind === 'extra-frame') {
      const response = session.receive(BROKER_TIMEOUT_MS);
      await session.writeRawForTest([`${JSON.stringify(inspect)}\n${JSON.stringify(requestFrame('inspect', {
        purpose: 'setup',
        path,
        directory: false,
      }))}\n`]);
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
  kind: 'wrong-id' | 'wrong-purpose',
): Promise<WindowsAuthorityReason> => {
  const process = lockedArtifactProcesses.get(held);
  if (!process) throw authorityError('request_protocol', 1);
  const frame = requestFrame('read', {
    id: kind === 'wrong-id' ? randomBytes(16).toString('hex') : process.heldId,
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
