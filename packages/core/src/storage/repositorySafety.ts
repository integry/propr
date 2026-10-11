import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import type { StorageProtection } from '@propr/shared';
import { assertRealDirectory } from './lifecycle.js';

const exec = promisify(execFile);
const gitEnvironment = () => ({ PATH: process.env.PATH, HOME: os.tmpdir(), LANG: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_NO_REPLACE_OBJECTS: '1', GIT_OPTIONAL_LOCKS: '0' });
async function git(directory: string, args: string[], signal?: AbortSignal): Promise<string> {
  const { stdout } = await exec('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', '-c', 'credential.helper=', '-c', 'protocol.ext.allow=never', '-C', directory, ...args], {
    signal, env: gitEnvironment(), timeout: 30_000, maxBuffer: 16 * 1024 * 1024,
  });
  return stdout;
}

export interface RepositoryIdentity { device: number; inode: number }
export async function repositoryIdentity(directory: string): Promise<RepositoryIdentity> {
  await assertRealDirectory(directory);
  await assertRealDirectory(path.join(directory, '.git'));
  const stat = await fs.lstat(directory);
  return { device: stat.dev, inode: stat.ino };
}

async function readTreeNames(directory: string, count: number, deadline: number, signal?: AbortSignal): Promise<string[]> {
  const handle = await fs.opendir(directory);
  const names: string[] = [];
  for await (const entry of handle) {
    signal?.throwIfAborted();
    if (names.length + count > 100_000 || Date.now() > deadline) throw new Error('unsafe_path');
    names.push(entry.name);
  }
  return names;
}

/** Walk only the candidate, refusing symlinks, mounts, excessive trees and substitution. */
async function inspectTree(directory: string, identity: RepositoryIdentity, signal?: AbortSignal): Promise<{ bytes: number; fingerprint: string }> {
  if (process.platform !== 'linux') throw new Error('unsupported');
  const hash = createHash('sha256');
  const seen = new Set<string>();
  let bytes = 0;
  let count = 0;
  const deadline = Date.now() + 5_000;
  const visit = async (target: string, relative: string): Promise<void> => {
    signal?.throwIfAborted();
    if (++count > 100_000 || Date.now() > deadline) throw new Error('unsafe_path');
    const stat = await fs.lstat(target);
    if (stat.isSymbolicLink() || stat.dev !== identity.device || (!stat.isDirectory() && !stat.isFile())) throw new Error('unsafe_path');
    if (!relative && stat.ino !== identity.inode) throw new Error('unsafe_path');
    const handle = await fs.open(target, constants.O_RDONLY | constants.O_NOFOLLOW | (stat.isDirectory() ? constants.O_DIRECTORY : constants.O_NONBLOCK));
    try {
      const pinned = await handle.stat();
      if (pinned.dev !== stat.dev || pinned.ino !== stat.ino) throw new Error('unsafe_path');
      hash.update(`${relative}\0${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${relative ? stat.ctimeMs : 0}\0`);
      const key = `${stat.dev}:${stat.ino}`;
      if (!seen.has(key)) { bytes += stat.blocks * 512; seen.add(key); }
      if (stat.isDirectory()) {
        const pinnedPath = `/proc/self/fd/${handle.fd}`;
        const names = await readTreeNames(pinnedPath, count, deadline, signal);
        for (const name of names.sort()) await visit(path.join(pinnedPath, name), path.join(relative, name));
        const after = await handle.stat();
        if (after.mtimeMs !== stat.mtimeMs) throw new Error('unsafe_path');
      }
    } finally { await handle.close(); }
  };
  await visit(directory, '');
  return { bytes, fingerprint: hash.digest('hex') };
}

