import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { assertRealDirectory } from './lifecycle.js';
import { StorageContractError } from './cleanupRequest.js';

/**
 * Cross-process export admission. Every lock generation has a unique, never
 * rebound name (`lease-<token>`), so recovery never races a reused name:
 *
 * 1. Publish `pending-<token>/owner.json`, then atomically rename it to `lease-<token>`.
 * 2. List the root. Any other live, malformed or unsafe lock fails closed. Of
 *    two concurrent admitters, whichever lists last sees the other: at most one
 *    is admitted, and only an admitted holder recovers expired locks.
 * 3. Recovery claims a stale lock by renaming it to a unique `retired-*` name,
 *    then erases only the fixed-name snapshot it names.
 *
 * Expiry alone is sufficient once a grace period has elapsed: an expired job
 * can never be redeemed, and its worker deadline is far shorter than the TTL.
 * A proven-dead owner (same Linux PID namespace) is recoverable at expiry.
 */
export const EXPORT_TTL = 5 * 60_000;
export const EXPORT_LOCK_GRACE = 60_000;
const OWNER = 'owner.json';
const LEGACY = 'active';
const TOKEN = '[0-9a-f]{32}';
const LEASE = new RegExp(`^lease-(${TOKEN})$`);
const PENDING = new RegExp(`^pending-(${TOKEN})$`);
const RETIRED = new RegExp(`^retired-${TOKEN}$`);
const SNAPSHOT = new RegExp(`^snapshot-${TOKEN}$`);
const LEGACY_SNAPSHOT = /^snapshot-[A-Za-z0-9]{6}$/;

export class DatabaseExportLockError extends StorageContractError {
  constructor(message: string) { super(409, message); }
}
const busy = () => new DatabaseExportLockError('Another database export is in progress. Wait for it to finish or expire, then try again.');
const unsafe = () => new DatabaseExportLockError('A previous database export left a lock or files that cannot be recovered automatically. An operator must inspect the instance export storage.');
const recoverableLater = (at: number) => new DatabaseExportLockError(`A previous database export expired and its lock can be recovered after ${new Date(at).toISOString()}. Try again then.`);

interface Owner { pid: number; pidNamespace: string | null; expiresAt: number; directory: string; token?: string }
interface Lock { name: string; dev: number; ino: number; owner?: Owner; recoverableAt: number }

const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
const ignoreMissing = (error: unknown) => { if (!missing(error)) throw error; };
const newToken = () => randomUUID().replace(/-/g, '');
function ownerPrivate(stat: { mode: number; uid: number }) {
  return (stat.mode & 0o077) === 0 && (typeof process.getuid !== 'function' || stat.uid === process.getuid());
}
export const exportSnapshotName = (token: string) => `snapshot-${token}`;
async function pidNamespace() {
  return process.platform === 'linux' ? fs.readlink('/proc/self/ns/pid').catch(() => null) : null;
}

async function readOwner(directory: string): Promise<Owner | undefined> {
  let handle: fs.FileHandle;
  try { handle = await fs.open(path.join(directory, OWNER), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if (missing(error)) return undefined; throw unsafe(); }
  let owner: Owner;
  try {
    const stat = await handle.stat();
    // Unlinked after opening: a concurrent release, not an unsafe link.
    if (stat.isFile() && stat.nlink === 0) return undefined;
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 2048 || !ownerPrivate(stat)) throw unsafe();
    try { owner = JSON.parse(await handle.readFile('utf8')); } catch { throw unsafe(); }
  } finally { await handle.close(); }
  if (!owner || typeof owner !== 'object' || !Number.isSafeInteger(owner.pid) || owner.pid < 1 || !Number.isFinite(owner.expiresAt)
    || (owner.pidNamespace !== null && typeof owner.pidNamespace !== 'string') || typeof owner.directory !== 'string') throw unsafe();
  return owner;
}

/** Earliest time an expired owner's lock may be recovered. */
async function recoverableAt(owner: Owner): Promise<number> {
  if (owner.pidNamespace !== null && owner.pidNamespace === await pidNamespace()) {
    try { process.kill(owner.pid, 0); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return owner.expiresAt; }
  }
  return owner.expiresAt + EXPORT_LOCK_GRACE;
}

async function inspect(root: string, name: string): Promise<Lock | undefined> {
  const directory = path.join(root, name);
  let stat;
  try { stat = await fs.lstat(directory); } catch (error) { ignoreMissing(error); return undefined; }
  if (!stat.isDirectory() || !ownerPrivate(stat)) throw unsafe();
  const owner = await readOwner(directory);
  const token = LEASE.exec(name)?.[1] ?? PENDING.exec(name)?.[1];
  if (owner && !(token ? owner.token === token && owner.directory === exportSnapshotName(token)
    : name === LEGACY ? LEGACY_SNAPSHOT.test(owner.directory) : SNAPSHOT.test(owner.directory) || LEGACY_SNAPSHOT.test(owner.directory))) throw unsafe();
  let at: number;
  // A retired lock was already claimed by an earlier, interrupted recovery.
  if (RETIRED.test(name)) at = 0;
  else if (owner) at = await recoverableAt(owner);
  // A published lease without an owner is mid-release; its snapshot is already erased.
  else if (LEASE.test(name)) at = 0;
  // An unpublished or legacy lock may still be initializing.
  else at = stat.mtimeMs + EXPORT_TTL + EXPORT_LOCK_GRACE;
  return { name, dev: stat.dev, ino: stat.ino, owner, recoverableAt: at };
}

