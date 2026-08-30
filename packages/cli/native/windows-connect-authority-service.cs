// ProPR Connect's machine-installed first-launch authority.
// This file is compiled only by the reviewed Windows release build and is
// installed by Windows Installer as LocalSystem. The npm package never starts
// or substitutes this executable.
using Microsoft.Win32.SafeHandles;
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Linq;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Security.Principal;
using System.ServiceProcess;
using System.Text;
using System.Web.Script.Serialization;

namespace Propr.ConnectAuthority {
  internal sealed class AuthorityService : ServiceBase {
    internal const string Name = "ProPRConnectAuthority";
    internal const string Version = "3.0.0";
    private const string PipeName = "ProPR.Connect.Authority.v3";
    private const int MaxFrame = 4096;
    private volatile bool stopping;
    private readonly HashSet<string> replay = new HashSet<string>(StringComparer.Ordinal);
    private readonly object replayLock = new object();

    internal AuthorityService() { ServiceName = Name; CanStop = true; AutoLog = false; }
    protected override void OnStart(string[] args) {
      SecurityIdentifier account = WindowsIdentity.GetCurrent().User;
      if (account == null || !account.IsWellKnown(WellKnownSidType.LocalSystemSid))
        throw new UnauthorizedAccessException();
      HardenInstalledImage();
      stopping = false;
      System.Threading.ThreadPool.QueueUserWorkItem(_ => AcceptLoop());
    }
    protected override void OnStop() { stopping = true; }

    private static void HardenInstalledImage() {
      string path = Process.GetCurrentProcess().MainModule.FileName;
      SecurityIdentifier system = new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null);
      SecurityIdentifier trustedInstaller = new SecurityIdentifier(
        "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464");
      FileSecurity security = new FileSecurity();
      security.SetOwner(system);
      security.SetAccessRuleProtection(true, false);
      security.AddAccessRule(new FileSystemAccessRule(system, FileSystemRights.FullControl, AccessControlType.Allow));
      security.AddAccessRule(new FileSystemAccessRule(trustedInstaller, FileSystemRights.FullControl, AccessControlType.Allow));
      File.SetAccessControl(path, security);
      if (!PrivateAcl(path, true)) throw new UnauthorizedAccessException();
    }