async function inspectLocalGit(directory: string, proofGit: (args: string[]) => Promise<string>): Promise<StorageProtection | null> {
  const config = await fs.readFile(path.join(directory, '.git', 'config'), 'utf8');
  if (/^\s*\[\s*(?:include|includeIf)\b/im.test(config)) return 'unknown_git_state';
  for (const name of ['info/grafts', 'index.lock', 'config.lock', 'MERGE_HEAD', 'REBASE_HEAD', 'rebase-merge', 'rebase-apply', 'sequencer']) {
    if (await fs.lstat(path.join(directory, '.git', name)).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; })) return 'unknown_git_state';
  }
  // Status can invoke clean filters from local config. Permit only inert, managed
  // clone configuration before asking Git to inspect the working copy.
  const keys = (await proofGit(['config', '--local', '--no-includes', '--name-only', '--list'])).trim().split('\n');
  const inert = /^(?:core\.(?:repositoryformatversion|filemode|bare|logallrefupdates|ignorecase|precomposeunicode)|remote\.origin\.(?:url|fetch)|branch\..+\.(?:remote|merge)|extensions\.objectformat)$/i;
  if (keys.some(key => !inert.test(key))) return 'unknown_git_state';
  const flags = await proofGit(['ls-files', '-v']);
  if (flags.split('\n').some(line => line && (line[0] === 'S' || line[0] === line[0].toLowerCase()))) return 'private_work';

  // Never walk alternate object stores, nested submodules, shallow boundaries or linked gitdirs.
  for (const name of ['objects/info/alternates', 'objects/info/http-alternates', 'shallow', 'modules', 'worktrees']) {
    if (await fs.lstat(path.join(directory, '.git', name)).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; })) return name === 'worktrees' ? 'worktrees' : 'unknown_git_state';
  }
  if ((await proofGit(['rev-parse', '--show-toplevel'])).trim() !== directory) return 'unsafe_path';
  if ((await proofGit(['status', '--porcelain=v1', '--untracked-files=all', '--ignored', '--ignore-submodules=all'])).length) return 'private_work';
  if ((await proofGit(['ls-files', '--stage'])).split('\n').some(line => line.startsWith('160000 '))) return 'unknown_git_state';
  const refs = await proofGit(['for-each-ref', '--format=%(refname)']);
  if (refs.split('\n').some(ref => ref.startsWith('refs/stash') || ref.includes('rescue'))) return 'salvage';
  if ((await proofGit(['fsck', '--full', '--no-reflogs'])).trim()) return 'local_history';
  return null;
}

async function advertisedRemoteRefs(remote: string, options: { token?: string; signal?: AbortSignal }): Promise<string | null> {
  // A neutral cwd prevents local URL rewrites, credential helpers and transport commands.
  const neutral = await fs.mkdtemp(path.join(os.tmpdir(), 'propr-storage-remote-'));
  let advertised: string | null;
  try {
    const env: Record<string, string | undefined> = { ...gitEnvironment(), GIT_CEILING_DIRECTORIES: path.dirname(neutral) };
    if (options.token) {
      env.GIT_CONFIG_COUNT = '1'; env.GIT_CONFIG_KEY_0 = 'http.https://github.com/.extraheader';
      env.GIT_CONFIG_VALUE_0 = `Authorization: Basic ${Buffer.from(`x-access-token:${options.token}`).toString('base64')}`;
    }
    try {
      advertised = (await exec('git', ['-c', 'credential.helper=', '-c', 'core.hooksPath=/dev/null', '-c', 'protocol.ext.allow=never', 'ls-remote', '--heads', '--tags', '--', remote], {
        signal: options.signal, cwd: neutral, env, timeout: 30_000, maxBuffer: 4 * 1024 * 1024,
      })).stdout;
    } catch { advertised = null; }
  } finally { await fs.rmdir(neutral); }
  return advertised;
}

function remoteTips(advertised: string): string[] | null {
  const tips = [...new Set(advertised.split('\n').filter(Boolean).map(line => line.split('\t')[0]))];
  return !tips.length || tips.length > 10_000 || tips.some(tip => !/^[0-9a-f]{40,64}$/.test(tip)) ? null : tips;
}

