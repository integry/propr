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
import {
  getOrCreatePublicInstanceIdentityPinned,
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
  nativeConnectRootAuthorityInspector,
  type ConnectAuthorityEntryKind,
  type ConnectRootAuthorityInspector,
} from "./connectRootAuthority.js";

const MAX_ENV_FILE_BYTES = 1024 * 1024;

export class ConnectRootError extends Error {
  constructor() {
    super("the explicit stack root is unavailable or is not owned by the caller");
    this.name = "ConnectRootError";
  }
}

export class PublicInstanceIdentityError extends Error {
  constructor() {
    super("the public instance identity is unavailable or invalid");
    this.name = "PublicInstanceIdentityError";
  }
}

export type ConnectRootSnapshotBoundary = "acquired" | "env-read" | "before-identity" | "identity-read";

export interface ConnectRootSnapshot {
  /** Parsed bytes from the held, identity-checked .env file. */
  readonly envFileValues: Readonly<Record<string, string>>;
  readonly identityDirectory: PinnedPublicIdentityDirectory;
  /** Original caller input key; never treated as authority or reopened here. */
  readonly requestedRoot: string;
}

export interface ConnectRootSnapshotOptions {
  platform?: NodeJS.Platform;
  /** Structured native authority source; deterministic fixtures use this same policy path. */
  authorityInspector?: ConnectRootAuthorityInspector;
  onBoundary?: (boundary: ConnectRootSnapshotBoundary) => void;
  parseEnvFile?: (contents: string) => Record<string, string>;
}

interface HeldDirectory {
  fd: number;
  visiblePath: string;
  openChild(name: string, flags: number, mode?: number): number;
}

interface AcquiredRoot {
  root: HeldDirectory;
  ancestry: Array<{ path: string; stat: Stats }>;
}

class ConnectSnapshotOperationError extends Error {
  constructor(readonly operationCause: unknown) {
    super("Connect snapshot operation failed");
  }
}

