import { getAuthenticatedOctokit } from '@propr/core';
import type { ClaudeCodeResponse, AgentExecutionResult } from '@propr/core';

export interface PRFile {
    filename: string;
    status: string;
    additions: number;
    deletions: number;
    patch?: string;
}

interface FetchPRFilesParams {
    octokit: Awaited<ReturnType<typeof getAuthenticatedOctokit>>;
    repoOwner: string;
    repoName: string;
    pullRequestNumber: number;
}

/**
 * Fetches all files changed in a PR with their diffs.
 * GitHub limits patch content to ~1MB per file, so very large diffs may be truncated.
 */
export async function fetchPRFiles({
    octokit,
    repoOwner,
    repoName,
    pullRequestNumber,
}: FetchPRFilesParams): Promise<PRFile[]> {
    const files: PRFile[] = [];
    let page = 1;
    let hasMoreFiles = true;

    while (hasMoreFiles) {
        const resp = await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}/files', {
            owner: repoOwner,
            repo: repoName,
            pull_number: pullRequestNumber,
            per_page: 100,
            page,
        });

        const pageFiles = resp.data as PRFile[];
        files.push(...pageFiles);

        const linkHeader = (resp.headers as Record<string, string | undefined>).link;
        hasMoreFiles = Boolean(linkHeader && linkHeader.includes('rel="next"'));
        page++;
    }

    return files;
}

/**
 * Fetches full content of changed files from the PR head branch.
 * Only fetches non-deleted files up to maxFiles and maxSizePerFile limits.
 */
export async function fetchPRFileContents(
    octokit: Awaited<ReturnType<typeof getAuthenticatedOctokit>>,
    repoOwner: string,
    repoName: string,
    prHeadRef: string,
    files: PRFile[],
    maxFiles: number = 10,
    maxSizePerFile: number = 50000
): Promise<Map<string, string>> {
    const contents = new Map<string, string>();
    const eligibleFiles = files
        .filter(f => f.status !== 'removed' && !f.filename.match(/\.(png|jpg|jpeg|gif|svg|ico|woff|woff2|ttf|eot|pdf|zip|tar|gz)$/i))
        .slice(0, maxFiles);

    for (const file of eligibleFiles) {
        try {
            const resp = await octokit.request('GET /repos/{owner}/{repo}/contents/{path}', {
                owner: repoOwner,
                repo: repoName,
                path: file.filename,
                ref: prHeadRef,
            });

            const data = resp.data as { content?: string; encoding?: string; size?: number };
            if (data.content && data.encoding === 'base64' && (data.size || 0) <= maxSizePerFile) {
                const decoded = Buffer.from(data.content, 'base64').toString('utf-8');
                contents.set(file.filename, decoded);
            }
        } catch {
            // File might not exist or be too large - skip silently
        }
    }

    return contents;
}

/**
 * Formats full file contents for inclusion in review prompts.
 */
export function formatFileContents(contents: Map<string, string>, maxChars: number = 100000): string {
    if (contents.size === 0) return '';

    const parts: string[] = [];
    let currentSize = 0;

    for (const [filename, content] of contents) {
        const ext = filename.split('.').pop() || '';
        const section = `## ${filename}\n\`\`\`${ext}\n${content}\n\`\`\`\n`;

        if (currentSize + section.length > maxChars) break;

        parts.push(section);
        currentSize += section.length;
    }

    return parts.length > 0
        ? `**Full content of ${parts.length} changed files (for context):**\n\n${parts.join('\n')}`
        : '';
}

/**
 * Formats PR files into a diff string for inclusion in review prompts.
 * Truncates if total size exceeds maxChars to avoid prompt bloat.
 */
export function formatPRDiff(files: PRFile[], maxChars: number = 100000): string {
    if (files.length === 0) return '';

    const parts: string[] = [];
    let currentSize = 0;
    let truncated = false;

    for (const file of files) {
        const header = `## ${file.filename} (${file.status}, +${file.additions}/-${file.deletions})`;
        const patch = file.patch || '(binary or too large to display)';
        const section = `${header}\n\`\`\`diff\n${patch}\n\`\`\`\n`;

        if (currentSize + section.length > maxChars) {
            truncated = true;
            break;
        }

        parts.push(section);
        currentSize += section.length;
    }

    const summary = `**${files.length} files changed** (+${files.reduce((s, f) => s + f.additions, 0)}/-${files.reduce((s, f) => s + f.deletions, 0)})`;
    const truncationNote = truncated ? `\n\n*Note: Diff truncated due to size. ${files.length - parts.length} files omitted.*` : '';

    return `${summary}\n\n${parts.join('\n')}${truncationNote}`;
}

/**
 * Converts AgentExecutionResult to ClaudeCodeResponse for backwards compatibility
 * with existing post-processing code.
 */
export function agentResultToClaudeResponse(result: AgentExecutionResult): ClaudeCodeResponse {
    return {
        success: result.success,
        model: result.modelUsed,
        executionTime: result.executionTimeMs,
        output: null,
        sessionId: result.sessionId || null,
        conversationId: result.conversationId,
        finalResult: result.summary ? { type: 'result', result: result.summary } : null,
        rawOutput: result.rawOutput,
        summary: result.summary || null,
        logs: result.logs,
        exitCode: result.exitCode ?? null,
        error: result.error,
        modifiedFiles: result.modifiedFiles,
        commitMessage: result.commitMessage || null,
        conversationLog: result.conversationLog,
        tokenUsage: result.tokenUsage
    };
}
