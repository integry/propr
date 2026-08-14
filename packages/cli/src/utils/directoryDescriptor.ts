import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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

type NativeDirectoryOperationTestHook = (event: NativeDirectoryOperationTestEvent) => void;

export const DARWIN_DIRECTORY_OPERATION_SHA256: Readonly<Record<string, string>> = {
  arm64: "88f07c0c7a4371f4fb227a4691009d09517de582ba49297d28d03ac94e586615",
  x64: "62183c0f4083cb8c98e09e2d2c688f8f81703e12b0f22320c335b51e927eaf53",
};

export const LINUX_DIRECTORY_OPERATION_SHA256: Readonly<Record<string, string>> = {
  arm64: "29b28b76ed8781f2567897ad9ba576798bbb669937048218e0416601788e0f1c",
  x64: "e3171d114742e15ad764761c16292f4f16edc2d5155da53d72842b2bc8db8308",
};

let nativeOperations: NativeDirectoryOperations | undefined;
let nativeOperationTestHook: NativeDirectoryOperationTestHook | undefined;

/** Install a deterministic race injector around a native descriptor-operation boundary. */
export function setNativeDirectoryOperationTestHook(hook?: NativeDirectoryOperationTestHook): void {
  nativeOperationTestHook = hook;
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
  ];
  const artifact = candidates.find((candidate) => existsSync(candidate));
  if (!artifact) throw new Error(`packaged ${platform} directory-operations artifact is missing for ${arch}`);
  verifyDirectoryOperationArtifact(artifact, expected, `${platform}-${arch}`);
  return artifact;
}

export function verifyDirectoryOperationArtifact(artifact: string, expected: string, arch: string): void {
  const actual = createHash("sha256").update(readFileSync(artifact)).digest("hex");
  if (actual !== expected) {
    throw new Error(`packaged directory-operations artifact failed integrity verification for ${arch}`);
  }
}

function hostOperations(): NativeDirectoryOperations {
  if (process.platform !== "darwin" && process.platform !== "linux") {
    throw new Error(`native directory operations were requested on unsupported platform ${process.platform}`);
  }
  nativeOperations ??= createRequire(import.meta.url)(nativeArtifactPath(process.platform, process.arch)) as NativeDirectoryOperations;
  return nativeOperations;
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
