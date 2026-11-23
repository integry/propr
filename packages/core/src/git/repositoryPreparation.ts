import { AsyncLocalStorage } from 'node:async_hooks';
import path from 'node:path';
import { realpath } from 'node:fs/promises';
import type { SimpleGit } from 'simple-git';
import { StorageLifecycle } from '../storage/lifecycle.js';

const held = new AsyncLocalStorage<ReadonlySet<string>>();

/** Cross-process preparation gate, shared by the clone and its linked worktrees. */
export async function withRepositoryPreparation<T>(git: SimpleGit, run: () => Promise<T>): Promise<T> {
    const common = await realpath((await git.raw(['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim());
    if (held.getStore()?.has(common)) return run();
    const gate = new StorageLifecycle(path.join(common, 'propr-preparation'));
    return gate.exclusive(() => held.run(new Set([...(held.getStore() ?? []), common]), run), 120_000);
}
