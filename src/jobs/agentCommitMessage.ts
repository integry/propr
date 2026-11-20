/**
 * Commit messages for agent runs (issue implementation and PR follow-ups): a
 * short imperative conventional subject, the run summary in the body, and the
 * `ProPR-Agent` trailer. The subject description comes from its own small call
 * (`commitSubject`, set by `applyRunSummarySelection`); without one it is the
 * PR or issue title, never the summary text. Imports only `@propr/shared` and
 * Node built-ins, so suites that mock `@propr/core` need no new names.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { assembleCommitMessage, buildCommitSubject, proprAgentTrailer } from '@propr/shared';

const execFileAsync = promisify(execFile);
const STATUS_TIMEOUT_MS = 15_000;

/**
 * Paths with uncommitted changes in `worktreePath`, for the commit type. Best
 * effort: an unreadable worktree gives an empty list and the type falls back
 * to the title.
 */
export async function pendingChangePaths(worktreePath: string | undefined): Promise<string[]> {
    if (!worktreePath) return [];
    try {
        const { stdout } = await execFileAsync('git', ['-C', worktreePath, 'status', '--porcelain=v1', '-z', '--untracked-files=all'], { timeout: STATUS_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 });
        const entries = stdout.split('\0');
        const paths: string[] = [];
        for (let i = 0; i < entries.length; i++) {
            const entry = entries[i];
            if (entry.length < 4) continue;
            const path = entry.slice(3);
            // ProPR runtime directories (previews, scratch) are never committed.
            if (!/^\.propr\/(?:previews|tmp)\//.test(path)) paths.push(path);
            // Renames and copies carry the source path as the next entry.
            if (entry[0] === 'R' || entry[0] === 'C') i++;
        }
        return paths;
    } catch {
        return [];
    }
}

/** The PR title inside a PR task title (`Follow-up PR #12: Add retries`); null for the untitled placeholder. */
export function pullRequestTitleFromTaskTitle(taskTitle: unknown): string | null {
    if (typeof taskTitle !== 'string') return null;
    const match = /^[^#\n]*\bPR #\d+:\s*(.+)$/.exec(taskTitle.trim());
    const title = match?.[1].trim();
    return title && title !== 'Untitled pull request' ? title : null;
}

export interface AgentCommitMessageOptions {
    /** Description the small model proposed (`ClaudeCodeResponse.commitSubject`). */
    generatedSubject?: string | null;
    /** PR or issue title: the subject when generation failed. */
    title?: string | null;
    /** Subject when there is no usable title either, e.g. `resolve issue #12`. */
    fallbackSubject: string;
    /** Changed paths, for the conventional-commit type. */
    paths?: readonly string[];
    /** Commit body: the run summary and references. */
    body: string;
    agentAlias?: string | null;
    model?: string | null;
}

export function buildAgentCommitMessage(options: AgentCommitMessageOptions): string {
    const subject = buildCommitSubject({
        generated: options.generatedSubject, title: options.title, fallback: options.fallbackSubject, paths: options.paths,
    });
    return assembleCommitMessage(subject, options.body, [proprAgentTrailer(options.agentAlias, options.model)]);
}
