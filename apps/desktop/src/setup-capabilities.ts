import { randomBytes } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
} from 'node:fs';
import { lstat, realpath, stat } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  ensurePrivateDirectory,
  secureExistingPrivateDirectory,
  writePrivateFileAtomic,
} from '@propr/local-setup';
import type { DesktopFilesystemSelection, DesktopSecretSelection } from './shared/contract';
import type { SetupActions } from '@propr/local-setup';

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

interface SecretRecord {
  sessionId: string;
  value: string;
  expiresAt: number;
}

const MAX_KEY_BYTES = 1024 * 1024;
const TTL_MS = 5 * 60_000;
const O_CLOEXEC = (constants as unknown as Record<string, number>).O_CLOEXEC ?? (process.platform === 'linux' ? 0o2000000 : 0);

export class SetupCapabilityError extends Error {
  constructor(message = 'The selected file, directory, or secret is no longer approved. Select it again.') {
    super(message);
    this.name = 'SetupCapabilityError';
  }
}

const safePath = (value: string): string => {
  if (!isAbsolute(value) || value.includes('\0')) throw new SetupCapabilityError();
  return resolve(value);
};

const assertOwner = (uid: bigint): void => {
  if (typeof process.getuid === 'function' && uid !== BigInt(process.getuid())) throw new SetupCapabilityError('The selection must be owned by the current user.');
};

export class RootDirectoryAuthority {
  readonly path: string;
  readonly #descriptor: number;
  readonly #device: bigint;
  readonly #inode: bigint;
  readonly #operationPath: string;
  #closed = false;

  private constructor(path: string, descriptor: number, device: bigint, inode: bigint) {
    this.path = path;
    this.#descriptor = descriptor;
    this.#device = device;
    this.#inode = inode;
    this.#operationPath = `/proc/${process.pid}/fd/${descriptor}`;
  }

  static open(path: string, create = false): RootDirectoryAuthority {
    const canonical = safePath(path);
    if (create) ensurePrivateDirectory(canonical);
    else secureExistingPrivateDirectory(canonical);
    const descriptor = openSync(canonical, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | O_CLOEXEC);
    try {
      const info = fstatSync(descriptor, { bigint: true });
      if (!info.isDirectory()) throw new SetupCapabilityError('The approved setup root is not a directory.');
      assertOwner(info.uid);
      return new RootDirectoryAuthority(canonical, descriptor, info.dev, info.ino);
    } catch (error) {
      closeSync(descriptor);
      throw error;
    }
  }

