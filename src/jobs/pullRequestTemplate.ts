import {
    buildPrTemplateValues, describePullRequest, loadPrTemplate, loadRepositoryGitHubPrTemplateFallback, TaskStates, withRetry, retryConfigs,
    type PrTemplateSource, type ResolvedPrTemplate, type WorkerStateManager,
} from '@propr/core';
import { PrTemplateError } from '@propr/shared';
import type { Logger } from 'pino';

type Octokit = {
    request: <T = unknown>(endpoint: string, options: Record<string, unknown>) => Promise<T>;
};

type ContentsEntry = { name: string; path: string; type: string; encoding?: string; content?: string };

/** Repository files at an immutable revision through the contents API, the same way `.propr/workflow.yml` is read. */
export function createGitHubPrTemplateSource(octokit: Octokit, owner: string, repo: string, correlationId?: string): PrTemplateSource {
    const contents = async (path: string, ref: string): Promise<ContentsEntry | ContentsEntry[] | null> => {
        try {
            const response = await withRetry(
                () => octokit.request<{ data: ContentsEntry | ContentsEntry[] }>('GET /repos/{owner}/{repo}/contents/{path}', { owner, repo, path, ref }),
                { ...retryConfigs.githubApi, correlationId }, 'read_pull_request_template',
            );
            return response.data;
        } catch (error) {
            if ((error as { status?: number }).status === 404) return null;
            throw error;
        }
    };
    return {
        async readFile(path, revision) {
            const file = await contents(path, revision);
            if (!file) return null;
            if (Array.isArray(file) || file.type !== 'file' || file.encoding !== 'base64' || typeof file.content !== 'string') {
                throw new PrTemplateError(`${path} must be a regular UTF-8 file`);
            }
            try {
                return { content: new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(file.content, 'base64')) };
            } catch {
                throw new PrTemplateError(`${path} must contain valid UTF-8 text`);
            }
        },
        async listDirectory(path, revision) {
            const entries = await contents(path, revision);
            return Array.isArray(entries) ? entries.map(({ name, path, type }) => ({ name, path, type })) : null;
        },
    };
}

/** Read the pull request template from the head of the PR's base branch. */
export async function loadPullRequestTemplate(options: {
    octokit: Octokit; repoOwner: string; repoName: string; baseBranch: string; correlationId?: string;
}): Promise<ResolvedPrTemplate | undefined> {
    const { octokit, repoOwner: owner, repoName: repo, baseBranch, correlationId } = options;
    const { data: { sha: revision } } = await withRetry(
        () => octokit.request<{ data: { sha: string } }>('GET /repos/{owner}/{repo}/commits/{ref}', { owner, repo, ref: baseBranch }),
        { ...retryConfigs.githubApi, correlationId }, 'resolve_pull_request_template_revision',
    );
    const githubFallback = await loadRepositoryGitHubPrTemplateFallback(`${owner}/${repo}`);
    return loadPrTemplate(createGitHubPrTemplateSource(octokit, owner, repo, correlationId), revision, { githubFallback });
}

/**
 * Explain on the task timeline why the default description was used. Best
 * effort: reporting must never affect the pull request or the run.
 */
export async function recordPullRequestTemplateError(options: {
    stateManager?: WorkerStateManager; taskId?: string; message: string; correlatedLogger: Logger;
}): Promise<void> {
    const { stateManager, taskId, message, correlatedLogger } = options;
    if (!stateManager || !taskId) return;
    try {
        const current = await stateManager.getTaskState(taskId);
        if (!current || ([TaskStates.CANCELLED, TaskStates.FAILED, TaskStates.COMPLETED] as string[]).includes(current.state)) return;
        await stateManager.updateTaskState(taskId, current.state, {
            reason: 'Pull request template could not be applied; used the default description',
            historyMetadata: { prTemplateError: message },
        });
    } catch (error) {
        correlatedLogger.warn({ taskId, error: (error as Error).message }, 'Failed to record pull request template error on the timeline');
    }
}

/**
 * A continuation PR's description shaped by the repository's template: the
 * default continuation text is its summary section. The continuation marker
 * always stays, and a description GitHub would reject keeps the default.
 */
export async function describeContinuationPullRequest(options: {
    octokit: Octokit;
    record: { repository: string; source_pr: number; source_title: string; branch_name: string; base_branch: string };
    marker: string;
    fallback: string;
    maxLength: number;
}): Promise<string> {
    const { octokit, record, marker, fallback } = options;
    const [repoOwner, repoName] = record.repository.split('/');
    const { body } = await describePullRequest({
        pieces: [{ section: 'summary', text: fallback }],
        defaultTitle: '',
        values: buildPrTemplateValues({ issueTitle: record.source_title, branch: record.branch_name, repository: record.repository }),
        loadTemplate: () => loadPullRequestTemplate({ octokit, repoOwner, repoName, baseBranch: record.base_branch }),
        context: { repository: record.repository, sourcePR: record.source_pr },
    });
    const marked = body.includes(marker) ? body : `${marker}\n${body}`;
    return marked.length <= options.maxLength ? marked : fallback;
}
