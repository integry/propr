/**
 * Proposes the description part of a commit subject ("keep the create dialog
 * open") from a run's summary, with its own small model call, the same
 * `summarization.agent_alias` path PR task titles use. The run summary itself
 * stays in the commit body. Never throws: any failure returns null and the
 * caller falls back to the PR or issue title (`buildCommitSubject`).
 */
import { COMMIT_SUBJECT_MAX_CHARS, isAcceptableCommitDescription, normalizeCommitDescription } from '@propr/shared';
import { loadSummarizationSettings } from '../config/configManager.js';
import { resolveConfiguredModel } from '../config/configuredModel.js';
import { runLightweightLLMAnalysis } from '../claude/claudeService.js';
import logger from '../utils/logger.js';

function withTimeoutRejection<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export const COMMIT_SUBJECT_TIMEOUT_MS = 30_000;
/** Summary text sent to the model; the subject only needs the gist. */
export const COMMIT_SUBJECT_SUMMARY_MAX_CHARS = 4000;
/** Room left for `type: ` inside the 72-character subject line. */
const DESCRIPTION_TARGET_CHARS = COMMIT_SUBJECT_MAX_CHARS - 12;

export interface CommitSubjectContext {
    taskId?: string;
    correlationId?: string;
    issueRef: { number: number; repoOwner: string; repoName: string };
    prNumber?: number;
    /** Issue or PR title, as context only. */
    title?: string | null;
}

export interface GenerateCommitSubjectDeps {
    loadSettings?: typeof loadSummarizationSettings;
    resolveModel?: typeof resolveConfiguredModel;
    runAnalysis?: typeof runLightweightLLMAnalysis;
    timeoutMs?: number;
}

export function buildCommitSubjectPrompt(summary: string, title?: string | null): string {
    const context = title?.trim() ? `\nThe change was made for: ${title.trim()}\n` : '';
    return `Write the subject line of a git commit for the change described below.

Rules:
- Imperative mood, as an instruction: "Add ...", "Fix ...", "Keep ...". Not "Added", not "I fixed".
- Say what changed, not how the work went: no first person, no test or check results, no finding IDs such as F1.
- At most ${DESCRIPTION_TARGET_CHARS} characters, one line, no trailing period, no type prefix such as "fix:".
${context}
Change description:
${summary.slice(0, COMMIT_SUBJECT_SUMMARY_MAX_CHARS)}

Your output must be ONLY the subject line, with no other text.`;
}

/** The normalized, accepted description, or null when there is no small model, the call failed, or the reply is unusable. */
export async function generateCommitSubject(summary: string | null | undefined, context: CommitSubjectContext, deps: GenerateCommitSubjectDeps = {}): Promise<string | null> {
    const text = summary?.trim();
    if (!text) return null;
    const correlationId = context.correlationId ?? context.taskId ?? 'commit-subject';
    const log = logger.withCorrelation(correlationId);
    try {
        const configured = (await (deps.loadSettings ?? loadSummarizationSettings)()).agent_alias?.trim();
        if (!configured) return null;
        const model = await (deps.resolveModel ?? resolveConfiguredModel)(configured);
        const timeoutMs = deps.timeoutMs ?? COMMIT_SUBJECT_TIMEOUT_MS;
        const reply = await withTimeoutRejection((deps.runAnalysis ?? runLightweightLLMAnalysis)({
            prompt: buildCommitSubjectPrompt(text, context.title), model, timeoutMs, correlationId,
            worktreePath: '', githubToken: '',
            issueRef: context.issueRef, taskId: context.taskId, prNumber: context.prNumber,
            executionType: 'title-generation',
            metadata: { taskKind: 'commit-subject', label: 'Commit subject', configuredVia: 'summarization.agent_alias' },
        }), timeoutMs);
        const description = normalizeCommitDescription(reply);
        if (!isAcceptableCommitDescription(description)) {
            log.warn({ taskId: context.taskId, reply: reply.slice(0, 200) }, 'Generated commit subject was rejected; the commit uses the title');
            return null;
        }
        return description;
    } catch (error) {
        log.warn({ taskId: context.taskId, error: (error as Error).message }, 'Commit subject generation failed; the commit uses the title');
        return null;
    }
}
