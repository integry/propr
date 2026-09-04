import { execFile as execFileCallback } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { chmod, lstat, mkdtemp, open, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
const HDIUTIL = '/usr/bin/hdiutil';
const MAX_DMG_BYTES = 8 * 1024 * 1024 * 1024;
const TRANSIENT_VERIFY_FAILURE = /^hdiutil: verify failed - (?:Resource temporarily unavailable|Resource busy)\s*$/;

const hashHeld = async (handle, size) => {
  const hash = createHash('sha256');
  const buffer = Buffer.alloc(1024 * 1024);
  let position = 0;
  while (position < Number(size)) {
    const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, Number(size) - position), position);
    if (bytesRead <= 0) throw new Error('DMG bytes changed while held');
    hash.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
  return hash.digest('hex');
};

const acquireCanonicalImage = async path => {
  const canonical = await realpath(path);
  if (canonical !== resolve(path)) throw new Error('DMG verification requires a canonical image pathname');
  const pathStats = await lstat(path, { bigint: true });
  if (!pathStats.isFile() || pathStats.isSymbolicLink() || pathStats.nlink !== 1n
    || pathStats.size <= 0n || pathStats.size > BigInt(MAX_DMG_BYTES)) {
    throw new Error('DMG verification requires one nonempty regular image');
  }
  const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const stats = await handle.stat({ bigint: true });
    if (!stats.isFile() || stats.dev !== pathStats.dev || stats.ino !== pathStats.ino
      || stats.size !== pathStats.size || stats.nlink !== 1n) {
      throw new Error('DMG identity changed before verification');
    }
    return { path: canonical, handle, stats, sha256: await hashHeld(handle, stats.size) };
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
};

const sameStats = (left, right) => left.dev === right.dev && left.ino === right.ino
  && left.size === right.size && left.nlink === right.nlink;

const reverifyHeld = async (image, label) => {
  const stats = await image.handle.stat({ bigint: true });
  if (!sameStats(stats, image.stats) || await hashHeld(image.handle, stats.size) !== image.sha256) {
    throw new Error(`DMG identity or checksum changed during ${label}`);
  }
  const pathStats = await lstat(image.path, { bigint: true }).catch(() => undefined);
  if (!pathStats || !sameStats(pathStats, stats) || pathStats.isSymbolicLink()) {
    throw new Error(`DMG pathname changed during ${label}`);
  }
};

const createProtectedSnapshot = async source => {
  const createdRoot = await mkdtemp(join(tmpdir(), 'propr-dmg-verify-'));
  const root = await realpath(createdRoot);
  const path = join(root, 'image.dmg');
  let writer;
  let handle;
  try {
    writer = await open(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL
      | fsConstants.O_NOFOLLOW, 0o600);
    const buffer = Buffer.alloc(1024 * 1024);
    let position = 0;
    while (position < Number(source.stats.size)) {
      const { bytesRead } = await source.handle.read(
        buffer, 0, Math.min(buffer.length, Number(source.stats.size) - position), position,
      );
      if (bytesRead <= 0) throw new Error('DMG bytes changed while creating the verification lease');
      let written = 0;
      while (written < bytesRead) {
        const result = await writer.write(buffer, written, bytesRead - written, position + written);
        if (result.bytesWritten <= 0) throw new Error('DMG verification snapshot write failed');
        written += result.bytesWritten;
      }
      position += bytesRead;
    }
    await writer.sync();
    await writer.close();
    writer = undefined;
    await chmod(path, 0o400);
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const stats = await handle.stat({ bigint: true });
    const sha256 = await hashHeld(handle, stats.size);
    if (!stats.isFile() || stats.nlink !== 1n || stats.size !== source.stats.size || sha256 !== source.sha256) {
      throw new Error('DMG verification snapshot does not match the held source');
    }
    // Deny creation, rename, and deletion for the entire hdiutil interval.
    // The randomized parent is searchable but neither enumerable nor writable.
    await chmod(root, 0o500);
    return { root, path, handle, stats, sha256 };
  } catch (error) {
    await writer?.close().catch(() => undefined);
    await handle?.close().catch(() => undefined);
    await chmod(root, 0o700).catch(() => undefined);
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
};

const releaseSnapshot = async snapshot => {
  await snapshot.handle.close().catch(() => undefined);
  await chmod(snapshot.root, 0o700).catch(() => undefined);
  await chmod(snapshot.path, 0o600).catch(() => undefined);
  await rm(snapshot.root, { recursive: true, force: true });
};

export const verifyDarwinImage = async (path, {
  run = (file, arguments_) => execFile(file, arguments_, { timeout: 120_000, maxBuffer: 64 * 1024 }),
  wait = milliseconds => new Promise(resolvePromise => setTimeout(resolvePromise, milliseconds)),
  nativePlatform = process.platform,
} = {}) => {
  if (nativePlatform !== 'darwin') throw new Error('DMG verification requires native macOS');
  const source = await acquireCanonicalImage(path);
  let snapshot;
  try {
    snapshot = await createProtectedSnapshot(source);
    await reverifyHeld(source, 'private snapshot creation');
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await run(HDIUTIL, ['verify', snapshot.path]);
      } catch (error) {
        const stderr = typeof error === 'object' && error !== null && typeof error.stderr === 'string' ? error.stderr : '';
        if (!TRANSIENT_VERIFY_FAILURE.test(stderr) || attempt === 2) {
          throw new Error(TRANSIENT_VERIFY_FAILURE.test(stderr)
            ? 'Native DMG verification remained busy after bounded retries'
            : 'Native DMG verification rejected the image');
        }
        await reverifyHeld(snapshot, 'verification retry');
        await reverifyHeld(source, 'verification retry');
        await wait(250 * (attempt + 1));
        continue;
      }
      await reverifyHeld(snapshot, 'verification');
      await reverifyHeld(source, 'verification');
      return { size: Number(source.stats.size), sha256: source.sha256, attempts: attempt + 1 };
    }
    throw new Error('Native DMG verification exhausted its bounded retry policy');
  } finally {
    try {
      if (snapshot) await releaseSnapshot(snapshot);
    } finally {
      await source.handle.close().catch(() => undefined);
    }
  }
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) throw new Error('Expected exactly one DMG pathname');
  await verifyDarwinImage(process.argv[2]);
  process.stdout.write('Native DMG verification passed\n');
}
