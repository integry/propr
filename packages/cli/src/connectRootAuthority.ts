import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fsyncSync,
  fstatSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readSync,
  rmSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseWindowsInspectionDocument,
  reportWindowsNativeStage,
  runWindowsReadOnlyInspection,
  WindowsNativeStageError,
  windowsInspectionEntryKind,
} from "./connectWindowsAuthority.js";
import {
  assertCanonicalNativeArtifactParents,
  physicalNativeArtifactCandidate,
} from "./utils/nativeArtifact.js";

const NATIVE_INSPECTION_MAX_BYTES = 128 * 1024;
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
const WINDOWS_AUTHORITY_MAX_ENTRIES = 32;
const WINDOWS_AUTHORITY_MAX_ACES_PER_ENTRY = 128;
const WINDOWS_AUTHORITY_MAX_TOTAL_ACES = 512;

export const WINDOWS_AUTHORITY_REQUIRED_CODE = "WINDOWS_AUTHORITY_REQUIRED" as const;

/**
 * Windows mutation/protection is intentionally deferred to #1997. Callers must
 * surface this result; there is no package broker, service, elevation, or
 * best-effort fallback in this discovery-only change.
 */
export class WindowsAuthorityRequiredError extends Error {
  readonly code = WINDOWS_AUTHORITY_REQUIRED_CODE;

  constructor() {
    super("Windows authority is required for this operation and is not available yet; use discovery-only status or retry after #1997 lands");
    this.name = "WindowsAuthorityRequiredError";
  }
}

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
  readonly index: number;
  readonly kind: "directory" | "file";
  readonly authorityKind: ConnectAuthorityEntryKind;
  readonly currentUserSid: string;
  readonly ownerSid: string;
  readonly daclProtected: boolean;
  readonly reparsePoint: boolean;
  readonly volumeSerialNumber: string;
  readonly fileId: string;
  readonly verifiedVolumeSerialNumber: string;
  readonly verifiedFileId: string;
  readonly rules: readonly WindowsAclRuleInspection[];
}

export interface DarwinAuthorityInspection {
  readonly version: 1;
  readonly device: string;
  readonly file: string;
  readonly acl: string;
}

export interface StableAuthorityIdentity {
  readonly device: string;
  readonly file: string;
}

export interface WindowsAuthorityTarget {
  readonly path: string;
  readonly kind: ConnectAuthorityEntryKind;
  readonly expectedIdentity: StableAuthorityIdentity;
  readonly pinnedFd: number;
}

export interface ConnectRootAuthorityInspector {
  inspectDarwinAcl(
    path: string,
    pinnedFd: number,
    expectedIdentity: StableAuthorityIdentity,
  ): DarwinAuthorityInspection;
  inspectWindowsAcl(
    path: string,
    expectedIdentity: StableAuthorityIdentity,
    pinnedFd?: number,
    kind?: ConnectAuthorityEntryKind,
  ): Promise<WindowsAuthorityInspection>;
  inspectWindowsAcls?(entries: readonly WindowsAuthorityTarget[]): Promise<readonly WindowsAuthorityInspection[]>;
}

export type WindowsAuthorityPolicyReason =
  | "OWNER_MISMATCH"
  | "DACL_NOT_PROTECTED"
  | "REPARSE_POINT"
  | "UNKNOWN_RIGHTS"
  | "BROAD_WRITE"
  | "INHERITED_WRITE";

/** Redacted policy diagnostic used by deterministic authority fixtures. */
export class WindowsAuthorityPolicyError extends Error {
  constructor(
    readonly entryIndex: number,
    readonly policyReason: WindowsAuthorityPolicyReason,
  ) {
    super(`Windows native authority rejected entry ${entryIndex}: ${policyReason}`);
    this.name = "WindowsAuthorityPolicyError";
  }
}

