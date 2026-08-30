// Strict UTF-8 source; the build gate rejects invalid byte sequences.
using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
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
  public bool daclProtected;
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
  static readonly Stream OUTPUT = Console.OpenStandardOutput();
  static SafeFileHandle IMAGE_LEASE;
  static string IMAGE_VOLUME;
  static string IMAGE_FILE_ID;
  static string IMAGE_SHA256;

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

  [DllImport("wintrust.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
  static extern int WinVerifyTrust(IntPtr window, [In] ref Guid action, IntPtr data);

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct WINTRUST_FILE_INFO {
    public uint cbStruct;
    public string pcwszFilePath;
    public IntPtr hFile;
    public IntPtr pgKnownSubject;
  }

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct WINTRUST_DATA {
    public uint cbStruct;
    public IntPtr pPolicyCallbackData;
    public IntPtr pSIPClientData;
    public uint dwUIChoice;
    public uint fdwRevocationChecks;
    public uint dwUnionChoice;
    public IntPtr pFile;
    public uint dwStateAction;
    public IntPtr hWVTStateData;
    public string pwszURLReference;
    public uint dwProvFlags;
    public uint dwUIContext;
    public IntPtr pSignatureSettings;
  }

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
      int priorOrder = -1;
      foreach (GenericAce generic in security.DiscretionaryAcl) {
        aceCount++;
        if ((generic.AceFlags & AceFlags.Inherited) != 0) throw new BrokerFailure("dacl_ace", 8);
        QualifiedAce qualified = generic as QualifiedAce;
        KnownAce known = generic as KnownAce;
        if (qualified == null || known == null || known.SecurityIdentifier == null
          || (qualified.AceQualifier != AceQualifier.AccessAllowed
            && qualified.AceQualifier != AceQualifier.AccessDenied)) {
          throw new BrokerFailure("dacl_ace", 8);
        }
        bool allowed = qualified.AceQualifier == AceQualifier.AccessAllowed;
        int order = allowed ? 1 : 0;
        if (order < priorOrder) throw new BrokerFailure("dacl_ace", 8);
        priorOrder = order;
        SecurityIdentifier sid = known.SecurityIdentifier;
        bool trusted = sid != null && (sid.Equals(current) || sid.Equals(system) || sid.Equals(administrators));
        if (allowed && !trusted && (known.AccessMask & WRITE_AUTHORITY) != 0) {
          throw new BrokerFailure("dacl_ace", 8);
        }
      }
      return new SecurityResult { ownerSid = current.Value, daclProtected = true, aceCount = aceCount };
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
      daclProtected = security.daclProtected,
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
    string purpose;
    InspectionResult initial;

    public HeldArtifact(string path, long exactBytes, string expectedVolumeSerial, string expectedFileId128,
      string purpose, string expectedSha256) {
      expectedBytes = exactBytes;
      this.purpose = purpose;
      handle = OpenPinned(path, true);
      try {
        initial = InspectHeld();
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

    InspectionResult InspectHeld() {
      InspectionResult result = InspectHandle(handle, false, purpose, expectedBytes);
      // Held responses have one stable schema for setup and artifact
      // capabilities. Setup policy remains bounded/non-exact, but its exact
      // held bytes are still hashed for later same-handle comparisons.
      if (purpose == "setup") {
        string[] hashes = Hash(handle, Int64.Parse(result.size));
        result.sha256 = hashes[0];
        result.sha1 = hashes[1];
      }
      return result;
    }

    public byte[] Read(long offset, int length) {
      RequireOpen();
      if (offset < 0 || length <= 0 || length > MAX_READ || offset + length > Int64.Parse(initial.size)) {
        throw new BrokerFailure("request_protocol", 1);
      }
      return ReadAt(handle, offset, length, "held_read", 13);
    }

    public InspectionResult Verify() {
      RequireOpen();
      InspectionResult verified = InspectHeld();
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
    if (expectedBytes < 0 || expectedBytes > 1073741824L || expectedVolumeSerial == null || expectedFileId128 == null
      || (purpose != "setup" && purpose != "artifact")
      || (purpose == "setup" && expectedBytes != 0)
      || (purpose == "artifact" && (expectedBytes == 0 || (expectedSha256 != null && expectedSha256.Length != 64)))
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
    byte[] bytes = STRICT_UTF8.GetBytes(JSON.Serialize(frame));
    if (bytes.Length <= 0 || bytes.Length > MAX_JSON) throw new BrokerFailure("output_bound", 17);
    byte[] prefix = new byte[] {
      (byte)((bytes.Length >> 24) & 0xff), (byte)((bytes.Length >> 16) & 0xff),
      (byte)((bytes.Length >> 8) & 0xff), (byte)(bytes.Length & 0xff)
    };
    OUTPUT.Write(prefix, 0, prefix.Length);
    OUTPUT.Write(bytes, 0, bytes.Length);
    OUTPUT.Flush();
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

  static bool CatalogEvidenceName(string value) {
    if (value == null || value.Length < 5 || value.Length > 180
      || !value.EndsWith(".cat", StringComparison.OrdinalIgnoreCase)) return false;
    foreach (char character in value) {
      if (!((character >= '0' && character <= '9') || (character >= 'A' && character <= 'Z')
        || (character >= 'a' && character <= 'z') || character == '_' || character == '.'
        || character == '~' || character == '-')) return false;
    }
    return true;
  }

  static string ReadFrameBounded(Stream input, ref long inputBytes) {
    int first = input.ReadByte();
    if (first < 0) return null;
    byte[] prefix = new byte[4];
    prefix[0] = (byte)first;
    for (int index = 1; index < prefix.Length; index++) {
      int next = input.ReadByte();
      if (next < 0) return throwProtocol();
      prefix[index] = (byte)next;
    }
    int length = (prefix[0] << 24) | (prefix[1] << 16) | (prefix[2] << 8) | prefix[3];
    if (length <= 0 || length > MAX_REQUEST || inputBytes + 4L + length > MAX_INPUT) {
      throw new BrokerFailure("output_bound", 17);
    }
    byte[] bytes = new byte[length];
    int offset = 0;
    while (offset < length) {
      int read = input.Read(bytes, offset, length - offset);
      if (read <= 0) return throwProtocol();
      offset += read;
    }
    inputBytes += 4L + length;
    try { return STRICT_UTF8.GetString(bytes); }
    catch { throw new BrokerFailure("request_protocol", 1); }
  }

  static string throwProtocol() { throw new BrokerFailure("request_protocol", 1); }

  static Dictionary<string, object> ReadObject(Stream input, ref long inputBytes) {
    string line = ReadFrameBounded(input, ref inputBytes);
    if (line == null) return null;
    try { return JSON.Deserialize<Dictionary<string, object>>(line); }
    catch { throw new BrokerFailure("request_protocol", 1); }
  }

  static BrokerFailure Innermost(Exception error) {
    while (error.InnerException != null) error = error.InnerException;
    return error as BrokerFailure;
  }

  static string[] ManifestPins(Dictionary<string, object> manifest) {
    IList values = manifest["signerPins"] as IList;
    if (values == null || values.Count <= 0 || values.Count > 16) throw new BrokerFailure("compile_load", 4);
    string[] pins = new string[values.Count];
    string previous = null;
    for (int index = 0; index < values.Count; index++) {
      string pin = values[index] as string;
      bool valid = pin != null && ((pin.StartsWith("certificate-sha256:", StringComparison.Ordinal)
        && Hex(pin.Substring(19), 64)) || (pin.StartsWith("spki-sha256:", StringComparison.Ordinal)
        && Hex(pin.Substring(12), 64)));
      if (!valid || (previous != null && String.CompareOrdinal(previous, pin) >= 0)) {
        throw new BrokerFailure("compile_load", 4);
      }
      pins[index] = pin;
      previous = pin;
    }
    return pins;
  }

  static void VerifyCompilerAttestation(Dictionary<string, object> manifest) {
    Dictionary<string, object> compiler = manifest["compiler"] as Dictionary<string, object>;
    string[] fields = { "kind", "framework", "signerCertificateSha256", "signerSpkiSha256",
      "signerRootSpkiSha256", "volumeSerial", "fileId128", "inputs" };
    if (compiler == null || !ExactFields(compiler, fields)
      || Text(compiler, "kind") != "windows-catalog-authorized-dotnet-framework-csc-v1"
      || (Text(compiler, "framework") != "Framework64-v4.0.30319"
        && Text(compiler, "framework") != "Framework-v4.0.30319")
      || !Hex(Text(compiler, "signerCertificateSha256"), 64)
      || !Hex(Text(compiler, "signerSpkiSha256"), 64)
      || !Hex(Text(compiler, "signerRootSpkiSha256"), 64)
      || !Hex(Text(compiler, "volumeSerial"), 16)
      || !Hex(Text(compiler, "fileId128"), 32)) throw new BrokerFailure("compile_load", 4);
    IList inputs = compiler["inputs"] as IList;
    string[] names = { "csc.exe", "System.dll", "System.Web.Extensions.dll" };
    if (inputs == null || inputs.Count != names.Length) throw new BrokerFailure("compile_load", 4);
    for (int index = 0; index < names.Length; index++) {
      Dictionary<string, object> input = inputs[index] as Dictionary<string, object>;
      string[] inputFields = { "name", "size", "sha256", "signerCertificateSha256", "signerSpkiSha256",
        "signerRootSpkiSha256", "catalogName", "catalogSha256", "catalogVolumeSerial", "catalogFileId128" };
      if (input == null || !ExactFields(input, inputFields)) throw new BrokerFailure("compile_load", 4);
      long size;
      try { size = Convert.ToInt64(input["size"]); } catch { throw new BrokerFailure("compile_load", 4); }
      if (Text(input, "name") != names[index] || size <= 0 || size > 33554432
        || !Hex(Text(input, "sha256"), 64)
        || !Hex(Text(input, "signerCertificateSha256"), 64)
        || !Hex(Text(input, "signerSpkiSha256"), 64)
        || !Hex(Text(input, "signerRootSpkiSha256"), 64)
        || !CatalogEvidenceName(Text(input, "catalogName"))
        || !Hex(Text(input, "catalogSha256"), 64)
        || !Hex(Text(input, "catalogVolumeSerial"), 16)
        || !Hex(Text(input, "catalogFileId128"), 32)) {
        throw new BrokerFailure("compile_load", 4);
      }
      if (index == 0 && (Text(input, "signerCertificateSha256") != Text(compiler, "signerCertificateSha256")
        || Text(input, "signerSpkiSha256") != Text(compiler, "signerSpkiSha256")
        || Text(input, "signerRootSpkiSha256") != Text(compiler, "signerRootSpkiSha256"))) {
        throw new BrokerFailure("compile_load", 4);
      }
    }
  }

  static void Stage(int index, string name) {
    Console.Error.WriteLine("PROPR_BOOTSTRAP " + index.ToString("D2") + " " + name);
    Console.Error.Flush();
    if (Environment.GetEnvironmentVariable("PROPR_WINDOWS_AUTHORITY_TEST_STAGE") == name) {
      throw new BrokerFailure("compile_load", index);
    }
  }

  static Dictionary<string, object> ReadManifest(string path) {
    byte[] bytes = File.ReadAllBytes(path);
    if (bytes.Length <= 0 || bytes.Length > 16384 || bytes[bytes.Length - 1] != 10) {
      throw new BrokerFailure("compile_load", 4);
    }
    string text;
    try { text = STRICT_UTF8.GetString(bytes, 0, bytes.Length - 1); }
    catch { throw new BrokerFailure("compile_load", 4); }
    Dictionary<string, object> value;
    try { value = JSON.Deserialize<Dictionary<string, object>>(text); }
    catch { throw new BrokerFailure("compile_load", 4); }
    string[] fields = { "schemaVersion", "name", "format", "architecture", "machine", "clr", "size", "sha256",
      "sourceSha256", "protocol", "trust", "publisher", "signerPins", "signerCertificateSha256",
      "signerSpkiSha256", "compiler", "bootstrap", "launcher" };
    if (!ExactFields(value, fields) || Integer(value, "schemaVersion") != 1
      || Text(value, "name") != "propr-windows-authority.exe" || Text(value, "format") != "PE32"
      || Text(value, "architecture") != "anycpu" || Text(value, "machine") != "I386"
      || !IsBool(value, "clr", true) || !Hex(Text(value, "sha256"), 64)
      || !Hex(Text(value, "sourceSha256"), 64) || Text(value, "protocol") != "propr-windows-authority-v1"
      || (Text(value, "trust") != "unsigned-validation" && Text(value, "trust") != "production-signed")) {
      throw new BrokerFailure("compile_load", 4);
    }
    bool production = Text(value, "trust") == "production-signed";
    if (production) {
      string[] pins = ManifestPins(value);
      string certificatePin = "certificate-sha256:" + Text(value, "signerCertificateSha256");
      string spkiPin = "spki-sha256:" + Text(value, "signerSpkiSha256");
      if (!Hex(Text(value, "signerCertificateSha256"), 64) || !Hex(Text(value, "signerSpkiSha256"), 64)
        || Array.IndexOf(pins, certificatePin) < 0 && Array.IndexOf(pins, spkiPin) < 0
        || String.IsNullOrEmpty(Text(value, "publisher"))) throw new BrokerFailure("compile_load", 4);
    } else if (value["publisher"] != null || value["signerCertificateSha256"] != null
      || value["signerSpkiSha256"] != null || !(value["signerPins"] is IList)
      || ((IList)value["signerPins"]).Count != 0) throw new BrokerFailure("compile_load", 4);
    Dictionary<string, object> launcher = value["launcher"] as Dictionary<string, object>;
    string[] launcherFields = { "name", "format", "architecture", "machine", "size", "sha256", "trust",
      "publisher", "signerPins", "signerCertificateSha256", "signerSpkiSha256" };
    if (!ExactFields(launcher, launcherFields) || Text(launcher, "name") != "propr-windows-launcher.node"
      || Text(launcher, "format") != "PE"
      || (Text(launcher, "architecture") != "x64" && Text(launcher, "architecture") != "arm64")
      || (Text(launcher, "architecture") == "x64" ? Text(launcher, "machine") != "AMD64"
        : Text(launcher, "machine") != "ARM64")
      || Integer(launcher, "size") <= 0 || Integer(launcher, "size") > 4194304
      || !Hex(Text(launcher, "sha256"), 64) || Text(launcher, "trust") != Text(value, "trust")
      || (launcher["publisher"] == null ? value["publisher"] != null
        : Text(launcher, "publisher") != Text(value, "publisher"))) throw new BrokerFailure("compile_load", 4);
    Dictionary<string, object> bootstrap = value["bootstrap"] as Dictionary<string, object>;
    if (bootstrap == null || !ExactFields(bootstrap, launcherFields) || Text(bootstrap, "name") != "propr-windows-bootstrap.node"
      || Text(bootstrap, "format") != "PE" || Text(bootstrap, "architecture") != Text(launcher, "architecture")
      || Text(bootstrap, "machine") != Text(launcher, "machine")
      || Integer(bootstrap, "size") <= 0 || Integer(bootstrap, "size") > 4194304
      || !Hex(Text(bootstrap, "sha256"), 64) || Text(bootstrap, "trust") != Text(value, "trust")
      || (bootstrap["publisher"] == null ? value["publisher"] != null
        : Text(bootstrap, "publisher") != Text(value, "publisher"))) throw new BrokerFailure("compile_load", 4);
    VerifyCompilerAttestation(value);
    return value;
  }

  static void VerifyImageSecurity(SafeFileHandle handle, bool production) {
    IntPtr owner, group, dacl, sacl, descriptor;
    uint error = GetSecurityInfo(handle, SE_FILE_OBJECT, OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
      out owner, out group, out dacl, out sacl, out descriptor);
    if (error != 0 || owner == IntPtr.Zero || dacl == IntPtr.Zero || descriptor == IntPtr.Zero) {
      throw new BrokerFailure("compile_load", 6);
    }
    try {
      if (!production) return;
      int length = checked((int)GetSecurityDescriptorLength(descriptor));
      if (length <= 0 || length > MAX_SECURITY_DESCRIPTOR) throw new BrokerFailure("compile_load", 6);
      byte[] bytes = new byte[length];
      Marshal.Copy(descriptor, bytes, 0, length);
      RawSecurityDescriptor security = new RawSecurityDescriptor(bytes, 0);
      SecurityIdentifier current = new SecurityIdentifier(CURRENT_USER_SID);
      SecurityIdentifier system = new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null);
      SecurityIdentifier administrators = new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null);
      SecurityIdentifier trustedInstaller = new SecurityIdentifier(
        "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464");
      bool ownerTrusted = security.Owner != null && (security.Owner.Equals(current) || security.Owner.Equals(system)
        || security.Owner.Equals(administrators) || security.Owner.Equals(trustedInstaller));
      if (!ownerTrusted || security.DiscretionaryAcl == null) throw new BrokerFailure("compile_load", 6);
      foreach (GenericAce generic in security.DiscretionaryAcl) {
        QualifiedAce qualified = generic as QualifiedAce;
        KnownAce known = generic as KnownAce;
        if (qualified == null || known == null || qualified.AceQualifier != AceQualifier.AccessAllowed) continue;
        SecurityIdentifier sid = known.SecurityIdentifier;
        bool trusted = sid != null && (sid.Equals(current) || sid.Equals(system) || sid.Equals(administrators)
          || sid.Equals(trustedInstaller));
        if (!trusted && (known.AccessMask & WRITE_AUTHORITY) != 0) throw new BrokerFailure("compile_load", 6);
      }
    } finally { LocalFree(descriptor); }
  }

  static void VerifyImageAncestors(string imagePath, bool production) {
    string directory = Path.GetDirectoryName(imagePath);
    while (!String.IsNullOrEmpty(directory)) {
      using (SafeFileHandle handle = OpenPinned(directory, false)) {
        FILE_ATTRIBUTE_TAG_INFO attributes = ReadInfo<FILE_ATTRIBUTE_TAG_INFO>(handle, FileAttributeTagInfo, "compile_load", 7);
        if ((attributes.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0 || attributes.ReparseTag != 0) {
          throw new BrokerFailure("compile_load", 7);
        }
        VerifyImageSecurity(handle, production);
      }
      string parent = Path.GetDirectoryName(directory);
      if (String.IsNullOrEmpty(parent) || String.Equals(parent, directory, StringComparison.OrdinalIgnoreCase)) break;
      directory = parent;
    }
  }

  static void VerifyAnyCpuPe(SafeFileHandle handle, long size) {
    int headerLength = checked((int)Math.Min(size, 65536));
    byte[] bytes = ReadAt(handle, 0, headerLength, "compile_load", 8);
    if (bytes.Length < 512 || bytes[0] != 0x4d || bytes[1] != 0x5a) throw new BrokerFailure("compile_load", 8);
    int pe = BitConverter.ToInt32(bytes, 0x3c);
    if (pe < 0x40 || pe + 248 > bytes.Length || bytes[pe] != 0x50 || bytes[pe + 1] != 0x45
      || bytes[pe + 2] != 0 || bytes[pe + 3] != 0 || BitConverter.ToUInt16(bytes, pe + 4) != 0x14c
      || BitConverter.ToUInt16(bytes, pe + 24) != 0x10b) throw new BrokerFailure("compile_load", 8);
    int sectionCount = BitConverter.ToUInt16(bytes, pe + 6);
    int optionalSize = BitConverter.ToUInt16(bytes, pe + 20);
    int clrDirectory = pe + 24 + 96 + (14 * 8);
    uint clrRva = BitConverter.ToUInt32(bytes, clrDirectory);
    if (sectionCount <= 0 || sectionCount > 96 || optionalSize < 224 || clrDirectory + 8 > pe + 24 + optionalSize
      || clrRva == 0 || BitConverter.ToUInt32(bytes, clrDirectory + 4) < 72) {
      throw new BrokerFailure("compile_load", 8);
    }
    int sectionTable = pe + 24 + optionalSize;
    int clrOffset = -1;
    for (int index = 0; index < sectionCount; index++) {
      int section = sectionTable + (index * 40);
      if (section + 40 > bytes.Length) throw new BrokerFailure("compile_load", 8);
      uint virtualSize = BitConverter.ToUInt32(bytes, section + 8);
      uint virtualAddress = BitConverter.ToUInt32(bytes, section + 12);
      uint rawSize = BitConverter.ToUInt32(bytes, section + 16);
      uint rawAddress = BitConverter.ToUInt32(bytes, section + 20);
      uint span = Math.Max(virtualSize, rawSize);
      if (clrRva >= virtualAddress && clrRva - virtualAddress < span) {
        clrOffset = checked((int)(rawAddress + clrRva - virtualAddress));
      }
    }
    if (clrOffset < 0 || clrOffset + 20 > bytes.Length) throw new BrokerFailure("compile_load", 8);
    uint corFlags = BitConverter.ToUInt32(bytes, clrOffset + 16);
    if ((corFlags & 0x1) == 0 || (corFlags & (0x2 | 0x10 | 0x20000)) != 0) throw new BrokerFailure("compile_load", 8);
  }

  sealed class DerElement {
    public int Start;
    public int Content;
    public int End;
  }

  static DerElement ReadDer(byte[] bytes, ref int offset, int expectedTag) {
    int start = offset;
    if (offset >= bytes.Length || bytes[offset++] != expectedTag || offset >= bytes.Length) {
      throw new BrokerFailure("compile_load", 9);
    }
    int length = bytes[offset++];
    if ((length & 0x80) != 0) {
      int count = length & 0x7f;
      if (count <= 0 || count > 4 || offset + count > bytes.Length || bytes[offset] == 0) {
        throw new BrokerFailure("compile_load", 9);
      }
      length = 0;
      for (int index = 0; index < count; index++) length = checked((length << 8) | bytes[offset++]);
      if (length < 128) throw new BrokerFailure("compile_load", 9);
    }
    int end = checked(offset + length);
    if (end > bytes.Length) throw new BrokerFailure("compile_load", 9);
    return new DerElement { Start = start, Content = offset, End = end };
  }

  static byte[] SubjectPublicKeyInfo(X509Certificate2 certificate) {
    byte[] raw = certificate.RawData;
    int cursor = 0;
    DerElement outer = ReadDer(raw, ref cursor, 0x30);
    int tbsCursor = outer.Content;
    DerElement tbs = ReadDer(raw, ref tbsCursor, 0x30);
    int field = tbs.Content;
    if (field < tbs.End && raw[field] == 0xa0) ReadDer(raw, ref field, 0xa0);
    ReadDer(raw, ref field, 0x02); // serial
    ReadDer(raw, ref field, 0x30); // signature algorithm
    ReadDer(raw, ref field, 0x30); // issuer
    ReadDer(raw, ref field, 0x30); // validity
    ReadDer(raw, ref field, 0x30); // subject
    DerElement spki = ReadDer(raw, ref field, 0x30);
    byte[] result = new byte[spki.End - spki.Start];
    Buffer.BlockCopy(raw, spki.Start, result, 0, result.Length);
    return result;
  }

  static string Sha256(byte[] bytes) {
    using (SHA256 hash = SHA256.Create()) {
      return BitConverter.ToString(hash.ComputeHash(bytes)).Replace("-", "").ToLowerInvariant();
    }
  }

  static void VerifyProductionSignature(string imagePath, string publisher, string[] pins,
    string expectedCertificateSha256, string expectedSpkiSha256) {
    WINTRUST_FILE_INFO file = new WINTRUST_FILE_INFO {
      cbStruct = (uint)Marshal.SizeOf(typeof(WINTRUST_FILE_INFO)), pcwszFilePath = imagePath,
      hFile = IntPtr.Zero, pgKnownSubject = IntPtr.Zero
    };
    IntPtr filePointer = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(WINTRUST_FILE_INFO)));
    IntPtr dataPointer = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(WINTRUST_DATA)));
    try {
      Marshal.StructureToPtr(file, filePointer, false);
      WINTRUST_DATA data = new WINTRUST_DATA {
        cbStruct = (uint)Marshal.SizeOf(typeof(WINTRUST_DATA)), dwUIChoice = 2, fdwRevocationChecks = 1,
        dwUnionChoice = 1, pFile = filePointer, dwStateAction = 0, dwProvFlags = 0x00000080,
        dwUIContext = 0, pSignatureSettings = IntPtr.Zero
      };
      Marshal.StructureToPtr(data, dataPointer, false);
      Guid action = new Guid("00AAC56B-CD44-11D0-8CC2-00C04FC295EE");
      if (WinVerifyTrust(new IntPtr(-1), ref action, dataPointer) != 0) throw new BrokerFailure("compile_load", 9);
      X509Certificate2 certificate = new X509Certificate2(X509Certificate.CreateFromSignedFile(imagePath));
      try {
        if (!String.Equals(certificate.Subject, publisher, StringComparison.Ordinal)) throw new BrokerFailure("compile_load", 9);
        DateTime now = DateTime.Now;
        if (now < certificate.NotBefore || now > certificate.NotAfter) throw new BrokerFailure("compile_load", 9);
        bool codeSigning = false;
        foreach (X509Extension extension in certificate.Extensions) {
          X509EnhancedKeyUsageExtension eku = extension as X509EnhancedKeyUsageExtension;
          if (eku == null) continue;
          foreach (Oid oid in eku.EnhancedKeyUsages) {
            if (oid.Value == "1.3.6.1.5.5.7.3.3") codeSigning = true;
          }
        }
        if (!codeSigning) throw new BrokerFailure("compile_load", 9);
        using (X509Chain chain = new X509Chain()) {
          chain.ChainPolicy.RevocationMode = X509RevocationMode.Online;
          chain.ChainPolicy.RevocationFlag = X509RevocationFlag.EntireChain;
          chain.ChainPolicy.VerificationFlags = X509VerificationFlags.NoFlag;
          chain.ChainPolicy.UrlRetrievalTimeout = TimeSpan.FromSeconds(15);
          if (!chain.Build(certificate)) throw new BrokerFailure("compile_load", 9);
        }
        string certificateSha256 = Sha256(certificate.RawData);
        string spkiSha256 = Sha256(SubjectPublicKeyInfo(certificate));
        if (certificateSha256 != expectedCertificateSha256 || spkiSha256 != expectedSpkiSha256
          || Array.IndexOf(pins, "certificate-sha256:" + certificateSha256) < 0
            && Array.IndexOf(pins, "spki-sha256:" + spkiSha256) < 0) {
          throw new BrokerFailure("compile_load", 9);
        }
      } finally { certificate.Dispose(); }
    } finally {
      Marshal.FreeHGlobal(dataPointer);
      Marshal.FreeHGlobal(filePointer);
    }
  }

  static void AuthenticateImage() {
    Stage(4, "MANIFEST");
    string imagePath = Path.GetFullPath(Assembly.GetExecutingAssembly().Location);
    if (String.IsNullOrEmpty(imagePath) || imagePath.IndexOf(':', 2) >= 0
      || !String.Equals(Path.GetFileName(imagePath), "propr-windows-authority.exe", StringComparison.OrdinalIgnoreCase)) {
      throw new BrokerFailure("compile_load", 4);
    }
    Dictionary<string, object> manifest = ReadManifest(Path.Combine(Path.GetDirectoryName(imagePath),
      "propr-windows-authority.manifest.json"));
    Stage(5, "HELPER_OPEN");
    SafeFileHandle handle = OpenPinned(imagePath, true);
    try {
      FILE_STANDARD_INFO standard = ReadInfo<FILE_STANDARD_INFO>(handle, FileStandardInfo, "compile_load", 5);
      if (standard.DeletePending || standard.Directory || standard.NumberOfLinks != 1 || standard.EndOfFile <= 0
        || standard.EndOfFile != Integer(manifest, "size")) throw new BrokerFailure("compile_load", 5);
      Stage(6, "HELPER_OWNER_DACL");
      bool production = Text(manifest, "trust") == "production-signed";
      VerifyImageAncestors(imagePath, production);
      VerifyImageSecurity(handle, production);
      Stage(7, "HELPER_REPARSE");
      FILE_ATTRIBUTE_TAG_INFO attributes = ReadInfo<FILE_ATTRIBUTE_TAG_INFO>(handle, FileAttributeTagInfo, "compile_load", 7);
      if ((attributes.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0 || attributes.ReparseTag != 0) {
        throw new BrokerFailure("compile_load", 7);
      }
      Stage(8, "HELPER_IDENTITY");
      FILE_ID_INFO identity = ReadInfo<FILE_ID_INFO>(handle, FileIdInfo, "compile_load", 8);
      if (identity.FileId == null || identity.FileId.Length != 16) throw new BrokerFailure("compile_load", 8);
      VerifyAnyCpuPe(handle, standard.EndOfFile);
      IMAGE_VOLUME = identity.VolumeSerialNumber.ToString("x16");
      IMAGE_FILE_ID = BitConverter.ToString(identity.FileId).Replace("-", "").ToLowerInvariant();
      Stage(9, "HELPER_HASH");
      IMAGE_SHA256 = Hash(handle, standard.EndOfFile)[0];
      if (IMAGE_SHA256 != Text(manifest, "sha256")) throw new BrokerFailure("compile_load", 9);
      if (Text(manifest, "trust") == "production-signed") VerifyProductionSignature(imagePath,
        Text(manifest, "publisher"), ManifestPins(manifest), Text(manifest, "signerCertificateSha256"),
        Text(manifest, "signerSpkiSha256"));
      ProveNoShareLock(imagePath);
      IMAGE_LEASE = handle;
      handle = null;
    } finally { if (handle != null) handle.Dispose(); }
  }

  static void ReverifyImage() {
    FILE_ID_INFO identity = ReadInfo<FILE_ID_INFO>(IMAGE_LEASE, FileIdInfo, "compile_load", 8);
    FILE_STANDARD_INFO standard = ReadInfo<FILE_STANDARD_INFO>(IMAGE_LEASE, FileStandardInfo, "compile_load", 8);
    string fileId = BitConverter.ToString(identity.FileId).Replace("-", "").ToLowerInvariant();
    string hash = Hash(IMAGE_LEASE, standard.EndOfFile)[0];
    if (identity.VolumeSerialNumber.ToString("x16") != IMAGE_VOLUME || fileId != IMAGE_FILE_ID || hash != IMAGE_SHA256) {
      throw new BrokerFailure("compile_load", 8);
    }
    string imagePath = Path.GetFullPath(Assembly.GetExecutingAssembly().Location);
    using (SafeFileHandle reopened = OpenPinned(imagePath, true)) {
      FILE_ATTRIBUTE_TAG_INFO attributes = ReadInfo<FILE_ATTRIBUTE_TAG_INFO>(reopened, FileAttributeTagInfo, "compile_load", 7);
      FILE_ID_INFO reopenedIdentity = ReadInfo<FILE_ID_INFO>(reopened, FileIdInfo, "compile_load", 8);
      FILE_STANDARD_INFO reopenedStandard = ReadInfo<FILE_STANDARD_INFO>(reopened, FileStandardInfo, "compile_load", 8);
      string reopenedFileId = BitConverter.ToString(reopenedIdentity.FileId).Replace("-", "").ToLowerInvariant();
      string reopenedHash = Hash(reopened, reopenedStandard.EndOfFile)[0];
      if ((attributes.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0 || attributes.ReparseTag != 0
        || reopenedIdentity.VolumeSerialNumber.ToString("x16") != IMAGE_VOLUME || reopenedFileId != IMAGE_FILE_ID
        || reopenedStandard.NumberOfLinks != 1 || reopenedHash != IMAGE_SHA256
        || Environment.GetEnvironmentVariable("PROPR_WINDOWS_AUTHORITY_TEST_IMAGE_FAULT") == "process-image") {
        throw new BrokerFailure("compile_load", 8);
      }
    }
  }

  public static void Initialize() { Smoke(); }

  public static void Serve() {
    Stream input = Console.OpenStandardInput();
    long inputBytes = 0;
    int frameCount = 0;
    Dictionary<string, object> start;
    try {
      start = ReadObject(input, ref inputBytes);
      if (!ExactFields(start, START_FIELDS) || Integer(start, "version") != 1 || Text(start, "type") != "start"
        || Text(start, "protocol") != "propr-windows-authority-v1" || !Hex(Text(start, "challenge"), 32)) {
        throw new BrokerFailure("ready_protocol", 12);
      }
      ReverifyImage();
    } catch (Exception error) {
      BrokerFailure failure = Innermost(error);
      WriteFailure(failure == null ? "ready_protocol" : failure.Code, failure == null ? 12 : failure.Scenario, "");
      return;
    }
    Stage(11, "READY");
    WriteFrame(Frame("version", 1, "type", "ready", "challenge", Text(start, "challenge"),
      "protocol", "propr-windows-authority-v1", "maxRequestBytes", MAX_REQUEST,
      "nativeSmoke", true, "compileCount", 1, "imageVolumeSerial", IMAGE_VOLUME,
      "imageFileId128", IMAGE_FILE_ID, "imageSha256", IMAGE_SHA256));

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
          if (operation == "fault-stderr"
            && Environment.GetEnvironmentVariable("PROPR_WINDOWS_AUTHORITY_TEST_TRANSPORT_FAULT") == "stderr") {
            Console.Error.WriteLine("PROPR_FAULT 01");
            Console.Error.Flush();
          } else if (operation == "hold") {
            string path = Text(request, "path");
            if (held != null || String.IsNullOrEmpty(path) || path.Length > 8192
              || (purpose != "setup" && purpose != "artifact") || !NullFields(request, "directory", "offset", "length")
              || !Hex(Text(request, "challenge"), 32) || !Hex(Text(request, "expectedVolumeSerial"), 16)
              || !Hex(Text(request, "expectedFileId128"), 32)
              || (purpose == "artifact" && request["expectedSha256"] != null
                && !Hex(Text(request, "expectedSha256"), 64))
              || (purpose == "setup" && request["expectedSha256"] != null)) throwProtocol();
            long expectedBytes = Integer(request, "expectedBytes");
            if ((purpose == "setup" && expectedBytes != 0) || (purpose == "artifact" && expectedBytes <= 0)) throwProtocol();
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

  public static int Main(string[] args) {
    try {
      if (args == null || args.Length != 1 || args[0] != "--broker") return 64;
      AuthenticateImage();
      Stage(10, "PROTOCOL_INIT");
      // The signed native parent boundary creates and owns the kill-on-close
      // job and proves this process image before it resumes this entrypoint.
      Initialize();
      Serve();
      return 0;
    } catch (Exception error) {
      BrokerFailure failure = Innermost(error);
      if (failure != null) {
        Console.Error.WriteLine("PROPR_FAILURE " + failure.Code + " " + failure.Scenario.ToString());
        Console.Error.Flush();
      }
      return 70;
    } finally {
      if (IMAGE_LEASE != null) IMAGE_LEASE.Dispose();
      IMAGE_LEASE = null;
    }
  }
}
