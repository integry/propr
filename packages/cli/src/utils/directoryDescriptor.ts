import { createHash } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertCanonicalNativeArtifactParents,
  isPackagedNativeArtifactResolution,
  physicalNativeArtifactCandidate,
} from "./nativeArtifact.js";

export type DirectoryDescriptorAccess = "child-paths" | "native-at";

export interface DirectoryEntryIdentity {
  dev: number;
  ino: number;
  kind: "directory" | "symbolic-link" | "file" | "other";
}

interface NativeDirectoryOperations {
  openAt(dirfd: number, name: string, flags: number, mode: number): number;
  mkdirAt(dirfd: number, name: string, mode: number): void;
  renameAt(oldDirfd: number, oldName: string, newDirfd: number, newName: string): void;
  linkAt(oldDirfd: number, oldName: string, newDirfd: number, newName: string, flags: number): void;
  unlinkAt(dirfd: number, name: string, flags: number): void;
  lstatAt(dirfd: number, name: string): DirectoryEntryIdentity;
}

export interface NativeDirectoryOperationTestEvent {
  operation: "openAt" | "mkdirAt" | "renameAt";
  phase: "before" | "after";
  dirfd: number;
  name: string;
  newName?: string;
  flags?: number;
  mode?: number;
  result?: number;
}

export type NativeDirectorySmokePhase = "addon-integrity-type" | "addon-load" | "descriptor-operation";
export type NativeDirectorySmokeCode = "STARTED" | "PASSED" | "FAILED";
export type NativeDirectorySmokeSubstep = "directory-open" | "addon-open" | "fstat-type";
export type NativeDirectorySmokeFailureCategory =
  | "access-denied"
  | "invalid-argument"
  | "io-failure"
  | "missing-entry"
  | "not-directory"
  | "symlink-refused"
  | "type-mismatch"
  | "unexpected";
export type NativeDirectorySmokeDiagnostic = (
  phase: NativeDirectorySmokePhase,
  code: NativeDirectorySmokeCode,
  failure?: Readonly<{
    substep: NativeDirectorySmokeSubstep;
    category: NativeDirectorySmokeFailureCategory;
  }>,
) => void;

type NativeDirectoryOperationTestHook = (event: NativeDirectoryOperationTestEvent) => void;

export type NativeDirectoryOpenTestPhase =
  | "before-primary-open"
  | "after-fallback-before-lstat"
  | "after-fallback-open"
  | "after-fallback-fstat"
  | "after-fallback-after-lstat";

type NativeDirectoryOpenTestHook = (phase: NativeDirectoryOpenTestPhase, directory: string) => void;

export const DARWIN_DIRECTORY_OPERATION_SHA256: Readonly<Record<string, string>> = {
  arm64: "88f07c0c7a4371f4fb227a4691009d09517de582ba49297d28d03ac94e586615",
  x64: "62183c0f4083cb8c98e09e2d2c688f8f81703e12b0f22320c335b51e927eaf53",
};

export const LINUX_DIRECTORY_OPERATION_SHA256: Readonly<Record<string, string>> = {
  arm64: "916679f413251c4b23c51167987a874bbbdd9d96991882bfac9093e0ea5fa051",
  x64: "7199378f1c7b443a05c596eae7c66f9a77cc01b4a493c07748df0df1083950f6",
};

let nativeOperations: NativeDirectoryOperations | undefined;
let nativeOperationTestHook: NativeDirectoryOperationTestHook | undefined;
let nativeDirectoryOpenTestHook: NativeDirectoryOpenTestHook | undefined;
let nativeDirectoryOpenFallbackTestEnabled = false;

function smokeFailureCategory(error: unknown): NativeDirectorySmokeFailureCategory {
  const code = error && typeof error === "object" && "code" in error
    ? (error as { code?: unknown }).code
    : undefined;
  if (code === "EACCES" || code === "EPERM") return "access-denied";
  if (code === "EINVAL") return "invalid-argument";
  if (code === "EIO") return "io-failure";
  if (code === "ENOENT") return "missing-entry";
  if (code === "ENOTDIR") return "not-directory";
  if (code === "ELOOP") return "symlink-refused";
  return "unexpected";
}

/** Install a deterministic race injector around a native descriptor-operation boundary. */
export function setNativeDirectoryOperationTestHook(hook?: NativeDirectoryOperationTestHook): void {
  nativeOperationTestHook = hook;
}

/** Install a deterministic test-only injector around the native authority directory open. */
export function setNativeDirectoryOpenTestHook(
  hook?: NativeDirectoryOpenTestHook,
  enableLinuxArm64Fallback = false,
): void {
  nativeDirectoryOpenTestHook = hook;
  nativeDirectoryOpenFallbackTestEnabled = hook !== undefined && enableLinuxArm64Fallback;
}

