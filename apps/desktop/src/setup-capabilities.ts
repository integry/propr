import { randomBytes } from 'node:crypto';
import {
  closeSync, constants, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync,
  readSync, realpathSync, renameSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { lstat, realpath } from 'node:fs/promises';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';
import type { SetupActions } from '@propr/local-setup';
import type { DesktopFilesystemSelection, DesktopSecretSelection } from './shared/contract';

const TTL_MS = 5 * 60_000;
const MAX_KEY_BYTES = 1024 * 1024;
const O_CLOEXEC = (constants as unknown as Record<string, number>).O_CLOEXEC ?? 0;

export class SetupCapabilityError extends Error {
  constructor(message = 'The selected file or secret is no longer approved. Select it again.') {
    super(message); this.name = 'SetupCapabilityError';
  }
}

const assertOwner = (uid: bigint): void => {
  if (typeof process.getuid === 'function' && uid !== BigInt(process.getuid())) throw new SetupCapabilityError('The selection must be owned by the current user.');
};

const readBoundedKey = (fd: number): Buffer => {
  const buffer = Buffer.allocUnsafe(MAX_KEY_BYTES + 1);
  let offset = 0;
  while (offset < buffer.length) {
    const count = readSync(fd, buffer, offset, buffer.length - offset, null);
    if (count === 0) break;
    offset += count;
  }
  if (offset === 0 || offset > MAX_KEY_BYTES) {
    throw new SetupCapabilityError('Choose a non-empty private key no larger than 1 MiB.');
  }
  return buffer.subarray(0, offset);
};

const ensurePrivateDirectory = (path: string): void => {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const info = lstatSync(path, { bigint: true });
  if (!info.isDirectory() || info.isSymbolicLink() || realpathSync(path) !== resolve(path)) throw new SetupCapabilityError('The setup directory must be a real directory.');
  assertOwner(info.uid);
  if ((info.mode & 0o777n) !== 0o700n) {
    const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | O_CLOEXEC);
    try { fchmodSync(fd, 0o700); } finally { closeSync(fd); }
  }
};

export class RootDirectoryAuthority {
  readonly path: string;
  readonly #boundary: string;
  readonly #fd: number;
  readonly #device: bigint;
  readonly #inode: bigint;
  #closed = false;

  private constructor(path: string, boundary: string, fd: number, device: bigint, inode: bigint) {
    this.path = path; this.#boundary = boundary; this.#fd = fd; this.#device = device; this.#inode = inode;
  }

  static open(path: string, boundary: string): RootDirectoryAuthority {
    const canonicalBoundary = resolve(boundary);
    const canonical = resolve(path);
    const scope = relative(canonicalBoundary, canonical);
    if (!scope || scope.startsWith('..') || isAbsolute(scope) || canonical.includes('\0')) throw new SetupCapabilityError('The fixed setup root is outside app data.');
    ensurePrivateDirectory(canonicalBoundary);
    let cursor = canonicalBoundary;
    for (const segment of scope.split(sep).filter(Boolean)) { cursor = resolve(cursor, segment); ensurePrivateDirectory(cursor); }
    const fd = openSync(canonical, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | O_CLOEXEC);
    const info = fstatSync(fd, { bigint: true });
    return new RootDirectoryAuthority(canonical, canonicalBoundary, fd, info.dev, info.ino);
  }

