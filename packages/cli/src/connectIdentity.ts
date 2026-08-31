import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  linkSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  unlinkSync,
} from "node:fs";
import type { Stats } from "node:fs";
import { basename, dirname, join, parse, resolve, sep } from "node:path";
import { userInfo } from "node:os";
import {
  getOrCreatePublicInstanceIdentityPinned,
  readPublicInstanceIdentityPinned,
  type PinnedPublicIdentityDirectory,
} from "@propr/local-setup";
import {
  directoryDescriptorAccess,
  mkdirAt,
  lstatAt,
  openAt,
  renameAt,
  unlinkAt,
} from "./utils/directoryDescriptor.js";
import {
  assertNativeEntryAuthority,
  assertNativeWindowsEntriesAuthority,
  nativeConnectRootAuthorityInspector,
  WindowsAuthorityInspectionError,
  WindowsAuthorityPolicyError,
  type ConnectAuthorityEntryKind,
  type ConnectRootAuthorityInspector,
} from "./connectRootAuthority.js";
import { canonicalRootKey } from "./config/rootKey.js";

const MAX_ENV_FILE_BYTES = 1024 * 1024;
const MAX_CONNECT_CONFIG_BYTES = 1024 * 1024;

export class ConnectRootError extends Error {
  constructor(readonly reason = "INVALID_ROOT") {
    super(`the explicit stack root is unavailable or is not owned by the caller [reason=${reason}]`);
    this.name = "ConnectRootError";
  }
}

export class PublicInstanceIdentityError extends Error {
  constructor() {
    super("the public instance identity is unavailable or invalid");
    this.name = "PublicInstanceIdentityError";
  }
}

export class TrustedConnectConfigError extends Error {
  constructor(readonly reason = "UNSAFE_CONFIG") {
    super(`the persisted Connect configuration is unavailable or unsafe [reason=${reason}]`);
    this.name = "TrustedConnectConfigError";
  }
}

export interface TrustedConnectConfigOptions {
  platform?: NodeJS.Platform;
  authorityInspector?: ConnectRootAuthorityInspector;
  /** Explicit only for deterministic/native tests; production uses OS userInfo. */
  trustedHome?: string;
  onBoundary?: (boundary:
    | "home-before-open"
    | "home-opened"
    | "config-directory-before-open"
    | "config-directory-opened"
    | "config-before-open"
    | "config-opened"
    | "config-read"
  ) => void | Promise<void>;
}

export type ConnectRootSnapshotBoundary = "acquired" | "env-read" | "before-identity" | "identity-read";

export interface ConnectRootSnapshot {
  /** Parsed bytes from the held, identity-checked .env file. */
  readonly envFileValues: Readonly<Record<string, string>>;
  readonly identityDirectory: PinnedPublicIdentityDirectory;
  /** Original caller input key; never treated as authority or reopened here. */
  readonly requestedRoot: string;
  readonly authorityDiagnostic: "verified";
}

export interface ConnectRootSnapshotOptions {
  platform?: NodeJS.Platform;
  /** Structured native authority source; deterministic fixtures use this same policy path. */
  authorityInspector?: ConnectRootAuthorityInspector;
  onBoundary?: (boundary: ConnectRootSnapshotBoundary) => void | Promise<void>;
  parseEnvFile?: (contents: string) => Record<string, string>;
}

interface HeldDirectory {
  fd: number;
  visiblePath: string;
  openChild(name: string, flags: number, mode?: number): number;
}

interface AcquiredRoot {
  root: HeldDirectory;
  ancestry: Array<{ path: string; stat: Stats; fd: number }>;
}

class ConnectSnapshotOperationError extends Error {
  constructor(readonly operationCause: unknown) {
    super("Connect snapshot operation failed");
  }
}

type IdentityValue = number | bigint | string;

function exactIdentityValue(value: IdentityValue): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) throw new ConnectRootError();
    return BigInt(value);
  }
  if (!/^(?:0|[1-9]\d{0,19})$/.test(value)) throw new ConnectRootError();
  return BigInt(value);
}

function sameIdentity(
  left: { readonly dev?: IdentityValue; readonly ino?: IdentityValue; readonly device?: IdentityValue; readonly file?: IdentityValue },
  right: { readonly dev?: IdentityValue; readonly ino?: IdentityValue; readonly device?: IdentityValue; readonly file?: IdentityValue },
): boolean {
  const leftDevice = left.device ?? left.dev;
  const leftFile = left.file ?? left.ino;
  const rightDevice = right.device ?? right.dev;
  const rightFile = right.file ?? right.ino;
  if (leftDevice === undefined || leftFile === undefined || rightDevice === undefined || rightFile === undefined) {
    throw new ConnectRootError();
  }
  return exactIdentityValue(leftDevice) === exactIdentityValue(rightDevice)
    && exactIdentityValue(leftFile) === exactIdentityValue(rightFile);
}

function descriptorRoot(): string {
  const root = "/proc/self/fd";
  if (!lstatSync(root).isDirectory()) throw new ConnectRootError();
  return root;
}

