import {
  chmodSync,
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import type { Stats } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { protectWindowsSetupEntry } from "../connectRootAuthority.js";

export const PRIVATE_DIRECTORY_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;

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

export function secureExistingPrivateDirectory(directoryPath: string): boolean {
  const stat = lstatIfPresent(directoryPath);
  if (!stat) return false;
  if (stat.isSymbolicLink()) throw new Error(`Refusing to use symbolic-link directory ${directoryPath}`);
  if (!stat.isDirectory()) throw new Error(`Expected a directory at ${directoryPath}`);
  assertOwned(stat, directoryPath);
  if (process.platform === "win32") {
    protectWindowsSetupEntry(directoryPath, "directory");
  } else if ((stat.mode & 0o777) !== PRIVATE_DIRECTORY_MODE) {
    chmodSync(directoryPath, PRIVATE_DIRECTORY_MODE);
  }
  return true;
}

/**
 * Validate an existing private directory without changing it. Read-only
 * consumers use this so inspecting configuration cannot repair or otherwise
 * mutate the authority boundary as a side effect.
 */
export function validateExistingPrivateDirectory(directoryPath: string): boolean {
  const stat = lstatIfPresent(directoryPath);
  if (!stat) return false;
  if (stat.isSymbolicLink()) throw new Error(`Refusing to use symbolic-link directory ${directoryPath}`);
  if (!stat.isDirectory()) throw new Error(`Expected a directory at ${directoryPath}`);
  assertOwned(stat, directoryPath);
  if (process.platform !== "win32" && (stat.mode & 0o777) !== PRIVATE_DIRECTORY_MODE) {
    throw new Error(`Refusing to use non-private directory ${directoryPath}`);
  }
  return true;
}

export function ensurePrivateDirectory(directoryPath: string): void {
  if (!lstatIfPresent(directoryPath)) {
    mkdirSync(directoryPath, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  }
  secureExistingPrivateDirectory(directoryPath);
}

export function secureExistingPrivateFile(filePath: string): boolean {
  const stat = lstatIfPresent(filePath);
  if (!stat) return false;
  if (stat.isSymbolicLink()) throw new Error(`Refusing to use symbolic-link file ${filePath}`);
  if (!stat.isFile()) throw new Error(`Expected a regular file at ${filePath}`);
  assertOwned(stat, filePath);
  if (process.platform === "win32") {
    protectWindowsSetupEntry(filePath, "file");
  } else if ((stat.mode & 0o777) !== PRIVATE_FILE_MODE) {
    chmodSync(filePath, PRIVATE_FILE_MODE);
  }
  return true;
}

/** Validate an existing private file without chmod or any other mutation. */
export function validateExistingPrivateFile(filePath: string): boolean {
  const stat = lstatIfPresent(filePath);
  if (!stat) return false;
  if (stat.isSymbolicLink()) throw new Error(`Refusing to use symbolic-link file ${filePath}`);
  if (!stat.isFile()) throw new Error(`Expected a regular file at ${filePath}`);
  assertOwned(stat, filePath);
  if (process.platform !== "win32" && (stat.mode & 0o777) !== PRIVATE_FILE_MODE) {
    throw new Error(`Refusing to use non-private file ${filePath}`);
  }
  return true;
}

export interface PrivateFileWriteOptions {
  secureParent?: boolean;
}

export function writePrivateFileAtomic(
  filePath: string,
  content: string | Buffer,
  options: PrivateFileWriteOptions = {},
): void {
  if (options.secureParent !== false) ensurePrivateDirectory(dirname(filePath));
  secureExistingPrivateFile(filePath);
  const tempPath = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(tempPath, "wx", PRIVATE_FILE_MODE);
    writeFileSync(descriptor, content);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(tempPath, filePath);
    if (process.platform === "win32") protectWindowsSetupEntry(filePath, "file");
    else chmodSync(filePath, PRIVATE_FILE_MODE);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    try { unlinkSync(tempPath); } catch { /* Best-effort cleanup after success or failure. */ }
  }
}