  validate(): void {
    if (this.#closed) throw new SetupCapabilityError('The setup directory authority expired. Select it again.');
    const anchored = fstatSync(this.#descriptor, { bigint: true });
    let current;
    try { current = lstatSync(this.path, { bigint: true }); } catch {
      throw new SetupCapabilityError('The selected setup directory changed. Select it again.');
    }
    if (!anchored.isDirectory() || !current.isDirectory() || current.isSymbolicLink()
      || anchored.dev !== this.#device || anchored.ino !== this.#inode
      || current.dev !== this.#device || current.ino !== this.#inode
      || realpathSync(this.path) !== this.path) {
      throw new SetupCapabilityError('The selected setup directory changed. Select it again.');
    }
    assertOwner(current.uid);
    for (const name of ['.env', 'data', 'logs', 'repos']) {
      const child = join(this.#operationPath, name);
      let info;
      try { info = lstatSync(child); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      if (info.isSymbolicLink()) throw new SetupCapabilityError('The setup directory contains an unsafe managed path.');
      if (name === '.env') {
        if (!info.isFile() || info.nlink !== 1) throw new SetupCapabilityError('The setup environment must be a non-linked regular file.');
      } else {
        const anchoredRoot = realpathSync(this.#operationPath);
        const childRelative = relative(anchoredRoot, realpathSync(child));
        if (!info.isDirectory() || childRelative.startsWith('..') || isAbsolute(childRelative)) {
          throw new SetupCapabilityError('The setup directory contains an unsafe managed path.');
        }
      }
    }
  }

  /** Stable main-process-only path for descriptor-relative managed operations. */
  operationPath(): string {
    this.validate();
    return this.#operationPath;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    closeSync(this.#descriptor);
  }
}

/**
 * Bind setup host actions to the held Linux directory descriptor. Only display
 * paths cross the setup engine; host I/O receives the descriptor-rooted path,
 * and Docker gets a fresh authority assertion at each container handoff.
 */
export function bindRootOperations(
  actions: SetupActions,
  displayRoot: string,
  authority: RootDirectoryAuthority,
): SetupActions {
  const guard = () => authority.validate();
  const operationRoot = authority.operationPath();
  const mapPath = (value: string, from: string, to: string): string => value === from || value.startsWith(`${from}${sep}`)
    ? `${to}${value.slice(from.length)}`
    : value;
  const transform = (value: unknown, from: string, to: string): unknown => {
    if (typeof value === 'string') return mapPath(value, from, to);
    if (typeof value === 'function') {
      return (...args: unknown[]) => Reflect.apply(value, undefined, args.map(argument => transform(argument, to, from)));
    }
    if (Array.isArray(value)) return value.map(item => transform(item, from, to));
    if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
      return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, transform(item, from, to)]));
    }
    return value;
  };
  const toOperation = (value: unknown) => transform(value, displayRoot, operationRoot);
  const toDisplay = (value: unknown) => transform(value, operationRoot, displayRoot);
  return new Proxy(actions, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        guard();
        const pathless = property === 'persistStackRoot' || property === 'getTunnelEnabled';
        const operationArgs = pathless ? args : args.map(toOperation);
        if (property === 'startStack' && operationArgs[0] && typeof operationArgs[0] === 'object') {
          operationArgs[0] = { ...(operationArgs[0] as Record<string, unknown>), assertRootAuthority: guard };
        }
        const result = Reflect.apply(value, target, operationArgs);
        if (result && typeof (result as PromiseLike<unknown>).then === 'function') {
          return Promise.resolve(result).then(output => { guard(); return toDisplay(output); });
        }
        guard();
        return toDisplay(result);
      };
    },
  });
}

export class SetupSecretCapabilities {
  readonly #records = new Map<string, SecretRecord>();
  readonly #now: () => number;

