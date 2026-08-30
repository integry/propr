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
  readSync,
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
  | "identity-read-statted"
  | "directory-synced";

export interface PublicIdentityOptions {
  generate?: () => string;
  role?: PublicIdentityRole;
  onBoundary?: (boundary: PublicIdentityBoundary) => void | Promise<void>;
}

export interface PinnedPublicIdentityDirectory {
  readonly fd: number;
  readonly ownerUid: number;
  open(name: string, flags: number, mode?: number): number;
  identify(name: string): {
    device: string;
    file: string;
    kind: "file" | "directory" | "symbolic-link" | "other";
  };
  /** Validate native owner/ACL/no-reparse authority for this exact open file. */
  validateEntry(name: string, fd: number, newlyCreated?: boolean): void | Promise<void>;
  publishNoReplace(oldName: string, newName: string): void;
  unlink(name: string): void;
}

class IdentityBusyError extends Error {}

function errno(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

export interface ExactPublicFileIdentity {
  readonly device: string;
  readonly file: string;
}

function exactIdentity(fd: number): ExactPublicFileIdentity {
  const stat = fstatSync(fd, { bigint: true });
  return { device: stat.dev.toString(10), file: stat.ino.toString(10) };
}

function canonicalIdentityPart(value: string): bigint {
  if (!/^(?:0|[1-9]\d{0,19})$/.test(value) || BigInt(value) > 0xffffffffffffffffn) {
    throw new Error("public instance identity metadata is not a canonical 64-bit identity");
  }
  return BigInt(value);
}

export function samePublicFileIdentity(
  left: ExactPublicFileIdentity,
  right: ExactPublicFileIdentity,
): boolean {
  return canonicalIdentityPart(left.device) === canonicalIdentityPart(right.device)
    && canonicalIdentityPart(left.file) === canonicalIdentityPart(right.file);
}

function sameIdentity(left: ExactPublicFileIdentity, right: ExactPublicFileIdentity): boolean {
  return samePublicFileIdentity(left, right);
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

function validateFileStat(stat: Stats, directoryOwnerUid: number, allowedLinks = 1): void {
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== allowedLinks) {
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

async function readIdentity(
  directory: PinnedPublicIdentityDirectory,
  name: string,
  options: Pick<PublicIdentityOptions, "onBoundary"> = {},
  allowedLinks = 1,
): Promise<string> {
  let fd: number | undefined;
  try {
    fd = directory.open(name, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = fstatSync(fd);
    const beforeIdentity = exactIdentity(fd);
    validateFileStat(before, directory.ownerUid, allowedLinks);
    await directory.validateEntry(name, fd);
    await options.onBoundary?.("identity-read-statted");
    const bytes = Buffer.allocUnsafe(PUBLIC_IDENTITY_MAX_BYTES + 1);
    let length = 0;
    while (length < bytes.byteLength) {
      const count = readSync(fd, bytes, length, bytes.byteLength - length, null);
      if (count === 0) break;
      length += count;
    }
    const after = fstatSync(fd);
    const afterIdentity = exactIdentity(fd);
    validateFileStat(after, directory.ownerUid, allowedLinks);
    await directory.validateEntry(name, fd);
    const namedAfter = directory.identify(name);
    if (
      !sameIdentity(beforeIdentity, afterIdentity)
      || before.size !== after.size
      || length !== before.size
      || length > PUBLIC_IDENTITY_MAX_BYTES
      || namedAfter.kind !== "file"
      || !sameIdentity(afterIdentity, namedAfter)
    ) {
      throw new Error("public instance identity changed while it was read");
    }
    const value = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length)),
    ) as unknown;
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

async function readIdentityIfPresent(
  directory: PinnedPublicIdentityDirectory,
  name: string,
  options: Pick<PublicIdentityOptions, "onBoundary"> = {},
): Promise<string | undefined> {
  try {
    return await readIdentity(directory, name, options);
  } catch (error) {
    if (errno(error) === "ENOENT") return undefined;
    throw error;
  }
}

/**
 * Repair only the exact Darwin/Windows link-then-unlink crash remnant. The
 * fixed recovery slot and final name must be the only two links to one valid
 * inode; a hardlink at any other name is deliberately indistinguishable from
 * an attack and remains rejected.
 */
async function recoverPublishedLinkRemnant(
  directory: PinnedPublicIdentityDirectory,
  options: Pick<PublicIdentityOptions, "onBoundary"> = {},
): Promise<string | undefined> {
  let finalFd: number | undefined;
  let recoveryFd: number | undefined;
  try {
    try {
      finalFd = directory.open(PUBLIC_INSTANCE_IDENTITY_FILENAME, constants.O_RDONLY | constants.O_NOFOLLOW);
      recoveryFd = directory.open(READY_NAME, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      if (errno(error) === "ENOENT") return undefined;
      throw error;
    }
    const finalStat = fstatSync(finalFd);
    const recoveryStat = fstatSync(recoveryFd);
    const finalIdentity = exactIdentity(finalFd);
    const recoveryIdentity = exactIdentity(recoveryFd);
    validateFileStat(finalStat, directory.ownerUid, 2);
    validateFileStat(recoveryStat, directory.ownerUid, 2);
    await directory.validateEntry(PUBLIC_INSTANCE_IDENTITY_FILENAME, finalFd);
    await directory.validateEntry(READY_NAME, recoveryFd);
    if (!sameIdentity(finalIdentity, recoveryIdentity)) {
      throw new Error("public identity hardlink state is ambiguous");
    }
    const recovered = await readIdentity(directory, PUBLIC_INSTANCE_IDENTITY_FILENAME, options, 2);
    // Revalidate both held handles immediately before removing the private name.
    const finalAfter = fstatSync(finalFd);
    const recoveryAfter = fstatSync(recoveryFd);
    const finalAfterIdentity = exactIdentity(finalFd);
    const recoveryAfterIdentity = exactIdentity(recoveryFd);
    const namedFinal = directory.identify(PUBLIC_INSTANCE_IDENTITY_FILENAME);
    const namedRecovery = directory.identify(READY_NAME);
    if (
      !sameIdentity(finalIdentity, finalAfterIdentity)
      || !sameIdentity(recoveryIdentity, recoveryAfterIdentity)
      || !sameIdentity(finalAfterIdentity, recoveryAfterIdentity)
      || finalAfter.nlink !== 2
      || recoveryAfter.nlink !== 2
      || namedFinal.kind !== "file"
      || namedRecovery.kind !== "file"
      || !sameIdentity(finalAfterIdentity, namedFinal)
      || !sameIdentity(recoveryAfterIdentity, namedRecovery)
    ) throw new Error("public identity hardlink state changed during recovery");
    directory.unlink(READY_NAME);
    syncDirectory(directory.fd);
    await options.onBoundary?.("directory-synced");
    return await readIdentity(directory, PUBLIC_INSTANCE_IDENTITY_FILENAME, options) ?? recovered;
  } finally {
    if (recoveryFd !== undefined) closeSync(recoveryFd);
    if (finalFd !== undefined) closeSync(finalFd);
  }
}

function unlinkIfPresent(directory: PinnedPublicIdentityDirectory, name: string): void {
  try {
    directory.unlink(name);
  } catch (error) {
    if (errno(error) !== "ENOENT") throw error;
  }
}

function syncDirectory(fd: number): void {
  // FlushFileBuffers does not support directory handles on Windows. The
  // identity file itself is flushed before publication; retain directory
  // syncing on platforms where the operation is supported.
  if (process.platform !== "win32") fsyncSync(fd);
}

async function publishRecovery(
  directory: PinnedPublicIdentityDirectory,
  onBoundary?: PublicIdentityOptions["onBoundary"],
): Promise<string | undefined> {
  let recovered: string;
  try {
    recovered = await readIdentity(directory, READY_NAME, { onBoundary });
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
      await directory.validateEntry(READY_NAME, recoveryFd);
    } finally {
      if (recoveryFd !== undefined) closeSync(recoveryFd);
    }
    unlinkIfPresent(directory, READY_NAME);
    syncDirectory(directory.fd);
    return undefined;
  }

  try {
    directory.publishNoReplace(READY_NAME, PUBLIC_INSTANCE_IDENTITY_FILENAME);
    await onBoundary?.("identity-published");
  } catch (error) {
    if (errno(error) !== "EEXIST") throw error;
    unlinkIfPresent(directory, READY_NAME);
  }
  syncDirectory(directory.fd);
  await onBoundary?.("directory-synced");
  try {
    return await readIdentity(directory, PUBLIC_INSTANCE_IDENTITY_FILENAME, { onBoundary }) ?? recovered;
  } catch (error) {
    if (error instanceof IdentityBusyError) return undefined;
    throw error;
  }
}

/** Central CLI/API creation algorithm operating only through a held data-directory handle. */
export async function getOrCreatePublicInstanceIdentityPinned(
  directory: PinnedPublicIdentityDirectory,
  options: PublicIdentityOptions = {},
): Promise<string> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    let recoveryEntryBusy = false;
    try {
      // READY is public state in the same authority boundary as the final
      // identity. Validate it even when a healthy final file already exists;
      // otherwise a hostile stale entry could remain outside the policy.
      await readIdentityIfPresent(directory, READY_NAME, options);
    } catch (error) {
      if (!(error instanceof IdentityBusyError)) throw error;
      recoveryEntryBusy = true;
    }
    try {
      const existing = await readIdentityIfPresent(directory, PUBLIC_INSTANCE_IDENTITY_FILENAME, options);
      if (existing) {
        if (recoveryEntryBusy) throw new Error("public identity recovery state is ambiguous");
        return existing;
      }
    } catch (error) {
      if (!(error instanceof IdentityBusyError)) throw error;
      const repaired = await recoverPublishedLinkRemnant(directory, options);
      if (repaired) return repaired;
    }
    if (recoveryEntryBusy) throw new Error("public identity recovery state is ambiguous");

    const recovered = await publishRecovery(directory, options.onBoundary);
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
      await options.onBoundary?.("temporary-opened");
      writeFileSync(temporaryFd, document);
      await options.onBoundary?.("temporary-written");
      fsyncSync(temporaryFd);
      if (process.platform !== "win32") {
        fchmodSync(temporaryFd, PUBLIC_IDENTITY_FILE_MODE);
        fsyncSync(temporaryFd);
      }
      await directory.validateEntry(temporaryName, temporaryFd, true);
      await options.onBoundary?.("temporary-synced");
      closeSync(temporaryFd);
      temporaryFd = undefined;

      try {
        directory.publishNoReplace(temporaryName, READY_NAME);
        temporaryPresent = false;
        await options.onBoundary?.("recovery-published");
      } catch (error) {
        if (errno(error) !== "EEXIST") throw error;
      }
    } finally {
      if (temporaryFd !== undefined) closeSync(temporaryFd);
      if (temporaryPresent) unlinkIfPresent(directory, temporaryName);
    }

    const winner = await publishRecovery(directory, options.onBoundary);
    if (winner) return winner;
  }
  throw new Error("public instance identity remained a non-single-link file or creation did not settle");
}

