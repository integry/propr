import type { Logger } from 'pino';
import type { Redis } from 'ioredis';
import { getAuthenticatedOctokit, logger as defaultLogger, type IssueJobData } from '@propr/core';
import { replayNoChangeCompletion } from './noChangeCompletion.js';
import {
    NO_CHANGE_COMPLETION_KEY_PREFIX,
    issueForCompletionKey,
    readNoChangeCompletionsAt,
    type IssueCoordinates,
    type NoChangeCompletionStore,
    type RetainedNoChangeCompletion,
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

/** Replays one completion whose done marker is on the issue; @returns whether it was replayed. */
async function recoverOne(
    octokit: Octokit, issue: IssueCoordinates, held: RetainedNoChangeCompletion,
    { store, now, log }: { store: NoChangeCompletionStore; now: () => number; log: Pick<Logger, 'info' | 'warn' | 'debug'> },
): Promise<boolean> {
    const { data } = await octokit.request<{ data: { labels: Array<string | { name?: string }> } }>(
        'GET /repos/{owner}/{repo}/issues/{issue_number}',
        { owner: issue.repoOwner, repo: issue.repoName, issue_number: issue.number },
    );
    const currentLabels = data.labels.map(label => typeof label === 'string' ? label : label.name ?? '');
    // Without the done marker the completion was never published; its own run (or the TTL) owns it.
    if (!currentLabels.includes(held.record.doneTag)) return false;
    // The replay re-checks the request generation before every mutation, so a
    // done marker published by newer work never finishes this older completion.
    await replayNoChangeCompletion({ octokit, issueRef: issue as IssueJobData, currentLabels, held, correlatedLogger: log as Logger, store, now });
    return true;
}

interface RecoveryContext {
    store: NoChangeCompletionStore;
    now: () => number;
    log: Pick<Logger, 'info' | 'warn' | 'debug'>;
    getOctokit: () => Promise<Octokit>;
}

/** Replays the due completions under one issue key; each settles independently of the others. */
async function recoverIssueCompletions(key: string, graceMs: number, context: RecoveryContext): Promise<number> {
    const { store, now, log } = context;
    const issue = issueForCompletionKey(key);
    if (!issue) return 0;
    let owed: RetainedNoChangeCompletion[];
    try {
        owed = await readNoChangeCompletionsAt(key, store);
    } catch (error) {
        log.warn({ key, error: (error as Error).message }, 'Could not read retained no-change completions; retrying next pass');
        return 0;
    }
    let replayed = 0;
    for (const held of owed) {
        if (now() - (held.record.retainedAt ?? 0) < graceMs) continue;
        try {
            if (await recoverOne(await context.getOctokit(), issue, held, context)) replayed += 1;
        } catch (error) {
            log.warn({ key, completionId: held.record.id, error: (error as Error).message },
                'Could not recover a retained no-change completion; retrying next pass');
        }
    }
    return replayed;
}

/**
 * Replays retained no-change completions without waiting for another job of
 * the same issue. The original job may have succeeded and released its trigger
 * with only the plan-status write still owed, so no later job would arrive.
 * Each step is single-owner (compare-and-set on the record, and an expiring
 * claim while the comment is posted), so a concurrent retry of the same issue
 * cannot double-post the comment or finalize the record before it is delivered.
 * @returns the number of records this pass replayed.
 */
export async function recoverNoChangeCompletions(options: NoChangeCompletionRecoveryOptions): Promise<number> {
    const { store, getOctokit = getAuthenticatedOctokit as unknown as () => Promise<Octokit>,
        now = Date.now, graceMs = NO_CHANGE_COMPLETION_RECOVERY_GRACE_MS, log = defaultLogger } = options;
    let cursor = '0';
    let replayed = 0;
    let octokit: Octokit | undefined;
    const context = { store, now, log, getOctokit: async () => (octokit ??= await getOctokit()) };
    do {
        const [next, keys] = await store.scan(cursor, 'MATCH', `${NO_CHANGE_COMPLETION_KEY_PREFIX}*`, 'COUNT', 100);
        cursor = next;
        for (const key of keys) replayed += await recoverIssueCompletions(key, graceMs, context);
    } while (cursor !== '0');
    return replayed;
}
