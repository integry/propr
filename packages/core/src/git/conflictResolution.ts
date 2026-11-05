import { createReadStream } from 'fs';
import { StringDecoder } from 'string_decoder';
import path from 'path';
import logger from '../utils/logger.js';
import { createHooklessGit } from './hooklessGit.js';
import { AI_COMMIT_AUTHOR, commitChanges } from './commitOperations.js';
import { assertCommitIsAncestor, mergeBaseIntoBranch, type MergeBaseIntoBranchOptions } from './mergeOperations.js';
import { pushBranch, type PushBranchOptions } from './repoBranching.js';

const CONFLICT_MARKER_PATTERN = /^(<<<<<<<|=======|>>>>>>>)($|\s)/;
// Git's binary heuristic: a NUL byte in the first 8000 bytes; git writes no markers into binary files.
const BINARY_SNIFF_BYTES = 8000;

export interface ConflictResolverContext {
    worktreePath: string;
    /** Files git left with conflict markers; empty for a clean merge. */
    conflictedFiles: string[];
    baseCommit: string;
    previousHeadSha: string;
}

export interface ConflictResolutionOptions<R> {
    worktreePath: string;
    baseBranch: string;
    /** Remote branch that receives the resolved head. */
    branchName: string;
    /** When set, the worktree HEAD must be exactly this commit before merging. */
    expectedHeadSha?: string;
    merge?: MergeBaseIntoBranchOptions;
    /** Edits the conflicted files in place. Must not commit; throwing aborts the resolution. */
    resolveConflicts: (context: ConflictResolverContext) => Promise<R>;
    /** Also run the resolver after a clean merge (e.g. an agent verifying the merged tree). */
    resolveCleanMerges?: boolean;
    /** Runs after the local merge, before the resolver (e.g. to describe the conflicts). */
    onMerged?: (context: ConflictResolverContext) => Promise<void>;
    commitMessage: string | ((context: { conflictedFiles: string[]; wasCleanMerge: boolean; resolverResult?: R }) => string);
    author?: { name: string; email: string };
    /** Publishes HEAD; defaults to `pushBranch` without rebasing (a rebase would drop the merge commit). */
    push?: (context: { worktreePath: string; branchName: string; headSha: string }) => Promise<{ commitHash?: string } | void>;
    pushOptions?: PushBranchOptions;
}

interface OutcomeBase {
    previousHeadSha: string;
    baseCommit: string;
    conflictedFiles: string[];
}

export type ConflictResolutionOutcome<R> =
    | (OutcomeBase & { status: 'resolved' | 'clean'; headSha: string; resolverResult?: R })
    | (OutcomeBase & { status: 'up_to_date'; headSha: string })
    | (OutcomeBase & { status: 'unresolved'; remainingMarkers: string[]; resolverResult?: R })
    | { status: 'head_moved'; previousHeadSha: string; expectedHeadSha: string };

/**
 * Streams one file line by line, so files of any size are verified. Returns
 * null when the file is gone (deleting a conflicted file is a valid resolution)
 * or binary.
 */
async function scanFileForConflictMarkers(filePath: string, file: string): Promise<string[] | null> {
    const markers: string[] = [];
    const decoder = new StringDecoder('utf8');
    let pending = '';
    let lineNumber = 0;
    let sniffed = 0;
    const scanLine = (line: string) => {
        lineNumber += 1;
        if (CONFLICT_MARKER_PATTERN.test(line)) markers.push(`${file}:${lineNumber}:${line}`);
    };
    try {
        for await (const chunk of createReadStream(filePath) as AsyncIterable<Buffer>) {
            if (sniffed < BINARY_SNIFF_BYTES) {
                if (chunk.subarray(0, BINARY_SNIFF_BYTES - sniffed).includes(0)) return null;
                sniffed += chunk.length;
            }
            const lines = (pending + decoder.write(chunk)).split(/\r?\n/);
            pending = lines.pop() ?? '';
            lines.forEach(scanLine);
        }
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT' || code === 'ENOTDIR') return null;
        throw error; // Unverifiable content must not be published.
    }
    pending += decoder.end();
    if (pending.endsWith('\r')) pending = pending.slice(0, -1);
    scanLine(pending);
    return markers;
}

/** Lists `file:line:marker` entries for conflict markers left in the given files. */
export async function findConflictMarkers(worktreePath: string, files: readonly string[]): Promise<string[]> {
    const markers: string[] = [];
    for (const file of new Set(files)) {
        markers.push(...(await scanFileForConflictMarkers(path.join(worktreePath, file), file) ?? []));
    }
    return markers;
}

async function revParse(worktreePath: string, ref: string): Promise<string | null> {
    try {
        return (await createHooklessGit(worktreePath).raw(['rev-parse', '--verify', ref])).trim() || null;
    } catch {
        return null;
    }
}

/** Leaves the worktree at the pre-merge head with no merge in progress. */
async function abortLocalMerge(worktreePath: string, previousHeadSha: string): Promise<void> {
    const git = createHooklessGit(worktreePath);
    try {
        if (await revParse(worktreePath, 'MERGE_HEAD')) await git.raw(['merge', '--abort']);
    } catch (error) {
        logger.warn({ worktreePath, error: (error as Error).message }, 'git merge --abort failed; resetting instead');
    }
    try {
        if (await revParse(worktreePath, 'HEAD') !== previousHeadSha || await revParse(worktreePath, 'MERGE_HEAD')) {
            await git.raw(['reset', '--hard', previousHeadSha]);
        }
    } catch (error) {
        logger.warn({ worktreePath, error: (error as Error).message }, 'Failed to reset worktree after aborted conflict resolution');
    }
}

