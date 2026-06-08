import { getAuthenticatedOctokit } from '@propr/core';
import type { ClaudeCodeResponse, AgentExecutionResult } from '@propr/core';

export interface PRFile {
    filename: string;
    status: string;
    additions: number;
    deletions: number;
    patch?: string;
}

export interface FormattedPRDiff {
    diff: string;
    omittedFiles: string[];
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

interface FetchPRFileContentsParams {
    octokit: Awaited<ReturnType<typeof getAuthenticatedOctokit>>;
    repoOwner: string;
    repoName: string;
    prHeadRef: string;
    files: PRFile[];
    maxFiles?: number;
    maxSizePerFile?: number;
}

/**
 * Fetches full content of changed files from the PR head branch.
 * Only fetches non-deleted files up to maxFiles and maxSizePerFile limits.
 */
export async function fetchPRFileContents(params: FetchPRFileContentsParams): Promise<Map<string, string>> {
    const {
        octokit,
        repoOwner,
        repoName,
        prHeadRef,
        files,
        maxFiles = 10,
        maxSizePerFile = 50000,
    } = params;
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
 * Prioritizes concise, reviewable text diffs so the prompt budget is used on
 * changes the reviewer can act on before large/generated/binary artifacts.
 */
export function formatPRDiff(files: PRFile[], maxChars: number = 100000): string {
    return formatPRDiffWithMetadata(files, maxChars).diff;
}

export function formatPRDiffWithMetadata(files: PRFile[], maxChars: number = 100000): FormattedPRDiff {
    if (files.length === 0) return { diff: '', omittedFiles: [] };

    const totalAdditions = files.reduce((s, f) => s + f.additions, 0);
    const totalDeletions = files.reduce((s, f) => s + f.deletions, 0);
    const orderedFiles = [...files].sort(comparePRFilesForReview);
    const parts: string[] = [];
    const omittedFiles: string[] = [];
    let currentSize = 0;

    for (const file of orderedFiles) {
        const section = formatPRFileDiffSection(file);

        if (currentSize + section.length > maxChars) {
            omittedFiles.push(file.filename);
            continue;
        }

        parts.push(section);
        currentSize += section.length;
    }

    const summary = `**${files.length} files changed** (+${totalAdditions}/-${totalDeletions})`;
    const truncationNote = omittedFiles.length > 0
        ? buildOmittedFilesNote(omittedFiles)
        : '';

    return {
        diff: `${summary}\n\n${parts.join('\n')}${truncationNote}`,
        omittedFiles,
    };
}

function buildOmittedFilesNote(omittedFiles: string[]): string {
    const maxListedFiles = 50;
    const listedFiles = omittedFiles.slice(0, maxListedFiles).map(filename => `- ${filename}`).join('\n');
    const remainingCount = omittedFiles.length - maxListedFiles;
    const remainingNote = remainingCount > 0 ? `\n- ...and ${remainingCount} more` : '';

    return [
        '',
        '',
        `*Note: Diff prioritized for review and truncated due to size. ${omittedFiles.length} files omitted. Large, binary, generated, and lockfile changes are deprioritized so smaller source changes fit first.*`,
        '',
        '**Files omitted from review diff:**',
        listedFiles,
        remainingNote,
    ].join('\n');
}

function formatPRFileDiffSection(file: PRFile): string {
    const header = `## ${file.filename} (${file.status}, +${file.additions}/-${file.deletions})`;
    const patch = file.patch || '(binary or too large to display)';
    return `${header}\n\`\`\`diff\n${patch}\n\`\`\`\n`;
}

function comparePRFilesForReview(a: PRFile, b: PRFile): number {
    return reviewPriority(a) - reviewPriority(b)
        || patchSize(a) - patchSize(b)
        || changedLineCount(a) - changedLineCount(b)
        || a.filename.localeCompare(b.filename);
}

function reviewPriority(file: PRFile): number {
    if (!file.patch || isBinaryFile(file.filename)) return 50;
    if (isLockfile(file.filename)) return 40;
    if (isGeneratedOrVendorFile(file.filename)) return 35;
    if (isDocumentationFile(file.filename)) return 20;
    return 0;
}

function patchSize(file: PRFile): number {
    return formatPRFileDiffSection(file).length;
}

function changedLineCount(file: PRFile): number {
    return file.additions + file.deletions;
}

function isLockfile(filename: string): boolean {
    const basename = filename.split('/').pop()?.toLowerCase() || filename.toLowerCase();
    return basename === 'package-lock.json'
        || basename === 'npm-shrinkwrap.json'
        || basename === 'yarn.lock'
        || basename === 'pnpm-lock.yaml'
        || basename === 'bun.lock'
        || basename === 'bun.lockb'
        || basename === 'composer.lock'
        || basename === 'poetry.lock'
        || basename === 'cargo.lock'
        || basename === 'gemfile.lock';
}

function isBinaryFile(filename: string): boolean {
    return /\.(png|jpe?g|gif|webp|avif|ico|bmp|tiff?|pdf|zip|tar|gz|tgz|bz2|xz|7z|rar|woff2?|ttf|eot|otf|mp4|mov|avi|webm|mp3|wav|flac|exe|dll|so|dylib|class|jar)$/i.test(filename);
}

function isGeneratedOrVendorFile(filename: string): boolean {
    return /(^|\/)(dist|build|coverage|vendor|third_party|node_modules)\//.test(filename)
        || /\.min\.(js|css)$/i.test(filename)
        || /\.(generated|gen)\.[cm]?[jt]sx?$/i.test(filename)
        || /\.snap$/i.test(filename);
}

function isDocumentationFile(filename: string): boolean {
    return /\.(md|mdx|rst|txt|adoc)$/i.test(filename)
        || /(^|\/)docs\//i.test(filename);
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
        tokenUsage: result.tokenUsage,
        usageMetrics: result.usageMetrics
    };
}