/** Erase a private snapshot containing only fixed SQLite names. Tolerates concurrent erasure. */
export async function eraseExportSnapshot(directory: string): Promise<void> {
  try { await assertRealDirectory(directory); } catch (error) { ignoreMissing(error); return; }
  let handle: fs.FileHandle;
  try { handle = await fs.open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); }
  catch (error) { ignoreMissing(error); return; }
  try {
    const pinned = process.platform === 'linux' ? `/proc/self/fd/${handle.fd}` : directory;
    const entries = await fs.readdir(pinned);
    if (entries.length > 4 || entries.some(name => !/^database\.sqlite(?:-wal|-shm|-journal)?$/.test(name))) throw new Error('Unknown export files');
    for (const name of entries) {
      const stat = await fs.lstat(path.join(pinned, name)).catch(error => { ignoreMissing(error); return undefined; });
      if (stat && (!stat.isFile() || stat.nlink !== 1)) throw new Error('Unsafe export file');
    }
    for (const name of entries) await fs.unlink(path.join(pinned, name)).catch(ignoreMissing);
    let current;
    try { current = await fs.lstat(directory); } catch (error) { ignoreMissing(error); return; }
    const original = await handle.stat();
    if (current.dev !== original.dev || current.ino !== original.ino) throw new Error('Export moved');
    await fs.rmdir(directory).catch(ignoreMissing);
  } finally { await handle.close(); }
}

async function retire(root: string, lock: Lock) {
  let claimed = path.join(root, lock.name);
  if (!RETIRED.test(lock.name)) {
    claimed = path.join(root, `retired-${newToken()}`);
    // Atomic claim: a concurrent release by a still-running expired owner wins or loses cleanly.
    try { await fs.rename(path.join(root, lock.name), claimed); } catch (error) { ignoreMissing(error); return; }
    const stat = await fs.lstat(claimed);
    if (stat.dev !== lock.dev || stat.ino !== lock.ino) {
      // Only an older runtime can rebind the legacy name: restore it and fail closed.
      await fs.rename(claimed, path.join(root, lock.name)).catch(() => undefined);
      throw unsafe();
    }
  }
  try {
    if (lock.owner) await eraseExportSnapshot(path.join(root, lock.owner.directory));
    await fs.unlink(path.join(claimed, OWNER)).catch(ignoreMissing);
    await fs.rmdir(claimed).catch(ignoreMissing);
  } catch { throw unsafe(); }
}

const lockName = (name: string) => name === LEGACY || LEASE.test(name) || PENDING.test(name) || RETIRED.test(name);

async function admit(root: string, token: string) {
  const now = Date.now();
  const stale: Lock[] = [];
  let later = 0;
  for (const name of await fs.readdir(root)) {
    if (name === `lease-${token}` || !lockName(name)) continue;
    const lock = await inspect(root, name);
    if (!lock) continue;
    if (lock.recoverableAt <= now) stale.push(lock);
    else if (!lock.owner || lock.owner.expiresAt > now) throw busy();
    else later = Math.max(later, lock.recoverableAt);
  }
  if (later) throw recoverableLater(later);
  for (const lock of stale) await retire(root, lock);
}

/** Acquire exclusive export admission, recovering expired locks. Never steals a live one. */
export async function acquireExportLease(root: string, expiresAt: number): Promise<string> {
  await assertRealDirectory(root);
  const token = newToken();
  const pending = path.join(root, `pending-${token}`);
  const owner: Owner = { token, pid: process.pid, pidNamespace: await pidNamespace(), expiresAt, directory: exportSnapshotName(token) };
  await fs.mkdir(pending, { mode: 0o700 });
  try {
    await fs.writeFile(path.join(pending, OWNER), JSON.stringify(owner), { flag: 'wx', mode: 0o600 });
    await fs.rename(pending, path.join(root, `lease-${token}`));
  } catch (error) {
    await fs.unlink(path.join(pending, OWNER)).catch(() => undefined);
    await fs.rmdir(pending).catch(() => undefined);
    throw error;
  }
  try {
    await admit(root, token);
    await fs.mkdir(path.join(root, owner.directory), { mode: 0o700 });
  } catch (error) {
    await releaseExportLease(root, token).catch(() => undefined);
    throw error;
  }
  return token;
}

/** Release this process's own lease; tolerant of concurrent recovery after expiry. */
export async function releaseExportLease(root: string, token: string): Promise<void> {
  const lease = path.join(root, `lease-${token}`);
  try { await assertRealDirectory(lease); } catch (error) { ignoreMissing(error); return; }
  await fs.unlink(path.join(lease, OWNER)).catch(ignoreMissing);
  await fs.rmdir(lease).catch(ignoreMissing);
}

/**
 * Read-only probe: is any lock recoverable now? Lets background recovery skip
 * acquiring a lease (and contending with a user's start) when nothing is stale.
 * Unsafe or busy states are left for admission to report; admission re-verifies.
 */
async function hasRecoverableLock(root: string): Promise<boolean> {
  let names: string[];
  try { await assertRealDirectory(root); names = await fs.readdir(root); }
  catch (error) { ignoreMissing(error); return false; }
  const now = Date.now();
  for (const name of names.filter(lockName)) {
    const lock = await inspect(root, name).catch(() => undefined);
    if (lock && lock.recoverableAt <= now) return true;
  }
  return false;
}

/** Opportunistic background recovery of expired locks; never contends with a live job. */
export async function recoverExpiredExportLocks(root: string): Promise<void> {
  if (!await hasRecoverableLock(root)) return;
  const token = await acquireExportLease(root, Date.now() + EXPORT_LOCK_GRACE);
  await fs.rmdir(path.join(root, exportSnapshotName(token))).catch(ignoreMissing);
  await releaseExportLease(root, token);
}
