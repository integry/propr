import { getAuthenticatedOctokit } from '@propr/core';
import type { ClaudeCodeResponse, AgentExecutionResult } from '@propr/core';

export interface PRFile {
    filename: string;
    status: string;
    additions: number;
    deletions: number;
    patch?: string;
}

/**
 * Fetches all files changed in a PR with their diffs.
 * GitHub limits patch content to ~1MB per file, so very large diffs may be truncated.
 */
export async function fetchPRFiles(
    octokit: Awaited<ReturnType<typeof getAuthenticatedOctokit>>,
    repoOwner: string,
    repoName: string,
    pullRequestNumber: number
): Promise<PRFile[]> {
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
