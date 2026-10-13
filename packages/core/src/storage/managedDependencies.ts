import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { generatedPayloadStorage } from './generatedPayloads.js';

/** Optional trusted producer. Refuses existing node_modules and local/private
 * dependency sources. Scripts/bin symlinks are disabled; ordinary agent installs
 * remain unregistered. Nothing enables cleanup policy as part of generation.
 */
export async function generateManagedDependencies(worktree: string): Promise<void> {
  const file = await fs.open(path.join(worktree, 'package-lock.json'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let lockBytes: string;
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 16 * 1024 * 1024) throw new Error('Unsafe lockfile');
    lockBytes = await file.readFile('utf8');
  } finally { await file.close(); }
  const lock = JSON.parse(lockBytes);
  if (![2, 3].includes(lock.lockfileVersion) || !lock.packages || Object.keys(lock.packages).length > 100_000) throw new Error('Supported npm lockfile required');
  for (const [name, value] of Object.entries(lock.packages)) {
    if (!name) continue;
    const dependency = value as { resolved?: string; integrity?: string; link?: boolean };
    if (dependency.link || !dependency.resolved || !/^https:\/\/registry\.npmjs\.org\/[A-Za-z0-9@%._~/-]+$/.test(dependency.resolved) || !/^sha512-[A-Za-z0-9+/]+=*$/.test(dependency.integrity ?? '')) throw new Error('Dependency is not provably public and refetchable');
  }
  await generatedPayloadStorage().generate(worktree, 'node_modules', 'npm ci from preserved package-lock.json; public registry integrity-pinned dependencies; scripts and bin links disabled', async () => {
    if (await fs.readFile(path.join(worktree, 'package-lock.json'), 'utf8') !== lockBytes) throw new Error('Lockfile changed before generation');
    await promisify(execFile)('npm', ['ci', '--ignore-scripts', '--bin-links=false', '--no-audit', '--no-fund', '--registry=https://registry.npmjs.org'], { cwd: worktree, timeout: 10 * 60_000, maxBuffer: 1024 * 1024 });
    if (await fs.readFile(path.join(worktree, 'package-lock.json'), 'utf8') !== lockBytes) throw new Error('Lockfile changed during generation; payload remains unregistered');
  });
}