/** Linux has traversable procfs dirfds; Darwin uses the packaged *at addon. */
export function directoryDescriptorAccess(platform: NodeJS.Platform = process.platform): DirectoryDescriptorAccess {
  if (platform === "linux") return "child-paths";
  if (platform === "darwin") return "native-at";
  throw new Error(`safe directory-handle publication is not supported on ${platform}`);
}

function nativeArtifactPath(platform: NodeJS.Platform, arch: string): string {
  const digests = platform === "darwin"
    ? DARWIN_DIRECTORY_OPERATION_SHA256
    : platform === "linux"
      ? LINUX_DIRECTORY_OPERATION_SHA256
      : undefined;
  const expected = digests?.[arch];
  if (!expected) throw new Error(`safe ${platform} directory operations are not packaged for ${arch}`);
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const relativeArtifact = join("prebuilds", `${platform}-${arch}`, "directory-operations.node");
  const candidates = [
    join(moduleDirectory, "..", "native", relativeArtifact),
    join(moduleDirectory, "..", "..", "native", relativeArtifact),
  ].map((logicalPath) => {
    const path = physicalNativeArtifactCandidate(logicalPath);
    return { path, packaged: isPackagedNativeArtifactResolution(logicalPath, path) };
  });
  const artifact = candidates.find((candidate) => existsSync(candidate.path));
  if (!artifact) throw new Error(`packaged ${platform} directory-operations artifact is missing for ${arch}`);
  if (artifact.packaged) assertCanonicalNativeArtifactParents(artifact.path);
  const named = lstatSync(artifact.path);
  if (!named.isFile() || named.isSymbolicLink() || (artifact.packaged && (named.mode & 0o022) !== 0)) {
    throw new Error(`packaged directory-operations artifact failed type verification for ${platform}-${arch}`);
  }
  verifyDirectoryOperationArtifact(artifact.path, expected, `${platform}-${arch}`);
  return artifact.path;
}

export function verifyDirectoryOperationArtifact(artifact: string, expected: string, arch: string): void {
  const actual = createHash("sha256").update(readFileSync(artifact)).digest("hex");
  if (actual !== expected) {
    throw new Error(`packaged directory-operations artifact failed integrity verification for ${arch}`);
  }
}

function hostOperations(reportSmokeDiagnostic?: NativeDirectorySmokeDiagnostic): NativeDirectoryOperations {
  if (process.platform !== "darwin" && process.platform !== "linux") {
    throw new Error(`native directory operations were requested on unsupported platform ${process.platform}`);
  }
  reportSmokeDiagnostic?.("addon-integrity-type", "STARTED");
  let artifact: string;
  try {
    artifact = nativeArtifactPath(process.platform, process.arch);
    reportSmokeDiagnostic?.("addon-integrity-type", "PASSED");
  } catch (error) {
    reportSmokeDiagnostic?.("addon-integrity-type", "FAILED");
    throw error;
  }
  reportSmokeDiagnostic?.("addon-load", "STARTED");
  try {
    nativeOperations ??= createRequire(import.meta.url)(artifact) as NativeDirectoryOperations;
    reportSmokeDiagnostic?.("addon-load", "PASSED");
  } catch (error) {
    reportSmokeDiagnostic?.("addon-load", "FAILED");
    throw error;
  }
  return nativeOperations;
}

function errorCode(error: unknown): unknown {
  return error && typeof error === "object" && "code" in error
    ? (error as { code?: unknown }).code
    : undefined;
}