function heldDirectory(fd: number, platform: NodeJS.Platform, visiblePath: string): HeldDirectory {
  if (platform === "linux") {
    const path = join(descriptorRoot(), String(fd));
    return {
      fd,
      visiblePath,
      openChild: (name, flags, mode = 0) => openSync(join(path, name), flags, mode),
    };
  }
  if (platform === "darwin") {
    return {
      fd,
      visiblePath,
      openChild: (name, flags, mode = 0) => openAt(fd, name, flags, mode),
    };
  }
  if (platform === "win32") {
    return {
      fd,
      visiblePath,
      openChild: (name, flags, mode = 0) => openSync(join(visiblePath, name), flags, mode),
    };
  }
  throw new ConnectRootError();
}

function assertSafeAncestry(ancestry: Stats[], callerUid: number): void {
  for (const stat of ancestry) {
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new ConnectRootError();
    if (stat.uid !== 0 && stat.uid !== callerUid) throw new ConnectRootError();
    const writableByOthers = (stat.mode & 0o022) !== 0;
    const sticky = (stat.mode & 0o1000) !== 0;
    if (writableByOthers && !sticky) throw new ConnectRootError();
  }
}

function assertPrivateRoot(stat: Stats, callerUid: number | undefined, platform: NodeJS.Platform): void {
  if (
    !stat.isDirectory()
    || stat.isSymbolicLink()
    || (platform !== "win32" && (stat.uid !== callerUid || (stat.mode & 0o022) !== 0))
  ) {
    throw new ConnectRootError();
  }
}

function assertPrivateData(stat: Stats, callerUid: number | undefined, platform: NodeJS.Platform): void {
  if (
    !stat.isDirectory()
    || stat.isSymbolicLink()
    || (platform !== "win32" && (stat.uid !== callerUid || (stat.mode & 0o777) !== 0o700))
  ) throw new ConnectRootError();
}

function assertPrivateEnv(stat: Stats, callerUid: number | undefined, platform: NodeJS.Platform): void {
  if (
    !stat.isFile()
    || stat.isSymbolicLink()
    || stat.nlink !== 1
    || (platform !== "win32" && (stat.uid !== callerUid || (stat.mode & 0o777) !== 0o600))
    || stat.size > MAX_ENV_FILE_BYTES
  ) throw new ConnectRootError();
}

function openRootNoFollow(rootDir: string, platform: NodeJS.Platform): AcquiredRoot {
  if (platform !== "win32") directoryDescriptorAccess(platform);
  const flags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
  const parsed = parse(rootDir);
  let fd = openSync(parsed.root, flags);
  const ancestry: Array<{ path: string; stat: Stats; fd: number }> = [];
  let visible = parsed.root;
  try {
    for (const component of rootDir.slice(parsed.root.length).split(sep).filter(Boolean)) {
      const current = heldDirectory(fd, platform, visible);
      const next = current.openChild(component, flags);
      if (visible === parsed.root) closeSync(fd);
      fd = next;
      visible = join(visible, component);
      const named = lstatSync(visible);
      const pinned = fstatSync(fd);
      if (named.isSymbolicLink() || !sameIdentity(named, pinned)) throw new ConnectRootError();
      ancestry.push({ path: visible, stat: named, fd });
    }
    return { root: heldDirectory(fd, platform, visible), ancestry };
  } catch (error) {
    for (const descriptor of new Set([fd, ...ancestry.map((entry) => entry.fd)])) {
      try { closeSync(descriptor); } catch { /* Preserve the authority error. */ }
    }
    throw error;
  }
}

function closeAcquired(acquired: AcquiredRoot): void {
  for (const descriptor of new Set([acquired.root.fd, ...acquired.ancestry.map((entry) => entry.fd)])) closeSync(descriptor);
}

function closeAcquiredAncestors(acquired: AcquiredRoot): void {
  for (const entry of acquired.ancestry.slice(0, -1)) closeSync(entry.fd);
}

function readHeldEnv(fd: number, platform: NodeJS.Platform): string {
  const before = fstatSync(fd);
  if (before.size < 0 || before.size > MAX_ENV_FILE_BYTES) throw new ConnectRootError();
  const bytes = Buffer.allocUnsafe(MAX_ENV_FILE_BYTES + 1);
  let length = 0;
  while (length < bytes.byteLength) {
    const count = readSync(fd, bytes, length, bytes.byteLength - length, null);
    if (count === 0) break;
    length += count;
  }
  const after = fstatSync(fd);
  assertPrivateEnv(after, before.uid, platform);
  if (
    !sameIdentity(before, after)
    || before.size !== after.size
    || length !== before.size
    || length > MAX_ENV_FILE_BYTES
  ) {
    throw new ConnectRootError();
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length));
  } catch {
    throw new ConnectRootError();
  }
}

function readBoundedPrivateFile(fd: number, maximum: number, validate: (stat: Stats) => void): string {
  const before = fstatSync(fd);
  validate(before);
  if (before.size <= 0 || before.size > maximum) throw new TrustedConnectConfigError();
  const bytes = Buffer.allocUnsafe(maximum + 1);
  let length = 0;
  while (length < bytes.byteLength) {
    const count = readSync(fd, bytes, length, bytes.byteLength - length, null);
    if (count === 0) break;
    length += count;
  }
  const after = fstatSync(fd);
  validate(after);
  if (!sameIdentity(before, after) || before.size !== after.size || length !== before.size || length > maximum) {
    throw new TrustedConnectConfigError();
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length));
  } catch {
    throw new TrustedConnectConfigError();
  }
}