/** Local half of the contract: resolve, verify markers, commit the merge. Never pushes. */
async function resolveAndCommit<R>(
    options: ConflictResolutionOptions<R>,
    context: ConflictResolverContext
): Promise<{ status: 'up_to_date'; resolverResult?: R } | { status: 'unresolved'; remainingMarkers: string[]; resolverResult?: R } | { status: 'committed'; resolverResult?: R }> {
    const { worktreePath, conflictedFiles, baseCommit, previousHeadSha } = context;
    const wasCleanMerge = conflictedFiles.length === 0;
    await options.onMerged?.(context);

    let resolverResult: R | undefined;
    if (wasCleanMerge && !options.resolveCleanMerges) {
        if (await revParse(worktreePath, 'HEAD') === previousHeadSha) return { status: 'up_to_date' };
    } else {
        resolverResult = await options.resolveConflicts(context);
    }

    const remainingMarkers = await findConflictMarkers(worktreePath, conflictedFiles);
    if (remainingMarkers.length > 0) {
        logger.error({ worktreePath, remainingMarkers: remainingMarkers.length, firstFewMarkers: remainingMarkers.slice(0, 5) }, 'Conflict markers still present after resolution');
        return { status: 'unresolved', remainingMarkers, resolverResult };
    }

    // The resolver never owns Git operations: stage its result here so the
    // commit below records MERGE_HEAD as the second parent.
    await createHooklessGit(worktreePath).add('.');
    const message = typeof options.commitMessage === 'function'
        ? options.commitMessage({ conflictedFiles, wasCleanMerge, resolverResult })
        : options.commitMessage;
    await commitChanges(worktreePath, message, options.author ?? AI_COMMIT_AUTHOR, { issueTitle: 'Resolve merge conflicts' });
    if (await revParse(worktreePath, 'MERGE_HEAD')) throw new Error('Merge is still in progress after committing the resolution');
    await assertCommitIsAncestor(worktreePath, baseCommit);
    return { status: 'committed', resolverResult };
}

/**
 * Git-level conflict resolution contract:
 * verify the expected head, merge the base, call the resolver only when there is
 * something to resolve, verify no conflict markers remain, create the merge commit
 * (hooks disabled), check the base is incorporated and push. Any failure before
 * the push aborts the local merge and leaves the remote head untouched.
 */
export async function performConflictResolution<R = unknown>(options: ConflictResolutionOptions<R>): Promise<ConflictResolutionOutcome<R>> {
    const { worktreePath, baseBranch, branchName } = options;
    const previousHeadSha = await revParse(worktreePath, 'HEAD');
    if (!previousHeadSha) throw new Error(`Cannot resolve conflicts: ${worktreePath} has no HEAD commit`);
    if (options.expectedHeadSha && previousHeadSha !== options.expectedHeadSha) {
        logger.warn({ worktreePath, expectedHeadSha: options.expectedHeadSha, previousHeadSha }, 'Conflict resolution skipped: worktree head is not the expected pull request head');
        return { status: 'head_moved', previousHeadSha, expectedHeadSha: options.expectedHeadSha };
    }

    const mergeResult = await mergeBaseIntoBranch(worktreePath, baseBranch, options.merge ?? {});
    if (mergeResult.outcome === 'failed') throw new Error(`Merge failed: ${mergeResult.error}`);
    if (!mergeResult.baseCommit) throw new Error(`Merge did not identify the fetched base commit for ${baseBranch}`);
    const baseCommit = mergeResult.baseCommit;
    const conflictedFiles = mergeResult.conflictedFiles ?? [];
    const context: ConflictResolverContext = { worktreePath, conflictedFiles, baseCommit, previousHeadSha };

    let local: Awaited<ReturnType<typeof resolveAndCommit<R>>>;
    try {
        local = await resolveAndCommit(options, context);
    } catch (error) {
        await abortLocalMerge(worktreePath, previousHeadSha);
        throw error;
    }
    if (local.status === 'up_to_date') {
        return { status: 'up_to_date', previousHeadSha, headSha: previousHeadSha, baseCommit, conflictedFiles };
    }
    const { resolverResult } = local;
    if (local.status === 'unresolved') {
        await abortLocalMerge(worktreePath, previousHeadSha);
        return { status: 'unresolved', previousHeadSha, baseCommit, conflictedFiles, remainingMarkers: local.remainingMarkers, resolverResult };
    }

    const headSha = await revParse(worktreePath, 'HEAD');
    if (!headSha) throw new Error('Conflict resolution produced no HEAD commit');
    const pushed = options.push
        ? await options.push({ worktreePath, branchName, headSha })
        : await pushBranch(worktreePath, branchName, { rebaseOnNonFastForward: false, ...options.pushOptions });
    const publishedHead = (pushed && pushed.commitHash) || headSha;

    logger.info({ worktreePath, branchName, baseBranch, previousHeadSha, headSha: publishedHead, conflictedFiles }, 'Conflict resolution pushed');
    return {
        status: conflictedFiles.length === 0 ? 'clean' : 'resolved',
        previousHeadSha,
        headSha: publishedHead,
        baseCommit,
        conflictedFiles,
        resolverResult,
    };
}