export interface RepositoryAudit { reasons: StorageProtection[]; bytes: number | null; fingerprint: string | null }
/** Remote is server-derived, never read from origin or supplied by an HTTP client. */
export async function auditRepository(directory: string, identity: RepositoryIdentity, remote: string, options: { token?: string; allowTestFileRemote?: boolean; metadataFingerprint?: string; signal?: AbortSignal } = {}): Promise<RepositoryAudit> {
  const retained = (reason: StorageProtection): RepositoryAudit => ({ reasons: [reason], bytes: null, fingerprint: null });
  const proofGit = (args: string[]) => git(directory, args, options.signal);
  try {
    options.signal?.throwIfAborted();
    const current = await repositoryIdentity(directory);
    if (current.device !== identity.device || current.inode !== identity.inode) return retained('unknown_ownership');
    const tree = await inspectTree(directory, identity, options.signal);
    if (options.metadataFingerprint && await repositoryMetadataFingerprint(directory) !== options.metadataFingerprint) return retained('private_work');
    const localProtection = await inspectLocalGit(directory, proofGit);
    if (localProtection) return retained(localProtection);
    const protocol = new URL(remote).protocol;
    if (!(protocol === 'https:' || (options.allowTestFileRemote && protocol === 'file:'))) return retained('remote_unavailable');
    const advertised = await advertisedRemoteRefs(remote, options);
    if (advertised === null) return retained(options.signal?.aborted ? 'busy' : 'remote_unavailable');
    const tips = remoteTips(advertised);
    if (!tips) return retained('unknown_git_state');
    // Prove EVERY local object recoverable from freshly advertised remote tips. This also
    // protects detached/reflog-only commits, dangling blobs, tags and private stash objects.
    const remoteObjects = new Set((await proofGit(['rev-list', '--objects', '--no-object-names', ...tips, '--'])).trim().split('\n'));
    const localObjects = (await proofGit(['cat-file', '--batch-all-objects', '--batch-check=%(objectname)'])).trim().split('\n');
    if (localObjects.some(object => !remoteObjects.has(object))) return retained('local_history');
    const finalTree = await inspectTree(directory, identity, options.signal);
    if (finalTree.fingerprint !== tree.fingerprint) return retained('changed');
    return { reasons: [], bytes: tree.bytes, fingerprint: tree.fingerprint };
  } catch { return retained(options.signal?.aborted ? 'busy' : 'unknown_git_state'); }
}

/** Managed metadata that cannot be reconstructed from remote objects must remain unchanged. */
export async function repositoryMetadataFingerprint(directory: string): Promise<string> {
  const gitDir = path.join(directory, '.git');
  await assertRealDirectory(gitDir);
  const allowed = new Set(['config', 'description', 'HEAD', 'index', 'packed-refs', 'FETCH_HEAD', 'ORIG_HEAD', 'COMMIT_EDITMSG', 'objects', 'refs', 'logs', 'info', 'hooks', 'branches']);
  for (const name of await fs.readdir(gitDir)) if (!allowed.has(name)) throw new Error('unknown_git_state');
  if ((await fs.readdir(path.join(gitDir, 'branches')).catch(error => { if (error.code === 'ENOENT') return []; throw error; })).length) throw new Error('unknown_git_state');
  const hash = createHash('sha256');
  const collect = async (relative: string): Promise<void> => {
    const target = path.join(gitDir, relative);
    const stat = await fs.lstat(target).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (!stat) { hash.update(`${relative}:missing\0`); return; }
    if (stat.isSymbolicLink() || stat.size > 65_536 || !stat.isFile() || stat.nlink > 1) throw new Error('unknown_git_state');
    await assertRealDirectory(path.dirname(target));
    const handle = await fs.open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      if ((await handle.stat()).ino !== stat.ino) throw new Error('unsafe_path');
      hash.update(relative).update('\0').update(await handle.readFile()).update('\0');
    } finally { await handle.close(); }
  };
  for (const file of ['config', 'description', 'info/exclude']) await collect(file);
  const hooks = path.join(gitDir, 'hooks');
  await assertRealDirectory(hooks);
  const names = await fs.readdir(hooks);
  if (names.length > 100) throw new Error('unknown_git_state');
  for (const name of names.sort()) await collect(`hooks/${name}`);
  const info = await fs.readdir(path.join(gitDir, 'info'));
  if (info.some(name => name !== 'exclude')) throw new Error('unknown_git_state');
  return hash.digest('hex');
}
