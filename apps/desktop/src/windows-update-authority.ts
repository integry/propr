import { spawn } from 'node:child_process';

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
}

export interface WindowsLockedArtifact {
  read(offset: number, length: number): Promise<Buffer>;
  close(): Promise<void>;
}

const BROKER_TIMEOUT_MS = 10_000;
const BROKER_OUTPUT_BYTES = 16 * 1024;

// The broker opens the object itself with FILE_FLAG_OPEN_REPARSE_POINT and without
// write/delete sharing. ACL and FILE_ID_INFO are consequently read from the same
// pinned kernel handle rather than from a pathname assembled by PowerShell.
const WINDOWS_AUTHORITY_BROKER = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using Microsoft.Win32.SafeHandles;

public sealed class InspectionResult {
  public string volumeSerial;
  public string fileId128;
  public bool directory;
  public string links;
  public string size;
}

public static class ProprUpdateAuthority {
  const uint READ_CONTROL = 0x00020000;
  const uint FILE_READ_ATTRIBUTES = 0x00000080;
  const uint FILE_SHARE_READ = 0x00000001;
  const uint OPEN_EXISTING = 3;
  const uint FILE_FLAG_BACKUP_SEMANTICS = 0x02000000;
  const uint FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000;
  const uint FILE_ATTRIBUTE_REPARSE_POINT = 0x00000400;
  const int FileStandardInfo = 1;
  const int FileAttributeTagInfo = 9;
  const int FileIdInfo = 18;
  const int SE_FILE_OBJECT = 1;
  const int OWNER_SECURITY_INFORMATION = 0x00000001;
  const int DACL_SECURITY_INFORMATION = 0x00000004;
  const int PROTECTED_DACL_SECURITY_INFORMATION = unchecked((int)0x80000000);
  const int WRITE_AUTHORITY = unchecked((int)0x500D0156);

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
  unsafe struct FILE_ID_INFO { public ulong VolumeSerialNumber; public fixed byte FileId[16]; }

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern SafeFileHandle CreateFileW(string name, uint access, uint share, IntPtr security,
    uint disposition, uint flags, IntPtr template);

  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool GetFileInformationByHandleEx(SafeFileHandle handle, int infoClass,
    IntPtr information, uint size);

  [DllImport("advapi32.dll", SetLastError = true)]
  static extern uint GetSecurityInfo(SafeFileHandle handle, int objectType, int securityInfo,
    out IntPtr owner, out IntPtr group, out IntPtr dacl, out IntPtr sacl, out IntPtr descriptor);

  [DllImport("kernel32.dll")]
  static extern IntPtr LocalFree(IntPtr memory);

  [DllImport("advapi32.dll")]
  static extern uint GetSecurityDescriptorLength(IntPtr descriptor);

  static T ReadInfo<T>(SafeFileHandle handle, int infoClass) where T : struct {
    int size = Marshal.SizeOf(typeof(T));
    IntPtr memory = Marshal.AllocHGlobal(size);
    try {
      if (!GetFileInformationByHandleEx(handle, infoClass, memory, (uint)size)) {
        throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
      }
      return (T)Marshal.PtrToStructure(memory, typeof(T));
    } finally { Marshal.FreeHGlobal(memory); }
  }