function sameIdentity(left: Pick<Stats, "dev" | "ino">, right: Pick<Stats, "dev" | "ino">): boolean {
  return left.dev === right.dev && left.ino === right.ino;
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
  const ancestry: Array<{ path: string; stat: Stats }> = [];
  let visible = parsed.root;
  try {
    for (const component of rootDir.slice(parsed.root.length).split(sep).filter(Boolean)) {
      const current = heldDirectory(fd, platform, visible);
      const next = current.openChild(component, flags);
      closeSync(fd);
      fd = next;
      visible = join(visible, component);
      const named = lstatSync(visible);
      const pinned = fstatSync(fd);
      if (named.isSymbolicLink() || !sameIdentity(named, pinned)) throw new ConnectRootError();
      ancestry.push({ path: visible, stat: named });
    }
    return { root: heldDirectory(fd, platform, visible), ancestry };
  } catch (error) {
    closeSync(fd);
    throw error;
  }
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

function authorityEntry(
  inspector: ConnectRootAuthorityInspector,
  platform: NodeJS.Platform,
  path: string,
  kind: ConnectAuthorityEntryKind,
): void {
  try {
    assertNativeEntryAuthority(inspector, platform, path, kind);
  } catch {
    throw new ConnectRootError();
  }
}

function assertPlatformAuthority(
  acquired: AcquiredRoot,
  platform: NodeJS.Platform,
  inspector: ConnectRootAuthorityInspector,
  callerUid: number | undefined,
): void {
  if (platform === "win32") {
    for (const entry of acquired.ancestry.slice(0, -1)) {
      authorityEntry(inspector, platform, entry.path, "ancestor");
    }
    authorityEntry(inspector, platform, acquired.root.visiblePath, "root");
    return;
  }
  if (callerUid === undefined) throw new ConnectRootError();
  assertSafeAncestry(acquired.ancestry.slice(0, -1).map((entry) => entry.stat), callerUid);
  assertPrivateRoot(fstatSync(acquired.root.fd), callerUid, platform);
  if (platform === "darwin") {
    for (const entry of acquired.ancestry.slice(0, -1)) {
      authorityEntry(inspector, platform, entry.path, "ancestor");
    }
    authorityEntry(inspector, platform, acquired.root.visiblePath, "root");
  }
}

function sameResolvedPath(left: string, right: string, platform: NodeJS.Platform): boolean {
  return platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function assertNamedEntry(rootDir: string, name: string, held: Stats): void {
  const named = lstatSync(join(rootDir, name));
  if (named.isSymbolicLink() || !sameIdentity(named, held)) throw new ConnectRootError();
}

function identifyHeldChild(directory: HeldDirectory, platform: NodeJS.Platform, name: string) {
  if (platform === "darwin") return lstatAt(directory.fd, name);
  const stat = lstatSync(platform === "linux"
    ? join(descriptorRoot(), String(directory.fd), name)
    : join(directory.visiblePath, name));
  return {
    dev: stat.dev,
    ino: stat.ino,
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
 * Run all root-dependent work inside one synchronous, descriptor-anchored snapshot.
 * No trusted pathname escapes the callback, and every named identity is checked again.
 */
export function withOwnedConnectRootSnapshot<T>(
  flagRoot: string | undefined,
  operation: (snapshot: ConnectRootSnapshot) => T,
  options: ConnectRootSnapshotOptions,
): T {
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
    if (!sameResolvedPath(realpathSync.native(requestedRoot), requestedRoot, platform)) throw new ConnectRootError();
  } catch {
    throw new ConnectRootError();
  }

  let root: HeldDirectory | undefined;
  let data: HeldDirectory | undefined;
  let envFd: number | undefined;
  try {
    const acquired = openRootNoFollow(requestedRoot, ioPlatform);
    root = acquired.root;
    assertPlatformAuthority(acquired, platform, inspector, callerUid);
    assertPrivateRoot(fstatSync(root.fd), callerUid, platform);

    const directoryFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
    const dataFd = root.openChild("data", directoryFlags);
    data = heldDirectory(dataFd, ioPlatform, join(requestedRoot, "data"));
    const initialDataStat = fstatSync(data.fd);
    assertPrivateData(initialDataStat, callerUid, platform);
    assertNamedEntry(requestedRoot, "data", initialDataStat);
    if (platform !== "linux") authorityEntry(inspector, platform, data.visiblePath, "data");
    envFd = root.openChild(".env", constants.O_RDONLY | constants.O_NOFOLLOW);
    const initialEnvStat = fstatSync(envFd);
    assertPrivateEnv(initialEnvStat, callerUid, platform);
    assertNamedEntry(requestedRoot, ".env", initialEnvStat);
    if (platform !== "linux") authorityEntry(inspector, platform, join(requestedRoot, ".env"), "env");
    options.onBoundary?.("acquired");

    const envFileValues = options.parseEnvFile(readHeldEnv(envFd, platform));
    options.onBoundary?.("env-read");
    const verifyNamedData = (): Stats => {
      const held = fstatSync(data!.fd);
      assertPrivateData(held, callerUid, platform);
      // Unix child operations remain anchored to the held descriptor even if
      // the visible name is concurrently replaced; final revalidation rejects
      // the snapshot. Windows child operations are pathname-based and must
      // therefore prove the visible data identity before every use.
      if (platform === "win32") {
        assertNamedEntry(requestedRoot, "data", held);
        authorityEntry(inspector, platform, data!.visiblePath, "data");
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
            const child = fstatSync(childFd);
            const named = lstatSync(join(data!.visiblePath, name));
            if (named.isSymbolicLink() || !sameIdentity(named, child)) throw new ConnectRootError();
          } catch (error) {
            closeSync(childFd);
            throw error;
          }
        }
        return childFd;
      },
      identify: (name) => identifyHeldChild(data!, ioPlatform, name),
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
      result = operation({
        envFileValues,
        identityDirectory,
        requestedRoot,
      });
    } catch (error) {
      operationError = error;
    }
    if (result && typeof (result as { then?: unknown }).then === "function") throw new ConnectRootError();

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
    if (platform !== "linux") {
      authorityEntry(inspector, platform, data.visiblePath, "data");
      authorityEntry(inspector, platform, join(requestedRoot, ".env"), "env");
    }
    const reacquired = openRootNoFollow(requestedRoot, ioPlatform);
    try {
      const before = acquired.ancestry;
      const after = reacquired.ancestry;
      if (
        before.length !== after.length
        || before.some((entry, index) => !sameIdentity(entry.stat, after[index].stat))
      ) throw new ConnectRootError();
      assertPlatformAuthority(reacquired, platform, inspector, callerUid);
    } finally {
      closeSync(reacquired.root.fd);
    }
    if (operationError !== undefined) throw new ConnectSnapshotOperationError(operationError);
    return result as T;
  } catch (error) {
    if (error instanceof ConnectSnapshotOperationError) throw error.operationCause;
    if (error instanceof PublicInstanceIdentityError) throw error;
    if (error instanceof ConnectRootError) throw error;
    throw new ConnectRootError();
  } finally {
    if (envFd !== undefined) closeSync(envFd);
    if (data !== undefined) closeSync(data.fd);
    if (root !== undefined) closeSync(root.fd);
  }
}

/** Host-side access used by stack initialization outside the Connect snapshot. */
export function getOrCreatePublicInstanceIdentity(
  dataDir: string,
  generate: () => string = randomUUID,
): string {
  const dataPath = resolve(dataDir);
  const platform = process.platform;
  if (platform === "win32") {
    let held: HeldDirectory | undefined;
    try {
      if (!sameResolvedPath(realpathSync.native(dataPath), dataPath, platform)) {
        throw new PublicInstanceIdentityError();
      }
      const acquired = openRootNoFollow(dataPath, platform);
      held = acquired.root;
      assertPlatformAuthority(acquired, platform, nativeConnectRootAuthorityInspector, undefined);
      const terminal = fstatSync(held.fd);
      assertPrivateData(terminal, undefined, platform);
      const verifyVisible = () => {
        const visible = lstatSync(dataPath);
        const pinned = fstatSync(held!.fd);
        if (visible.isSymbolicLink() || !sameIdentity(visible, pinned)) throw new PublicInstanceIdentityError();
        assertPrivateData(pinned, undefined, platform);
        authorityEntry(nativeConnectRootAuthorityInspector, platform, dataPath, "data");
      };
      const directory: PinnedPublicIdentityDirectory = {
        fd: held.fd,
        ownerUid: terminal.uid,
        open: (name, flags, mode = 0) => {
          verifyVisible();
          const fd = held!.openChild(name, flags, mode);
          try {
            const opened = fstatSync(fd);
            const named = lstatSync(join(dataPath, name));
            if (named.isSymbolicLink() || !sameIdentity(opened, named)) throw new PublicInstanceIdentityError();
            return fd;
          } catch (error) {
            closeSync(fd);
            throw error;
          }
        },
        identify: (name) => identifyHeldChild(held!, platform, name),
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
      const identity = getOrCreatePublicInstanceIdentityPinned(directory, { generate, role: "host" });
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
        assertPlatformAuthority(acquiredParent, platform, nativeConnectRootAuthorityInspector, callerUid);
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
    assertPlatformAuthority(acquired, platform, nativeConnectRootAuthorityInspector, callerUid);
    assertPrivateData(fstatSync(held.fd), callerUid, platform);
    const directory: PinnedPublicIdentityDirectory = {
      fd: held.fd,
      ownerUid: callerUid,
      open: (name, flags, mode = 0) => held!.openChild(name, flags, mode),
      identify: (name) => identifyHeldChild(held!, platform, name),
      publishNoReplace: (oldName, newName) => renameAt(held!.fd, oldName, newName),
      unlink: (name) => unlinkAt(held!.fd, name),
    };
    const identity = getOrCreatePublicInstanceIdentityPinned(directory, { generate, role: "host" });
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

export function getOrCreateSnapshotPublicInstanceIdentity(
  directory: PinnedPublicIdentityDirectory,
  generate: () => string = randomUUID,
): string {
  try {
    return getOrCreatePublicInstanceIdentityPinned(directory, { generate, role: "host" });
  } catch (error) {
    if (error instanceof PublicInstanceIdentityError) throw error;
    throw new PublicInstanceIdentityError();
  }
}