function sameDirectoryIdentity(
  left: Readonly<{ dev: number; ino: number }>,
  right: Readonly<{ dev: number; ino: number }>,
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

/**
 * Open and pin the authority directory. Some Linux ARM64 hosts reject the
 * strict directory/no-follow flag combination with EINVAL. Only that errno on
 * Linux ARM64 may use the compatibility open, and the held descriptor must
 * identify the exact same non-link directory before and after it is opened.
 */
function openNativeAuthorityDirectory(directory: string): number {
  try {
    nativeDirectoryOpenTestHook?.("before-primary-open", directory);
    return openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  } catch (error) {
    const isLinuxArm64 = process.platform === "linux" && process.arch === "arm64";
    if ((!isLinuxArm64 && !nativeDirectoryOpenFallbackTestEnabled) || errorCode(error) !== "EINVAL") throw error;
  }

  nativeDirectoryOpenTestHook?.("after-fallback-before-lstat", directory);
  const before = lstatSync(directory);
  if (!before.isDirectory() || before.isSymbolicLink()) {
    throw new Error("native directory authority root was not a non-link directory before open");
  }

  let directoryFd: number | undefined;
  try {
    directoryFd = openSync(directory, constants.O_RDONLY);
    nativeDirectoryOpenTestHook?.("after-fallback-open", directory);
    const opened = fstatSync(directoryFd);
    nativeDirectoryOpenTestHook?.("after-fallback-fstat", directory);
    const after = lstatSync(directory);
    nativeDirectoryOpenTestHook?.("after-fallback-after-lstat", directory);
    if (!opened.isDirectory()
      || !after.isDirectory()
      || after.isSymbolicLink()
      || !sameDirectoryIdentity(before, opened)
      || !sameDirectoryIdentity(before, after)
      || !sameDirectoryIdentity(opened, after)) {
      throw new Error("native directory authority root changed during descriptor fallback");
    }
    const result = directoryFd;
    directoryFd = undefined;
    return result;
  } finally {
    if (directoryFd !== undefined) closeSync(directoryFd);
  }
}

/**
 * Load the integrity-pinned host addon and perform one descriptor-relative
 * operation. Packaged desktop discovery uses this on Linux so acceptance binds
 * the selected native artifact to the running main process, rather than merely
 * inspecting a file copied into the package.
 */
export function assertNativeDirectoryEntry(
  directory: string,
  name: string,
  expectedKind: DirectoryEntryIdentity['kind'],
  reportSmokeDiagnostic?: NativeDirectorySmokeDiagnostic,
): void {
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(name) || name === '.' || name === '..') {
    throw new Error('native directory authority entry name is invalid');
  }
  const operations = hostOperations(reportSmokeDiagnostic);
  reportSmokeDiagnostic?.("descriptor-operation", "STARTED");
  let directoryFd: number | undefined;
  let entryFd: number | undefined;
  let substep: NativeDirectorySmokeSubstep = "directory-open";
  let failureReported = false;
  try {
    directoryFd = openNativeAuthorityDirectory(directory);
    // Pin through the addon's descriptor-relative open, then let the host
    // runtime inspect that descriptor. This avoids architecture-specific C
    // stat ABI wrappers while retaining no-follow and exact-type authority.
    substep = "addon-open";
    entryFd = operations.openAt(directoryFd, name, constants.O_RDONLY | constants.O_NOFOLLOW, 0);
    substep = "fstat-type";
    const entry = fstatSync(entryFd);
    const kind = entry.isFile()
      ? "file"
      : entry.isDirectory()
        ? "directory"
        : entry.isSymbolicLink()
          ? "symbolic-link"
          : "other";
    if (kind !== expectedKind) {
      reportSmokeDiagnostic?.("descriptor-operation", "FAILED", {
        substep,
        category: "type-mismatch",
      });
      failureReported = true;
      throw new Error('native directory authority entry type did not match');
    }
    reportSmokeDiagnostic?.("descriptor-operation", "PASSED");
  } catch (error) {
    if (!failureReported) {
      reportSmokeDiagnostic?.("descriptor-operation", "FAILED", {
        substep,
        category: smokeFailureCategory(error),
      });
    }
    throw error;
  } finally {
    if (entryFd !== undefined) closeSync(entryFd);
    if (directoryFd !== undefined) closeSync(directoryFd);
  }
}

export function openAt(dirfd: number, name: string, flags: number, mode = 0): number {
  const operations = hostOperations();
  nativeOperationTestHook?.({ operation: "openAt", phase: "before", dirfd, name, flags, mode });
  const result = operations.openAt(dirfd, name, flags, mode);
  nativeOperationTestHook?.({ operation: "openAt", phase: "after", dirfd, name, flags, mode, result });
  return result;
}

export function mkdirAt(dirfd: number, name: string, mode: number): void {
  const operations = hostOperations();
  nativeOperationTestHook?.({ operation: "mkdirAt", phase: "before", dirfd, name, mode });
  operations.mkdirAt(dirfd, name, mode);
  nativeOperationTestHook?.({ operation: "mkdirAt", phase: "after", dirfd, name, mode });
}

/** Atomically move one child without replacing an entry already at newName. */
export function renameAt(dirfd: number, oldName: string, newName: string): void {
  const operations = hostOperations();
  nativeOperationTestHook?.({ operation: "renameAt", phase: "before", dirfd, name: oldName, newName });
  operations.renameAt(dirfd, oldName, dirfd, newName);
  nativeOperationTestHook?.({ operation: "renameAt", phase: "after", dirfd, name: oldName, newName });
}

export function linkAt(dirfd: number, oldName: string, newName: string): void {
  hostOperations().linkAt(dirfd, oldName, dirfd, newName, 0);
}

export function unlinkAt(dirfd: number, name: string): void {
  hostOperations().unlinkAt(dirfd, name, 0);
}

export function lstatAt(dirfd: number, name: string): DirectoryEntryIdentity {
  return hostOperations().lstatAt(dirfd, name);
}
