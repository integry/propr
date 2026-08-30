// ProPR Windows Connect authority supervisor, protocol version 2.
//
// This is the complete audited source. Release/Windows validation builds this
// file once, in a bounded build workspace, as a deterministic AnyCPU PE. The
// installed CLI never compiles or transports source and never invokes a shell.

using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Numerics;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Web.Script.Serialization;
using Microsoft.Win32.SafeHandles;

internal static class ProprWindowsAuthoritySupervisor
{
    private const int ProtocolVersion = 2;
    private const int MaxFrameBytes = 4096;
    private const int MaxMessages = 256;
    private const int ExitFailure = 23;
    private static readonly UTF8Encoding StrictUtf8 = new UTF8Encoding(false, true);
    private static string stage = "PROTOCOL_INIT";
    private static string requestId = new string('0', 32);
    private static ulong sequence;
    private static string failureStage;
    private static FileStream heldImage;
    private static SafeFileHandle heldDirectory;
    private static IntPtr parent = IntPtr.Zero;
    private static IntPtr job = IntPtr.Zero;
    private static Identity heldIdentity;
    private static string expectedDigest;
    private static string imagePath;
    private static SecurityIdentifier owner;
    private static bool ready;

    [StructLayout(LayoutKind.Sequential)]
    private struct FileIdInfo { internal ulong Volume; internal ulong Low; internal ulong High; }
    [StructLayout(LayoutKind.Sequential)]
    private struct FileAttributeTagInfo { internal uint Attributes; internal uint ReparseTag; }
    [StructLayout(LayoutKind.Sequential)]
    private struct BasicLimits
    {
        internal long PerProcess; internal long PerJob; internal uint Flags;
        internal UIntPtr MinWorking; internal UIntPtr MaxWorking; internal uint Active;
        internal UIntPtr Affinity; internal uint Priority; internal uint Scheduling;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct IoCounters
    {
        internal ulong ReadOps; internal ulong WriteOps; internal ulong OtherOps;
        internal ulong ReadBytes; internal ulong WriteBytes; internal ulong OtherBytes;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct ExtendedLimits
    {
        internal BasicLimits Basic; internal IoCounters Io;
        internal UIntPtr ProcessMemory; internal UIntPtr JobMemory;
        internal UIntPtr PeakProcess; internal UIntPtr PeakJob;
    }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct StartupInfo
    {
        internal uint Size; internal IntPtr Reserved; internal IntPtr Desktop; internal IntPtr Title;
        internal uint X; internal uint Y; internal uint XSize; internal uint YSize;
        internal uint XCountChars; internal uint YCountChars; internal uint FillAttribute;
        internal uint Flags; internal ushort ShowWindow; internal ushort Reserved2;
        internal IntPtr Reserved2Bytes; internal IntPtr StandardInput; internal IntPtr StandardOutput; internal IntPtr StandardError;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct ProcessInformation
    {
        internal IntPtr Process; internal IntPtr Thread; internal uint ProcessId; internal uint ThreadId;
    }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct WinTrustFileInfo
    {
        internal uint Size; internal string FilePath; internal IntPtr File; internal IntPtr KnownSubject;
    }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct WinTrustData
    {
        internal uint Size; internal IntPtr PolicyCallbackData; internal IntPtr SipClientData;
        internal uint UiChoice; internal uint RevocationChecks; internal uint UnionChoice;
        internal IntPtr FileInfo; internal uint StateAction; internal IntPtr StateData;
        internal string UrlReference; internal uint ProviderFlags; internal uint UiContext;
    }

    private sealed class Identity
    {
        internal readonly string Volume;
        internal readonly string File;
        internal Identity(string volume, string file) { Volume = volume; File = file; }
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetFileInformationByHandleEx(SafeFileHandle handle, int infoClass, out FileIdInfo info, uint size);
    [DllImport("kernel32.dll", EntryPoint = "GetFileInformationByHandleEx", SetLastError = true)]
    private static extern bool GetFileAttributesByHandle(SafeFileHandle handle, int infoClass, out FileAttributeTagInfo info, uint size);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeFileHandle CreateFile(string name, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
    [DllImport("msvcrt.dll", CallingConvention = CallingConvention.Cdecl)]
    private static extern IntPtr _get_osfhandle(int fd);
    [DllImport("msvcrt.dll", CallingConvention = CallingConvention.Cdecl)]
    private static extern int _close(int fd);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(uint access, bool inherit, uint processId);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr CreateJobObject(IntPtr security, string name);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(IntPtr handle, int infoClass, ref ExtendedLimits limits, uint size);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr handle, IntPtr process);
    [DllImport("kernel32.dll")]
    private static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CreateProcess(string applicationName, StringBuilder commandLine, IntPtr processAttributes,
        IntPtr threadAttributes, bool inheritHandles, uint creationFlags, IntPtr environment, string currentDirectory,
        ref StartupInfo startup, out ProcessInformation information);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    private static extern void GetStartupInfo(ref StartupInfo startup);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool QueryFullProcessImageName(IntPtr process, uint flags, StringBuilder name, ref uint size);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);
    [DllImport("wintrust.dll", ExactSpelling = true, PreserveSig = true)]
    private static extern int WinVerifyTrust(IntPtr window, ref Guid action, IntPtr data);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool ConvertStringSecurityDescriptorToSecurityDescriptor(string text, uint revision, out IntPtr descriptor, out uint size);
    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool GetSecurityDescriptorDacl(IntPtr descriptor, out bool present, out IntPtr dacl, out bool defaulted);
    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern uint SetSecurityInfo(IntPtr handle, int objectType, uint information, IntPtr ownerValue, IntPtr group, IntPtr dacl, IntPtr sacl);
    [DllImport("kernel32.dll")]
    private static extern IntPtr LocalFree(IntPtr memory);

    private static void Enter(string value)
    {
        stage = value;
        if (String.Equals(failureStage, value, StringComparison.Ordinal)) throw new InvalidOperationException("injected");
    }

    private static byte[] ReadExact(Stream stream, int count, int timeoutMilliseconds)
    {
        byte[] value = new byte[count];
        int offset = 0;
        DateTime deadline = DateTime.UtcNow.AddMilliseconds(timeoutMilliseconds);
        while (offset < count)
        {
            if (DateTime.UtcNow >= deadline) throw new IOException("deadline");
            if (parent != IntPtr.Zero && WaitForSingleObject(parent, 0) != 258) throw new IOException("parent");
            IAsyncResult pending = stream.BeginRead(value, offset, count - offset, null, null);
            try
            {
                while (!pending.AsyncWaitHandle.WaitOne(25))
                {
                    if (DateTime.UtcNow >= deadline) throw new IOException("deadline");
                    if (parent != IntPtr.Zero && WaitForSingleObject(parent, 0) != 258) throw new IOException("parent");
                }
                int read = stream.EndRead(pending);
                if (read <= 0) throw new EndOfStreamException();
                offset += read;
            }
            finally { pending.AsyncWaitHandle.Close(); }
        }
        return value;
    }

    private static Dictionary<string, object> ReadFrame(Stream input, int timeoutMilliseconds)
    {
        byte[] header = ReadExact(input, 4, timeoutMilliseconds);
        uint length = BitConverter.ToUInt32(header, 0);
        if (length < 2 || length > MaxFrameBytes) throw new InvalidDataException("frame");
        string json = StrictUtf8.GetString(ReadExact(input, checked((int)length), timeoutMilliseconds));
        object parsed = new JavaScriptSerializer { MaxJsonLength = MaxFrameBytes, RecursionLimit = 8 }.DeserializeObject(json);
        Dictionary<string, object> value = parsed as Dictionary<string, object>;
        if (value == null) throw new InvalidDataException("frame");
        return value;
    }

    private static void WriteFrame(Stream output, string json)
    {
        byte[] body = StrictUtf8.GetBytes(json);
        if (body.Length < 2 || body.Length > MaxFrameBytes) throw new InvalidDataException("frame");
        byte[] header = BitConverter.GetBytes((uint)body.Length);
        output.Write(header, 0, header.Length);
        output.Write(body, 0, body.Length);
        output.Flush();
    }

    private static bool ExactKeys(Dictionary<string, object> value, params string[] expected)
    {
        if (value.Count != expected.Length) return false;
        foreach (string key in expected) if (!value.ContainsKey(key)) return false;
        return true;
    }

    private static string StringValue(Dictionary<string, object> value, string key)
    {
        object item;
        return value.TryGetValue(key, out item) ? item as string : null;
    }

    private static bool IsHex(string value, int length)
    {
        if (value == null || value.Length != length) return false;
        foreach (char ch in value) if (!((ch >= '0' && ch <= '9') || (ch >= 'a' && ch <= 'f'))) return false;
        return true;
    }

    private static Identity GetIdentity(SafeFileHandle handle)
    {
        FileIdInfo info;
        if (handle == null || handle.IsInvalid || !GetFileInformationByHandleEx(handle, 18, out info, 24)) throw new IOException("identity");
        BigInteger file = ((BigInteger)info.High << 64) + info.Low;
        return new Identity(info.Volume.ToString(CultureInfo.InvariantCulture), file.ToString(CultureInfo.InvariantCulture));
    }

    private static void RequireOrdinary(SafeFileHandle handle)
    {
        FileAttributeTagInfo info;
        if (!GetFileAttributesByHandle(handle, 9, out info, 8) || (info.Attributes & 0x400) != 0) throw new IOException("reparse");
    }

    private static string Hash(FileStream stream)
    {
        stream.Position = 0;
        byte[] digest;
        using (SHA256 sha = SHA256.Create()) { digest = sha.ComputeHash(stream); }
        stream.Position = 0;
        StringBuilder value = new StringBuilder(64);
        foreach (byte item in digest) value.Append(item.ToString("x2", CultureInfo.InvariantCulture));
        return value.ToString();
    }

    private static FileSystemAccessRule Rule(SecurityIdentifier sid, bool directory)
    {
        InheritanceFlags inheritance = directory ? InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit : InheritanceFlags.None;
        return new FileSystemAccessRule(sid, FileSystemRights.FullControl, inheritance, PropagationFlags.None, AccessControlType.Allow);
    }

    private static void ProtectAndVerify(string path, bool directory)
    {
        FileSystemSecurity security = directory ? (FileSystemSecurity)new DirectorySecurity() : new FileSecurity();
        security.SetOwner(owner);
        security.SetAccessRuleProtection(true, false);
        foreach (string text in new[] { owner.Value, "S-1-5-18", "S-1-5-32-544" }) security.AddAccessRule(Rule(new SecurityIdentifier(text), directory));
        if (directory) Directory.SetAccessControl(path, (DirectorySecurity)security); else File.SetAccessControl(path, (FileSecurity)security);
        FileSystemSecurity actual = directory ? (FileSystemSecurity)Directory.GetAccessControl(path) : File.GetAccessControl(path);
        if (!actual.AreAccessRulesProtected || actual.GetOwner(typeof(SecurityIdentifier)).Value != owner.Value) throw new UnauthorizedAccessException();
        AuthorizationRuleCollection rules = actual.GetAccessRules(true, true, typeof(SecurityIdentifier));
        if (rules.Count != 3) throw new UnauthorizedAccessException();
        foreach (FileSystemAccessRule rule in rules)
        {
            string sid = rule.IdentityReference.Value;
            if (rule.IsInherited || rule.AccessControlType != AccessControlType.Allow || rule.FileSystemRights != FileSystemRights.FullControl ||
                (sid != owner.Value && sid != "S-1-5-18" && sid != "S-1-5-32-544")) throw new UnauthorizedAccessException();
        }
    }

    private static void CreateAndAssignJob()
    {
        // The directly spawned lease instance created the process suspended and
        // assigned its kill-on-close job before this protocol instance ran.
        Enter("JOB_ASSIGN");
    }

    private static bool HardenProcess()
    {
        IntPtr descriptor = IntPtr.Zero;
        try
        {
            uint size; bool present; bool defaulted; IntPtr dacl;
            string sddl = "D:P(A;;0x00100001;;;" + owner.Value + ")(A;;GA;;;SY)(A;;GA;;;BA)";
            if (!ConvertStringSecurityDescriptorToSecurityDescriptor(sddl, 1, out descriptor, out size) ||
                !GetSecurityDescriptorDacl(descriptor, out present, out dacl, out defaulted) || !present) return false;
            return SetSecurityInfo(GetCurrentProcess(), 6, 0x80000004, IntPtr.Zero, IntPtr.Zero, dacl, IntPtr.Zero) == 0;
        }
        finally { if (descriptor != IntPtr.Zero) LocalFree(descriptor); }
    }

    private static string Response(string kind, string id)
    {
        return "{\"version\":2,\"kind\":\"" + kind + "\",\"requestId\":\"" + id +
            "\",\"supervisorPid\":\"" + System.Diagnostics.Process.GetCurrentProcess().Id.ToString(CultureInfo.InvariantCulture) +
            "\",\"sequence\":" + sequence.ToString(CultureInfo.InvariantCulture) +
            ",\"volumeSerialNumber\":\"" + heldIdentity.Volume + "\",\"fileId\":\"" + heldIdentity.File +
            "\",\"sha256\":\"" + expectedDigest + "\"}";
    }

    private static void VerifyHeldImage()
    {
        Enter("HELPER_IDENTITY");
        Identity current = GetIdentity(heldImage.SafeFileHandle);
        if (current.Volume != heldIdentity.Volume || current.File != heldIdentity.File) throw new IOException("identity");
        Enter("HELPER_HASH");
        if (!String.Equals(Hash(heldImage), expectedDigest, StringComparison.Ordinal)) throw new IOException("hash");
        ProtectAndVerify(Path.GetDirectoryName(imagePath), true);
        ProtectAndVerify(imagePath, false);
    }

    private static void Run(Stream input, Stream output)
    {
        Enter("PROTOCOL_INIT");
        Dictionary<string, object> init = ReadFrame(input, 10000);
        bool testing = ExactKeys(init, "version", "kind", "requestId", "path", "sha256", "parentPid", "testFailureStage");
        if (!testing && !ExactKeys(init, "version", "kind", "requestId", "path", "sha256", "parentPid")) throw new InvalidDataException("init");
        if (testing) failureStage = StringValue(init, "testFailureStage");
        requestId = StringValue(init, "requestId");
        imagePath = StringValue(init, "path");
        expectedDigest = StringValue(init, "sha256");
        string parentPid = StringValue(init, "parentPid");
        if (Convert.ToInt32(init["version"], CultureInfo.InvariantCulture) != ProtocolVersion || StringValue(init, "kind") != "init" ||
            !IsHex(requestId, 32) || !IsHex(expectedDigest, 64) || String.IsNullOrEmpty(imagePath) || imagePath.Length > 1024 || imagePath.IndexOf('\0') >= 0 ||
            parentPid == null || !System.Text.RegularExpressions.Regex.IsMatch(parentPid, "^[1-9][0-9]{0,9}$")) throw new InvalidDataException("init");
        Enter("HELPER_OPEN");
        IntPtr raw = _get_osfhandle(3);
        if (raw == new IntPtr(-1)) throw new IOException("inherited image");
        using (SafeFileHandle inherited = new SafeFileHandle(raw, false))
        {
            RequireOrdinary(inherited);
            Identity inheritedIdentity = GetIdentity(inherited);
            string directory = Path.GetDirectoryName(imagePath);
            heldDirectory = CreateFile(directory, 0x00020000, 1, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero);
            if (heldDirectory.IsInvalid) throw new IOException("directory");
            RequireOrdinary(heldDirectory);
            heldImage = new FileStream(imagePath, FileMode.Open, FileAccess.Read, FileShare.Read, 4096, FileOptions.SequentialScan);
            RequireOrdinary(heldImage.SafeFileHandle);
            heldIdentity = GetIdentity(heldImage.SafeFileHandle);
            if (heldIdentity.Volume != inheritedIdentity.Volume || heldIdentity.File != inheritedIdentity.File) throw new IOException("identity");
            if (_close(3) != 0) throw new IOException("duplicate");
        }
        owner = WindowsIdentity.GetCurrent().User;
        VerifyHeldImage();
        CreateAndAssignJob();
        uint parsedParent;
        if (!UInt32.TryParse(parentPid, NumberStyles.None, CultureInfo.InvariantCulture, out parsedParent)) throw new InvalidDataException("parent");
        parent = OpenProcess(0x00100000, false, parsedParent);
        if (parent == IntPtr.Zero || !HardenProcess()) throw new IOException("parent");
        Enter("READY");
        sequence = 1;
        WriteFrame(output, Response("ready", requestId));
        ready = true;
        HashSet<string> seen = new HashSet<string>(StringComparer.Ordinal) { requestId };
        for (int count = 0; count < MaxMessages && WaitForSingleObject(parent, 0) == 258; ++count)
        {
            Enter("PRE_CHALLENGE");
            Dictionary<string, object> request = ReadFrame(input, 300000);
            if (!ExactKeys(request, "version", "kind", "requestId")) throw new InvalidDataException("request");
            string kind = StringValue(request, "kind");
            string id = StringValue(request, "requestId");
            if (Convert.ToInt32(request["version"], CultureInfo.InvariantCulture) != ProtocolVersion ||
                (kind != "challenge" && kind != "stop") || !IsHex(id, 32) || !seen.Add(id)) throw new InvalidDataException("request");
            requestId = id;
            VerifyHeldImage();
            Enter(kind == "stop" ? "SHUTDOWN" : "POST_CHALLENGE");
            ++sequence;
            WriteFrame(output, Response(kind == "stop" ? "stopped" : "ready", id));
            if (kind == "stop") return;
        }
        throw new IOException("shutdown");
    }

    private static bool VerifyAuthenticode(string path)
    {
        WinTrustFileInfo file = new WinTrustFileInfo();
        file.Size = (uint)Marshal.SizeOf(typeof(WinTrustFileInfo));
        file.FilePath = path;
        IntPtr filePointer = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(WinTrustFileInfo)));
        IntPtr dataPointer = IntPtr.Zero;
        try
        {
            Marshal.StructureToPtr(file, filePointer, false);
            WinTrustData data = new WinTrustData();
            data.Size = (uint)Marshal.SizeOf(typeof(WinTrustData));
            data.UiChoice = 2; // WTD_UI_NONE
            data.RevocationChecks = 1; // WTD_REVOKE_WHOLECHAIN
            data.UnionChoice = 1; // WTD_CHOICE_FILE
            data.FileInfo = filePointer;
            data.ProviderFlags = 0x00000080 | 0x00001000; // REVOCATION_CHECK_CHAIN | CACHE_ONLY_URL_RETRIEVAL
            dataPointer = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(WinTrustData)));
            Marshal.StructureToPtr(data, dataPointer, false);
            Guid action = new Guid("00AAC56B-CD44-11D0-8CC2-00C04FC295EE");
            return WinVerifyTrust(new IntPtr(-1), ref action, dataPointer) == 0;
        }
        finally
        {
            if (dataPointer != IntPtr.Zero)
            {
                Marshal.DestroyStructure(dataPointer, typeof(WinTrustData));
                Marshal.FreeHGlobal(dataPointer);
            }
            Marshal.DestroyStructure(filePointer, typeof(WinTrustFileInfo));
            Marshal.FreeHGlobal(filePointer);
        }
    }

    private static int LeaseMain(bool unsignedValidation)
    {
        string path = System.Reflection.Assembly.GetExecutingAssembly().Location;
        if (!unsignedValidation && !VerifyAuthenticode(path)) return ExitFailure;
        owner = WindowsIdentity.GetCurrent().User;
        if (!HardenProcess()) return ExitFailure;
        IntPtr leaseJob = IntPtr.Zero;
        ProcessInformation child = new ProcessInformation();
        using (FileStream lease = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read, 4096, FileOptions.SequentialScan))
        {
            RequireOrdinary(lease.SafeFileHandle);
            Identity leaseIdentity = GetIdentity(lease.SafeFileHandle);
            string leaseHash = Hash(lease);
            IntPtr inheritedRaw = _get_osfhandle(4);
            if (inheritedRaw == new IntPtr(-1)) return ExitFailure;
            using (SafeFileHandle inheritedHandle = new SafeFileHandle(inheritedRaw, false))
            using (FileStream inherited = new FileStream(inheritedHandle, FileAccess.Read, 4096, false))
            {
                RequireOrdinary(inheritedHandle);
                Identity inheritedIdentity = GetIdentity(inheritedHandle);
                if (inheritedIdentity.Volume != leaseIdentity.Volume || inheritedIdentity.File != leaseIdentity.File ||
                    !String.Equals(Hash(inherited), leaseHash, StringComparison.Ordinal)) return ExitFailure;
            }
            if (_close(4) != 0) return ExitFailure;
            StartupInfo startup = new StartupInfo();
            startup.Size = (uint)Marshal.SizeOf(typeof(StartupInfo));
            // Preserve Node's documented extra-stdio CRT descriptor table so
            // the inherited broker capability remains fd 3 in the child.
            GetStartupInfo(ref startup);
            StringBuilder commandLine = new StringBuilder("\"" + path + "\" --authority-v2");
            if (!CreateProcess(path, commandLine, IntPtr.Zero, IntPtr.Zero, true, 0x00000004, IntPtr.Zero,
                Path.GetDirectoryName(path), ref startup, out child)) return ExitFailure; // CREATE_SUSPENDED
            try
            {
                leaseJob = CreateJobObject(IntPtr.Zero, null);
                if (leaseJob == IntPtr.Zero) return ExitFailure;
                ExtendedLimits limits = new ExtendedLimits();
                limits.Basic.Flags = 0x2000;
                if (!SetInformationJobObject(leaseJob, 9, ref limits, (uint)Marshal.SizeOf(typeof(ExtendedLimits))) ||
                    !AssignProcessToJobObject(leaseJob, child.Process)) return ExitFailure;

                StringBuilder loadedPath = new StringBuilder(32768);
                uint loadedLength = (uint)loadedPath.Capacity;
                if (!QueryFullProcessImageName(child.Process, 0, loadedPath, ref loadedLength)) return ExitFailure;
                using (FileStream loaded = new FileStream(loadedPath.ToString(), FileMode.Open, FileAccess.Read, FileShare.Read,
                    4096, FileOptions.SequentialScan))
                {
                    RequireOrdinary(loaded.SafeFileHandle);
                    Identity loadedIdentity = GetIdentity(loaded.SafeFileHandle);
                    if (loadedIdentity.Volume != leaseIdentity.Volume || loadedIdentity.File != leaseIdentity.File ||
                        !String.Equals(Hash(loaded), leaseHash, StringComparison.Ordinal)) return ExitFailure;
                }
                if (ResumeThread(child.Thread) == UInt32.MaxValue) return ExitFailure;
                WaitForSingleObject(child.Process, 0xffffffff);
                uint exitCode;
                return GetExitCodeProcess(child.Process, out exitCode) ? unchecked((int)exitCode) : ExitFailure;
            }
            finally
            {
                if (child.Thread != IntPtr.Zero) CloseHandle(child.Thread);
                if (child.Process != IntPtr.Zero) CloseHandle(child.Process);
                if (leaseJob != IntPtr.Zero) CloseHandle(leaseJob);
            }
        }
    }

    public static int Main(string[] args)
    {
        if (args.Length == 1 && args[0] == "--lease-v2") return LeaseMain(false);
        if (args.Length == 1 && args[0] == "--lease-validation-v2") return LeaseMain(true);
        if (args.Length != 1 || args[0] != "--authority-v2") return ExitFailure;
        Stream input = Console.OpenStandardInput();
        Stream output = Console.OpenStandardOutput();
        try { Run(input, output); return 0; }
        catch
        {
            try
            {
                string safeStage = System.Text.RegularExpressions.Regex.IsMatch(stage ?? "", "^[A-Z_]{1,32}$") ? stage : "PROTOCOL_INIT";
                if (ready && heldIdentity != null && expectedDigest != null)
                {
                    string body = Response("capability-error", requestId);
                    WriteFrame(output, body.Substring(0, body.Length - 1) + ",\"stage\":\"" + safeStage + "\"}");
                }
                else WriteFrame(output, "{\"version\":2,\"kind\":\"startup-error\",\"requestId\":\"" + requestId + "\",\"stage\":\"" + safeStage + "\"}");
            }
            catch { }
            return ExitFailure;
        }
        finally
        {
            if (heldImage != null) heldImage.Dispose();
            if (heldDirectory != null) heldDirectory.Dispose();
            if (parent != IntPtr.Zero) CloseHandle(parent);
            if (job != IntPtr.Zero) CloseHandle(job);
        }
    }
}
