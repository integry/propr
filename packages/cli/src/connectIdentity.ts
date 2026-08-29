import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
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
  openAt,
  renameAt,
  unlinkAt,
} from "./utils/directoryDescriptor.js";

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
  onBoundary?: (boundary: ConnectRootSnapshotBoundary) => void;
  parseEnvFile?: (contents: string) => Record<string, string>;
}

interface HeldDirectory {
  fd: number;
  openChild(name: string, flags: number, mode?: number): number;
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

function heldDirectory(fd: number, platform: NodeJS.Platform): HeldDirectory {
  if (platform === "linux") {
    const path = join(descriptorRoot(), String(fd));
    return {
      fd,
      openChild: (name, flags, mode = 0) => openSync(join(path, name), flags, mode),
    };
  }
  if (platform === "darwin") {
    return {
      fd,
      openChild: (name, flags, mode = 0) => openAt(fd, name, flags, mode),
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

function assertPrivateRoot(stat: Stats, callerUid: number): void {
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== callerUid || (stat.mode & 0o022) !== 0) {
    throw new ConnectRootError();
  }
}

function assertPrivateData(stat: Stats, callerUid: number): void {
  if (
    !stat.isDirectory()
    || stat.isSymbolicLink()
    || stat.uid !== callerUid
    || (stat.mode & 0o777) !== 0o700
  ) throw new ConnectRootError();
}

function assertPrivateEnv(stat: Stats, callerUid: number): void {
  if (
    !stat.isFile()
    || stat.isSymbolicLink()
    || stat.nlink !== 1
    || stat.uid !== callerUid
    || (stat.mode & 0o777) !== 0o600
    || stat.size > MAX_ENV_FILE_BYTES
  ) throw new ConnectRootError();
}

function openRootNoFollow(rootDir: string, platform: NodeJS.Platform): {
  root: HeldDirectory;
  ancestry: Stats[];
} {
  directoryDescriptorAccess(platform);
  const flags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
  const parsed = parse(rootDir);
  let fd = openSync(parsed.root, flags);
  const ancestry: Stats[] = [];
  let visible = parsed.root;
  try {
    for (const component of rootDir.slice(parsed.root.length).split(sep).filter(Boolean)) {
      const current = heldDirectory(fd, platform);
      const next = current.openChild(component, flags);
      closeSync(fd);
      fd = next;
      visible = join(visible, component);
      const named = lstatSync(visible);
      const pinned = fstatSync(fd);
      if (named.isSymbolicLink() || !sameIdentity(named, pinned)) throw new ConnectRootError();
      ancestry.push(named);
    }
    return { root: heldDirectory(fd, platform), ancestry };
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

function readHeldEnv(fd: number): string {
  const before = fstatSync(fd);
  const bytes = readFileSync(fd);
  const after = fstatSync(fd);
  if (!sameIdentity(before, after) || before.size !== after.size || bytes.byteLength > MAX_ENV_FILE_BYTES) {
    throw new ConnectRootError();
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ConnectRootError();
  }
}

function assertNamedEntry(rootDir: string, name: string, held: Stats): void {
  const named = lstatSync(join(rootDir, name));
  if (named.isSymbolicLink() || !sameIdentity(named, held)) throw new ConnectRootError();
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
  if (platform !== process.platform || (platform !== "linux" && platform !== "darwin")) {
    // Node does not expose Windows handle-relative opens or ACL ownership. A
    // pathname-only approximation would be replaceable, so fail closed.
    throw new ConnectRootError();
  }
  const callerUid = process.getuid?.();
  if (callerUid === undefined) throw new ConnectRootError();
  const requestedRoot = resolve(flagRoot);
  try {
    if (realpathSync.native(requestedRoot) !== requestedRoot) throw new ConnectRootError();
  } catch {
    throw new ConnectRootError();
  }

  let root: HeldDirectory | undefined;
  let data: HeldDirectory | undefined;
  let envFd: number | undefined;
  try {
    const acquired = openRootNoFollow(requestedRoot, platform);
    root = acquired.root;
    assertSafeAncestry(acquired.ancestry.slice(0, -1), callerUid);
    assertPrivateRoot(fstatSync(root.fd), callerUid);

    const directoryFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
    const dataFd = root.openChild("data", directoryFlags);
    data = heldDirectory(dataFd, platform);
    assertPrivateData(fstatSync(data.fd), callerUid);
    envFd = root.openChild(".env", constants.O_RDONLY | constants.O_NOFOLLOW);
    assertPrivateEnv(fstatSync(envFd), callerUid);
    options.onBoundary?.("acquired");

    const envFileValues = options.parseEnvFile(readHeldEnv(envFd));
    options.onBoundary?.("env-read");
    const identityDirectory: PinnedPublicIdentityDirectory = {
      fd: data.fd,
      ownerUid: callerUid,
      open: (name, flags, mode = 0) => data!.openChild(name, flags, mode),
      publishNoReplace: (oldName, newName) => renameAt(data!.fd, oldName, newName),
      unlink: (name) => unlinkAt(data!.fd, name),
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
    assertPrivateRoot(heldRootStat, callerUid);
    const heldDataStat = fstatSync(data.fd);
    const heldEnvStat = fstatSync(envFd);
    assertPrivateData(heldDataStat, callerUid);
    assertPrivateEnv(heldEnvStat, callerUid);
    assertNamedEntry(requestedRoot, "data", heldDataStat);
    assertNamedEntry(requestedRoot, ".env", heldEnvStat);
    const reacquired = openRootNoFollow(requestedRoot, platform);
    try {
      const before = acquired.ancestry;
      const after = reacquired.ancestry;
      if (
        before.length !== after.length
        || before.some((stat, index) => !sameIdentity(stat, after[index]))
      ) throw new ConnectRootError();
      assertSafeAncestry(after.slice(0, -1), callerUid);
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
        assertSafeAncestry(acquiredParent.ancestry.slice(0, -1), callerUid);
        assertPrivateRoot(fstatSync(acquiredParent.root.fd), callerUid);
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
    assertSafeAncestry(acquired.ancestry.slice(0, -1), callerUid);
    assertPrivateData(fstatSync(held.fd), callerUid);
    const directory: PinnedPublicIdentityDirectory = {
      fd: held.fd,
      ownerUid: callerUid,
      open: (name, flags, mode = 0) => held!.openChild(name, flags, mode),
      publishNoReplace: (oldName, newName) => renameAt(held!.fd, oldName, newName),
      unlink: (name) => unlinkAt(held!.fd, name),
    };
    const identity = getOrCreatePublicInstanceIdentityPinned(directory, { generate, role: "host" });
    const named = lstatSync(dataPath);
    const pinned = fstatSync(held.fd);
    if (named.isSymbolicLink() || !sameIdentity(named, pinned)) throw new PublicInstanceIdentityError();
    assertPrivateData(pinned, callerUid);
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
