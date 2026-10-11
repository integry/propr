import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { assertRepositoryClonePath } from '../git/repositoryPaths.js';
import { repositoryStorageLifecycle, assertRealDirectory, storageControlRoot } from './lifecycle.js';
import { repositoryIdentity, repositoryMetadataFingerprint, type RepositoryIdentity } from './repositorySafety.js';

export interface CacheRecord { id: string; owner: string; name: string; identity: RepositoryIdentity; metadataFingerprint: string }
export async function registerRepositoryCache(directory: string, owner: string, name: string): Promise<void> {
  assertRepositoryClonePath(directory, process.env.GIT_CLONES_BASE_PATH || '/tmp/git-processor/clones', owner, name);
  const identity = await repositoryIdentity(directory);
  const metadataFingerprint = await repositoryMetadataFingerprint(directory);
  await repositoryStorageLifecycle.exclusive(async () => {
    const root = path.join(storageControlRoot(), 'repositories');
    await fs.mkdir(root, { recursive: true });
    await assertRealDirectory(root);
    const id = createHash('sha256').update(`${owner}/${name}`).digest('hex');
    const temporary = path.join(root, randomUUID());
    await fs.writeFile(temporary, JSON.stringify({ id, owner, name, identity, metadataFingerprint } satisfies CacheRecord), { flag: 'wx' });
    await fs.rename(temporary, path.join(root, `${id}.json`));
  });
}
