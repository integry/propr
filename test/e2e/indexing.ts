import type { ApiClient } from '../../packages/cli/src/api/client.js';
import { getIndexingStatus, triggerIndexing, type RepositoryIndexingStatus } from '../../packages/cli/src/api/repos.js';
import { abortableSleep, planDeadline } from './planGeneration.js';

export const INDEXING_BUDGET_MS = 300_000;
// The polling deadline must report its last observation before node:test cancels it.
export const INDEXING_TEST_TIMEOUT_MS = INDEXING_BUDGET_MS + 30_000;

interface IndexingOptions {
  signal?: AbortSignal;
  deadline?: number;
  branch?: string;
  label?: string;
  now?: () => number;
  sleep?: typeof abortableSleep;
  log?: (message: string) => void;
}

export async function triggerAndWaitForIndexing(repo: string, fullReindex: boolean, client: ApiClient, options: IndexingOptions = {}): Promise<void> {
  const now = options.now ?? Date.now;
  const deadline = options.deadline ?? planDeadline(INDEXING_BUDGET_MS, undefined, now());
  options.signal?.throwIfAborted();
  if (now() >= deadline) throw new Error(`${options.label ?? 'Indexing'} for ${repo}: deadline passed before triggering indexing`);
  const signal = boundedSignal(options.signal, deadline - now());
  let branch = options.branch;
  try {
    const result = await triggerIndexing(repo, { fullReindex, baseBranch: branch }, client, { signal, timeout: Math.min(30_000, deadline - now()), retry: false });
    if (!result.success) throw new Error(result.error || 'Indexing trigger failed');
    branch = result.baseBranch ?? branch;
  } catch (error) {
    if (!(error instanceof Error && error.message.includes('Indexing job already queued'))) throw error;
    (options.log ?? console.log)(`    ${options.label ?? 'Indexing'} already queued; waiting for current indexing job`);
  }
  await waitForIndexedRepo(repo, client, { ...options, branch, deadline });
}

function boundedSignal(parent: AbortSignal | undefined, remaining: number): AbortSignal {
  const timeout = AbortSignal.timeout(Math.max(0, Math.ceil(remaining)));
  return parent ? AbortSignal.any([parent, timeout]) : timeout;
}

export async function waitForIndexedRepo(repo: string, client: ApiClient, options: IndexingOptions = {}): Promise<void> {
  const now = options.now ?? Date.now;
  const deadline = options.deadline ?? planDeadline(INDEXING_BUDGET_MS, undefined, now());
  const signal = boundedSignal(options.signal, deadline - now());
  const label = options.label ?? 'Indexing';
  const log = options.log ?? console.log;
  const phases = new Set<string>();
  let last: RepositoryIndexingStatus | undefined;
  const diagnostic = () => `${label} for ${repo} (${options.branch ?? 'default branch'}): last status=${last?.indexing_status ?? 'missing'}, phase=${last?.progress?.phase ?? 'none'}, files=${last?.progress?.processedFiles ?? 0}/${last?.progress?.totalFiles ?? 0}, directories=${last?.progress?.processedDirectories ?? 0}/${last?.progress?.totalDirectories ?? 0}, observed phases=${[...phases].join(', ') || 'none'}`;
  try {
    while (now() < deadline) {
      signal.throwIfAborted();
      const result = await getIndexingStatus(repo, client, { signal, timeout: Math.min(30_000, deadline - now()), retry: false });
      last = options.branch ? result.repositories.find(row => row.branch === options.branch) : result.repositories[0];
      if (last?.progress?.phase) phases.add(last.progress.phase);
      if (last?.indexing_status === 'failed') throw new Error(`${diagnostic()}; indexing failed`);
      if (last?.indexing_status === 'completed' && last.last_indexed_at && last.last_indexed_hash) {
        log(`    ${label} completed. Indexed at: ${last.last_indexed_at}, hash: ${last.last_indexed_hash.substring(0, 8)}`);
        return;
      }
      await (options.sleep ?? abortableSleep)(Math.min(5_000, Math.max(0, deadline - now())), signal);
    }
  } catch (error) {
    if (options.signal?.aborted) throw error;
    if (!signal.aborted && now() < deadline) throw error;
  }
  throw new Error(`${diagnostic()}; timed out waiting for indexing completion`);
}