  constructor(now: () => number = Date.now) { this.#now = now; }

  issue(sessionId: string, value: string): DesktopSecretSelection {
    if (!value || value.length > 512 || /[\0\r\n]/.test(value)) throw new SetupCapabilityError('The webhook secret is invalid.');
    const capability = randomBytes(32).toString('base64url');
    this.#records.set(capability, { sessionId, value, expiresAt: this.#now() + TTL_MS });
    return { capability, label: 'Secret entered' };
  }

  validate(capability: string, sessionId: string): void {
    const record = this.#records.get(capability);
    if (!record || record.sessionId !== sessionId || record.expiresAt < this.#now()) throw new SetupCapabilityError();
  }

  consume(capability: string, sessionId: string): string {
    this.validate(capability, sessionId);
    const record = this.#records.get(capability)!;
    this.#records.delete(capability);
    return record.value;
  }

  clear(): void { this.#records.clear(); }
}

export class SetupFilesystemCapabilities {
  readonly #records = new Map<string, SelectionRecord>();
  readonly #now: () => number;

  constructor(now: () => number = Date.now) { this.#now = now; }

  async issue(kind: SelectionKind, sessionId: string, selectedPath: string): Promise<DesktopFilesystemSelection> {
    const originalPath = safePath(selectedPath);
    const before = await lstat(originalPath, { bigint: true });
    if (before.isSymbolicLink()) throw new SetupCapabilityError('Symbolic-link selections are not allowed.');
    if (kind === 'directory' ? !before.isDirectory() : !before.isFile()) throw new SetupCapabilityError();
    assertOwner(before.uid);
    if (kind === 'directory') secureExistingPrivateDirectory(originalPath);
    if (kind === 'private-key') {
      if ((before.mode & 0o077n) !== 0n) throw new SetupCapabilityError('The private-key file must not be accessible by group or other users.');
      if (before.nlink !== 1n || before.size <= 0n || before.size > BigInt(MAX_KEY_BYTES)) throw new SetupCapabilityError('The private-key file size or link count is invalid.');
    }
    const canonicalPath = await realpath(originalPath);
    if (canonicalPath !== originalPath) throw new SetupCapabilityError('Selections containing symbolic links are not allowed.');
    const canonical = await stat(canonicalPath, { bigint: true });
    if (canonical.dev !== before.dev || canonical.ino !== before.ino) throw new SetupCapabilityError();
    const capability = randomBytes(32).toString('base64url');
    this.#records.set(capability, { kind, sessionId, originalPath, canonicalPath, device: before.dev, inode: before.ino, expiresAt: this.#now() + TTL_MS });
    return { capability, label: kind === 'directory' ? canonicalPath : basename(canonicalPath) };
  }

  #take(capability: string, kind: SelectionKind, sessionId: string): SelectionRecord {
    const record = this.#records.get(capability);
    this.#records.delete(capability);
    if (!record || record.kind !== kind || record.sessionId !== sessionId || record.expiresAt < this.#now()) throw new SetupCapabilityError();
    return record;
  }

  async validate(capability: string, kind: SelectionKind, sessionId: string): Promise<string> {
    const record = this.#records.get(capability);
    if (!record || record.kind !== kind || record.sessionId !== sessionId || record.expiresAt < this.#now()) throw new SetupCapabilityError();
    const current = await lstat(record.originalPath, { bigint: true }).catch(() => null);
    if (!current || current.isSymbolicLink() || current.dev !== record.device || current.ino !== record.inode
      || (kind === 'directory' ? !current.isDirectory() : !current.isFile())) throw new SetupCapabilityError();
    if (await realpath(record.originalPath) !== record.canonicalPath) throw new SetupCapabilityError();
    if (kind === 'private-key' && ((current.mode & 0o077n) !== 0n || current.nlink !== 1n || current.size <= 0n || current.size > BigInt(MAX_KEY_BYTES))) throw new SetupCapabilityError();
    return record.canonicalPath;
  }

  async consumeDirectory(capability: string, sessionId: string): Promise<RootDirectoryAuthority> {
    await this.validate(capability, 'directory', sessionId);
    const record = this.#take(capability, 'directory', sessionId);
    return RootDirectoryAuthority.open(record.canonicalPath);
  }

  async consumePrivateKey(capability: string, sessionId: string, keyStorageDir: string): Promise<string> {
    const record = this.#take(capability, 'private-key', sessionId);
    ensurePrivateDirectory(keyStorageDir);
    const descriptor = openSync(record.originalPath, constants.O_RDONLY | constants.O_NOFOLLOW | O_CLOEXEC);
    try {
      const current = fstatSync(descriptor, { bigint: true });
      if (!current.isFile() || current.dev !== record.device || current.ino !== record.inode || current.nlink !== 1n
        || current.uid !== BigInt(process.getuid?.() ?? Number(current.uid)) || (current.mode & 0o077n) !== 0n
        || current.size <= 0n || current.size > BigInt(MAX_KEY_BYTES)) throw new SetupCapabilityError();
      const bytes = readFileSync(descriptor);
      const ownedPath = join(resolve(keyStorageDir), `${randomBytes(24).toString('hex')}.pem`);
      writePrivateFileAtomic(ownedPath, bytes);
      return ownedPath;
    } finally {
      closeSync(descriptor);
    }
  }

  consume(capabilities: string[]): void { for (const capability of capabilities) this.#records.delete(capability); }
  clear(): void { this.#records.clear(); }
}