    private static PipeSecurity PipeAcl() {
      PipeSecurity acl = new PipeSecurity();
      acl.SetAccessRuleProtection(true, false);
      acl.SetOwner(new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null));
      acl.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null),
        PipeAccessRights.FullControl, AccessControlType.Allow));
      acl.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null),
        PipeAccessRights.FullControl, AccessControlType.Allow));
      acl.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(WellKnownSidType.AuthenticatedUserSid, null),
        PipeAccessRights.ReadWrite, AccessControlType.Allow));
      return acl;
    }

    private void AcceptLoop() {
      bool first = true;
      while (!stopping) {
        NamedPipeServerStream pipe = null;
        try {
          PipeOptions options = PipeOptions.Asynchronous | PipeOptions.WriteThrough;
          if (first) options |= (PipeOptions)0x00080000; // FILE_FLAG_FIRST_PIPE_INSTANCE
          pipe = new NamedPipeServerStream(PipeName, PipeDirection.InOut, 8,
            PipeTransmissionMode.Byte, options, MaxFrame + 4, MaxFrame + 4, PipeAcl(),
            HandleInheritability.None, PipeAccessRights.ReadWrite);
          first = false;
          pipe.WaitForConnection();
          NamedPipeServerStream accepted = pipe;
          pipe = null;
          System.Threading.ThreadPool.QueueUserWorkItem(_ => Serve(accepted));
        } catch { if (!stopping) System.Threading.Thread.Sleep(100); }
        finally { if (pipe != null) pipe.Dispose(); }
      }
    }

    private static byte[] ReadFrame(Stream stream) {
      byte[] prefix = ReadExact(stream, 4);
      int length = BitConverter.ToInt32(prefix, 0);
      if (length < 2 || length > MaxFrame) throw new InvalidDataException();
      return ReadExact(stream, length);
    }
    private static byte[] ReadExact(Stream stream, int length) {
      byte[] bytes = new byte[length];
      int offset = 0;
      while (offset < length) {
        int count = stream.Read(bytes, offset, length - offset);
        if (count <= 0) throw new EndOfStreamException();
        offset += count;
      }
      return bytes;
    }
    private static void WriteFrame(Stream stream, SortedDictionary<string, object> value) {
      string text = new JavaScriptSerializer { MaxJsonLength = MaxFrame }.Serialize(value);
      byte[] body = new UTF8Encoding(false, true).GetBytes(text);
      if (body.Length < 2 || body.Length > MaxFrame) throw new InvalidDataException();
      byte[] prefix = BitConverter.GetBytes(body.Length);
      stream.Write(prefix, 0, prefix.Length);
      stream.Write(body, 0, body.Length);
      stream.Flush();
    }
    private static Dictionary<string, object> Parse(byte[] bytes) {
      string text = new UTF8Encoding(false, true).GetString(bytes);
      Dictionary<string, object> value = new JavaScriptSerializer { MaxJsonLength = MaxFrame }
        .Deserialize<Dictionary<string, object>>(text);
      if (value == null) throw new InvalidDataException();
      string canonical = new JavaScriptSerializer { MaxJsonLength = MaxFrame }.Serialize(
        new SortedDictionary<string, object>(value, StringComparer.Ordinal));
      if (!String.Equals(canonical, text, StringComparison.Ordinal)) throw new InvalidDataException();
      return value;
    }
    private static string Required(Dictionary<string, object> value, string key, int max) {
      object raw;
      string text;
      if (!value.TryGetValue(key, out raw) || (text = raw as string) == null || text.Length < 1 || text.Length > max ||
          text.IndexOfAny(new[] { '\0', '\r', '\n' }) >= 0) throw new InvalidDataException();
      return text;
    }
    private static void Exact(Dictionary<string, object> value, params string[] keys) {
      if (!value.Keys.OrderBy(x => x, StringComparer.Ordinal).SequenceEqual(keys.OrderBy(x => x, StringComparer.Ordinal)))
        throw new InvalidDataException();
    }
    private bool Fresh(string requestId) {
      lock (replayLock) {
        if (replay.Contains(requestId)) return false;
        if (replay.Count >= 1024) return false;
        replay.Add(requestId);
        return true;
      }
    }

    private void Serve(NamedPipeServerStream pipe) {
      FileStream lease = null;
      string leaseId = null;
      try {
        SecurityIdentifier clientSid = null;
        pipe.RunAsClient(() => clientSid = WindowsIdentity.GetCurrent(true).User);
        if (clientSid == null || clientSid.IsWellKnown(WellKnownSidType.AnonymousSid) ||
            clientSid.IsWellKnown(WellKnownSidType.LocalSystemSid)) throw new UnauthorizedAccessException();
        uint clientPid;
        if (!GetNamedPipeClientProcessId(pipe.SafePipeHandle, out clientPid) || clientPid < 1)
          throw new UnauthorizedAccessException();
        using (Process client = Process.GetProcessById((int)clientPid)) {
          if (client.SessionId <= 0) throw new UnauthorizedAccessException();
        }
        Dictionary<string, object> request = Parse(ReadFrame(pipe));
        Exact(request, "version", "kind", "requestId", "nonce", "serviceVersion", "artifactPath", "artifactSha256");
        if (Convert.ToInt32(request["version"]) != 3 || Required(request, "kind", 32) != "authorize-launch")
          throw new InvalidDataException();
        string requestId = Required(request, "requestId", 32);
        string nonce = Required(request, "nonce", 64);
        string requestedVersion = Required(request, "serviceVersion", 16);
        string artifactPath = Required(request, "artifactPath", 1024);
        string artifactHash = Required(request, "artifactSha256", 64);
        if (!Hex(requestId, 32) || !Hex(nonce, 64) || !Hex(artifactHash, 64) || !Path.IsPathRooted(artifactPath))
          throw new InvalidDataException();
        if (requestedVersion != Version) {
          WriteFrame(pipe, Document("version", 3, "kind", "version-mismatch", "requestId", requestId,
            "nonce", nonce, "serviceVersion", Version));
          return;
        }
        if (!Fresh(requestId)) throw new InvalidDataException();
        lease = new FileStream(artifactPath, FileMode.Open, FileAccess.Read, FileShare.Read, 4096,
          FileOptions.SequentialScan);
        FileIdentity artifactIdentity = FileIdentity.Read(lease.SafeFileHandle);
        if (!artifactIdentity.Ordinary || Hash(lease) != artifactHash)
          throw new UnauthorizedAccessException();
        leaseId = Guid.NewGuid().ToString("N");
        FileIdentity self = FileIdentity.ReadProcess(Process.GetCurrentProcess());
        string selfPath = Process.GetCurrentProcess().MainModule.FileName;
        string[] pins = SigningPins(selfPath);
        string[] artifactPins = SigningPins(artifactPath);
        if (pins[0] != artifactPins[0] || pins[1] != artifactPins[1]) throw new UnauthorizedAccessException();
        if (!PrivateAcl(selfPath, true)) throw new UnauthorizedAccessException();
        string digest = HashCanonical(request);
        WriteFrame(pipe, Document(
          "version", 3, "kind", "launch-authorized", "requestId", requestId, "nonce", nonce,
          "requestDigest", digest, "hook", "windows-service.before-package-createprocess-v1", "leaseId", leaseId,
          "serviceVersion", Version, "serverPid", Process.GetCurrentProcess().Id.ToString(),
          "pipeServerPid", Process.GetCurrentProcess().Id.ToString(), "imagePath", selfPath,
          "volumeSerialNumber", self.Volume.ToString(), "fileId", self.FileId.ToString(), "sha256", HashFile(selfPath),
          "authenticodeLeafSha256", pins[0], "authenticodeSpkiSha256", pins[1], "accountSid", "S-1-5-18",
          "daclProtected", true, "replayed", false));
        Control(pipe, leaseId, artifactIdentity, artifactHash, artifactPath, "confirm-launch");
        Control(pipe, leaseId, artifactIdentity, artifactHash, artifactPath, "release-launch");
      } catch { /* Closing the pipe and lease is the only failure surface. */ }
      finally { if (lease != null) lease.Dispose(); pipe.Dispose(); }
    }

    private void Control(NamedPipeServerStream pipe, string leaseId, FileIdentity artifact,
      string hash, string artifactPath, string expectedKind) {
      Dictionary<string, object> control = Parse(ReadFrame(pipe));
      string[] keys = expectedKind == "confirm-launch"
        ? new[] { "version", "kind", "requestId", "nonce", "leaseId", "childPid" }
        : new[] { "version", "kind", "requestId", "nonce", "leaseId" };
      Exact(control, keys);
      string requestId = Required(control, "requestId", 32);
      string nonce = Required(control, "nonce", 64);
      if (Convert.ToInt32(control["version"]) != 3 || Required(control, "kind", 32) != expectedKind ||
          Required(control, "leaseId", 32) != leaseId || !Hex(requestId, 32) || !Hex(nonce, 64))
        throw new InvalidDataException();
      if (!Fresh(requestId)) throw new InvalidDataException();
      if (expectedKind == "confirm-launch") {
        int pid;
        if (!Int32.TryParse(Required(control, "childPid", 10), out pid) || pid < 1) throw new InvalidDataException();
        using (Process child = Process.GetProcessById(pid)) {
          FileIdentity loaded = FileIdentity.ReadProcess(child);
          string loadedPath = child.MainModule.FileName;
          if (!loaded.Equals(artifact) || HashFile(loadedPath) != hash ||
              !String.Equals(Path.GetFullPath(loadedPath), Path.GetFullPath(artifactPath), StringComparison.OrdinalIgnoreCase))
            throw new UnauthorizedAccessException();
        }
      }
      WriteFrame(pipe, Document("version", 3, "kind", expectedKind + "-receipt", "requestId", requestId,
        "nonce", nonce, "leaseId", leaseId, "verified", true));
    }

    private static bool Hex(string value, int length) {
      return value.Length == length && value.All(c => (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'));
    }
    private static string Hash(Stream stream) {
      stream.Position = 0;
      using (SHA256 sha = SHA256.Create()) return BitConverter.ToString(sha.ComputeHash(stream)).Replace("-", "").ToLowerInvariant();
    }
    private static string HashFile(string path) { using (FileStream file = File.OpenRead(path)) return Hash(file); }
    private static string HashCanonical(Dictionary<string, object> value) {
      SortedDictionary<string, object> sorted = new SortedDictionary<string, object>(value, StringComparer.Ordinal);
      byte[] bytes = Encoding.UTF8.GetBytes(new JavaScriptSerializer().Serialize(sorted));
      using (SHA256 sha = SHA256.Create()) return BitConverter.ToString(sha.ComputeHash(bytes)).Replace("-", "").ToLowerInvariant();
    }
    private static SortedDictionary<string, object> Document(params object[] pairs) {
      SortedDictionary<string, object> value = new SortedDictionary<string, object>(StringComparer.Ordinal);
      for (int i = 0; i < pairs.Length; i += 2) value.Add((string)pairs[i], pairs[i + 1]);
      return value;
    }
    private static bool PrivateAcl(string path, bool requireSystemOwner) {
      FileSecurity acl = File.GetAccessControl(path, AccessControlSections.Owner | AccessControlSections.Access);
      SecurityIdentifier owner = (SecurityIdentifier)acl.GetOwner(typeof(SecurityIdentifier));
      if (!acl.AreAccessRulesProtected || (requireSystemOwner &&
          !owner.IsWellKnown(WellKnownSidType.LocalSystemSid) && owner.Value != "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464")) return false;
      foreach (FileSystemAccessRule rule in acl.GetAccessRules(true, true, typeof(SecurityIdentifier))) {
        SecurityIdentifier sid = (SecurityIdentifier)rule.IdentityReference;
        if (rule.AccessControlType == AccessControlType.Allow &&
            (rule.FileSystemRights & (FileSystemRights.Write | FileSystemRights.Delete | FileSystemRights.ChangePermissions |
              FileSystemRights.TakeOwnership)) != 0 && !sid.IsWellKnown(WellKnownSidType.LocalSystemSid) &&
            !sid.IsWellKnown(WellKnownSidType.BuiltinAdministratorsSid) &&
            sid.Value != "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464" &&
            sid.Value != owner.Value) return false;
      }
      return true;
    }
    private static string[] SigningPins(string path) {
#if PROPR_VALIDATION
      return new[] { new string('0', 64), new string('0', 64) };
#else
      if (!VerifyAuthenticode(path)) throw new UnauthorizedAccessException();
      X509Certificate2 certificate = new X509Certificate2(X509Certificate.CreateFromSignedFile(path));
      if (DateTime.UtcNow < certificate.NotBefore.ToUniversalTime() || DateTime.UtcNow > certificate.NotAfter.ToUniversalTime())
        throw new UnauthorizedAccessException();
      using (SHA256 sha = SHA256.Create()) {
        string leaf = BitConverter.ToString(sha.ComputeHash(certificate.RawData)).Replace("-", "").ToLowerInvariant();
        byte[] spki = Der(0x30, Join(
          Der(0x30, Join(DerOid(certificate.PublicKey.Oid.Value), certificate.PublicKey.EncodedParameters.RawData)),
          Der(0x03, Join(new byte[] { 0 }, certificate.PublicKey.EncodedKeyValue.RawData))));
        string key = BitConverter.ToString(sha.ComputeHash(spki)).Replace("-", "").ToLowerInvariant();
        return new[] { leaf, key };
      }
#endif
    }
    private static byte[] Join(params byte[][] values) {
      int length = values.Sum(value => value.Length); byte[] result = new byte[length]; int offset = 0;
      foreach (byte[] value in values) { Buffer.BlockCopy(value, 0, result, offset, value.Length); offset += value.Length; }
      return result;
    }
    private static byte[] Der(byte tag, byte[] value) { return Join(new[] { tag }, DerLength(value.Length), value); }
    private static byte[] DerLength(int length) {
      if (length < 0x80) return new[] { (byte)length };
      if (length <= 0xff) return new[] { (byte)0x81, (byte)length };
      if (length <= 0xffff) return new[] { (byte)0x82, (byte)(length >> 8), (byte)length };
      return new[] { (byte)0x84, (byte)(length >> 24), (byte)(length >> 16), (byte)(length >> 8), (byte)length };
    }
    private static byte[] DerOid(string text) {
      string[] fields = text.Split('.'); List<byte> body = new List<byte>();
      ulong first = UInt64.Parse(fields[0], CultureInfo.InvariantCulture);
      ulong second = UInt64.Parse(fields[1], CultureInfo.InvariantCulture);
      body.Add(checked((byte)(first * 40 + second)));
      for (int index = 2; index < fields.Length; index++) {
        ulong value = UInt64.Parse(fields[index], CultureInfo.InvariantCulture); byte[] encoded = new byte[10]; int cursor = 10;
        encoded[--cursor] = (byte)(value & 0x7f);
        while ((value >>= 7) != 0) encoded[--cursor] = (byte)(0x80 | (value & 0x7f));
        while (cursor < 10) body.Add(encoded[cursor++]);
      }
      return Der(0x06, body.ToArray());
    }
    private static bool VerifyAuthenticode(string path) {
      WINTRUST_FILE_INFO file = new WINTRUST_FILE_INFO { Size = (uint)Marshal.SizeOf(typeof(WINTRUST_FILE_INFO)), FilePath = path };
      IntPtr filePointer = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(WINTRUST_FILE_INFO)));
      IntPtr dataPointer = IntPtr.Zero;
      try {
        Marshal.StructureToPtr(file, filePointer, false);
        WINTRUST_DATA data = new WINTRUST_DATA { Size = (uint)Marshal.SizeOf(typeof(WINTRUST_DATA)), UiChoice = 2,
          RevocationChecks = 1, UnionChoice = 1, FileInfo = filePointer, ProviderFlags = 0x80 };
        dataPointer = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(WINTRUST_DATA)));
        Marshal.StructureToPtr(data, dataPointer, false);
        Guid action = new Guid("00AAC56B-CD44-11D0-8CC2-00C04FC295EE");
        return WinVerifyTrust(new IntPtr(-1), ref action, dataPointer) == 0;
      } finally {
        if (dataPointer != IntPtr.Zero) { Marshal.DestroyStructure(dataPointer, typeof(WINTRUST_DATA)); Marshal.FreeHGlobal(dataPointer); }
        Marshal.DestroyStructure(filePointer, typeof(WINTRUST_FILE_INFO)); Marshal.FreeHGlobal(filePointer);
      }
    }

    [StructLayout(LayoutKind.Sequential)] private struct FILE_ID_INFO { internal ulong VolumeSerialNumber; internal FILE_ID_128 FileId; }
    [StructLayout(LayoutKind.Sequential)] private struct FILE_ID_128 {
      [MarshalAs(UnmanagedType.ByValArray, SizeConst = 16)] internal byte[] Identifier;
    }
    private sealed class FileIdentity {
      internal ulong Volume; internal string FileId; internal bool Ordinary;
      internal static FileIdentity Read(SafeFileHandle handle) {
        FILE_ID_INFO info;
        if (!GetFileInformationByHandleEx(handle, 18, out info, Marshal.SizeOf(typeof(FILE_ID_INFO))))
          throw new System.ComponentModel.Win32Exception();
        BY_HANDLE_FILE_INFORMATION basic;
        if (!GetFileInformationByHandle(handle, out basic) || (basic.FileAttributes & 0x410) != 0 || basic.NumberOfLinks != 1)
          throw new UnauthorizedAccessException();
        byte[] unsigned = new byte[17];
        Buffer.BlockCopy(info.FileId.Identifier, 0, unsigned, 0, 16);
        return new FileIdentity { Volume = info.VolumeSerialNumber,
          FileId = new System.Numerics.BigInteger(unsigned).ToString(), Ordinary = true };
      }
      internal static FileIdentity ReadProcess(Process process) {
        using (FileStream image = new FileStream(process.MainModule.FileName, FileMode.Open, FileAccess.Read,
          FileShare.Read | FileShare.Delete)) return Read(image.SafeFileHandle);
      }
      public override bool Equals(object value) { FileIdentity other = value as FileIdentity; return other != null && Volume == other.Volume && FileId == other.FileId; }
      public override int GetHashCode() { return Volume.GetHashCode() ^ FileId.GetHashCode(); }
    }
    [StructLayout(LayoutKind.Sequential)] private struct BY_HANDLE_FILE_INFORMATION {
      internal uint FileAttributes; internal System.Runtime.InteropServices.ComTypes.FILETIME CreationTime;
      internal System.Runtime.InteropServices.ComTypes.FILETIME LastAccessTime;
      internal System.Runtime.InteropServices.ComTypes.FILETIME LastWriteTime; internal uint VolumeSerialNumber;
      internal uint FileSizeHigh; internal uint FileSizeLow; internal uint NumberOfLinks;
      internal uint FileIndexHigh; internal uint FileIndexLow;
    }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] private struct WINTRUST_FILE_INFO {
      internal uint Size; internal string FilePath; internal IntPtr File; internal IntPtr KnownSubject;
    }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] private struct WINTRUST_DATA {
      internal uint Size; internal IntPtr PolicyCallbackData; internal IntPtr SipClientData; internal uint UiChoice;
      internal uint RevocationChecks; internal uint UnionChoice; internal IntPtr FileInfo; internal uint StateAction;
      internal IntPtr StateData; internal string UrlReference; internal uint ProviderFlags; internal uint UiContext;
    }
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetFileInformationByHandleEx(
      SafeFileHandle handle, int informationClass, out FILE_ID_INFO information, int size);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetFileInformationByHandle(
      SafeFileHandle handle, out BY_HANDLE_FILE_INFORMATION information);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetNamedPipeClientProcessId(
      SafePipeHandle pipe, out uint clientProcessId);
    [DllImport("wintrust.dll", ExactSpelling = true, PreserveSig = true)] private static extern int WinVerifyTrust(
      IntPtr window, ref Guid action, IntPtr data);
  }

  internal static class Program {
    private static void Main(string[] args) {
      if (Environment.UserInteractive && args.Length == 1 && args[0] == "--validation-console") {
        // Installed-service tests use SCM for authority. Console mode only
        // proves that an uninstalled package copy cannot become the service.
        Environment.Exit(23);
      }
      ServiceBase.Run(new AuthorityService());
    }
  }
}
