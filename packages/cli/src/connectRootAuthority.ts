import { spawnSync } from "node:child_process";
import { fstatSync } from "node:fs";
import { isAbsolute, join } from "node:path";

const NATIVE_INSPECTION_MAX_BYTES = 32 * 1024;
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
  readonly currentUserSid: string;
  readonly ownerSid: string;
  readonly daclProtected: boolean;
  readonly reparsePoint: boolean;
  readonly volumeSerialNumber: string;
  readonly fileId: string;
  readonly rules: readonly WindowsAclRuleInspection[];
}

export interface StableAuthorityIdentity {
  readonly device: string;
  readonly file: string;
}

export interface ConnectRootAuthorityInspector {
  inspectDarwinAcl(path: string, pinnedFd: number): string;
  inspectWindowsAcl(path: string, expectedIdentity: StableAuthorityIdentity): WindowsAuthorityInspection;
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

const POWERSHELL_ACL_INSPECTION = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$target = [Environment]::GetEnvironmentVariable('PROPR_NATIVE_AUTHORITY_TARGET', 'Process')
if ([string]::IsNullOrEmpty($target)) { throw 'missing authority target' }
[string]$source = @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class ProprFileIdentity {
  [StructLayout(LayoutKind.Sequential)] public struct FILETIME { public uint Low; public uint High; }
  [StructLayout(LayoutKind.Sequential)] public struct BY_HANDLE_FILE_INFORMATION {
    public uint Attributes; public FILETIME Creation; public FILETIME Access; public FILETIME Write;
    public uint VolumeSerial; public uint SizeHigh; public uint SizeLow; public uint Links;
    public uint FileIndexHigh; public uint FileIndexLow;
  }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern SafeFileHandle CreateFileW(string name, uint access, uint share, IntPtr security,
    uint creation, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern bool GetFileInformationByHandle(SafeFileHandle handle, out BY_HANDLE_FILE_INFORMATION info);
  [DllImport("advapi32.dll", SetLastError=true)]
  private static extern uint GetSecurityInfo(SafeFileHandle handle, int objectType, uint securityInfo,
    out IntPtr owner, out IntPtr group, out IntPtr dacl, out IntPtr sacl, out IntPtr securityDescriptor);
  [DllImport("advapi32.dll", SetLastError=true)]
  private static extern uint GetSecurityDescriptorLength(IntPtr securityDescriptor);
  [DllImport("kernel32.dll", SetLastError=true)]
  private static extern IntPtr LocalFree(IntPtr memory);
  public static byte[] ReadSecurityDescriptor(SafeFileHandle handle) {
    IntPtr owner, group, dacl, sacl, descriptor;
    uint status = GetSecurityInfo(handle, 1, 0x00000007, out owner, out group, out dacl, out sacl, out descriptor);
    if (status != 0) throw new Win32Exception((int)status);
    try {
      uint length = GetSecurityDescriptorLength(descriptor);
      if (length == 0 || length > 65536) throw new InvalidOperationException("invalid security descriptor");
      byte[] bytes = new byte[length];
      Marshal.Copy(descriptor, bytes, 0, (int)length);
      return bytes;
    } finally { LocalFree(descriptor); }
  }
}
'@
Add-Type -TypeDefinition $source
$handle = [ProprFileIdentity]::CreateFileW($target, 0x00020000, 7, [IntPtr]::Zero, 3, 0x02200000, [IntPtr]::Zero)
if ($handle.IsInvalid) { throw 'authority target open failed' }
try {
  $before = [ProprFileIdentity+BY_HANDLE_FILE_INFORMATION]::new()
  if (-not [ProprFileIdentity]::GetFileInformationByHandle($handle, [ref]$before)) { throw 'identity read failed' }
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$descriptor = [System.Security.AccessControl.RawSecurityDescriptor]::new([ProprFileIdentity]::ReadSecurityDescriptor($handle), 0)
if ($null -eq $descriptor.Owner -or $null -eq $descriptor.DiscretionaryAcl) { throw 'incomplete security descriptor' }
$owner = $descriptor.Owner.Value
$rules = @($descriptor.DiscretionaryAcl | ForEach-Object {
  if (-not ($_ -is [System.Security.AccessControl.QualifiedAce])) { throw 'unsupported access rule' }
  if ($_.AceQualifier -eq [System.Security.AccessControl.AceQualifier]::AccessAllowed) { $accessType = 'allow' }
  elseif ($_.AceQualifier -eq [System.Security.AccessControl.AceQualifier]::AccessDenied) { $accessType = 'deny' }
  else { throw 'unsupported access rule' }
  $mask = [uint32]([int64]$_.AccessMask -band 0xffffffffL)
  [ordered]@{
    identitySid = $_.SecurityIdentifier.Value
    inherited = [bool](($_.AceFlags -band [System.Security.AccessControl.AceFlags]::Inherited) -ne 0)
    accessType = $accessType
    appliesToSelf = [bool](($_.AceFlags -band [System.Security.AccessControl.AceFlags]::InheritOnly) -eq 0)
    rights = $mask.ToString([Globalization.CultureInfo]::InvariantCulture)
  }
})
$after = [ProprFileIdentity+BY_HANDLE_FILE_INFORMATION]::new()
if (-not [ProprFileIdentity]::GetFileInformationByHandle($handle, [ref]$after)) { throw 'identity reread failed' }
$beforeId = ([uint64]$before.FileIndexHigh -shl 32) -bor [uint64]$before.FileIndexLow
$afterId = ([uint64]$after.FileIndexHigh -shl 32) -bor [uint64]$after.FileIndexLow
if ($before.VolumeSerial -ne $after.VolumeSerial -or $beforeId -ne $afterId) { throw 'authority target changed' }
[ordered]@{
  currentUserSid = $identity
  ownerSid = $owner
  daclProtected = [bool](($descriptor.ControlFlags -band [System.Security.AccessControl.ControlFlags]::DiscretionaryAclProtected) -ne 0)
  reparsePoint = [bool](($before.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0)
  volumeSerialNumber = ([uint64]$before.VolumeSerial).ToString([Globalization.CultureInfo]::InvariantCulture)
  fileId = $beforeId.ToString([Globalization.CultureInfo]::InvariantCulture)
  rules = $rules
} | ConvertTo-Json -Compress -Depth 4
} finally { $handle.Dispose() }
`;

const POWERSHELL_PRIVATE_ACL = String.raw`
$ErrorActionPreference = 'Stop'
$target = [Environment]::GetEnvironmentVariable('PROPR_NATIVE_AUTHORITY_TARGET', 'Process')
$kind = [Environment]::GetEnvironmentVariable('PROPR_NATIVE_AUTHORITY_KIND', 'Process')
if ([string]::IsNullOrEmpty($target)) { throw 'missing authority target' }
$current = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$system = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-18')
$admins = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')
if ($kind -eq 'directory') {
  $acl = [System.Security.AccessControl.DirectorySecurity]::new()
  $inheritance = [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
} elseif ($kind -eq 'file') {
  $acl = [System.Security.AccessControl.FileSecurity]::new()
  $inheritance = [System.Security.AccessControl.InheritanceFlags]::None
} else { throw 'invalid entry kind' }
$acl.SetOwner($current)
$acl.SetAccessRuleProtection($true, $false)
foreach ($principal in @($current, $system, $admins)) {
  $rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
    $principal,
    [System.Security.AccessControl.FileSystemRights]::FullControl,
    $inheritance,
    [System.Security.AccessControl.PropagationFlags]::None,
    [System.Security.AccessControl.AccessControlType]::Allow
  )
  [void]$acl.AddAccessRule($rule)
}
Set-Acl -LiteralPath $target -AclObject $acl
`;

function windowsPowerShellExecutable(environment: NodeJS.ProcessEnv): string {
  const systemRoot = environment.SystemRoot ?? environment.SYSTEMROOT;
  if (!systemRoot || !isAbsolute(systemRoot) || systemRoot.includes("\0") || systemRoot.length > 1024) {
    throw new Error("Windows system authority inspection is unavailable");
  }
  return join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

function windowsAuthorityEnvironment(path: string, kind?: "directory" | "file"): NodeJS.ProcessEnv {
  if (!path || path.includes("\0") || path.length > 32_767) {
    throw new Error("Windows system authority inspection is unavailable");
  }
  return {
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    ...(process.env.SYSTEMROOT ? { SYSTEMROOT: process.env.SYSTEMROOT } : {}),
    ...(process.env.WINDIR ? { WINDIR: process.env.WINDIR } : {}),
    ...(process.env.TEMP ? { TEMP: process.env.TEMP } : {}),
    ...(process.env.TMP ? { TMP: process.env.TMP } : {}),
    PROPR_NATIVE_AUTHORITY_TARGET: path,
    ...(kind === undefined ? {} : { PROPR_NATIVE_AUTHORITY_KIND: kind }),
  };
}

function nativeDarwinAcl(_path: string, pinnedFd: number): string {
  if (!Number.isInteger(pinnedFd) || pinnedFd < 0) throw new Error("Darwin ACL authority inspection is unavailable");
  const result = spawnSync("/bin/ls", ["-Llde", "/dev/fd/3"], {
    shell: false,
    windowsHide: true,
    encoding: "buffer",
    env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
    timeout: 3000,
    maxBuffer: NATIVE_INSPECTION_MAX_BYTES,
    // The inspected object is the caller's already-held descriptor. Passing it
    // as fd 3 removes pathname replacement from the ACL authority decision.
    stdio: ["ignore", "pipe", "pipe", pinnedFd],
  });
  if (result.status !== 0 || result.error || result.signal) {
    throw new Error("Darwin ACL authority inspection is unavailable");
  }
  return decodeBoundedUtf8(result.stdout);
}

function nativeWindowsAcl(path: string, _expectedIdentity: StableAuthorityIdentity): WindowsAuthorityInspection {
  const executable = windowsPowerShellExecutable(process.env);
  const result = spawnSync(executable, [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    POWERSHELL_ACL_INSPECTION,
  ], {
    shell: false,
    windowsHide: true,
    encoding: "buffer",
    env: windowsAuthorityEnvironment(path),
    timeout: 3000,
    maxBuffer: NATIVE_INSPECTION_MAX_BYTES,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0 || result.error || result.signal) {
    throw new Error("Windows ACL authority inspection is unavailable");
  }
  const parsed = JSON.parse(decodeBoundedUtf8(result.stdout).trim()) as unknown;
  assertWindowsInspectionShape(parsed);
  return parsed;
}

/** Establish the same narrowly documented DACL used by a new Windows stack. */
export function protectWindowsSetupEntry(path: string, kind: "directory" | "file"): void {
  if (process.platform !== "win32") return;
  const executable = windowsPowerShellExecutable(process.env);
  const result = spawnSync(executable, [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    POWERSHELL_PRIVATE_ACL,
  ], {
    shell: false,
    windowsHide: true,
    encoding: "buffer",
    env: windowsAuthorityEnvironment(path, kind),
    timeout: 3000,
    maxBuffer: NATIVE_INSPECTION_MAX_BYTES,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0 || result.error || result.signal || (result.stdout?.byteLength ?? 0) > 0) {
    throw new Error("Windows setup authority could not be established");
  }
}

export const nativeConnectRootAuthorityInspector: ConnectRootAuthorityInspector = {
  inspectDarwinAcl: nativeDarwinAcl,
  inspectWindowsAcl: nativeWindowsAcl,
};

function exactKeys(value: object, expected: readonly string[]): boolean {
  return Object.keys(value).sort().join(",") === [...expected].sort().join(",");
}

function assertWindowsInspectionShape(value: unknown): asserts value is WindowsAuthorityInspection {
  if (
    !value
    || typeof value !== "object"
    || Array.isArray(value)
    || !exactKeys(value, ["currentUserSid", "ownerSid", "daclProtected", "reparsePoint", "volumeSerialNumber", "fileId", "rules"])
  ) throw new Error("Windows ACL authority inspection was malformed");
  const record = value as Record<string, unknown>;
  if (
    typeof record.currentUserSid !== "string"
    || !WINDOWS_SID.test(record.currentUserSid)
    || typeof record.ownerSid !== "string"
    || !WINDOWS_SID.test(record.ownerSid)
    || typeof record.daclProtected !== "boolean"
    || typeof record.reparsePoint !== "boolean"
    || typeof record.volumeSerialNumber !== "string"
    || !/^(?:0|[1-9]\d{0,19})$/.test(record.volumeSerialNumber)
    || typeof record.fileId !== "string"
    || !/^(?:0|[1-9]\d{0,19})$/.test(record.fileId)
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
    || (protectedTerminal && !inspection.daclProtected)
    || inspection.reparsePoint
  ) throw new Error("Windows root authority is unsafe");

  for (const rule of inspection.rules) {
    if (rule.accessType !== "allow" || !rule.appliesToSelf) continue;
    const rights = BigInt(rule.rights);
    if ((rights & ~WINDOWS_KNOWN_ALLOW_RIGHTS) !== 0n) {
      throw new Error("Windows root authority has an unknown grant");
    }
    const mutates = (rights & (WINDOWS_MUTATING_RIGHTS | WINDOWS_GENERIC_MUTATING_RIGHTS)) !== 0n;
    if (!mutates) continue;
    // OS ancestry commonly inherits grants for the same narrowly trusted
    // user/SYSTEM/Administrators set. Terminal setup/config entries must be
    // protected and explicit; an ancestor may inherit only those principals.
    if (!trustedOwners.has(rule.identitySid) || (protectedTerminal && rule.inherited)) {
      throw new Error("Windows root authority has a broad, inherited, or unknown writable grant");
    }
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
  if (!output || Buffer.byteLength(output, "utf8") > NATIVE_INSPECTION_MAX_BYTES || output.includes("\0")) {
    throw new Error("Darwin ACL authority inspection was malformed");
  }
  const lines = output.replace(/\n$/, "").split("\n");
  if (lines.length === 0 || lines[0].trim() === "") throw new Error("Darwin ACL authority inspection was malformed");
  for (const line of lines.slice(1)) {
    if (line.trim() === "") continue;
    const match = /^\s+\d+:\s+.+?\s+(allow|deny)\s+([a-z_,]+)\s*$/.exec(line);
    if (!match) throw new Error("Darwin ACL authority inspection was malformed");
    if (match[1] === "deny") continue;
    const permissions = match[2].split(",");
    for (const permission of permissions) {
      if (DARWIN_MUTATING_ACL_PERMISSIONS.has(permission)) {
        throw new Error("Darwin ACL grants unexpected write authority");
      }
      if (!DARWIN_READ_ONLY_ACL_PERMISSIONS.has(permission) && !DARWIN_ACL_FLAGS.has(permission)) {
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
    assertSafeDarwinAclOutput(inspector.inspectDarwinAcl(path, pinnedFd));
  } else if (platform === "win32") {
    const inspection = inspector.inspectWindowsAcl(path, before);
    if (inspection.volumeSerialNumber !== before.device || inspection.fileId !== before.file) {
      throw new Error("Windows authority inspection did not match the pinned object");
    }
    assertSafeWindowsAuthority(inspection, kind);
  }
  const after = stableAuthorityIdentity(pinnedFd);
  if (before.device !== after.device || before.file !== after.file) {
    throw new Error("native authority target changed during inspection");
  }
}
