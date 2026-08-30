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
using System.Threading;
using System.Web.Script.Serialization;

namespace Propr.ConnectAuthority {
  internal sealed class AuthorityService : ServiceBase {
    internal const string Name = "ProPRConnectAuthority";
    internal const string Version = "3.0.0";
    private const string PipeName = "ProPR.Connect.Authority.v3";
    private const int MaxFrame = 4096;
    private const int ReadDeadlineMilliseconds = 3000;
    private volatile bool stopping;
    private readonly ReplayWindow replay = new ReplayWindow(1024, TimeSpan.FromMinutes(2));
    private readonly ReplayWindow authenticationReplay = new ReplayWindow(1024, TimeSpan.FromMinutes(2));
    private FileStream serviceImageLease;

    internal AuthorityService() { ServiceName = Name; CanStop = true; AutoLog = false; }
    protected override void OnStart(string[] args) {
      WindowsIdentity serviceIdentity = WindowsIdentity.GetCurrent();
      SecurityIdentifier account = serviceIdentity.User;
      if (account == null || !account.IsWellKnown(WellKnownSidType.LocalSystemSid))
        throw new UnauthorizedAccessException();
      SecurityIdentifier expectedServiceSid = ServiceSid();
      if (serviceIdentity.Groups == null || !serviceIdentity.Groups.Cast<IdentityReference>()
          .Any(group => ((SecurityIdentifier)group.Translate(typeof(SecurityIdentifier))).Value == expectedServiceSid.Value))
        throw new UnauthorizedAccessException();
      HardenInstalledImage();
      string servicePath = Process.GetCurrentProcess().MainModule.FileName;
      serviceImageLease = new FileStream(servicePath, FileMode.Open, FileAccess.Read, FileShare.Read, 4096,
        FileOptions.SequentialScan);
      if (!FileIdentity.Read(serviceImageLease.SafeFileHandle).Ordinary) throw new UnauthorizedAccessException();
      stopping = false;
      System.Threading.ThreadPool.QueueUserWorkItem(_ => AcceptLoop());
    }
    protected override void OnStop() {
      stopping = true;
      if (serviceImageLease != null) { serviceImageLease.Dispose(); serviceImageLease = null; }
    }

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
      security.AddAccessRule(new FileSystemAccessRule(
        new SecurityIdentifier(WellKnownSidType.AuthenticatedUserSid, null),
        FileSystemRights.ReadAndExecute, AccessControlType.Allow));
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

