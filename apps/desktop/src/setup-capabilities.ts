import { randomBytes } from 'node:crypto';
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  type BigIntStats,
} from 'node:fs';
import { lstat, realpath, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  ensurePrivateDirectory,
  writePrivateFileAtomic,
} from '@propr/local-setup';
import type { DesktopFilesystemSelection, DesktopSecretSelection } from './shared/contract';
import type { SetupActions } from '@propr/local-setup';

type SelectionKind = 'private-key';

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
  readonly #privateBoundary: string;
  readonly #descriptor: number;
  readonly #device: bigint;
  readonly #inode: bigint;
  readonly #operationPath: string;
  #closed = false;

  private constructor(path: string, privateBoundary: string, descriptor: number, device: bigint, inode: bigint) {
    this.path = path;
    this.#privateBoundary = privateBoundary;
    this.#descriptor = descriptor;
    this.#device = device;
    this.#inode = inode;
    this.#operationPath = `/proc/${process.pid}/fd/${descriptor}`;
  }

  static open(path: string, create = false, privateBoundary = dirname(path)): RootDirectoryAuthority {
    const canonical = safePath(path);
    const boundary = safePath(privateBoundary);
    ensurePrivateAncestry(boundary, canonical, create);
    const descriptor = openSync(canonical, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | O_CLOEXEC);
    try {
      const info = fstatSync(descriptor, { bigint: true });
      if (!info.isDirectory()) throw new SetupCapabilityError('The approved setup root is not a directory.');
      assertOwner(info.uid);
      return new RootDirectoryAuthority(canonical, boundary, descriptor, info.dev, info.ino);
    } catch (error) {
      closeSync(descriptor);
      throw error;
    }
  }

  validate(): void {
    if (this.#closed) throw new SetupCapabilityError('The setup directory authority expired. Select it again.');
    ensurePrivateAncestry(this.#privateBoundary, this.path, false);
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
      try { info = lstatSync(child, { bigint: true }); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      if (info.isSymbolicLink()) throw new SetupCapabilityError('The setup directory contains an unsafe managed path.');
      assertOwner(info.uid);
      if (name === '.env') {
        if (!info.isFile() || info.nlink !== 1n) throw new SetupCapabilityError('The setup environment must be a non-linked regular file.');
        enforceModeNoFollow(child, info, 0o600, false);
      } else {
        const anchoredRoot = realpathSync(this.#operationPath);
        const childRelative = relative(anchoredRoot, realpathSync(child));
        if (!info.isDirectory() || childRelative.startsWith('..') || isAbsolute(childRelative)) {
          throw new SetupCapabilityError('The setup directory contains an unsafe managed path.');
        }
        enforceModeNoFollow(child, info, 0o700, true);
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
 * Establish and revalidate the fixed runtime root beneath Electron's app-data
 * boundary. Every app-owned component is an owner-only real directory; links
 * and path replacement are rejected before a Docker lifecycle handoff.
 */
function ensurePrivateAncestry(boundaryPath: string, rootPath: string, create: boolean): void {
  const boundary = resolve(boundaryPath);
  const root = resolve(rootPath);
  const suffix = relative(boundary, root);
  if (!suffix || suffix.startsWith('..') || isAbsolute(suffix)) throw new SetupCapabilityError('The fixed setup root is outside the app-data boundary.');
  const components = suffix ? suffix.split(sep).filter(Boolean) : [];
  let cursor = boundary;
  const paths = [boundary, ...components.map(component => (cursor = join(cursor, component)))];
  for (let index = 0; index < paths.length; index += 1) {
    const current = paths[index];
    let info;
    try {
      info = lstatSync(current, { bigint: true });
    } catch (error) {
      if (!create || (error as NodeJS.ErrnoException).code !== 'ENOENT' || index === 0) throw error;
      mkdirSync(current, { mode: 0o700 });
      info = lstatSync(current, { bigint: true });
    }
    if (!info.isDirectory() || info.isSymbolicLink() || realpathSync(current) !== current) {
      throw new SetupCapabilityError('The fixed setup root ancestry must contain only real directories.');
    }
    assertOwner(info.uid);
    enforceModeNoFollow(current, info, 0o700, true);
  }
}

function enforceModeNoFollow(
  path: string,
  expected: BigIntStats,
  mode: number,
  directory: boolean,
): void {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | O_CLOEXEC | (directory ? constants.O_DIRECTORY : 0));
  try {
    const opened = fstatSync(descriptor, { bigint: true });
    if (opened.dev !== expected.dev || opened.ino !== expected.ino
      || (directory ? !opened.isDirectory() : !opened.isFile())) {
      throw new SetupCapabilityError('The fixed setup root identity changed during validation.');
    }
    assertOwner(opened.uid);
    if ((opened.mode & 0o777n) !== BigInt(mode)) fchmodSync(descriptor, mode);
  } finally {
    closeSync(descriptor);
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
  const descriptorActions = new Set([
    'runChecks',
    'inspectStackInit',
    'inspectDatastoreAdministrators',
    'scaffoldStack',
    'readEnvVars',
    'applyEnvSelection',
    'clearEnvKeys',
    'detectGithubAuthMode',
    'prepareAgentCredentialDir',
  ]);
  const toOperation = (value: unknown) => transform(value, displayRoot, operationRoot);
  const toDisplay = (value: unknown) => transform(value, operationRoot, displayRoot);
  return new Proxy(actions, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        guard();
        const descriptorRelative = typeof property === 'string' && descriptorActions.has(property);
        const operationArgs = descriptorRelative ? args.map(toOperation) : args;
        if (property === 'startStack' && operationArgs[0] && typeof operationArgs[0] === 'object') {
          operationArgs[0] = { ...(operationArgs[0] as Record<string, unknown>), rootOperationsDir: operationRoot, assertRootAuthority: guard };
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
    if (!before.isFile()) throw new SetupCapabilityError();
    assertOwner(before.uid);
    if ((before.mode & 0o077n) !== 0n) throw new SetupCapabilityError('The private-key file must not be accessible by group or other users.');
    if (before.nlink !== 1n || before.size <= 0n || before.size > BigInt(MAX_KEY_BYTES)) throw new SetupCapabilityError('The private-key file size or link count is invalid.');
    const canonicalPath = await realpath(originalPath);
    if (canonicalPath !== originalPath) throw new SetupCapabilityError('Selections containing symbolic links are not allowed.');
    const canonical = await stat(canonicalPath, { bigint: true });
    if (canonical.dev !== before.dev || canonical.ino !== before.ino) throw new SetupCapabilityError();
    const capability = randomBytes(32).toString('base64url');
    this.#records.set(capability, { kind, sessionId, originalPath, canonicalPath, device: before.dev, inode: before.ino, expiresAt: this.#now() + TTL_MS });
    return { capability, label: basename(canonicalPath) };
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
      || !current.isFile()) throw new SetupCapabilityError();
    if (await realpath(record.originalPath) !== record.canonicalPath) throw new SetupCapabilityError();
    if ((current.mode & 0o077n) !== 0n || current.nlink !== 1n || current.size <= 0n || current.size > BigInt(MAX_KEY_BYTES)) throw new SetupCapabilityError();
    return record.canonicalPath;
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
