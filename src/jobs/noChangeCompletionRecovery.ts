import type { Logger } from 'pino';
import type { Redis } from 'ioredis';
import { getAuthenticatedOctokit, logger as defaultLogger, type IssueJobData } from '@propr/core';
import { replayNoChangeCompletion } from './noChangeCompletion.js';
import {
    NO_CHANGE_COMPLETION_KEY_PREFIX,
    issueForCompletionKey,
    readNoChangeCompletionAt,
    type NoChangeCompletionStore,
} from './noChangeCompletionObligation.js';

/** A completing run settles its own record; recovery only picks up ones left this long. */
export const NO_CHANGE_COMPLETION_RECOVERY_GRACE_MS = 10 * 60 * 1000;

type Octokit = Parameters<typeof replayNoChangeCompletion>[0]['octokit'];
export type NoChangeCompletionRecoveryStore = NoChangeCompletionStore & Pick<Redis, 'scan'>;

export interface NoChangeCompletionRecoveryOptions {
    store: NoChangeCompletionRecoveryStore;
    getOctokit?: () => Promise<Octokit>;
    now?: () => number;
    graceMs?: number;
    log?: Pick<Logger, 'info' | 'warn' | 'debug'>;
}

/**
 * Replays retained no-change completions without waiting for another job of
 * the same issue. The original job may have succeeded and released its trigger
 * with only the plan-status write still owed, so no later job would arrive.
 * Each step is single-owner (compare-and-set on the record), so a concurrent
 * retry of the same issue cannot double-post the comment.
 * @returns the number of records this pass replayed.
 */
export async function recoverNoChangeCompletions(options: NoChangeCompletionRecoveryOptions): Promise<number> {
    const { store, getOctokit = getAuthenticatedOctokit as unknown as () => Promise<Octokit>,
        now = Date.now, graceMs = NO_CHANGE_COMPLETION_RECOVERY_GRACE_MS, log = defaultLogger } = options;
    let cursor = '0';
    let replayed = 0;
    let octokit: Octokit | undefined;
    do {
        const [next, keys] = await store.scan(cursor, 'MATCH', `${NO_CHANGE_COMPLETION_KEY_PREFIX}*`, 'COUNT', 100);
        cursor = next;
        for (const key of keys) {
            const issue = issueForCompletionKey(key);
            if (!issue) continue;
            try {
                const held = await readNoChangeCompletionAt(key, store);
                if (!held || now() - (held.record.retainedAt ?? 0) < graceMs) continue;
                octokit ??= await getOctokit();
                const { data } = await octokit.request<{ data: { labels: Array<string | { name?: string }> } }>(
                    'GET /repos/{owner}/{repo}/issues/{issue_number}',
                    { owner: issue.repoOwner, repo: issue.repoName, issue_number: issue.number },
                );
                const currentLabels = data.labels.map(label => typeof label === 'string' ? label : label.name ?? '');
                // Without the done marker the completion was never published; its own run (or the TTL) owns it.
                if (!currentLabels.includes(held.record.doneTag)) continue;
                const issueRef = issue as IssueJobData;
                await replayNoChangeCompletion({ octokit, issueRef, currentLabels, held, correlatedLogger: log as Logger, store });
                replayed += 1;
            } catch (error) {
                log.warn({ key, error: (error as Error).message }, 'Could not recover a retained no-change completion; retrying next pass');
            }
        }
    } while (cursor !== '0');
    return replayed;
}
