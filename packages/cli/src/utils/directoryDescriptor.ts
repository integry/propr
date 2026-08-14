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
  arm64: "aa380d388e6c8e3a0f14c9e9a5bdfbb59095ed17fb3325318e4aeaa621e71380",
  x64: "e040b7c44a325e1c0c4b288917676a140da0402f3c98bba68a8f23d244049040",
};

let nativeOperations: NativeDirectoryOperations | undefined;
let nativeOperationTestHook: NativeDirectoryOperationTestHook | undefined;

/** Install a deterministic race injector around the Darwin addon boundary. */
export function setNativeDirectoryOperationTestHook(hook?: NativeDirectoryOperationTestHook): void {
  nativeOperationTestHook = hook;
}

/** Linux has traversable procfs dirfds; Darwin uses the packaged *at addon. */
export function directoryDescriptorAccess(platform: NodeJS.Platform = process.platform): DirectoryDescriptorAccess {
  if (platform === "linux") return "child-paths";
  if (platform === "darwin") return "native-at";
  throw new Error(`safe directory-handle publication is not supported on ${platform}`);
}

function nativeArtifactPath(arch: string): string {
  const expected = DARWIN_DIRECTORY_OPERATION_SHA256[arch];
  if (!expected) throw new Error(`safe Darwin directory operations are not packaged for ${arch}`);
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const relativeArtifact = join("prebuilds", `darwin-${arch}`, "directory-operations.node");
  const candidates = [
    join(moduleDirectory, "..", "native", relativeArtifact),
    join(moduleDirectory, "..", "..", "native", relativeArtifact),
  ];
  const artifact = candidates.find((candidate) => existsSync(candidate));
  if (!artifact) throw new Error(`packaged Darwin directory-operations artifact is missing for ${arch}`);
  verifyDirectoryOperationArtifact(artifact, expected, arch);
  return artifact;
}

export function verifyDirectoryOperationArtifact(artifact: string, expected: string, arch: string): void {
  const actual = createHash("sha256").update(readFileSync(artifact)).digest("hex");
  if (actual !== expected) {
    throw new Error(`packaged Darwin directory-operations artifact failed integrity verification for ${arch}`);
  }
}

function darwinOperations(): NativeDirectoryOperations {
  if (process.platform !== "darwin") {
    throw new Error("native Darwin directory operations were requested on a non-Darwin host");
  }
  nativeOperations ??= createRequire(import.meta.url)(nativeArtifactPath(process.arch)) as NativeDirectoryOperations;
  return nativeOperations;
}

export function openAt(dirfd: number, name: string, flags: number, mode = 0): number {
  const operations = darwinOperations();
  nativeOperationTestHook?.({ operation: "openAt", phase: "before", dirfd, name, flags, mode });
  const result = operations.openAt(dirfd, name, flags, mode);
  nativeOperationTestHook?.({ operation: "openAt", phase: "after", dirfd, name, flags, mode, result });
  return result;
}

export function mkdirAt(dirfd: number, name: string, mode: number): void {
  const operations = darwinOperations();
  nativeOperationTestHook?.({ operation: "mkdirAt", phase: "before", dirfd, name, mode });
  operations.mkdirAt(dirfd, name, mode);
  nativeOperationTestHook?.({ operation: "mkdirAt", phase: "after", dirfd, name, mode });
}

export function renameAt(dirfd: number, oldName: string, newName: string): void {
  const operations = darwinOperations();
  nativeOperationTestHook?.({ operation: "renameAt", phase: "before", dirfd, name: oldName, newName });
  operations.renameAt(dirfd, oldName, dirfd, newName);
  nativeOperationTestHook?.({ operation: "renameAt", phase: "after", dirfd, name: oldName, newName });
}

export function linkAt(dirfd: number, oldName: string, newName: string): void {
  darwinOperations().linkAt(dirfd, oldName, dirfd, newName, 0);
}

export function unlinkAt(dirfd: number, name: string): void {
  darwinOperations().unlinkAt(dirfd, name, 0);
}

export function lstatAt(dirfd: number, name: string): DirectoryEntryIdentity {
  return darwinOperations().lstatAt(dirfd, name);
}