  static void VerifySecurity(SafeFileHandle handle) {
    IntPtr owner, group, dacl, sacl, descriptor;
    uint error = GetSecurityInfo(handle, SE_FILE_OBJECT,
      OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
      out owner, out group, out dacl, out sacl, out descriptor);
    if (error != 0 || descriptor == IntPtr.Zero) throw new System.ComponentModel.Win32Exception((int)error);
    try {
      int length = checked((int)GetSecurityDescriptorLength(descriptor));
      if (length <= 0 || length > 65536) throw new InvalidDataException("security descriptor is invalid");
      byte[] bytes = new byte[length];
      Marshal.Copy(descriptor, bytes, 0, length);
      RawSecurityDescriptor security = new RawSecurityDescriptor(bytes, 0);
      SecurityIdentifier current = WindowsIdentity.GetCurrent(TokenAccessLevels.Query).User;
      if (security.Owner == null || !security.Owner.Equals(current)) throw new UnauthorizedAccessException("owner mismatch");
      if ((security.ControlFlags & ControlFlags.DiscretionaryAclProtected) == 0 || security.DiscretionaryAcl == null) {
        throw new UnauthorizedAccessException("DACL is not protected");
      }
      SecurityIdentifier system = new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null);
      SecurityIdentifier administrators = new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null);
      foreach (GenericAce generic in security.DiscretionaryAcl) {
        if ((generic.AceFlags & AceFlags.Inherited) != 0) throw new UnauthorizedAccessException("inherited ACE");
        CommonAce ace = generic as CommonAce;
        if (ace == null || ace.AceQualifier != AceQualifier.AccessAllowed) continue;
        bool trusted = ace.SecurityIdentifier.Equals(current) || ace.SecurityIdentifier.Equals(system)
          || ace.SecurityIdentifier.Equals(administrators);
        if (!trusted && (ace.AccessMask & WRITE_AUTHORITY) != 0) {
          throw new UnauthorizedAccessException("broad write authority");
        }
      }
    } finally { LocalFree(descriptor); }
  }

  static SafeFileHandle OpenPinned(string path) {
    SafeFileHandle handle = CreateFileW(path, READ_CONTROL | FILE_READ_ATTRIBUTES, FILE_SHARE_READ,
      IntPtr.Zero, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, IntPtr.Zero);
    if (handle.IsInvalid) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    return handle;
  }

  public static unsafe InspectionResult Inspect(string path, bool expectedDirectory) {
    using (SafeFileHandle handle = OpenPinned(path)) {
      FILE_ATTRIBUTE_TAG_INFO attributes = ReadInfo<FILE_ATTRIBUTE_TAG_INFO>(handle, FileAttributeTagInfo);
      if ((attributes.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0) throw new IOException("reparse point");
      FILE_STANDARD_INFO standard = ReadInfo<FILE_STANDARD_INFO>(handle, FileStandardInfo);
      if (standard.DeletePending || standard.Directory != expectedDirectory) throw new IOException("object type mismatch");
      if (!standard.Directory && standard.NumberOfLinks != 1) throw new IOException("file is not single-link");
      VerifySecurity(handle);
      FILE_ID_INFO identity = ReadInfo<FILE_ID_INFO>(handle, FileIdInfo);
      byte[] fileId = new byte[16];
      fixed (byte* source = identity.FileId) Marshal.Copy((IntPtr)source, fileId, 0, fileId.Length);
      return new InspectionResult {
        volumeSerial = identity.VolumeSerialNumber.ToString("x16"),
        fileId128 = BitConverter.ToString(fileId).Replace("-", "").ToLowerInvariant(),
        directory = standard.Directory,
        links = standard.NumberOfLinks.ToString(),
        size = standard.EndOfFile.ToString()
      };
    }
  }

  static string PrivateSddl() {
    string owner = WindowsIdentity.GetCurrent(TokenAccessLevels.Query).User.Value;
    return "O:" + owner + "G:" + owner + "D:P(A;;FA;;;" + owner + ")(A;;FA;;;SY)(A;;FA;;;BA)";
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
}
'@ -Language CSharp -CompilerOptions '/unsafe'

$request = [Console]::In.ReadToEnd() | ConvertFrom-Json
if ($request.operation -eq 'inspect') {
  $result = [ProprUpdateAuthority]::Inspect([string]$request.path, [bool]$request.directory)
} elseif ($request.operation -eq 'ensure-directory') {
  $result = [ProprUpdateAuthority]::EnsureDirectory([string]$request.path)
} elseif ($request.operation -eq 'protect-directory') {
  $result = [ProprUpdateAuthority]::ProtectDirectory([string]$request.path)
} elseif ($request.operation -eq 'protect-file') {
  $result = [ProprUpdateAuthority]::ProtectFile([string]$request.path)
} else { throw 'unsupported operation' }
$result | ConvertTo-Json -Compress
`;

const WINDOWS_HELD_READER_BROKER = String.raw`
$ErrorActionPreference = 'Stop'
$request = [Console]::In.ReadLine() | ConvertFrom-Json
$stream = [IO.File]::Open([string]$request.path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
try {
  [Console]::Out.WriteLine('{"ready":true}')
  [Console]::Out.Flush()
  while (($line = [Console]::In.ReadLine()) -ne $null) {
    $command = $line | ConvertFrom-Json
    if ($command.operation -eq 'close') { break }
    if ($command.operation -ne 'read') { throw 'unsupported operation' }
    $offset = [Int64]$command.offset
    $length = [Int32]$command.length
    if ($offset -lt 0 -or $length -le 0 -or $length -gt 1048576 -or $offset + $length -gt $stream.Length) {
      throw 'invalid read range'
    }
    $buffer = New-Object byte[] $length
    [void]$stream.Seek($offset, [IO.SeekOrigin]::Begin)
    $read = 0
    while ($read -lt $length) {
      $count = $stream.Read($buffer, $read, $length - $read)
      if ($count -eq 0) { throw 'short read' }
      $read += $count
    }
    [Console]::Out.WriteLine((@{ bytes = [Convert]::ToBase64String($buffer) } | ConvertTo-Json -Compress))
    [Console]::Out.Flush()
  }
} finally { $stream.Dispose() }
`;

type BrokerOperation = 'inspect' | 'ensure-directory' | 'protect-directory' | 'protect-file';

const runBroker = async (
  operation: BrokerOperation,
  path: string,
  directory: boolean,
): Promise<WindowsPrivatePathInspection> => new Promise((resolve, reject) => {
  const encoded = Buffer.from(WINDOWS_AUTHORITY_BROKER, 'utf16le').toString('base64');
  const child = spawn('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded,
  ], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let stdout = Buffer.alloc(0);
  let stderrBytes = 0;
  let settled = false;
  const fail = (): void => {
    if (settled) return;
    settled = true;
    reject(new Error('Verified update cache authority inspection failed'));
  };
  const timeout = setTimeout(() => {
    child.kill();
    fail();
  }, BROKER_TIMEOUT_MS);
  child.stdout.on('data', (chunk: Buffer) => {
    if (stdout.length + chunk.length > BROKER_OUTPUT_BYTES) {
      child.kill();
      fail();
      return;
    }
    stdout = Buffer.concat([stdout, chunk]);
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderrBytes += chunk.length;
    if (stderrBytes > BROKER_OUTPUT_BYTES) child.kill();
  });
  child.on('error', fail);
  child.on('close', code => {
    clearTimeout(timeout);
    if (settled) return;
    if (code !== 0 || stderrBytes > BROKER_OUTPUT_BYTES) return fail();
    let value: unknown;
    try { value = JSON.parse(stdout.toString('utf8')); } catch { return fail(); }
    if (typeof value !== 'object' || value === null) return fail();
    const candidate = value as Record<string, unknown>;
    if (!/^[a-f0-9]{16}$/.test(String(candidate.volumeSerial))
      || !/^[a-f0-9]{32}$/.test(String(candidate.fileId128))
      || candidate.directory !== directory
      || !/^(0|[1-9]\d*)$/.test(String(candidate.links))
      || !/^(0|[1-9]\d*)$/.test(String(candidate.size))) return fail();
    settled = true;
    resolve({
      identity: {
        platform: 'win32',
        volumeSerial: String(candidate.volumeSerial),
        fileId128: String(candidate.fileId128),
      },
      directory,
      links: String(candidate.links),
      size: String(candidate.size),
    });
  });
  child.stdin.end(JSON.stringify({ operation, path, directory }));
});

export const inspectWindowsPrivatePath = (path: string, directory = false): Promise<WindowsPrivatePathInspection> =>
  runBroker('inspect', path, directory);

export const ensureWindowsPrivateDirectory = (path: string): Promise<WindowsPrivatePathInspection> =>
  runBroker('ensure-directory', path, true);

export const protectWindowsPrivateDirectory = (path: string): Promise<WindowsPrivatePathInspection> =>
  runBroker('protect-directory', path, true);

export const protectWindowsPrivateFile = (path: string): Promise<WindowsPrivatePathInspection> =>
  runBroker('protect-file', path, false);

export const openWindowsLockedArtifact = async (path: string): Promise<WindowsLockedArtifact> => {
  const encoded = Buffer.from(WINDOWS_HELD_READER_BROKER, 'utf16le').toString('base64');
  const child = spawn('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded,
  ], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  child.stdin.write(`${JSON.stringify({ path })}\n`);

  let buffered = '';
  let stderrBytes = 0;
  let closed = false;
  const lines: string[] = [];
  const waiters: Array<{ resolve: (line: string) => void; reject: () => void }> = [];
  const fail = (): void => {
    while (waiters.length) waiters.shift()!.reject();
  };
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    buffered += chunk;
    if (buffered.length > 2 * 1024 * 1024) {
      child.kill();
      fail();
      return;
    }
    while (buffered.includes('\n')) {
      const newline = buffered.indexOf('\n');
      const line = buffered.slice(0, newline).trimEnd();
      buffered = buffered.slice(newline + 1);
      const waiter = waiters.shift();
      if (waiter) waiter.resolve(line);
      else lines.push(line);
    }
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderrBytes += chunk.length;
    if (stderrBytes > BROKER_OUTPUT_BYTES) child.kill();
  });
  child.on('error', fail);
  const exited = new Promise<void>(resolve => child.on('close', () => { fail(); resolve(); }));

  const command = (value?: object): Promise<string> => new Promise((resolve, reject) => {
    if (lines.length) {
      resolve(lines.shift()!);
      if (value) child.stdin.write(`${JSON.stringify(value)}\n`);
      return;
    }
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('Verified update artifact lock failed'));
    }, BROKER_TIMEOUT_MS);
    waiters.push({
      resolve: line => { clearTimeout(timer); resolve(line); },
      reject: () => { clearTimeout(timer); reject(new Error('Verified update artifact lock failed')); },
    });
    if (value) child.stdin.write(`${JSON.stringify(value)}\n`);
  });

  let ready: unknown;
  try { ready = JSON.parse(await command()); } catch {
    child.kill();
    throw new Error('Verified update artifact lock failed');
  }
  if (typeof ready !== 'object' || ready === null || (ready as Record<string, unknown>).ready !== true) {
    child.kill();
    throw new Error('Verified update artifact lock failed');
  }

  return {
    read: async (offset, length) => {
      let result: unknown;
      try { result = JSON.parse(await command({ operation: 'read', offset, length })); } catch {
        throw new Error('Verified update artifact lock failed');
      }
      const encodedBytes = typeof result === 'object' && result !== null
        ? (result as Record<string, unknown>).bytes
        : undefined;
      if (typeof encodedBytes !== 'string') throw new Error('Verified update artifact lock failed');
      const bytes = Buffer.from(encodedBytes, 'base64');
      if (bytes.length !== length || bytes.toString('base64') !== encodedBytes) {
        throw new Error('Verified update artifact lock failed');
      }
      return bytes;
    },
    close: async () => {
      if (closed) return;
      closed = true;
      child.stdin.end(`${JSON.stringify({ operation: 'close' })}\n`);
      await Promise.race([
        exited,
        new Promise<void>((_resolve, reject) => setTimeout(() => reject(new Error('Verified update artifact lock failed')), BROKER_TIMEOUT_MS)),
      ]);
    },
  };
};
