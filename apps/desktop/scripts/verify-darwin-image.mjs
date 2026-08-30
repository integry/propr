import { execFile as execFileCallback } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
const MAX_DMG_BYTES = 8 * 1024 * 1024 * 1024;
const TRANSIENT_VERIFY_FAILURE = /^hdiutil: verify failed - (?:Resource temporarily unavailable|Resource busy)\s*$/;

const capture = async path => {
  const canonical = await realpath(path);
  if (canonical !== resolve(path)) throw new Error('DMG verification requires a canonical image pathname');
  const pathStats = await lstat(path, { bigint: true });
  if (!pathStats.isFile() || pathStats.isSymbolicLink() || pathStats.nlink !== 1n
    || pathStats.size <= 0n || pathStats.size > BigInt(MAX_DMG_BYTES)) {
    throw new Error('DMG verification requires one nonempty regular image');
  }
  const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const before = await handle.stat({ bigint: true });
    if (before.dev !== pathStats.dev || before.ino !== pathStats.ino || before.size !== pathStats.size
      || before.nlink !== 1n) throw new Error('DMG identity changed before verification');
    const hash = createHash('sha256');
    const buffer = Buffer.alloc(1024 * 1024);
    let position = 0;
    while (position < Number(before.size)) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, Number(before.size) - position), position);
      if (bytesRead <= 0) throw new Error('DMG bytes changed before verification');
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size || after.nlink !== before.nlink) {
      throw new Error('DMG identity changed while hashing');
    }
    return { dev: after.dev, ino: after.ino, size: after.size, sha256: hash.digest('hex') };
  } finally {
    // hdiutil must never race a maker/hash descriptor retained by this process.
    await handle.close();
  }
};

const sameCapture = (left, right) => left.dev === right.dev && left.ino === right.ino
  && left.size === right.size && left.sha256 === right.sha256;

export const verifyDarwinImage = async (path, {
  run = (file, arguments_) => execFile(file, arguments_, { timeout: 120_000, maxBuffer: 64 * 1024 }),
  wait = milliseconds => new Promise(resolvePromise => setTimeout(resolvePromise, milliseconds)),
  nativePlatform = process.platform,
} = {}) => {
  if (nativePlatform !== 'darwin') throw new Error('DMG verification requires native macOS');
  const before = await capture(path);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await run('hdiutil', ['verify', resolve(path)]);
    } catch (error) {
      const stderr = typeof error === 'object' && error !== null && typeof error.stderr === 'string' ? error.stderr : '';
      if (!TRANSIENT_VERIFY_FAILURE.test(stderr) || attempt === 2) {
        throw new Error(TRANSIENT_VERIFY_FAILURE.test(stderr)
          ? 'Native DMG verification remained busy after bounded retries'
          : 'Native DMG verification rejected the image');
      }
      const unchanged = await capture(path);
      if (!sameCapture(before, unchanged)) throw new Error('DMG identity or checksum changed during verification retry');
      await wait(250 * (attempt + 1));
      continue;
    }
    const after = await capture(path);
    if (!sameCapture(before, after)) throw new Error('DMG identity or checksum changed during verification');
    return { size: Number(after.size), sha256: after.sha256, attempts: attempt + 1 };
  }
  throw new Error('Native DMG verification exhausted its bounded retry policy');
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) throw new Error('Expected exactly one DMG pathname');
  await verifyDarwinImage(process.argv[2]);
  process.stdout.write('Native DMG verification passed\n');
}
