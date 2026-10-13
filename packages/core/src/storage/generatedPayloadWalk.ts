import fs from 'node:fs/promises';
import { constants, type Stats } from 'node:fs';
import path from 'node:path';
import { createHash, type Hash } from 'node:crypto';

export interface Budget { entries: number; bytes: number; deadline: number }
export interface Limits { maxEntries?: number; maxBytes?: number; maxMs?: number }
export const budget = (limits: Limits = {}): Budget => ({ entries: Math.min(100_000, limits.maxEntries ?? 100_000), bytes: Math.min(512 * 1024 * 1024, limits.maxBytes ?? 512 * 1024 * 1024), deadline: Date.now() + Math.min(5_000, limits.maxMs ?? 5_000) });
interface WalkOptions {
  signal?: AbortSignal; remove?: boolean; expected?: Map<string, string>; onRemove?: () => void;
}
interface WalkState {
  device: number; limits: Budget; mounts: string[]; options: WalkOptions;
  hash: Hash; bytes: number; nodes: Map<string, string>;
}
function checkTime(state: WalkState): void {
  state.options.signal?.throwIfAborted();
  if (Date.now() >= state.limits.deadline) throw new Error('bounded_scan');
}
function checkNode(stat: Stats, real: string, relative: string, state: WalkState): void {
  if (stat.dev !== state.device || stat.isSymbolicLink() || state.mounts.includes(real) || (!stat.isDirectory() && !stat.isFile()) || (stat.isFile() && stat.nlink !== 1) || path.basename(relative) === '.git') throw new Error('unsafe_path');
  if (relative) state.bytes += stat.blocks * 512; // Empty root is retained.
  state.limits.bytes -= stat.blocks * 512;
  if (state.limits.bytes < 0) throw new Error('bounded_scan');
}
async function visitDirectory(handle: fs.FileHandle, relative: string, stat: Stats, state: WalkState): Promise<void> {
  const pinnedPath = `/proc/self/fd/${handle.fd}`;
  const names: string[] = [];
  const entries = await fs.opendir(pinnedPath);
  for await (const entry of entries) {
    if (names.length >= state.limits.entries || Date.now() >= state.limits.deadline) throw new Error('bounded_scan');
    names.push(entry.name);
  }
  for (const name of names.sort()) await visit(path.join(pinnedPath, name), path.posix.join(relative, name), state);
  if (!state.options.remove && (await handle.stat()).mtimeMs !== stat.mtimeMs) throw new Error('changed');
}
async function removeNode(target: string, stat: Stats, state: WalkState): Promise<void> {
  state.options.signal?.throwIfAborted();
  const final = await fs.lstat(target);
  if (final.ino !== stat.ino || final.dev !== stat.dev || (stat.isFile() && (final.size !== stat.size || final.mtimeMs !== stat.mtimeMs || final.ctimeMs !== stat.ctimeMs))) throw new Error('unsafe_path');
  if (stat.isDirectory()) await fs.rmdir(target); else await fs.unlink(target);
  state.options.onRemove?.();
}
async function visit(target: string, relative: string, state: WalkState): Promise<void> {
  checkTime(state);
  if (--state.limits.entries < 0) throw new Error('bounded_scan');
  const stat = await fs.lstat(target);
  checkNode(stat, await fs.realpath(target), relative, state);
  const handle = await fs.open(target, constants.O_RDONLY | constants.O_NOFOLLOW | (stat.isDirectory() ? constants.O_DIRECTORY : constants.O_NONBLOCK));
  try {
    const pinned = await handle.stat();
    if (pinned.ino !== stat.ino || pinned.dev !== stat.dev) throw new Error('unsafe_path');
    const node = createHash('sha256');
    node.update(`${relative}\0${stat.dev}:${stat.ino}:${stat.mode}:${stat.isFile() ? stat.size : 0}\0`);
    const { remove, expected } = state.options;
    if (remove && stat.isDirectory() && expected?.get(relative) !== node.copy().digest('hex')) throw new Error('private_work');
    if (stat.isDirectory()) await visitDirectory(handle, relative, stat, state);
    else {
      const stream = handle.createReadStream({ autoClose: false });
      for await (const chunk of stream) { checkTime(state); node.update(chunk); }
    }
    const digest = node.digest('hex');
    state.nodes.set(relative, digest); state.hash.update(relative).update(digest);
    if (remove && expected?.get(relative) !== digest) throw new Error('private_work');
    if (remove && relative) await removeNode(target, stat, state);
  } finally { await handle.close(); }
}
/** Linux descriptor-pinned walk. Reject links (including hardlinks), mounts,
 * nested Git state, and special files. Delete only exact files already proved.
 * No recursive rm, globbing, or following caller-provided filesystem paths.
 */
export async function walk(directory: string, device: number, limits: Budget, options: WalkOptions = {}): Promise<{ fingerprint: string; bytes: number; nodes: Map<string, string> }> {
  if (process.platform !== 'linux') throw new Error('unsupported');
  const mounts = (await fs.readFile('/proc/self/mountinfo', 'utf8')).split('\n').filter(Boolean).map(line => line.split(' ')[4].replace(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(parseInt(octal, 8))));
  const state: WalkState = { device, limits, options, mounts, hash: createHash('sha256'), bytes: 0, nodes: new Map() };
  await visit(directory, '', state);
  return { fingerprint: state.hash.digest('hex'), bytes: state.bytes, nodes: state.nodes };
}
