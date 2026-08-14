import { closeSync, constants, openSync } from "node:fs";
import { dirname, join } from "node:path";

export type DirectoryDescriptorAccess = "child-paths" | "working-directory";

/**
 * Linux exposes directory descriptors as traversable symlinks in procfs.
 * Darwin's fdescfs exposes the descriptor itself, but not children below it.
 */
export function directoryDescriptorAccess(platform: NodeJS.Platform = process.platform): DirectoryDescriptorAccess {
  if (platform === "linux") return "child-paths";
  if (platform === "darwin") return "working-directory";
  throw new Error(`safe directory-handle publication is not supported on ${platform}`);
}

/**
 * Run a synchronous operation relative to a held directory. On Darwin, chdir
 * pins name resolution to the held vnode; the original cwd is itself pinned
 * and restored by descriptor even if its visible pathname changes.
 */
export function withDirectoryDescriptorPath<T>(
  descriptorPath: string,
  access: DirectoryDescriptorAccess,
  operation: (base: string) => T
): T {
  if (access === "child-paths") return operation(descriptorPath);

  const flags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
  const originalDirectory = openSync(".", flags);
  try {
    process.chdir(descriptorPath);
    return operation(".");
  } finally {
    try {
      process.chdir(join(dirname(descriptorPath), String(originalDirectory)));
    } finally {
      closeSync(originalDirectory);
    }
  }
}
