import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import type { Stats } from "node:fs";
import { dirname, join, parse, resolve, sep } from "node:path";
import {
  PUBLIC_INSTANCE_IDENTITY_FILENAME,
  PUBLIC_INSTANCE_IDENTITY_SCHEMA_VERSION,
  parsePublicInstanceIdentityDocument,
} from "@propr/shared";

export const PUBLIC_IDENTITY_DIRECTORY_MODE = 0o700;
export const PUBLIC_IDENTITY_FILE_MODE = 0o644;
const PUBLIC_IDENTITY_TEMPORARY_MODE = 0o600;
export const PUBLIC_IDENTITY_MAX_BYTES = 1024;

const READY_NAME = `.${PUBLIC_INSTANCE_IDENTITY_FILENAME}.ready-v1`;
const TEMP_PREFIX = `.${PUBLIC_INSTANCE_IDENTITY_FILENAME}.creating-v1-`;

export type PublicIdentityRole = "host" | "root-container";
export type PublicIdentityBoundary =
  | "temporary-opened"
  | "temporary-written"
  | "temporary-synced"
  | "recovery-published"
  | "identity-published"
  | "directory-synced";

export interface PublicIdentityOptions {
  generate?: () => string;
  role?: PublicIdentityRole;
  onBoundary?: (boundary: PublicIdentityBoundary) => void;
}

export interface PinnedPublicIdentityDirectory {
  readonly fd: number;
  readonly ownerUid: number;
  open(name: string, flags: number, mode?: number): number;
  publishNoReplace(oldName: string, newName: string): void;
  unlink(name: string): void;
}

class IdentityBusyError extends Error {}

function errno(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

function sameIdentity(left: Pick<Stats, "dev" | "ino">, right: Pick<Stats, "dev" | "ino">): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function validateDirectoryMode(stat: Stats): void {
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("public identity data directory is invalid");
  if (process.platform !== "win32" && (stat.mode & 0o777) !== PUBLIC_IDENTITY_DIRECTORY_MODE) {
    throw new Error("public identity data directory is not private");
  }
}

export function publicIdentityFilePermissionsAllowed(
  metadata: { uid: number; mode: number },
  directoryOwnerUid: number,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform === "win32") return false;
  return (metadata.uid === directoryOwnerUid || metadata.uid === 0)
    && (metadata.mode & 0o777) === PUBLIC_IDENTITY_FILE_MODE;
}

function validateFileStat(stat: Stats, directoryOwnerUid: number): void {
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    if (stat.isFile() && stat.nlink === 2) throw new IdentityBusyError();
    throw new Error("public instance identity file is not a private single-link regular file");
  }
  if (stat.size <= 0 || stat.size > PUBLIC_IDENTITY_MAX_BYTES) {
    throw new Error("public instance identity file has an invalid size");
  }
  if (process.platform !== "win32") {
    if (!publicIdentityFilePermissionsAllowed(stat, directoryOwnerUid)) {
      throw new Error("public instance identity file has an unexpected owner or unsafe permissions");
    }
  }
}