/** Fixed, redacted boundary for a failed read-only Windows ACL inspection. */
export class WindowsAuthorityInspectionError extends Error {
  constructor() {
    super("Windows ACL authority inspection is unavailable");
    this.name = "WindowsAuthorityInspectionError";
  }
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

const DARWIN_AUTHORITY_BROKER_SHA256: Readonly<Record<string, string>> = {
  arm64: "75fda2624bf093555e726b968401321fef61ea7ae0479f4c1892be0dfc6554c0",
  x64: "e5a49be0db85655b9ff1d0614de9d61defd41a0a1b2eff8f11571407f10d809b",
};

function readExactDescriptor(fd: number, size: number): Buffer {
  if (!Number.isSafeInteger(size) || size <= 0 || size > 512 * 1024) {
    throw new Error("packaged native authority broker failed integrity verification");
  }
  const bytes = Buffer.allocUnsafe(size);
  let offset = 0;
  while (offset < size) {
    const count = readSync(fd, bytes, offset, size - offset, offset);
    if (count <= 0) throw new Error("packaged native authority broker failed integrity verification");
    offset += count;
  }
  return bytes;
}

function darwinAuthorityBrokerArtifact(): {
  path: string;
  fd: number;
  identity: StableAuthorityIdentity;
  digest: string;
  bytes: Buffer;
} {
  const expected = DARWIN_AUTHORITY_BROKER_SHA256[process.arch];
  if (!expected) throw new Error(`native authority inspection is not packaged for darwin-${process.arch}`);
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const relative = join("prebuilds", `darwin-${process.arch}`, "connect-authority-broker");
  const candidates = [
    join(moduleDirectory, "native", relative),
    join(moduleDirectory, "..", "native", relative),
    join(moduleDirectory, "..", "..", "native", relative),
  ].map(physicalNativeArtifactCandidate);
  for (const path of candidates) {
    let fd: number | undefined;
    try {
      assertCanonicalNativeArtifactParents(path);
      fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = fstatSync(fd, { bigint: true });
      const named = lstatSync(path, { bigint: true });
      if (
        !stat.isFile()
        || named.isSymbolicLink()
        || stat.dev !== named.dev
        || stat.ino !== named.ino
        || stat.size <= 0n
        || stat.size > BigInt(512 * 1024)
        || (typeof process.getuid === "function" && stat.uid !== 0n && stat.uid !== BigInt(process.getuid()))
        || (stat.mode & 0o022n) !== 0n
        || (stat.mode & 0o111n) === 0n
      ) {
        closeSync(fd);
        fd = undefined;
        continue;
      }
      const bytes = readExactDescriptor(fd, Number(stat.size));
      const digest = createHash("sha256").update(bytes).digest("hex");
      if (digest !== expected) throw new Error("packaged native authority broker failed integrity verification");
      return {
        path,
        fd,
        identity: { device: stat.dev.toString(10), file: stat.ino.toString(10) },
        digest,
        bytes,
      };
    } catch (error) {
      if (fd !== undefined) closeSync(fd);
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  throw new Error(`packaged native authority broker is missing for darwin-${process.arch}`);
}

function revalidateDarwinAuthorityBroker(
  artifact: { fd: number; identity: StableAuthorityIdentity; digest: string; bytes: Buffer },
): void {
  const stat = fstatSync(artifact.fd, { bigint: true });
  if (
    !stat.isFile()
    || stat.dev.toString(10) !== artifact.identity.device
    || stat.ino.toString(10) !== artifact.identity.file
    || Number(stat.size) !== artifact.bytes.byteLength
    || createHash("sha256").update(readExactDescriptor(artifact.fd, artifact.bytes.byteLength)).digest("hex") !== artifact.digest
  ) throw new Error("packaged native authority broker was replaced");
}

function stageDarwinAuthorityBroker(artifact: ReturnType<typeof darwinAuthorityBrokerArtifact>): {
  path: string;
  fd: number;
  directory: string;
} {
  const directory = mkdtempSync(join(tmpdir(), "propr-authority-capability-"));
  try {
    chmodSync(directory, 0o700);
    const path = join(directory, `broker-${randomUUID()}`);
    const writableFd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR, 0o500);
    try {
      let offset = 0;
      while (offset < artifact.bytes.byteLength) {
        const count = writeSync(writableFd, artifact.bytes, offset, artifact.bytes.byteLength - offset, offset);
        if (count <= 0) throw new Error("Darwin ACL authority inspection is unavailable");
        offset += count;
      }
      fsyncSync(writableFd);
      fchmodSync(writableFd, 0o500);
      const staged = fstatSync(writableFd, { bigint: true });
      if (!staged.isFile() || staged.size !== BigInt(artifact.bytes.byteLength)) {
        throw new Error("Darwin ACL authority inspection is unavailable");
      }
      closeSync(writableFd);
      const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const readable = fstatSync(fd, { bigint: true });
      if (readable.dev !== staged.dev || readable.ino !== staged.ino) {
        closeSync(fd);
        throw new Error("Darwin ACL authority inspection is unavailable");
      }
      return { path, fd, directory };
    } catch (error) {
      try { closeSync(writableFd); } catch { /* It was closed before the read-only reopen. */ }
      throw error;
    }
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

function exactKeys(value: object, expected: readonly string[]): boolean {
  return Object.keys(value).sort().join(",") === [...expected].sort().join(",");
}

function canonicalUint64(value: unknown): value is string {
  return typeof value === "string"
    && /^(?:0|[1-9]\d{0,19})$/.test(value)
    && BigInt(value) <= 0xffffffffffffffffn;
}

function assertDarwinInspectionShape(value: unknown): asserts value is DarwinAuthorityInspection {
  if (
    !value
    || typeof value !== "object"
    || Array.isArray(value)
    || !exactKeys(value, ["version", "device", "file", "acl"])
  ) throw new Error("Darwin ACL authority inspection was malformed");
  const record = value as Record<string, unknown>;
  if (
    record.version !== 1
    || !canonicalUint64(record.device)
    || !canonicalUint64(record.file)
    || typeof record.acl !== "string"
    || Buffer.byteLength(record.acl, "utf8") > 24 * 1024
  ) throw new Error("Darwin ACL authority inspection was malformed");
}

function nativeDarwinAcl(
  _path: string,
  pinnedFd: number,
  _expectedIdentity: StableAuthorityIdentity,
): DarwinAuthorityInspection {
  if (!Number.isInteger(pinnedFd) || pinnedFd < 0) throw new Error("Darwin ACL authority inspection is unavailable");
  const artifact = darwinAuthorityBrokerArtifact();
  let capability: ReturnType<typeof stageDarwinAuthorityBroker>;
  try {
    capability = stageDarwinAuthorityBroker(artifact);
  } catch (error) {
    closeSync(artifact.fd);
    throw error;
  }
  let result: ReturnType<typeof spawnSync>;
  try {
    result = spawnSync(capability.path, [], {
      shell: false,
      windowsHide: true,
      encoding: "buffer",
      env: {},
      timeout: 5000,
      maxBuffer: NATIVE_INSPECTION_MAX_BYTES,
      stdio: ["ignore", "pipe", "pipe", pinnedFd],
    });
    const staged = fstatSync(capability.fd, { bigint: true });
    if (
      !staged.isFile()
      || staged.size !== BigInt(artifact.bytes.byteLength)
      || createHash("sha256").update(readExactDescriptor(capability.fd, artifact.bytes.byteLength)).digest("hex") !== artifact.digest
    ) throw new Error("packaged native authority broker was replaced");
    revalidateDarwinAuthorityBroker(artifact);
  } finally {
    closeSync(capability.fd);
    rmSync(capability.directory, { recursive: true, force: true });
    closeSync(artifact.fd);
  }
  if (result.status !== 0 || result.error || result.signal || decodeBoundedUtf8(result.stderr).length !== 0) {
    throw new Error("Darwin ACL authority inspection is unavailable");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeBoundedUtf8(result.stdout).trim());
  } catch {
    throw new Error("Darwin ACL authority inspection was malformed");
  }
  assertDarwinInspectionShape(parsed);
  return parsed;
}

async function nativeWindowsAcls(
  entries: readonly WindowsAuthorityTarget[],
): Promise<readonly WindowsAuthorityInspection[]> {
  try {
    return runWindowsReadOnlyInspection(entries);
  } catch (error) {
    if (error instanceof WindowsNativeStageError) reportWindowsNativeStage(error.stage);
    throw new WindowsAuthorityInspectionError();
  }
}

async function nativeWindowsAcl(
  path: string,
  expectedIdentity: StableAuthorityIdentity,
  pinnedFd?: number,
  kind: ConnectAuthorityEntryKind = "root",
): Promise<WindowsAuthorityInspection> {
  if (pinnedFd === undefined) throw new WindowsAuthorityInspectionError();
  const inspections = await nativeWindowsAcls([{ path, expectedIdentity, pinnedFd, kind }]);
  if (inspections.length !== 1) {
    reportWindowsNativeStage("parent:entry-count");
    throw new WindowsAuthorityInspectionError();
  }
  return inspections[0];
}

export const nativeConnectRootAuthorityInspector: ConnectRootAuthorityInspector = {
  inspectDarwinAcl: nativeDarwinAcl,
  inspectWindowsAcl: nativeWindowsAcl,
  inspectWindowsAcls: nativeWindowsAcls,
};

/** Windows mutation is unsupported until the separately reviewed authority work lands. */
export async function protectWindowsSetupEntry(_path: string, _kind: "directory" | "file"): Promise<void> {
  if (process.platform === "win32") throw new WindowsAuthorityRequiredError();
}

/** Windows mutation is unsupported until the separately reviewed authority work lands. */
export async function protectWindowsSetupEntries(
  entries: readonly { readonly path: string; readonly kind: "directory" | "file" }[],
): Promise<void> {
  if (process.platform === "win32" && entries.length > 0) throw new WindowsAuthorityRequiredError();
}

export function assertWindowsInspectionShape(value: unknown): asserts value is WindowsAuthorityInspection {
  if (
    !value
    || typeof value !== "object"
    || Array.isArray(value)
    || !exactKeys(value, [
      "index", "kind", "authorityKind", "currentUserSid", "ownerSid", "daclProtected", "reparsePoint",
      "volumeSerialNumber", "fileId", "verifiedVolumeSerialNumber", "verifiedFileId", "rules",
    ])
  ) throw new Error("Windows ACL authority inspection was malformed");
  const record = value as Record<string, unknown>;
  if (
    !Number.isInteger(record.index)
    || (record.index as number) < 0
    || (record.index as number) >= WINDOWS_AUTHORITY_MAX_ENTRIES
    || (record.kind !== "directory" && record.kind !== "file")
    || !["ancestor", "home", "root", "data", "env"].includes(record.authorityKind as string)
    || typeof record.currentUserSid !== "string" || !WINDOWS_SID.test(record.currentUserSid)
    || typeof record.ownerSid !== "string" || !WINDOWS_SID.test(record.ownerSid)
    || typeof record.daclProtected !== "boolean"
    || typeof record.reparsePoint !== "boolean"
    || !canonicalUint64(record.volumeSerialNumber)
    || typeof record.fileId !== "string" || !/^(?:0|[1-9]\d{0,38})$/.test(record.fileId)
    || BigInt(record.fileId) > 0xffffffffffffffffffffffffffffffffn
    || !canonicalUint64(record.verifiedVolumeSerialNumber)
    || typeof record.verifiedFileId !== "string" || !/^(?:0|[1-9]\d{0,38})$/.test(record.verifiedFileId)
    || BigInt(record.verifiedFileId) > 0xffffffffffffffffffffffffffffffffn
    || !Array.isArray(record.rules) || record.rules.length > WINDOWS_AUTHORITY_MAX_ACES_PER_ENTRY
  ) throw new Error("Windows ACL authority inspection was malformed");
  for (const rule of record.rules) {
    if (
      !rule || typeof rule !== "object" || Array.isArray(rule)
      || !exactKeys(rule, ["identitySid", "inherited", "accessType", "appliesToSelf", "rights"])
    ) throw new Error("Windows ACL authority inspection was malformed");
    const item = rule as Record<string, unknown>;
    if (
      typeof item.identitySid !== "string" || !WINDOWS_SID.test(item.identitySid)
      || typeof item.inherited !== "boolean"
      || (item.accessType !== "allow" && item.accessType !== "deny")
      || typeof item.appliesToSelf !== "boolean"
      || typeof item.rights !== "string" || !/^(?:0|[1-9]\d{0,9})$/.test(item.rights)
      || BigInt(item.rights) > 0xffffffffn
    ) throw new Error("Windows ACL authority inspection was malformed");
  }
}

/** Apply the fail-closed policy to deterministic Windows ACL fixtures. */
export function assertSafeWindowsAuthority(
  inspection: WindowsAuthorityInspection,
  kind: ConnectAuthorityEntryKind,
): void {
  assertWindowsInspectionShape(inspection);
  const protectedEntry = kind === "root" || kind === "data" || kind === "env";
  const trustedOwner = WINDOWS_TRUSTED_MUTATORS.has(inspection.ownerSid)
    || inspection.ownerSid === "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464";
  if (inspection.ownerSid !== inspection.currentUserSid
    && !((kind === "ancestor" || kind === "home") && trustedOwner)) {
    throw new WindowsAuthorityPolicyError(inspection.index, "OWNER_MISMATCH");
  }
  if (inspection.reparsePoint) throw new WindowsAuthorityPolicyError(inspection.index, "REPARSE_POINT");
  for (const rule of inspection.rules) {
    const rights = BigInt(rule.rights);
    if ((rights & ~WINDOWS_KNOWN_ALLOW_RIGHTS) !== 0n) {
      throw new WindowsAuthorityPolicyError(inspection.index, "UNKNOWN_RIGHTS");
    }
    if (rule.accessType !== "allow" || !rule.appliesToSelf) continue;
    const mutating = (rights & (WINDOWS_MUTATING_RIGHTS | WINDOWS_GENERIC_MUTATING_RIGHTS)) !== 0n;
    if (!mutating) continue;
    if (rule.identitySid !== inspection.currentUserSid && !WINDOWS_TRUSTED_MUTATORS.has(rule.identitySid)) {
      throw new WindowsAuthorityPolicyError(inspection.index, "BROAD_WRITE");
    }
    if (rule.inherited && protectedEntry) {
      throw new WindowsAuthorityPolicyError(inspection.index, "INHERITED_WRITE");
    }
  }
  if (protectedEntry && !inspection.daclProtected) {
    throw new WindowsAuthorityPolicyError(inspection.index, "DACL_NOT_PROTECTED");
  }
}

const DARWIN_READ_ONLY_ACL_PERMISSIONS = new Set([
  "execute", "list", "read", "readattr", "readextattr", "readsecurity", "search", "synchronize",
]);
const DARWIN_MUTATING_ACL_PERMISSIONS = new Set([
  "write", "append", "delete", "delete_child", "add_file", "add_subdirectory",
  "writeattr", "writeextattr", "writesecurity", "chown",
]);
const DARWIN_ACL_FLAGS = new Set(["directory_inherit", "file_inherit", "inherited", "limit_inherit", "only_inherit"]);

/** Reject malformed ACL output and every ACL allow entry carrying mutation authority. */
export function assertSafeDarwinAclOutput(output: string): void {
  if (!output || Buffer.byteLength(output, "utf8") > 24 * 1024 || output.includes("\0")) {
    throw new Error("Darwin ACL authority inspection was malformed");
  }
  const lines = output.replace(/\n$/, "").split("\n");
  if (!/^!#acl 1(?: (?:defer_inherit|no_inherit)(?:,(?:defer_inherit|no_inherit))*)?$/.test(lines[0])) {
    throw new Error("Darwin ACL authority inspection was malformed");
  }
  for (const line of lines.slice(1)) {
    const fields = line.split(":");
    if (
      fields.length !== 6
      || (fields[0] !== "user" && fields[0] !== "group")
      || !/^[0-9A-F]{8}(?:-[0-9A-F]{4}){3}-[0-9A-F]{12}$/.test(fields[1])
      || fields[2].length > 255
      || !/^(?:|0|[1-9]\d{0,9})$/.test(fields[3])
    ) throw new Error("Darwin ACL authority inspection was malformed");
    const disposition = fields[4].split(",");
    if (disposition[0] !== "allow" && disposition[0] !== "deny") {
      throw new Error("Darwin ACL authority inspection was malformed");
    }
    if (disposition.slice(1).some((flag) => !DARWIN_ACL_FLAGS.has(flag))) {
      throw new Error("Darwin ACL authority inspection was malformed");
    }
    for (const permission of fields[5].split(",")) {
      if (disposition[0] === "allow" && DARWIN_MUTATING_ACL_PERMISSIONS.has(permission)) {
        throw new Error("Darwin ACL grants unexpected write authority");
      }
      if (!DARWIN_READ_ONLY_ACL_PERMISSIONS.has(permission) && !DARWIN_MUTATING_ACL_PERMISSIONS.has(permission)) {
        throw new Error("Darwin ACL authority inspection was malformed");
      }
    }
  }
}

export async function assertNativeEntryAuthority(
  inspector: ConnectRootAuthorityInspector,
  platform: NodeJS.Platform,
  path: string,
  kind: ConnectAuthorityEntryKind,
  pinnedFd: number,
): Promise<void> {
  const before = stableAuthorityIdentity(pinnedFd);
  if (platform === "darwin") {
    const inspection = inspector.inspectDarwinAcl(path, pinnedFd, before);
    assertDarwinInspectionShape(inspection);
    if (inspection.device !== before.device || inspection.file !== before.file) {
      throw new Error("Darwin authority inspection did not match the pinned object");
    }
    assertSafeDarwinAclOutput(inspection.acl);
  } else if (platform === "win32") {
    const inspection = await inspector.inspectWindowsAcl(path, before, pinnedFd, kind);
    try {
      assertWindowsInspectionShape(inspection);
    } catch {
      reportWindowsNativeStage("parent:entry-shape");
      throw new WindowsAuthorityInspectionError();
    }
    try {
      if (
        inspection.index !== 0
        || inspection.authorityKind !== kind
        || inspection.kind !== windowsInspectionEntryKind(kind)
        || inspection.currentUserSid.length === 0
        || BigInt(inspection.volumeSerialNumber) !== BigInt(before.device)
        || BigInt(inspection.fileId) !== BigInt(before.file)
        || BigInt(inspection.volumeSerialNumber) !== BigInt(inspection.verifiedVolumeSerialNumber)
        || BigInt(inspection.fileId) !== BigInt(inspection.verifiedFileId)
      ) throw new Error();
    } catch {
      throw new WindowsAuthorityInspectionError();
    }
    assertSafeWindowsAuthority(inspection, kind);
  }
  const after = stableAuthorityIdentity(pinnedFd);
  if (before.device !== after.device || before.file !== after.file) {
    throw new Error("native authority target changed during inspection");
  }
}

/** Inspect and bind one Windows descriptor batch before applying entry policy. */
export async function assertNativeWindowsEntriesAuthority(
  inspector: ConnectRootAuthorityInspector,
  entries: readonly { path: string; kind: ConnectAuthorityEntryKind; pinnedFd: number }[],
): Promise<void> {
  const targets = entries.map((entry) => ({
    path: entry.path,
    kind: entry.kind,
    expectedIdentity: stableAuthorityIdentity(entry.pinnedFd),
    pinnedFd: entry.pinnedFd,
  }));
  const batched = inspector.inspectWindowsAcls !== undefined;
  const inspections = inspector.inspectWindowsAcls
    ? await inspector.inspectWindowsAcls(targets)
    : await Promise.all(targets.map((target) => inspector.inspectWindowsAcl(
      target.path, target.expectedIdentity, target.pinnedFd, target.kind,
    )));
  if (inspections.length !== targets.length) {
    reportWindowsNativeStage("parent:entry-count");
    throw new WindowsAuthorityInspectionError();
  }
  for (let index = 0; index < targets.length; index += 1) {
    const after = stableAuthorityIdentity(entries[index].pinnedFd);
    if (after.device !== targets[index].expectedIdentity.device || after.file !== targets[index].expectedIdentity.file) {
      reportWindowsNativeStage("parent:post-bind");
      throw new WindowsAuthorityInspectionError();
    }
  }
  let currentUserSid: string | undefined;
  let totalAces = 0;
  for (let index = 0; index < targets.length; index += 1) {
    const target = targets[index];
    const inspection = inspections[index];
    try {
      assertWindowsInspectionShape(inspection);
    } catch {
      reportWindowsNativeStage("parent:entry-shape");
      throw new WindowsAuthorityInspectionError();
    }
    try {
      totalAces += inspection.rules.length;
      if (
        inspection.index !== (batched ? index : 0)
        || inspection.authorityKind !== target.kind
        || inspection.kind !== windowsInspectionEntryKind(target.kind)
        || (currentUserSid !== undefined && inspection.currentUserSid !== currentUserSid)
        || BigInt(inspection.volumeSerialNumber) !== BigInt(target.expectedIdentity.device)
        || BigInt(inspection.fileId) !== BigInt(target.expectedIdentity.file)
        || BigInt(inspection.volumeSerialNumber) !== BigInt(inspection.verifiedVolumeSerialNumber)
        || BigInt(inspection.fileId) !== BigInt(inspection.verifiedFileId)
        || totalAces > WINDOWS_AUTHORITY_MAX_TOTAL_ACES
      ) throw new Error();
      currentUserSid = inspection.currentUserSid;
    } catch {
      reportWindowsNativeStage("parent:descriptor-bind");
      throw new WindowsAuthorityInspectionError();
    }
    assertSafeWindowsAuthority(inspection, target.kind);
  }
}

export { parseWindowsInspectionDocument };