    private static byte[] ReadFrame(NamedPipeServerStream stream) {
      long deadline = Stopwatch.GetTimestamp() + (Stopwatch.Frequency * ReadDeadlineMilliseconds / 1000);
      byte[] prefix = ReadExact(stream, 4, deadline);
      int length = BitConverter.ToInt32(prefix, 0);
      if (length < 2 || length > MaxFrame) throw new InvalidDataException();
      return ReadExact(stream, length, deadline);
    }
    private static byte[] ReadExact(NamedPipeServerStream stream, int length, long deadline) {
      byte[] bytes = new byte[length];
      int offset = 0;
      while (offset < length) {
        long remainingTicks = deadline - Stopwatch.GetTimestamp();
        if (remainingTicks <= 0) { stream.Dispose(); throw new TimeoutException(); }
        int remainingMilliseconds = (int)Math.Min(Int32.MaxValue,
          Math.Max(1, remainingTicks * 1000 / Stopwatch.Frequency));
        IAsyncResult pending = stream.BeginRead(bytes, offset, length - offset, null, null);
        if (!pending.AsyncWaitHandle.WaitOne(remainingMilliseconds)) {
          pending.AsyncWaitHandle.Close();
          stream.Dispose();
          throw new TimeoutException();
        }
        int count;
        try { count = stream.EndRead(pending); }
        finally { pending.AsyncWaitHandle.Close(); }
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
    internal sealed class ReplayWindow {
      private readonly int capacity;
      private readonly long lifetimeTicks;
      private readonly Func<long> clock;
      private readonly Dictionary<string, long> active = new Dictionary<string, long>(StringComparer.Ordinal);
      private readonly Dictionary<string, long> recent = new Dictionary<string, long>(StringComparer.Ordinal);
      private readonly object gate = new object();

      internal ReplayWindow(int capacity, TimeSpan lifetime, Func<long> clock = null) {
        if (capacity < 1 || lifetime <= TimeSpan.Zero) throw new ArgumentOutOfRangeException();
        this.capacity = capacity;
        lifetimeTicks = Math.Max(1, (long)(lifetime.TotalSeconds * Stopwatch.Frequency));
        this.clock = clock ?? Stopwatch.GetTimestamp;
      }
      private void Expire(long now) {
        foreach (string key in recent.Where(pair => pair.Value <= now).Select(pair => pair.Key).ToArray())
          recent.Remove(key);
      }
      internal bool TryAcquire(string requestId) {
        lock (gate) {
          long now = clock();
          Expire(now);
          if (active.ContainsKey(requestId) || recent.ContainsKey(requestId)) return false;
          active.Add(requestId, now);
          return true;
        }
      }
      internal void Complete(string requestId) {
        lock (gate) {
          if (!active.Remove(requestId)) return;
          long now = clock();
          Expire(now);
          if (recent.Count >= capacity) {
            string oldest = recent.OrderBy(pair => pair.Value).ThenBy(pair => pair.Key, StringComparer.Ordinal).First().Key;
            recent.Remove(oldest);
          }
          recent[requestId] = checked(now + lifetimeTicks);
        }
      }
      internal static bool ValidateDeterministically() {
        long now = 0;
        ReplayWindow bounded = new ReplayWindow(4, TimeSpan.FromSeconds(10), () => now);
        for (int index = 0; index < 4; index++) {
          string id = index.ToString("x32");
          if (!bounded.TryAcquire(id)) return false;
          bounded.Complete(id);
        }
        if (!bounded.TryAcquire("ffffffffffffffffffffffffffffffff")) return false;
        bounded.Complete("ffffffffffffffffffffffffffffffff");
        if (!bounded.TryAcquire("00000000000000000000000000000000")) return false;
        bounded.Complete("00000000000000000000000000000000");
        string expiring = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
        if (!bounded.TryAcquire(expiring)) return false;
        bounded.Complete(expiring);
        if (bounded.TryAcquire(expiring)) return false;
        now = 11 * Stopwatch.Frequency;
        if (!bounded.TryAcquire(expiring)) return false;

        ReplayWindow concurrent = new ReplayWindow(4, TimeSpan.FromSeconds(10), () => 0);
        int accepted = 0;
        System.Threading.Tasks.Parallel.For(0, 64, _ => {
          if (concurrent.TryAcquire("cccccccccccccccccccccccccccccccc")) Interlocked.Increment(ref accepted);
        });
        return accepted == 1;
      }
    }

    private void Serve(NamedPipeServerStream pipe) {
      FileStream lease = null;
      string leaseId = null;
      string authenticationReplayId = null;
      List<string> operationReplayIds = new List<string>();
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
        Dictionary<string, object> authentication = Parse(ReadFrame(pipe));
        Exact(authentication, "version", "kind", "requestId", "nonce");
        string authenticationId = Required(authentication, "requestId", 32);
        string authenticationNonce = Required(authentication, "nonce", 64);
        if (Convert.ToInt32(authentication["version"]) != 3 ||
            Required(authentication, "kind", 32) != "authenticate-server" ||
            !Hex(authenticationId, 32) || !Hex(authenticationNonce, 64) || !authenticationReplay.TryAcquire(authenticationId))
          throw new InvalidDataException();
        authenticationReplayId = authenticationId;
        FileIdentity authenticatedSelf = FileIdentity.ReadProcess(Process.GetCurrentProcess());
        string authenticatedPath = Process.GetCurrentProcess().MainModule.FileName;
        if (!PrivateAcl(authenticatedPath, true)) throw new UnauthorizedAccessException();
        WriteFrame(pipe, Document(
          "version", 3, "kind", "server-authenticated", "requestId", authenticationId,
          "nonce", authenticationNonce, "serverPid", Process.GetCurrentProcess().Id.ToString(),
          "imagePath", authenticatedPath, "volumeSerialNumber", authenticatedSelf.Volume.ToString(),
          "fileId", authenticatedSelf.FileId, "sha256", HashFile(authenticatedPath),
          "accountSid", "S-1-5-18", "serviceSid", ServiceSid().Value,
          "daclProtected", true));

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
        if (!replay.TryAcquire(requestId)) throw new InvalidDataException();
        operationReplayIds.Add(requestId);
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
        Control(pipe, leaseId, artifactIdentity, artifactHash, artifactPath, "confirm-launch", operationReplayIds);
        Control(pipe, leaseId, artifactIdentity, artifactHash, artifactPath, "release-launch", operationReplayIds);
      } catch { /* Closing the pipe and lease is the only failure surface. */ }
      finally {
        foreach (string id in operationReplayIds) replay.Complete(id);
        if (authenticationReplayId != null) authenticationReplay.Complete(authenticationReplayId);
        if (lease != null) lease.Dispose();
        pipe.Dispose();
      }
    }

    private void Control(NamedPipeServerStream pipe, string leaseId, FileIdentity artifact,
      string hash, string artifactPath, string expectedKind, List<string> operationReplayIds) {
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
      if (!replay.TryAcquire(requestId)) throw new InvalidDataException();
      operationReplayIds.Add(requestId);
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
    internal static bool PrivateAcl(string path, bool requireSystemOwner) {
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
    internal static SecurityIdentifier ServiceSid() {
      return (SecurityIdentifier)new NTAccount("NT SERVICE", Name).Translate(typeof(SecurityIdentifier));
    }
    internal static string[] SigningPins(string path) {
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
    internal sealed class FileIdentity {
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
#if PROPR_VALIDATION
      if (args.Length == 1 && args[0] == "--validation-replay-window-v1") {
        bool valid = AuthorityService.ReplayWindow.ValidateDeterministically();
        if (valid) Console.Out.Write("{\"bounded\":true,\"concurrent\":true,\"expiry\":true,\"version\":1}\n");
        Environment.Exit(valid ? 0 : 23);
      }
#endif
      if (args.Length == 1 && args[0] == "--client-proxy-v3") {
        Environment.Exit(ClientProxy.Run());
      }
      if (Environment.UserInteractive && args.Length == 1 && args[0] == "--validation-console") {
        // Installed-service tests use SCM for authority. Console mode only
        // proves that an uninstalled package copy cannot become the service.
        Environment.Exit(23);
      }
      ServiceBase.Run(new AuthorityService());
    }
  }

  internal static class ClientProxy {
    private const int MaxFrame = 4096;
    private static byte[] ReadExact(Stream stream, int length) {
      byte[] value = new byte[length]; int offset = 0;
      while (offset < length) { int count = stream.Read(value, offset, length - offset); if (count <= 0) throw new EndOfStreamException(); offset += count; }
      return value;
    }
    private static byte[] ReadFrame(Stream stream) {
      byte[] prefix = ReadExact(stream, 4); int length = BitConverter.ToInt32(prefix, 0);
      if (length < 2 || length > MaxFrame) throw new InvalidDataException();
      return ReadExact(stream, length);
    }
    private static void WriteRawFrame(Stream stream, byte[] body) {
      if (body.Length < 2 || body.Length > MaxFrame) throw new InvalidDataException();
      byte[] prefix = BitConverter.GetBytes(body.Length); stream.Write(prefix, 0, 4); stream.Write(body, 0, body.Length); stream.Flush();
    }
    private static string Required(Dictionary<string, object> value, string key, int max) {
      object raw; string text;
      if (!value.TryGetValue(key, out raw) || (text = raw as string) == null || text.Length < 1 || text.Length > max ||
          text.IndexOfAny(new[] { '\0', '\r', '\n' }) >= 0) throw new InvalidDataException();
      return text;
    }
    private static void Exact(Dictionary<string, object> value, params string[] keys) {
      if (!value.Keys.OrderBy(x => x, StringComparer.Ordinal).SequenceEqual(keys.OrderBy(x => x, StringComparer.Ordinal)))
        throw new InvalidDataException();
    }
    private static Dictionary<string, object> Parse(byte[] bytes) {
      string text = new UTF8Encoding(false, true).GetString(bytes);
      Dictionary<string, object> value = new JavaScriptSerializer { MaxJsonLength = MaxFrame }.Deserialize<Dictionary<string, object>>(text);
      if (value == null || new JavaScriptSerializer { MaxJsonLength = MaxFrame }.Serialize(
          new SortedDictionary<string, object>(value, StringComparer.Ordinal)) != text) throw new InvalidDataException();
      return value;
    }
    private static void WriteDocument(Stream stream, SortedDictionary<string, object> value) {
      WriteRawFrame(stream, new UTF8Encoding(false, true).GetBytes(new JavaScriptSerializer().Serialize(value)));
    }
    private static SortedDictionary<string, object> Document(params object[] pairs) {
      SortedDictionary<string, object> value = new SortedDictionary<string, object>(StringComparer.Ordinal);
      for (int i = 0; i < pairs.Length; i += 2) value.Add((string)pairs[i], pairs[i + 1]);
      return value;
    }
    private static bool Hex(string value, int length) {
      return value.Length == length && value.All(c => (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'));
    }
    private static string Hash(Stream stream) {
      stream.Position = 0; using (SHA256 sha = SHA256.Create()) return BitConverter.ToString(sha.ComputeHash(stream)).Replace("-", "").ToLowerInvariant();
    }
    private static bool PipeAcl(NamedPipeClientStream pipe) {
      PipeSecurity acl = pipe.GetAccessControl();
      SecurityIdentifier owner = (SecurityIdentifier)acl.GetOwner(typeof(SecurityIdentifier));
      if (!acl.AreAccessRulesProtected || !owner.IsWellKnown(WellKnownSidType.LocalSystemSid)) return false;
      bool system = false, administrators = false, authenticated = false;
      int rules = 0;
      foreach (PipeAccessRule rule in acl.GetAccessRules(true, true, typeof(SecurityIdentifier))) {
        rules++;
        SecurityIdentifier sid = (SecurityIdentifier)rule.IdentityReference;
        if (rule.AccessControlType != AccessControlType.Allow || rule.IsInherited) return false;
        if (sid.IsWellKnown(WellKnownSidType.LocalSystemSid)) {
          system = rule.PipeAccessRights == PipeAccessRights.FullControl;
        } else if (sid.IsWellKnown(WellKnownSidType.BuiltinAdministratorsSid)) {
          administrators = rule.PipeAccessRights == PipeAccessRights.FullControl;
        } else if (sid.IsWellKnown(WellKnownSidType.AuthenticatedUserSid)) {
          PipeAccessRights rights = rule.PipeAccessRights;
          authenticated = rights == PipeAccessRights.ReadWrite ||
            rights == (PipeAccessRights.ReadWrite | PipeAccessRights.Synchronize);
        } else return false;
      }
      return rules == 3 && system && administrators && authenticated;
    }
    internal static int Run() {
      try {
        Stream input = Console.OpenStandardInput(); Stream output = Console.OpenStandardOutput();
        Dictionary<string, object> open = Parse(ReadFrame(input));
        Exact(open, "version", "kind", "requestId", "nonce", "serviceVersion", "imagePath", "sha256",
          "authenticodeLeafSha256", "authenticodeSpkiSha256");
        string requestId = Required(open, "requestId", 32); string nonce = Required(open, "nonce", 64);
        string expectedPath = Required(open, "imagePath", 1024); string expectedHash = Required(open, "sha256", 64);
        string expectedLeaf = Required(open, "authenticodeLeafSha256", 64);
        string expectedSpki = Required(open, "authenticodeSpkiSha256", 64);
        if (Convert.ToInt32(open["version"]) != 3 || Required(open, "kind", 32) != "proxy-open" ||
            Required(open, "serviceVersion", 16) != AuthorityService.Version || !Hex(requestId, 32) || !Hex(nonce, 64) ||
            !Hex(expectedHash, 64) || !Hex(expectedLeaf, 64) || !Hex(expectedSpki, 64)) throw new InvalidDataException();

        using (NamedPipeClientStream pipe = new NamedPipeClientStream(".", "ProPR.Connect.Authority.v3",
          PipeAccessRights.ReadWrite | PipeAccessRights.ReadPermissions, PipeOptions.WriteThrough,
          TokenImpersonationLevel.Identification, HandleInheritability.None)) {
          pipe.Connect(8000);
          uint pid;
          if (!GetNamedPipeServerProcessId(pipe.SafePipeHandle, out pid) || pid < 1 || !PipeAcl(pipe)) throw new UnauthorizedAccessException();
          uint serverSession;
          if (!ProcessIdToSessionId(pid, out serverSession) || serverSession != 0) throw new UnauthorizedAccessException();
          // PROCESS_QUERY_LIMITED_INFORMATION is available to a standard-user
          // verifier. The exact protected pipe owner proves LocalSystem; the
          // checksum-held service image's OnStart gate proves its service SID.
          // Do not request TOKEN_QUERY on the LocalSystem process: Windows may
          // correctly deny that operation to the standard-user client.
          IntPtr process = OpenProcess(0x00100000, false, pid);
          if (process == IntPtr.Zero) throw new UnauthorizedAccessException();
          try {
            StringBuilder loadedPath = new StringBuilder(32768); uint loadedLength = (uint)loadedPath.Capacity;
            if (!QueryFullProcessImageName(process, 0, loadedPath, ref loadedLength) ||
                !String.Equals(Path.GetFullPath(loadedPath.ToString()), Path.GetFullPath(expectedPath), StringComparison.OrdinalIgnoreCase))
              throw new UnauthorizedAccessException();
            using (FileStream held = new FileStream(loadedPath.ToString(), FileMode.Open, FileAccess.Read, FileShare.Read)) {
              AuthorityService.FileIdentity identity = AuthorityService.FileIdentity.Read(held.SafeFileHandle);
              string[] pins = AuthorityService.SigningPins(loadedPath.ToString());
              string selfPath = Process.GetCurrentProcess().MainModule.FileName;
              using (FileStream self = new FileStream(selfPath, FileMode.Open, FileAccess.Read, FileShare.Read)) {
                AuthorityService.FileIdentity selfIdentity = AuthorityService.FileIdentity.Read(self.SafeFileHandle);
                if (!String.Equals(Path.GetFullPath(selfPath), Path.GetFullPath(expectedPath), StringComparison.OrdinalIgnoreCase) ||
                    selfIdentity.Volume != identity.Volume || selfIdentity.FileId != identity.FileId ||
                    !selfIdentity.Ordinary || !identity.Ordinary || Hash(self) != expectedHash) throw new UnauthorizedAccessException();
              }
              if (Hash(held) != expectedHash || pins[0] != expectedLeaf || pins[1] != expectedSpki ||
                  !AuthorityService.PrivateAcl(loadedPath.ToString(), true)) throw new UnauthorizedAccessException();
              string authId = Guid.NewGuid().ToString("N"); string authNonce = BitConverter.ToString(Random(32)).Replace("-", "").ToLowerInvariant();
              WriteDocument(pipe, Document("version", 3, "kind", "authenticate-server", "requestId", authId, "nonce", authNonce));
              Dictionary<string, object> proof = Parse(ReadFrame(pipe));
              Exact(proof, "version", "kind", "requestId", "nonce", "serverPid", "imagePath", "volumeSerialNumber", "fileId",
                "sha256", "accountSid", "serviceSid", "daclProtected");
              string serviceSid = AuthorityService.ServiceSid().Value;
              string proofPath = Required(proof, "imagePath", 1024);
              if (Convert.ToInt32(proof["version"]) != 3 || Required(proof, "kind", 32) != "server-authenticated" ||
                  Required(proof, "requestId", 32) != authId || Required(proof, "nonce", 64) != authNonce ||
                  Required(proof, "serverPid", 10) != pid.ToString() ||
                  !String.Equals(Path.GetFullPath(proofPath), Path.GetFullPath(loadedPath.ToString()), StringComparison.OrdinalIgnoreCase) ||
                  Required(proof, "volumeSerialNumber", 32) != identity.Volume.ToString() || Required(proof, "fileId", 64) != identity.FileId ||
                  Required(proof, "sha256", 64) != expectedHash || Required(proof, "accountSid", 32) != "S-1-5-18" ||
                  Required(proof, "serviceSid", 96) != serviceSid || proof["daclProtected"] as bool? != true)
                throw new UnauthorizedAccessException();
              WriteDocument(output, Document("version", 3, "kind", "proxy-ready", "requestId", requestId, "nonce", nonce,
                "serverPid", pid.ToString(), "imagePath", loadedPath.ToString(), "volumeSerialNumber", identity.Volume.ToString(),
                "fileId", identity.FileId, "sha256", expectedHash, "accountSid", "S-1-5-18",
                "serviceSid", serviceSid, "daclProtected", true, "verified", true));
              while (true) { byte[] body; try { body = ReadFrame(input); } catch (EndOfStreamException) { break; }
                WriteRawFrame(pipe, body); WriteRawFrame(output, ReadFrame(pipe)); }
            }
          } finally { CloseHandle(process); }
        }
        return 0;
      } catch { return 23; }
    }
    private static byte[] Random(int length) { byte[] value = new byte[length]; using (RandomNumberGenerator rng = RandomNumberGenerator.Create()) rng.GetBytes(value); return value; }
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetNamedPipeServerProcessId(SafePipeHandle pipe, out uint pid);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool QueryFullProcessImageName(IntPtr process, uint flags, StringBuilder path, ref uint length);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool ProcessIdToSessionId(uint processId, out uint sessionId);
    [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);
  }
}