function parseTrustedTunnelOverride(contents: string, requestedRoot: string, platform: NodeJS.Platform): boolean | undefined {
  let parsed: unknown;
  try { parsed = JSON.parse(contents); } catch { throw new TrustedConnectConfigError(); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new TrustedConnectConfigError();
  const data = parsed as Record<string, unknown>;
  const states = new Map<string, boolean>();
  if (data.tunnelEnabledByRoot !== undefined) {
    if (!data.tunnelEnabledByRoot || typeof data.tunnelEnabledByRoot !== "object" || Array.isArray(data.tunnelEnabledByRoot)) {
      throw new TrustedConnectConfigError();
    }
    for (const [root, enabled] of Object.entries(data.tunnelEnabledByRoot as Record<string, unknown>)) {
      if (typeof enabled !== "boolean") throw new TrustedConnectConfigError();
      let key: string;
      try { key = canonicalRootKey(root, platform); } catch { throw new TrustedConnectConfigError(); }
      const existing = states.get(key);
      if (existing !== undefined && existing !== enabled) throw new TrustedConnectConfigError();
      states.set(key, enabled);
    }
  }
  if (data.tunnelEnabled !== undefined) {
    if (typeof data.tunnelEnabled !== "boolean" || typeof data.stackRoot !== "string") {
      throw new TrustedConnectConfigError();
    }
    let legacyKey: string;
    try { legacyKey = canonicalRootKey(data.stackRoot, platform); } catch { throw new TrustedConnectConfigError(); }
    const existing = states.get(legacyKey);
    if (existing !== undefined && existing !== data.tunnelEnabled) throw new TrustedConnectConfigError();
    if (existing === undefined) states.set(legacyKey, data.tunnelEnabled);
  }
  let requestedKey: string;
  try { requestedKey = canonicalRootKey(requestedRoot, platform); } catch { throw new TrustedConnectConfigError(); }
  return states.get(requestedKey);
}

/**
 * Read only the root-specific tunnel intent from an OS-selected home. The
 * directory and file stay pinned throughout a bounded synchronous read; no
 * ambient HOME/cwd, profile, token, or unrelated setting is consumed.
 */
export async function readTrustedConnectTunnelOverride(
  requestedRoot: string,
  options: TrustedConnectConfigOptions = {},
): Promise<boolean | undefined> {
  const platform = options.platform ?? process.platform;
  const ioPlatform = platform === process.platform ? platform : process.platform;
  if (
    (platform !== "linux" && platform !== "darwin" && platform !== "win32")
    || (ioPlatform !== "linux" && ioPlatform !== "darwin" && ioPlatform !== "win32")
  ) throw new TrustedConnectConfigError();
  const inspector = options.authorityInspector ?? nativeConnectRootAuthorityInspector;
  const callerUid = process.getuid?.();
  const homePath = resolve(options.trustedHome ?? userInfo().homedir);
  let home: AcquiredRoot | undefined;
  let homeAncestorsClosed = false;
  let configDir: HeldDirectory | undefined;
  let configFd: number | undefined;
  try {
    if (!sameResolvedPath(realpathSync.native(homePath), homePath, platform)) {
      throw new TrustedConnectConfigError("REPARSE_POINT");
    }
    const namedHomeBefore = lstatSync(homePath);
    if (namedHomeBefore.isSymbolicLink()) throw new TrustedConnectConfigError("REPARSE_POINT");
    await options.onBoundary?.("home-before-open");
    home = openRootNoFollow(homePath, ioPlatform);
    await options.onBoundary?.("home-opened");
    if (!sameIdentity(namedHomeBefore, fstatSync(home.root.fd))) throw new TrustedConnectConfigError();
    if (platform !== "win32") {
      await assertTrustedHomeAuthority(home, platform, inspector, callerUid);
      closeAcquiredAncestors(home);
      homeAncestorsClosed = true;
    }
    assertPrivateRoot(fstatSync(home.root.fd), callerUid, platform);
    const verifyNamedHome = () => {
      const held = fstatSync(home!.root.fd);
      const named = lstatSync(homePath);
      if (named.isSymbolicLink() || !sameIdentity(named, held)) throw new TrustedConnectConfigError();
      return held;
    };

    verifyNamedHome();
    const namedConfigDirectoryBefore = lstatSync(join(homePath, ".propr"));
    if (namedConfigDirectoryBefore.isSymbolicLink()) {
      throw new TrustedConnectConfigError("CONFIG_DIRECTORY_REPARSE");
    }
    await options.onBoundary?.("config-directory-before-open");
    const configDirectoryFd = home.root.openChild(
      ".propr",
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    configDir = heldDirectory(configDirectoryFd, ioPlatform, join(homePath, ".propr"));
    await options.onBoundary?.("config-directory-opened");
    verifyNamedHome();
    if (!sameIdentity(namedConfigDirectoryBefore, fstatSync(configDir.fd))) throw new TrustedConnectConfigError();
    const directoryStat = fstatSync(configDir.fd);
    assertPrivateData(directoryStat, callerUid, platform);
    assertNamedEntry(homePath, ".propr", directoryStat);
    if (platform === "darwin") await authorityEntry(inspector, platform, configDir.visiblePath, "data", configDir.fd);
    const verifyNamedConfigDirectory = () => {
      verifyNamedHome();
      const held = fstatSync(configDir!.fd);
      assertNamedEntry(homePath, ".propr", held);
      return held;
    };

    verifyNamedConfigDirectory();
    let namedConfigBefore: ReturnType<typeof lstatSync> | undefined;
    try {
      namedConfigBefore = lstatSync(join(configDir.visiblePath, "config.json"));
      if (namedConfigBefore.isSymbolicLink()) throw new TrustedConnectConfigError();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      // Do not decide absence from this precheck. Only the anchored child open
      // below can authenticate an absent config entry.
      verifyNamedConfigDirectory();
    }
    await options.onBoundary?.("config-before-open");
    try {
      configFd = configDir.openChild("config.json", constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        // Absence is authoritative only for this exact child-open failure, and
        // only while the already-held/named parent still denotes one object.
        verifyNamedConfigDirectory();
        if (namedConfigBefore !== undefined) throw new TrustedConnectConfigError();
        if (platform === "win32") {
          await authorityEntries(inspector, [
            ...home.ancestry.slice(0, -1).map((entry) => ({
              path: entry.path, kind: "ancestor" as const, pinnedFd: entry.fd,
            })),
            { path: home.root.visiblePath, kind: "home", pinnedFd: home.root.fd },
            { path: configDir.visiblePath, kind: "data", pinnedFd: configDir.fd },
          ]);
          closeAcquiredAncestors(home);
          homeAncestorsClosed = true;
        }
        return undefined;
      }
      throw error;
    }
    verifyNamedConfigDirectory();
    if (namedConfigBefore === undefined || !sameIdentity(namedConfigBefore, fstatSync(configFd))) {
      throw new TrustedConnectConfigError();
    }
    const validateConfig = (stat: Stats) => {
      if (
        !stat.isFile()
        || stat.isSymbolicLink()
        || stat.nlink !== 1
        || (platform !== "win32" && (stat.uid !== callerUid || (stat.mode & 0o777) !== 0o600))
      ) throw new TrustedConnectConfigError();
    };
    validateConfig(fstatSync(configFd));
    assertNamedEntry(configDir.visiblePath, "config.json", fstatSync(configFd));
    if (platform === "darwin") {
      await authorityEntry(inspector, platform, join(configDir.visiblePath, "config.json"), "env", configFd);
    } else if (platform === "win32") {
      await authorityEntries(inspector, [
        ...home.ancestry.slice(0, -1).map((entry) => ({
          path: entry.path, kind: "ancestor" as const, pinnedFd: entry.fd,
        })),
        { path: home.root.visiblePath, kind: "home", pinnedFd: home.root.fd },
        { path: configDir.visiblePath, kind: "data", pinnedFd: configDir.fd },
        { path: join(configDir.visiblePath, "config.json"), kind: "env", pinnedFd: configFd },
      ]);
      closeAcquiredAncestors(home);
      homeAncestorsClosed = true;
    }
    verifyNamedConfigDirectory();
    await options.onBoundary?.("config-opened");
    const contents = readBoundedPrivateFile(configFd, MAX_CONNECT_CONFIG_BYTES, validateConfig);
    await options.onBoundary?.("config-read");

    const fileAfter = fstatSync(configFd);
    assertNamedEntry(configDir.visiblePath, "config.json", fileAfter);
    const directoryAfter = fstatSync(configDir.fd);
    assertPrivateData(directoryAfter, callerUid, platform);
    assertNamedEntry(homePath, ".propr", directoryAfter);
    const homeAfter = fstatSync(home.root.fd);
    assertPrivateRoot(homeAfter, callerUid, platform);
    const namedHome = lstatSync(homePath);
    if (namedHome.isSymbolicLink() || !sameIdentity(namedHome, homeAfter)) throw new TrustedConnectConfigError();
    if (platform === "darwin") {
      await authorityEntry(inspector, platform, configDir.visiblePath, "data", configDir.fd);
      await authorityEntry(inspector, platform, join(configDir.visiblePath, "config.json"), "env", configFd);
    } else if (platform === "win32") {
      await authorityEntries(inspector, [
        { path: home.root.visiblePath, kind: "home", pinnedFd: home.root.fd },
        { path: configDir.visiblePath, kind: "data", pinnedFd: configDir.fd },
        { path: join(configDir.visiblePath, "config.json"), kind: "env", pinnedFd: configFd },
      ]);
    }
    return parseTrustedTunnelOverride(contents, requestedRoot, platform);
  } catch (error) {
    if (error instanceof TrustedConnectConfigError) throw error;
    if (error instanceof WindowsAuthorityPolicyError) {
      throw new TrustedConnectConfigError(`NATIVE_ENTRY_${error.entryIndex}_${error.policyReason}`);
    }
    if (error instanceof ConnectRootError) throw new TrustedConnectConfigError(error.reason);
    throw new TrustedConnectConfigError();
  } finally {
    if (configFd !== undefined) closeSync(configFd);
    if (configDir !== undefined) closeSync(configDir.fd);
    if (home !== undefined) {
      if (!homeAncestorsClosed) closeAcquiredAncestors(home);
      closeSync(home.root.fd);
    }
  }
}

async function authorityEntry(
  inspector: ConnectRootAuthorityInspector,
  platform: NodeJS.Platform,
  path: string,
  kind: ConnectAuthorityEntryKind,
  pinnedFd: number,
): Promise<void> {
  try {
    await assertNativeEntryAuthority(inspector, platform, path, kind, pinnedFd);
  } catch (error) {
    if (error instanceof WindowsAuthorityInspectionError) throw error;
    if (error instanceof WindowsAuthorityPolicyError) throw error;
    throw new ConnectRootError();
  }
}

async function authorityEntries(
  inspector: ConnectRootAuthorityInspector,
  entries: readonly { path: string; kind: ConnectAuthorityEntryKind; pinnedFd: number }[],
): Promise<void> {
  await assertNativeWindowsEntriesAuthority(inspector, entries);
}

async function assertPlatformAuthority(
  acquired: AcquiredRoot,
  platform: NodeJS.Platform,
  inspector: ConnectRootAuthorityInspector,
  callerUid: number | undefined,
): Promise<void> {
  if (platform === "win32") {
    await authorityEntries(inspector, [
      ...acquired.ancestry.slice(0, -1).map((entry) => ({
        path: entry.path, kind: "ancestor" as const, pinnedFd: entry.fd,
      })),
      { path: acquired.root.visiblePath, kind: "root", pinnedFd: acquired.root.fd },
    ]);
    return;
  }
  if (callerUid === undefined) throw new ConnectRootError();
  assertSafeAncestry(acquired.ancestry.slice(0, -1).map((entry) => entry.stat), callerUid);
  assertPrivateRoot(fstatSync(acquired.root.fd), callerUid, platform);
  if (platform === "darwin") {
    for (const entry of acquired.ancestry.slice(0, -1)) {
      await authorityEntry(inspector, platform, entry.path, "ancestor", entry.fd);
    }
    await authorityEntry(inspector, platform, acquired.root.visiblePath, "root", acquired.root.fd);
  }
}

async function assertTrustedHomeAuthority(
  acquired: AcquiredRoot,
  platform: NodeJS.Platform,
  inspector: ConnectRootAuthorityInspector,
  callerUid: number | undefined,
): Promise<void> {
  if (platform === "win32") {
    await authorityEntries(inspector, [
      ...acquired.ancestry.slice(0, -1).map((entry) => ({
        path: entry.path, kind: "ancestor" as const, pinnedFd: entry.fd,
      })),
      { path: acquired.root.visiblePath, kind: "home", pinnedFd: acquired.root.fd },
    ]);
    return;
  }
  if (callerUid === undefined) throw new TrustedConnectConfigError();
  assertSafeAncestry(acquired.ancestry.slice(0, -1).map((entry) => entry.stat), callerUid);
  assertPrivateRoot(fstatSync(acquired.root.fd), callerUid, platform);
  if (platform === "darwin") {
    for (const entry of acquired.ancestry.slice(0, -1)) {
      await authorityEntry(inspector, platform, entry.path, "ancestor", entry.fd);
    }
    await authorityEntry(inspector, platform, acquired.root.visiblePath, "home", acquired.root.fd);
  }
}

function sameResolvedPath(left: string, right: string, platform: NodeJS.Platform): boolean {
  return platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function assertNamedEntry(rootDir: string, name: string, held: Stats): void {
  const named = lstatSync(join(rootDir, name));
  if (named.isSymbolicLink() || !sameIdentity(named, held)) throw new ConnectRootError("NAMED_REPLACED");
}

function identifyHeldChild(directory: HeldDirectory, platform: NodeJS.Platform, name: string) {
  if (platform === "darwin") {
    const stat = lstatAt(directory.fd, name);
    return {
      device: exactIdentityValue(stat.dev).toString(10),
      file: exactIdentityValue(stat.ino).toString(10),
      kind: stat.kind,
    };
  }
  const stat = lstatSync(platform === "linux"
    ? join(descriptorRoot(), String(directory.fd), name)
    : join(directory.visiblePath, name), { bigint: true });
  return {
    device: stat.dev.toString(10),
    file: stat.ino.toString(10),
    kind: stat.isFile()
      ? "file" as const
      : stat.isDirectory()
        ? "directory" as const
        : stat.isSymbolicLink()
          ? "symbolic-link" as const
          : "other" as const,
  };
}

/**
 * Run all root-dependent work inside one descriptor-anchored snapshot.
 * No trusted pathname escapes the callback, and every named identity is checked again.
 */
export async function withOwnedConnectRootSnapshot<T>(
  flagRoot: string | undefined,
  operation: (snapshot: ConnectRootSnapshot) => T | Promise<T>,
  options: ConnectRootSnapshotOptions,
): Promise<T> {
  if (!flagRoot || !options.parseEnvFile) throw new ConnectRootError();
  const platform = options.platform ?? process.platform;
  if (platform !== "linux" && platform !== "darwin" && platform !== "win32") throw new ConnectRootError();
  const ioPlatform = platform === process.platform
    ? platform
    : (process.platform === "linux" || process.platform === "darwin") && options.authorityInspector
      ? process.platform
      : undefined;
  if (!ioPlatform) throw new ConnectRootError();
  const inspector = options.authorityInspector ?? nativeConnectRootAuthorityInspector;
  const callerUid = process.getuid?.();
  if (platform !== "win32" && callerUid === undefined) throw new ConnectRootError();
  const requestedRoot = resolve(flagRoot);
  try {
    if (!sameResolvedPath(realpathSync.native(requestedRoot), requestedRoot, platform)) {
      throw new ConnectRootError("REPARSE_POINT");
    }
  } catch (error) {
    if (error instanceof ConnectRootError) throw error;
    throw new ConnectRootError("REALPATH_UNAVAILABLE");
  }

  let root: HeldDirectory | undefined;
  let data: HeldDirectory | undefined;
  let envFd: number | undefined;
  let acquiredRoot: AcquiredRoot | undefined;
  let acquiredAncestorsClosed = false;
  try {
    const acquired = openRootNoFollow(requestedRoot, ioPlatform);
    acquiredRoot = acquired;
    root = acquired.root;
    if (platform !== "win32") {
      await assertPlatformAuthority(acquired, platform, inspector, callerUid);
      closeAcquiredAncestors(acquired);
      acquiredAncestorsClosed = true;
    }
    assertPrivateRoot(fstatSync(root.fd), callerUid, platform);

    const directoryFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
    const verifyNamedRoot = () => {
      const held = fstatSync(root!.fd);
      const named = lstatSync(requestedRoot);
      if (named.isSymbolicLink() || !sameIdentity(named, held)) throw new ConnectRootError();
      return held;
    };
    verifyNamedRoot();
    const dataFd = root.openChild("data", directoryFlags);
    data = heldDirectory(dataFd, ioPlatform, join(requestedRoot, "data"));
    verifyNamedRoot();
    const initialDataStat = fstatSync(data.fd);
    assertPrivateData(initialDataStat, callerUid, platform);
    assertNamedEntry(requestedRoot, "data", initialDataStat);
    if (platform === "darwin") await authorityEntry(inspector, platform, data.visiblePath, "data", data.fd);
    verifyNamedRoot();
    envFd = root.openChild(".env", constants.O_RDONLY | constants.O_NOFOLLOW);
    verifyNamedRoot();
    const initialEnvStat = fstatSync(envFd);
    assertPrivateEnv(initialEnvStat, callerUid, platform);
    assertNamedEntry(requestedRoot, ".env", initialEnvStat);
    if (platform === "darwin") {
      await authorityEntry(inspector, platform, join(requestedRoot, ".env"), "env", envFd);
    } else if (platform === "win32") {
      await authorityEntries(inspector, [
        ...acquired.ancestry.slice(0, -1).map((entry) => ({
          path: entry.path, kind: "ancestor" as const, pinnedFd: entry.fd,
        })),
        { path: root.visiblePath, kind: "root", pinnedFd: root.fd },
        { path: data.visiblePath, kind: "data", pinnedFd: data.fd },
        { path: join(requestedRoot, ".env"), kind: "env", pinnedFd: envFd },
      ]);
      closeAcquiredAncestors(acquired);
      acquiredAncestorsClosed = true;
    }
    await options.onBoundary?.("acquired");

    const envFileValues = options.parseEnvFile(readHeldEnv(envFd, platform));
    await options.onBoundary?.("env-read");
    const verifyNamedData = (): Stats => {
      const held = fstatSync(data!.fd);
      assertPrivateData(held, callerUid, platform);
      // Unix child operations remain anchored to the held descriptor even if
      // the visible name is concurrently replaced; final revalidation rejects
      // the snapshot. Windows child operations are pathname-based and must
      // therefore prove the visible data identity before every use.
      if (platform === "win32") {
        assertNamedEntry(requestedRoot, "data", held);
      }
      return held;
    };
    const identityDirectory: PinnedPublicIdentityDirectory = {
      fd: data.fd,
      ownerUid: initialDataStat.uid,
      open: (name, flags, mode = 0) => {
        verifyNamedData();
        const childFd = data!.openChild(name, flags, mode);
        if (platform === "win32") {
          try {
            verifyNamedData();
            const child = fstatSync(childFd);
            const named = lstatSync(join(data!.visiblePath, name));
            if (named.isSymbolicLink() || !sameIdentity(named, child)) throw new ConnectRootError();
            verifyNamedData();
          } catch (error) {
            closeSync(childFd);
            throw error;
          }
        }
        return childFd;
      },
      identify: (name) => {
        verifyNamedData();
        const identity = identifyHeldChild(data!, ioPlatform, name);
        verifyNamedData();
        return identity;
      },
      validateEntry: async (name, fd) => {
        const entryPath = join(data!.visiblePath, name);
        if (platform !== "linux") {
          await authorityEntry(inspector, platform, entryPath, "env", fd);
        }
      },
      publishNoReplace: (oldName, newName) => {
        verifyNamedData();
        if (platform === "win32") {
          linkSync(join(data!.visiblePath, oldName), join(data!.visiblePath, newName));
          unlinkSync(join(data!.visiblePath, oldName));
        } else {
          renameAt(data!.fd, oldName, newName);
        }
        verifyNamedData();
      },
      unlink: (name) => {
        verifyNamedData();
        if (platform === "win32") unlinkSync(join(data!.visiblePath, name));
        else unlinkAt(data!.fd, name);
        verifyNamedData();
      },
    };

    let result: T | undefined;
    let operationError: unknown;
    try {
      result = await operation({
        envFileValues,
        identityDirectory,
        requestedRoot,
        authorityDiagnostic: "verified",
      });
    } catch (error) {
      operationError = error;
    }
    const namedRoot = lstatSync(requestedRoot);
    const heldRootStat = fstatSync(root.fd);
    if (namedRoot.isSymbolicLink() || !sameIdentity(namedRoot, heldRootStat)) throw new ConnectRootError();
    assertPrivateRoot(heldRootStat, callerUid, platform);
    const heldDataStat = fstatSync(data.fd);
    const heldEnvStat = fstatSync(envFd);
    assertPrivateData(heldDataStat, callerUid, platform);
    assertPrivateEnv(heldEnvStat, callerUid, platform);
    assertNamedEntry(requestedRoot, "data", heldDataStat);
    assertNamedEntry(requestedRoot, ".env", heldEnvStat);
    if (platform === "darwin") {
      await authorityEntry(inspector, platform, data.visiblePath, "data", data.fd);
      await authorityEntry(inspector, platform, join(requestedRoot, ".env"), "env", envFd);
    }
    const reacquired = openRootNoFollow(requestedRoot, ioPlatform);
    try {
      const before = acquired.ancestry;
      const after = reacquired.ancestry;
      if (
        before.length !== after.length
        || before.some((entry, index) => !sameIdentity(entry.stat, after[index].stat))
      ) throw new ConnectRootError();
      if (platform === "win32") {
        await authorityEntries(inspector, [
          ...reacquired.ancestry.slice(0, -1).map((entry) => ({
            path: entry.path, kind: "ancestor" as const, pinnedFd: entry.fd,
          })),
          { path: reacquired.root.visiblePath, kind: "root", pinnedFd: reacquired.root.fd },
          { path: data.visiblePath, kind: "data", pinnedFd: data.fd },
          { path: join(requestedRoot, ".env"), kind: "env", pinnedFd: envFd },
        ]);
      } else {
        await assertPlatformAuthority(reacquired, platform, inspector, callerUid);
      }
    } finally {
      closeAcquired(reacquired);
    }
    if (operationError !== undefined) throw new ConnectSnapshotOperationError(operationError);
    return result as T;
  } catch (error) {
    if (error instanceof ConnectSnapshotOperationError) throw error.operationCause;
    if (error instanceof PublicInstanceIdentityError) throw error;
    if (error instanceof WindowsAuthorityInspectionError) throw error;
    if (error instanceof ConnectRootError) throw error;
    if (error instanceof WindowsAuthorityPolicyError) {
      throw new ConnectRootError(`NATIVE_ENTRY_${error.entryIndex}_${error.policyReason}`);
    }
    throw new ConnectRootError();
  } finally {
    if (acquiredRoot !== undefined && !acquiredAncestorsClosed) closeAcquiredAncestors(acquiredRoot);
    if (envFd !== undefined) closeSync(envFd);
    if (data !== undefined) closeSync(data.fd);
    if (root !== undefined) closeSync(root.fd);
  }
}

/** Host-side access used by stack initialization outside the Connect snapshot. */
export async function getOrCreatePublicInstanceIdentity(
  dataDir: string,
  generate: () => string = randomUUID,
): Promise<string> {
  const platform = process.platform;
  const requestedDataPath = resolve(dataDir);
  const dataPath = platform === "win32" ? realpathSync.native(requestedDataPath) : requestedDataPath;
  if (platform === "win32") {
    let held: HeldDirectory | undefined;
    try {
      const acquired = openRootNoFollow(dataPath, platform);
      held = acquired.root;
      // Windows stack initialization and configuration persistence predate
      // Connect discovery. Keep this mutation path independent from the
      // read-only DACL diagnostic that is deferred to #1997.
      closeAcquiredAncestors(acquired);
      const terminal = fstatSync(held.fd);
      assertPrivateData(terminal, undefined, platform);
      const verifyVisible = () => {
        const visible = lstatSync(dataPath);
        const pinned = fstatSync(held!.fd);
        if (visible.isSymbolicLink() || !sameIdentity(visible, pinned)) throw new PublicInstanceIdentityError();
        assertPrivateData(pinned, undefined, platform);
      };
      const directory: PinnedPublicIdentityDirectory = {
        fd: held.fd,
        ownerUid: terminal.uid,
        open: (name, flags, mode = 0) => {
          verifyVisible();
          const fd = held!.openChild(name, flags, mode);
          try {
            verifyVisible();
            const opened = fstatSync(fd);
            const named = lstatSync(join(dataPath, name));
            if (named.isSymbolicLink() || !sameIdentity(opened, named)) throw new PublicInstanceIdentityError();
            verifyVisible();
            return fd;
          } catch (error) {
            closeSync(fd);
            throw error;
          }
        },
        identify: (name) => {
          verifyVisible();
          const identity = identifyHeldChild(held!, platform, name);
          verifyVisible();
          return identity;
        },
        validateEntry: () => undefined,
        publishNoReplace: (oldName, newName) => {
          verifyVisible();
          linkSync(join(dataPath, oldName), join(dataPath, newName));
          unlinkSync(join(dataPath, oldName));
          verifyVisible();
        },
        unlink: (name) => {
          verifyVisible();
          unlinkSync(join(dataPath, name));
          verifyVisible();
        },
      };
      const identity = await getOrCreatePublicInstanceIdentityPinned(directory, { generate, role: "host" });
      verifyVisible();
      return identity;
    } catch (error) {
      if (error instanceof PublicInstanceIdentityError) throw error;
      throw new PublicInstanceIdentityError();
    } finally {
      if (held !== undefined) closeSync(held.fd);
    }
  }
  if (platform !== "linux" && platform !== "darwin") throw new PublicInstanceIdentityError();
  let held: HeldDirectory | undefined;
  try {
    try {
      lstatSync(dataPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parentPath = dirname(dataPath);
      if (realpathSync.native(parentPath) !== parentPath) throw new PublicInstanceIdentityError();
      const callerUid = process.getuid?.();
      if (callerUid === undefined) throw new PublicInstanceIdentityError();
      const acquiredParent = openRootNoFollow(parentPath, platform);
      try {
        try {
          await assertPlatformAuthority(acquiredParent, platform, nativeConnectRootAuthorityInspector, callerUid);
        } finally {
          closeAcquiredAncestors(acquiredParent);
        }
        assertPrivateRoot(fstatSync(acquiredParent.root.fd), callerUid, platform);
        try {
          mkdirAt(acquiredParent.root.fd, basename(dataPath), 0o700);
        } catch (mkdirError) {
          if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") throw mkdirError;
        }
        const createdFd = acquiredParent.root.openChild(
          basename(dataPath),
          constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
        );
        try {
          fchmodSync(createdFd, 0o700);
        } finally {
          closeSync(createdFd);
        }
      } finally {
        closeSync(acquiredParent.root.fd);
      }
    }
    if (realpathSync.native(dataPath) !== dataPath) throw new PublicInstanceIdentityError();
    const callerUid = process.getuid?.();
    if (callerUid === undefined) throw new PublicInstanceIdentityError();
    const acquired = openRootNoFollow(dataPath, platform);
    held = acquired.root;
    try {
      await assertPlatformAuthority(acquired, platform, nativeConnectRootAuthorityInspector, callerUid);
    } finally {
      closeAcquiredAncestors(acquired);
    }
    assertPrivateData(fstatSync(held.fd), callerUid, platform);
    const directory: PinnedPublicIdentityDirectory = {
      fd: held.fd,
      ownerUid: callerUid,
      open: (name, flags, mode = 0) => held!.openChild(name, flags, mode),
      identify: (name) => identifyHeldChild(held!, platform, name),
      validateEntry: async (name, fd) => {
        if (platform === "darwin") {
          await authorityEntry(nativeConnectRootAuthorityInspector, platform, join(dataPath, name), "env", fd);
        }
      },
      publishNoReplace: (oldName, newName) => renameAt(held!.fd, oldName, newName),
      unlink: (name) => unlinkAt(held!.fd, name),
    };
    const identity = await getOrCreatePublicInstanceIdentityPinned(directory, { generate, role: "host" });
    const named = lstatSync(dataPath);
    const pinned = fstatSync(held.fd);
    if (named.isSymbolicLink() || !sameIdentity(named, pinned)) throw new PublicInstanceIdentityError();
    assertPrivateData(pinned, callerUid, platform);
    return identity;
  } catch (error) {
    if (error instanceof PublicInstanceIdentityError) throw error;
    throw new PublicInstanceIdentityError();
  } finally {
    if (held !== undefined) closeSync(held.fd);
  }
}

export async function getOrCreateSnapshotPublicInstanceIdentity(
  directory: PinnedPublicIdentityDirectory,
  generate: () => string = randomUUID,
): Promise<string> {
  try {
    return await getOrCreatePublicInstanceIdentityPinned(directory, { generate, role: "host" });
  } catch (error) {
    if (error instanceof WindowsAuthorityInspectionError) throw error;
    if (error instanceof PublicInstanceIdentityError) throw error;
    throw new PublicInstanceIdentityError();
  }
}

export async function readSnapshotPublicInstanceIdentity(
  directory: PinnedPublicIdentityDirectory,
): Promise<string> {
  try {
    return await readPublicInstanceIdentityPinned(directory);
  } catch (error) {
    if (error instanceof WindowsAuthorityInspectionError) throw error;
    if (error instanceof PublicInstanceIdentityError) throw error;
    throw new PublicInstanceIdentityError();
  }
}
