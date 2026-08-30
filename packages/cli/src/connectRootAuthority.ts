import { spawnSync } from "node:child_process";
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

export type ConnectAuthorityEntryKind = "ancestor" | "root" | "data" | "env";

export interface WindowsAclRuleInspection {
  readonly identitySid: string;
  readonly inherited: boolean;
  readonly accessType: "allow" | "deny";
  /** Canonical base-10 representation of the unsigned 32-bit access mask. */
  readonly rights: string;
}

export interface WindowsAuthorityInspection {
  readonly currentUserSid: string;
  readonly ownerSid: string;
  readonly daclProtected: boolean;
  readonly reparsePoint: boolean;
  readonly rules: readonly WindowsAclRuleInspection[];
}

export interface ConnectRootAuthorityInspector {
  inspectDarwinAcl(path: string): string;
  inspectWindowsAcl(path: string): WindowsAuthorityInspection;
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
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$item = Get-Item -LiteralPath $target -Force
$acl = Get-Acl -LiteralPath $target
$owner = $acl.Owner
try { $owner = ([System.Security.Principal.NTAccount]$owner).Translate([System.Security.Principal.SecurityIdentifier]).Value } catch {
  try { $owner = ([System.Security.Principal.SecurityIdentifier]$owner).Value } catch { throw }
}
$rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]) | ForEach-Object {
  $mask = [uint32]([int64]$_.FileSystemRights -band 0xffffffffL)
  [ordered]@{
    identitySid = $_.IdentityReference.Value
    inherited = [bool]$_.IsInherited
    accessType = if ($_.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow) { 'allow' } else { 'deny' }
    rights = $mask.ToString([Globalization.CultureInfo]::InvariantCulture)
  }
})
[ordered]@{
  currentUserSid = $identity
  ownerSid = $owner
  daclProtected = [bool]$acl.AreAccessRulesProtected
  reparsePoint = [bool](($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0)
  rules = $rules
} | ConvertTo-Json -Compress -Depth 4
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
    ...process.env,
    PROPR_NATIVE_AUTHORITY_TARGET: path,
    ...(kind === undefined ? {} : { PROPR_NATIVE_AUTHORITY_KIND: kind }),
  };
}

function nativeDarwinAcl(path: string): string {
  const result = spawnSync("/bin/ls", ["-lde", path], {
    shell: false,
    windowsHide: true,
    encoding: "buffer",
    maxBuffer: NATIVE_INSPECTION_MAX_BYTES,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0 || result.error || result.signal) {
    throw new Error("Darwin ACL authority inspection is unavailable");
  }
  return decodeBoundedUtf8(result.stdout);
}

function nativeWindowsAcl(path: string): WindowsAuthorityInspection {
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
    || !exactKeys(value, ["currentUserSid", "ownerSid", "daclProtected", "reparsePoint", "rules"])
  ) throw new Error("Windows ACL authority inspection was malformed");
  const record = value as Record<string, unknown>;
  if (
    typeof record.currentUserSid !== "string"
    || !WINDOWS_SID.test(record.currentUserSid)
    || typeof record.ownerSid !== "string"
    || !WINDOWS_SID.test(record.ownerSid)
    || typeof record.daclProtected !== "boolean"
    || typeof record.reparsePoint !== "boolean"
    || !Array.isArray(record.rules)
    || record.rules.length > 256
  ) throw new Error("Windows ACL authority inspection was malformed");
  for (const rule of record.rules) {
    if (
      !rule
      || typeof rule !== "object"
      || Array.isArray(rule)
      || !exactKeys(rule, ["identitySid", "inherited", "accessType", "rights"])
    ) throw new Error("Windows ACL authority inspection was malformed");
    const item = rule as Record<string, unknown>;
    if (
      typeof item.identitySid !== "string"
      || !WINDOWS_SID.test(item.identitySid)
      || typeof item.inherited !== "boolean"
      || (item.accessType !== "allow" && item.accessType !== "deny")
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
  if (
    (terminal && inspection.ownerSid !== inspection.currentUserSid)
    || (!terminal && !trustedOwners.has(inspection.ownerSid))
    || (terminal && !inspection.daclProtected)
    || inspection.reparsePoint
  ) throw new Error("Windows root authority is unsafe");

  for (const rule of inspection.rules) {
    if (rule.accessType !== "allow") continue;
    const rights = BigInt(rule.rights);
    if ((rights & ~WINDOWS_KNOWN_ALLOW_RIGHTS) !== 0n) {
      throw new Error("Windows root authority has an unknown grant");
    }
    const mutates = (rights & (WINDOWS_MUTATING_RIGHTS | WINDOWS_GENERIC_MUTATING_RIGHTS)) !== 0n;
    if (!mutates) continue;
    if (rule.inherited || !trustedOwners.has(rule.identitySid)) {
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
): void {
  if (platform === "darwin") {
    assertSafeDarwinAclOutput(inspector.inspectDarwinAcl(path));
  } else if (platform === "win32") {
    assertSafeWindowsAuthority(inspector.inspectWindowsAcl(path), kind);
  }
}
