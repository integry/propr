import { randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import type { Stats } from "node:fs";
import { join, resolve } from "node:path";
import {
  PUBLIC_INSTANCE_IDENTITY_FILENAME,
  PUBLIC_INSTANCE_IDENTITY_SCHEMA_VERSION,
  parsePublicInstanceIdentityDocument,
} from "@propr/shared";
import { secureExistingPrivateDirectory, secureExistingPrivateFile } from "./utils/privateFilesystem.js";

const MAX_IDENTITY_FILE_BYTES = 1024;

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

function assertOwned(stat: Stats): void {
  if (process.platform === "win32") return;
  const uid = process.getuid?.();
  if (uid !== undefined && stat.uid !== uid) throw new ConnectRootError();
}

/** Resolve one explicit stack root without scanning or accepting a symlink root. */
export function resolveOwnedConnectRoot(flagRoot: string | undefined): string {
  if (!flagRoot) throw new ConnectRootError();
  try {
    const rootDir = resolve(flagRoot);
    const rootStat = lstatSync(rootDir);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new ConnectRootError();
    assertOwned(rootStat);
    // Resolve once after lstat and require the caller's authority to name the
    // same directory. This rejects roots whose terminal component changes via
    // a symlink without recursively searching any parent or sibling directory.
    if (realpathSync(rootDir) !== rootDir) throw new ConnectRootError();
    if (!secureExistingPrivateDirectory(join(rootDir, "data"))) throw new ConnectRootError();
    if (!secureExistingPrivateFile(join(rootDir, ".env"))) throw new ConnectRootError();
    return rootDir;
  } catch (error) {
    if (error instanceof ConnectRootError) throw error;
    throw new ConnectRootError();
  }
}

function readIdentity(filePath: string): string {
  try {
    const stat = lstatSync(filePath);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_IDENTITY_FILE_BYTES) {
      throw new PublicInstanceIdentityError();
    }
    const parsed = parsePublicInstanceIdentityDocument(JSON.parse(readFileSync(filePath, "utf8")));
    if (!parsed) throw new PublicInstanceIdentityError();
    return parsed.publicInstanceIdentity;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw error;
    if (error instanceof PublicInstanceIdentityError) throw error;
    throw new PublicInstanceIdentityError();
  }
}

/**
 * Read or atomically create the stack's public, non-secret installation id.
 * The containing data directory is the durable stack boundary.
 */
export function getOrCreatePublicInstanceIdentity(
  dataDir: string,
  generate: () => string = randomUUID,
): string {
  const filePath = join(dataDir, PUBLIC_INSTANCE_IDENTITY_FILENAME);
  try {
    return readIdentity(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const publicInstanceIdentity = generate();
  const document = `${JSON.stringify({
    schemaVersion: PUBLIC_INSTANCE_IDENTITY_SCHEMA_VERSION,
    publicInstanceIdentity,
  })}\n`;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(filePath, "wx", 0o644);
    writeFileSync(descriptor, document, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    return readIdentity(filePath);
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return readIdentity(filePath);
    throw error;
  }
}
