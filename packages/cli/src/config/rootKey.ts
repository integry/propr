import path from "node:path";

/** Canonical key for persisted settings scoped to one exact stack root. */
export function canonicalRootKey(root: string, platform: NodeJS.Platform = process.platform): string {
  if (typeof root !== "string" || root.length === 0 || root.includes("\0")) {
    throw new Error("Invalid stack root key");
  }
  if (platform === "win32") {
    if (!path.win32.isAbsolute(root)) throw new Error("Invalid stack root key");
    return path.win32.normalize(path.win32.resolve(root)).toLowerCase();
  }
  if (platform === "linux" || platform === "darwin") {
    if (!path.posix.isAbsolute(root)) throw new Error("Invalid stack root key");
    return path.posix.normalize(path.posix.resolve(root));
  }
  throw new Error("Invalid stack root key");
}