function readIdentity(directory: PinnedPublicIdentityDirectory, name: string): string {
  let fd: number | undefined;
  try {
    fd = directory.open(name, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = fstatSync(fd);
    validateFileStat(before, directory.ownerUid);
    const bytes = readFileSync(fd);
    const after = fstatSync(fd);
    if (!sameIdentity(before, after) || before.size !== after.size) {
      throw new Error("public instance identity changed while it was read");
    }
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
    if (
      !value
      || typeof value !== "object"
      || Array.isArray(value)
      || Object.keys(value as Record<string, unknown>).sort().join(",")
        !== "publicInstanceIdentity,schemaVersion"
    ) throw new Error("public instance identity document is invalid");
    const parsed = parsePublicInstanceIdentityDocument(value);
    if (!parsed) throw new Error("public instance identity document is invalid");
    return parsed.publicInstanceIdentity;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function readIdentityIfPresent(
  directory: PinnedPublicIdentityDirectory,
  name: string,
): string | undefined {
  try {
    return readIdentity(directory, name);
  } catch (error) {
    if (errno(error) === "ENOENT") return undefined;
    throw error;
  }
}

function unlinkIfPresent(directory: PinnedPublicIdentityDirectory, name: string): void {
  try {
    directory.unlink(name);
  } catch (error) {
    if (errno(error) !== "ENOENT") throw error;
  }
}

function publishRecovery(
  directory: PinnedPublicIdentityDirectory,
  onBoundary?: PublicIdentityOptions["onBoundary"],
): string | undefined {
  let recovered: string;
  try {
    recovered = readIdentity(directory, READY_NAME);
  } catch (error) {
    if (errno(error) === "ENOENT") return undefined;
    if (error instanceof IdentityBusyError) return undefined;
    // Only the fixed, fully-written recovery slot is eligible for cleanup.
    // An unsafe owner/type/link is deliberately left untouched and rejected.
    let recoveryFd: number | undefined;
    try {
      recoveryFd = directory.open(READY_NAME, constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = fstatSync(recoveryFd);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw error;
      if (!publicIdentityFilePermissionsAllowed(stat, directory.ownerUid)) throw error;
    } finally {
      if (recoveryFd !== undefined) closeSync(recoveryFd);
    }
    unlinkIfPresent(directory, READY_NAME);
    fsyncSync(directory.fd);
    return undefined;
  }

  try {
    directory.publishNoReplace(READY_NAME, PUBLIC_INSTANCE_IDENTITY_FILENAME);
    onBoundary?.("identity-published");
  } catch (error) {
    if (errno(error) !== "EEXIST") throw error;
    unlinkIfPresent(directory, READY_NAME);
  }
  fsyncSync(directory.fd);
  onBoundary?.("directory-synced");
  try {
    return readIdentity(directory, PUBLIC_INSTANCE_IDENTITY_FILENAME) ?? recovered;
  } catch (error) {
    if (error instanceof IdentityBusyError) return undefined;
    throw error;
  }
}

/** Central CLI/API creation algorithm operating only through a held data-directory handle. */
export function getOrCreatePublicInstanceIdentityPinned(
  directory: PinnedPublicIdentityDirectory,
  options: PublicIdentityOptions = {},
): string {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      const existing = readIdentityIfPresent(directory, PUBLIC_INSTANCE_IDENTITY_FILENAME);
      if (existing) return existing;
    } catch (error) {
      if (!(error instanceof IdentityBusyError)) throw error;
    }

    const recovered = publishRecovery(directory, options.onBoundary);
    if (recovered) return recovered;

    const generated = (options.generate ?? randomUUID)();
    const parsedGenerated = parsePublicInstanceIdentityDocument({
      schemaVersion: PUBLIC_INSTANCE_IDENTITY_SCHEMA_VERSION,
      publicInstanceIdentity: generated,
    });
    if (!parsedGenerated) throw new Error("identity generator returned an invalid UUIDv4");
    const document = Buffer.from(`${JSON.stringify(parsedGenerated)}\n`, "utf8");
    if (document.byteLength > PUBLIC_IDENTITY_MAX_BYTES) throw new Error("public identity document is too large");

    const temporaryName = `${TEMP_PREFIX}${process.pid}-${randomUUID()}`;
    let temporaryFd: number | undefined;
    let temporaryPresent = false;
    try {
      temporaryFd = directory.open(
        temporaryName,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        PUBLIC_IDENTITY_TEMPORARY_MODE,
      );
      temporaryPresent = true;
      if (process.platform !== "win32") fchmodSync(temporaryFd, PUBLIC_IDENTITY_TEMPORARY_MODE);
      options.onBoundary?.("temporary-opened");
      writeFileSync(temporaryFd, document);
      options.onBoundary?.("temporary-written");
      fsyncSync(temporaryFd);
      if (process.platform !== "win32") {
        fchmodSync(temporaryFd, PUBLIC_IDENTITY_FILE_MODE);
        fsyncSync(temporaryFd);
      }
      options.onBoundary?.("temporary-synced");
      closeSync(temporaryFd);
      temporaryFd = undefined;

      try {
        directory.publishNoReplace(temporaryName, READY_NAME);
        temporaryPresent = false;
        options.onBoundary?.("recovery-published");
      } catch (error) {
        if (errno(error) !== "EEXIST") throw error;
      }
    } finally {
      if (temporaryFd !== undefined) closeSync(temporaryFd);
      if (temporaryPresent) unlinkIfPresent(directory, temporaryName);
    }

    const winner = publishRecovery(directory, options.onBoundary);
    if (winner) return winner;
  }
  throw new Error("public instance identity remained a non-single-link file or creation did not settle");
}

function descriptorRoot(): string {
  for (const candidate of ["/proc/self/fd", "/dev/fd"]) {
    try {
      if (lstatSync(candidate).isDirectory()) return candidate;
    } catch {
      // Try the next platform descriptor filesystem.
    }
  }
  throw new Error("safe directory-handle access is unavailable");
}

function validateAncestorOwnership(stats: Stats[], terminalOwner: number, role: PublicIdentityRole): void {
  const caller = process.getuid?.();
  if (role === "host" && caller !== undefined && terminalOwner !== caller) {
    throw new Error("public identity data directory is not owned by the host caller");
  }
  for (let index = 0; index < stats.length; index += 1) {
    const stat = stats[index];
    const terminal = index === stats.length - 1;
    if (terminal) {
      validateDirectoryMode(stat);
      continue;
    }
    if (process.platform === "win32") throw new Error("Windows directory ACL authority is unavailable");
    if (stat.uid !== 0 && stat.uid !== terminalOwner) {
      throw new Error("public identity ancestry has an unexpected owner");
    }
    const writableByOthers = (stat.mode & 0o022) !== 0;
    const sticky = (stat.mode & 0o1000) !== 0;
    if (writableByOthers && !sticky) throw new Error("public identity ancestry is replaceable");
  }
}

function openPinnedDataDirectory(dataDir: string, role: PublicIdentityRole): {
  directory: PinnedPublicIdentityDirectory;
  close(): void;
  validateVisible(): void;
} {
  if (process.platform !== "linux") {
    throw new Error(`safe public identity directory access is not supported on ${process.platform}`);
  }
  const absolute = resolve(dataDir);
  const parent = dirname(absolute);
  try {
    lstatSync(absolute);
  } catch (error) {
    if (errno(error) !== "ENOENT") throw error;
    if (role === "root-container") {
      throw new Error("root container cannot establish the host-owned public identity directory");
    }
    mkdirSync(absolute, { recursive: false, mode: PUBLIC_IDENTITY_DIRECTORY_MODE });
    chmodSync(absolute, PUBLIC_IDENTITY_DIRECTORY_MODE);
  }

  const flags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
  const fdRoot = descriptorRoot();
  let fd = openSync(parse(absolute).root, flags);
  const ancestry: Stats[] = [];
  try {
    let visible = parse(absolute).root;
    for (const component of absolute.slice(parse(absolute).root.length).split(sep).filter(Boolean)) {
      const next = openSync(join(fdRoot, String(fd), component), flags);
      closeSync(fd);
      fd = next;
      visible = join(visible, component);
      const visibleStat = lstatSync(visible);
      const pinnedStat = fstatSync(fd);
      if (visibleStat.isSymbolicLink() || !sameIdentity(visibleStat, pinnedStat)) {
        throw new Error("public identity directory changed during acquisition");
      }
      ancestry.push(visibleStat);
    }
    const terminal = fstatSync(fd);
    validateAncestorOwnership(ancestry, terminal.uid, role);
    if (realpathSync.native(absolute) !== absolute) throw new Error("public identity directory uses a symbolic-link ancestor");
    const anchor = join(fdRoot, String(fd));
    const directory: PinnedPublicIdentityDirectory = {
      fd,
      ownerUid: terminal.uid,
      open: (name, openFlags, mode = 0) => openSync(join(anchor, name), openFlags, mode),
      publishNoReplace: (oldName, newName) => {
        linkSync(join(anchor, oldName), join(anchor, newName));
        unlinkSync(join(anchor, oldName));
      },
      unlink: (name) => unlinkSync(join(anchor, name)),
    };
    return {
      directory,
      close: () => closeSync(fd),
      validateVisible: () => {
        const visible = lstatSync(absolute);
        if (visible.isSymbolicLink() || !sameIdentity(visible, fstatSync(fd))) {
          throw new Error("public identity data directory was replaced");
        }
      },
    };
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

/** Path entry point used by both host initialization and the root API container. */
export function getOrCreatePublicInstanceIdentity(
  dataDir: string,
  options: PublicIdentityOptions = {},
): string {
  const pinned = openPinnedDataDirectory(dataDir, options.role ?? "host");
  try {
    const identity = getOrCreatePublicInstanceIdentityPinned(pinned.directory, options);
    pinned.validateVisible();
    return identity;
  } finally {
    pinned.close();
  }
}