/** Read the existing public identity without creating, repairing, or unlinking anything. */
export async function readPublicInstanceIdentityPinned(
  directory: PinnedPublicIdentityDirectory,
  options: Pick<PublicIdentityOptions, "onBoundary"> = {},
): Promise<string> {
  const value = await readIdentityIfPresent(directory, PUBLIC_INSTANCE_IDENTITY_FILENAME, options);
  if (!value) throw new Error("public instance identity is absent");
  return value;
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
      const visibleIdentityStat = lstatSync(visible, { bigint: true });
      if (visibleStat.isSymbolicLink() || !sameIdentity(
        { device: visibleIdentityStat.dev.toString(10), file: visibleIdentityStat.ino.toString(10) },
        exactIdentity(fd),
      )) {
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
      identify: (name) => {
        const stat = lstatSync(join(anchor, name), { bigint: true });
        return {
          device: stat.dev.toString(10),
          file: stat.ino.toString(10),
          kind: stat.isFile()
            ? "file"
            : stat.isDirectory()
              ? "directory"
              : stat.isSymbolicLink()
                ? "symbolic-link"
                : "other",
        };
      },
      validateEntry: () => undefined,
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
        const visibleIdentity = lstatSync(absolute, { bigint: true });
        if (visible.isSymbolicLink() || !sameIdentity(
          { device: visibleIdentity.dev.toString(10), file: visibleIdentity.ino.toString(10) },
          exactIdentity(fd),
        )) {
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
export async function getOrCreatePublicInstanceIdentity(
  dataDir: string,
  options: PublicIdentityOptions = {},
): Promise<string> {
  const pinned = openPinnedDataDirectory(dataDir, options.role ?? "host");
  try {
    const identity = await getOrCreatePublicInstanceIdentityPinned(pinned.directory, options);
    pinned.validateVisible();
    return identity;
  } finally {
    pinned.close();
  }
}
