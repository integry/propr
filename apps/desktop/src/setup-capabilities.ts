import { randomBytes } from 'node:crypto';
import { lstat, realpath, stat } from 'node:fs/promises';
import { basename, isAbsolute, resolve } from 'node:path';
import type { DesktopFilesystemSelection } from './shared/contract';

type SelectionKind = 'directory' | 'private-key';

interface SelectionRecord {
  kind: SelectionKind;
  sessionId: string;
  originalPath: string;
  canonicalPath: string;
  device: bigint;
  inode: bigint;
  expiresAt: number;
}

const MAX_KEY_BYTES = 1024 * 1024;
const TTL_MS = 5 * 60_000;

export class SetupCapabilityError extends Error {
  constructor(message = 'The selected file or directory is no longer approved. Select it again.') {
    super(message);
    this.name = 'SetupCapabilityError';
  }
}

const safePath = (value: string): string => {
  if (!isAbsolute(value) || value.includes('\0')) throw new SetupCapabilityError();
  return resolve(value);
};

export const validatePrivateKeyPath = async (value: string): Promise<string> => {
  const path = safePath(value);
  const info = await lstat(path, { bigint: true });
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077n) !== 0n || info.size <= 0n || info.size > BigInt(MAX_KEY_BYTES)) throw new SetupCapabilityError();
  if (typeof process.getuid === 'function' && info.uid !== BigInt(process.getuid())) throw new SetupCapabilityError();
  if (await realpath(path) !== path) throw new SetupCapabilityError();
  return path;
};

export class SetupFilesystemCapabilities {
  readonly #records = new Map<string, SelectionRecord>();
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  async issue(kind: SelectionKind, sessionId: string, selectedPath: string): Promise<DesktopFilesystemSelection> {
    const originalPath = safePath(selectedPath);
    const before = await lstat(originalPath, { bigint: true });
    if (before.isSymbolicLink()) throw new SetupCapabilityError('Symbolic-link selections are not allowed.');
    if (kind === 'directory' ? !before.isDirectory() : !before.isFile()) throw new SetupCapabilityError();
    if (kind === 'private-key') {
      if ((before.mode & 0o077n) !== 0n) throw new SetupCapabilityError('The private-key file must not be accessible by group or other users.');
      if (before.size <= 0n || before.size > BigInt(MAX_KEY_BYTES)) throw new SetupCapabilityError('The private-key file size is invalid.');
      if (typeof process.getuid === 'function' && before.uid !== BigInt(process.getuid())) throw new SetupCapabilityError('The private-key file must be owned by the current user.');
    }
    const canonicalPath = await realpath(originalPath);
    if (canonicalPath !== originalPath) throw new SetupCapabilityError('Selections containing symbolic links are not allowed.');
    const canonical = await stat(canonicalPath, { bigint: true });
    if (canonical.dev !== before.dev || canonical.ino !== before.ino) throw new SetupCapabilityError();
    const capability = randomBytes(32).toString('base64url');
    this.#records.set(capability, {
      kind,
      sessionId,
      originalPath,
      canonicalPath,
      device: before.dev,
      inode: before.ino,
      expiresAt: this.#now() + TTL_MS,
    });
    return { capability, label: kind === 'directory' ? canonicalPath : basename(canonicalPath) };
  }

  async validate(capability: string, kind: SelectionKind, sessionId: string): Promise<string> {
    const record = this.#records.get(capability);
    if (!record || record.kind !== kind || record.sessionId !== sessionId || record.expiresAt < this.#now()) throw new SetupCapabilityError();
    const current = await lstat(record.originalPath, { bigint: true }).catch(() => null);
    if (!current || current.isSymbolicLink() || current.dev !== record.device || current.ino !== record.inode
      || (kind === 'directory' ? !current.isDirectory() : !current.isFile())) throw new SetupCapabilityError();
    if (await realpath(record.originalPath) !== record.canonicalPath) throw new SetupCapabilityError();
    if (kind === 'private-key' && ((current.mode & 0o077n) !== 0n || current.size <= 0n || current.size > BigInt(MAX_KEY_BYTES))) throw new SetupCapabilityError();
    return record.canonicalPath;
  }

  consume(capabilities: string[]): void {
    for (const capability of capabilities) this.#records.delete(capability);
  }

  clear(): void {
    this.#records.clear();
  }
}