  validate(): void {
    if (this.#closed) throw new SetupCapabilityError('The setup directory authority expired.');
    const anchored = fstatSync(this.#fd, { bigint: true });
    const current = lstatSync(this.path, { bigint: true });
    if (!anchored.isDirectory() || !current.isDirectory() || current.isSymbolicLink()
      || anchored.dev !== this.#device || anchored.ino !== this.#inode || current.dev !== this.#device
      || current.ino !== this.#inode || realpathSync(this.path) !== this.path) throw new SetupCapabilityError('The setup directory changed during setup.');
    assertOwner(current.uid);
    const scope = relative(this.#boundary, this.path);
    if (!scope || scope.startsWith('..') || isAbsolute(scope)) throw new SetupCapabilityError();
  }

  close(): void { if (!this.#closed) { this.#closed = true; closeSync(this.#fd); } }
}

const isThenable = (value: unknown): value is PromiseLike<unknown> => (
  (typeof value === 'object' && value !== null) || typeof value === 'function'
) && typeof (value as PromiseLike<unknown>).then === 'function';

/** Revalidate the fixed root around every setup host action and Docker handoff. */
export const bindRootOperations = (actions: SetupActions, authority: RootDirectoryAuthority): SetupActions => new Proxy(actions, {
  get(target, property, receiver) {
    const value = Reflect.get(target, property, receiver);
    if (typeof value !== 'function') return value;
    return (...args: unknown[]) => {
      authority.validate();
      if ((property === 'pullImages' || property === 'startStack' || property === 'replaceRunningStack'
        || property === 'checkBackendHealth') && args[0] && typeof args[0] === 'object') {
        args[0] = { ...(args[0] as Record<string, unknown>), assertRootAuthority: () => authority.validate() };
      }
      const result = Reflect.apply(value, target, args);
      if (!isThenable(result)) {
        authority.validate();
        return result;
      }
      return Promise.resolve(result).then(output => { authority.validate(); return output; }, error => { authority.validate(); throw error; });
    };
  },
});

interface FileRecord { sessionId: string; path: string; canonical: string; device: bigint; inode: bigint; expiresAt: number }
export class SetupFilesystemCapabilities {
  readonly #records = new Map<string, FileRecord>();
  async issue(sessionId: string, selectedPath: string, signal?: AbortSignal): Promise<DesktopFilesystemSelection> {
    signal?.throwIfAborted();
    if (!isAbsolute(selectedPath) || selectedPath.includes('\0')) throw new SetupCapabilityError();
    const path = resolve(selectedPath);
    const before = await lstat(path, { bigint: true });
    const canonical = await realpath(path);
    signal?.throwIfAborted();
    if (!before.isFile() || before.isSymbolicLink() || canonical !== path || before.nlink !== 1n
      || before.size <= 0n || before.size > BigInt(MAX_KEY_BYTES) || (before.mode & 0o077n) !== 0n) throw new SetupCapabilityError('Choose an owner-only regular key file.');
    assertOwner(before.uid);
    const capability = randomBytes(32).toString('base64url');
    this.#records.set(capability, { sessionId, path, canonical, device: before.dev, inode: before.ino, expiresAt: Date.now() + TTL_MS });
    return { capability, label: basename(path) };
  }
  async consume(capability: string, sessionId: string, storageDir: string, signal?: AbortSignal): Promise<string> {
    const record = this.#records.get(capability); this.#records.delete(capability);
    signal?.throwIfAborted();
    if (!record || record.sessionId !== sessionId || record.expiresAt < Date.now()) throw new SetupCapabilityError();
    const current = await lstat(record.path, { bigint: true });
    if (!current.isFile() || current.isSymbolicLink() || current.dev !== record.device || current.ino !== record.inode
      || await realpath(record.path) !== record.canonical || current.nlink !== 1n || (current.mode & 0o077n) !== 0n) throw new SetupCapabilityError();
    ensurePrivateDirectory(storageDir);
    const source = openSync(record.path, constants.O_RDONLY | constants.O_NOFOLLOW | O_CLOEXEC);
    const target = resolve(storageDir, `${randomBytes(24).toString('hex')}.pem`);
    const temporary = `${target}.tmp`;
    try {
      const opened = fstatSync(source, { bigint: true });
      if (!opened.isFile() || opened.dev !== record.device || opened.ino !== record.inode
        || opened.nlink !== 1n || (opened.mode & 0o077n) !== 0n
        || opened.size <= 0n || opened.size > BigInt(MAX_KEY_BYTES)) throw new SetupCapabilityError();
      assertOwner(opened.uid);
      signal?.throwIfAborted();
      const contents = readBoundedKey(source);
      const consumed = fstatSync(source, { bigint: true });
      if (!consumed.isFile() || consumed.dev !== opened.dev || consumed.ino !== opened.ino
        || consumed.nlink !== 1n || consumed.uid !== opened.uid || (consumed.mode & 0o077n) !== 0n
        || consumed.size <= 0n || consumed.size > BigInt(MAX_KEY_BYTES)) throw new SetupCapabilityError();
      writeFileSync(temporary, contents, { mode: 0o600, flag: 'wx' });
      signal?.throwIfAborted();
      renameSync(temporary, target);
      return target;
    } catch (error) { try { unlinkSync(temporary); } catch { /* not created */ } throw error; }
    finally { closeSync(source); }
  }
  clear(): void { this.#records.clear(); }
}

interface SecretRecord { sessionId: string; value: string; expiresAt: number }
export class SetupSecretCapabilities {
  readonly #records = new Map<string, SecretRecord>();
  issue(sessionId: string, value: string): DesktopSecretSelection {
    if (value.length < 16 || value.length > 512 || /[\0\r\n]/.test(value)) throw new SetupCapabilityError('The webhook secret is invalid.');
    const capability = randomBytes(32).toString('base64url');
    this.#records.set(capability, { sessionId, value, expiresAt: Date.now() + TTL_MS });
    return { capability, label: 'Secret entered' };
  }
  consume(capability: string, sessionId: string, signal?: AbortSignal): string {
    signal?.throwIfAborted();
    const record = this.#records.get(capability); this.#records.delete(capability);
    if (!record || record.sessionId !== sessionId || record.expiresAt < Date.now()) throw new SetupCapabilityError();
    signal?.throwIfAborted();
    return record.value;
  }
  clear(): void { this.#records.clear(); }
}
