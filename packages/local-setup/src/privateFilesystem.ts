import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeSync,
  type Stats,
} from "node:fs";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";

export const PRIVATE_DIRECTORY_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;
const O_CLOEXEC = (constants as unknown as Record<string, number>).O_CLOEXEC ?? (process.platform === 'linux' ? 0o2000000 : 0);

function lstatIfPresent(targetPath: string): Stats | undefined {
  try {
    return lstatSync(targetPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function assertOwned(stat: Stats, targetPath: string): void {
  if (process.platform === "win32") return;
  const currentUid = process.getuid?.();
  if (currentUid !== undefined && stat.uid !== currentUid) {
    throw new Error(`Refusing to use ${targetPath}: it is not owned by the current user`);
  }
}

function assertNoSymlinkComponents(targetPath: string): void {
  const absolute = resolve(targetPath);
  if (!isAbsolute(absolute) || absolute.includes("\0")) throw new Error("Invalid private filesystem path");
  const root = parse(absolute).root;
  let cursor = root;
  for (const component of absolute.slice(root.length).split(/[\\/]+/).filter(Boolean)) {
    cursor = join(cursor, component);
    const stat = lstatIfPresent(cursor);
    if (!stat) break;
    // Let the exact-target validator report whether the link was supplied as a
    // file or directory. Components above the target can never be followed.
    if (stat.isSymbolicLink() && cursor === absolute) return;
    if (stat.isSymbolicLink()) throw new Error(`Refusing to follow symbolic-link directory component ${cursor}`);
  }
}

export function secureExistingPrivateDirectory(directoryPath: string): boolean {
  assertNoSymlinkComponents(directoryPath);
  const stat = lstatIfPresent(directoryPath);
  if (!stat) return false;
  if (stat.isSymbolicLink()) throw new Error(`Refusing to use symbolic-link directory ${directoryPath}`);
  if (!stat.isDirectory()) throw new Error(`Expected a directory at ${directoryPath}`);
  assertOwned(stat, directoryPath);
  if (realpathSync(directoryPath) !== resolve(directoryPath)) throw new Error(`Refusing to use linked directory ${directoryPath}`);
  if (process.platform !== "win32" && (stat.mode & 0o777) !== PRIVATE_DIRECTORY_MODE) {
    chmodSync(directoryPath, PRIVATE_DIRECTORY_MODE);
  }
  return true;
}

export function ensurePrivateDirectory(directoryPath: string): void {
  assertNoSymlinkComponents(directoryPath);
  if (!lstatIfPresent(directoryPath)) mkdirSync(directoryPath, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  secureExistingPrivateDirectory(directoryPath);
}

export function secureExistingPrivateFile(filePath: string): boolean {
  assertNoSymlinkComponents(filePath);
  const stat = lstatIfPresent(filePath);
  if (!stat) return false;
  if (stat.isSymbolicLink()) throw new Error(`Refusing to use symbolic-link file ${filePath}`);
  if (!stat.isFile()) throw new Error(`Expected a regular file at ${filePath}`);
  if (stat.nlink !== 1) throw new Error(`Refusing to use hard-linked file ${filePath}`);
  assertOwned(stat, filePath);
  if (process.platform !== "win32" && (stat.mode & 0o777) !== PRIVATE_FILE_MODE) chmodSync(filePath, PRIVATE_FILE_MODE);
  return true;
}

export interface PrivateFileWriteOptions {
  secureParent?: boolean;
  signal?: AbortSignal;
  /** Test seam for simulating a commit failure after the durable temp write. */
  beforeRename?(): void;
}

/**
 * Publish a private file without ever modifying the previous inode in place.
 * The random same-directory temporary is exclusive, fully written and synced;
 * cancellation is observed immediately before the only commit point.
 */
export function writePrivateFileAtomic(
  filePath: string,
  content: string | Buffer,
  options: PrivateFileWriteOptions = {},
): void {
  const target = resolve(filePath);
  const parent = dirname(target);
  if (options.secureParent !== false) ensurePrivateDirectory(parent);
  else secureExistingPrivateDirectory(parent);
  secureExistingPrivateFile(target);
  const temporary = join(parent, `.${randomBytes(24).toString("hex")}.tmp`);
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content);
  let descriptor: number | undefined;
  let directoryDescriptor: number | undefined;
  try {
    descriptor = openSync(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW | O_CLOEXEC,
      PRIVATE_FILE_MODE,
    );
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || opened.nlink !== 1) throw new Error("Atomic write temporary is not a private regular file");
    let offset = 0;
    while (offset < bytes.length) offset += writeSync(descriptor, bytes, offset, bytes.length - offset);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    options.beforeRename?.();
    options.signal?.throwIfAborted();
    renameSync(temporary, target);
    const final = lstatSync(target);
    if (!final.isFile() || final.isSymbolicLink() || final.nlink !== 1) throw new Error("Atomic write produced an unsafe target");
    assertOwned(final, target);
    if (process.platform !== "win32") chmodSync(target, PRIVATE_FILE_MODE);
    directoryDescriptor = openSync(parent, constants.O_RDONLY | constants.O_DIRECTORY | O_CLOEXEC);
    fsyncSync(directoryDescriptor);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (directoryDescriptor !== undefined) closeSync(directoryDescriptor);
    try { unlinkSync(temporary); } catch { /* Removed by rename or best-effort failure cleanup. */ }
  }
}

/** Open a private file without following links and read that exact inode once. */
export function readPrivateFile(filePath: string, maxBytes = 1024 * 1024): Buffer | undefined {
  const target = resolve(filePath);
  assertNoSymlinkComponents(target);
  let descriptor: number;
  try {
    descriptor = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW | O_CLOEXEC);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > maxBytes) throw new Error(`Refusing to read unsafe private file ${target}`);
    assertOwned(stat, target);
    return readFileSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}
