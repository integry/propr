import {
    PR_BODY_MAX_LENGTH, PR_TEMPLATE_BODY_SECTIONS, PR_TEMPLATE_MAX_BYTES, PR_TEMPLATE_PATH, PrTemplateError,
    composePrBody, composePrTitle, composeWithRepositoryTemplate, defaultPrBody, parsePrTemplate,
    type ParsedPrTemplate, type PrBodyPiece, type PrTemplateValues,
} from '@propr/shared';
import { sanitizeAgentReport } from '../agents/agentReportSanitizer.js';
import { getAgentTypeFromModel, getModelShortName } from '../config/modelAliases.js';
import { redactSecrets } from '../utils/secretRedaction.js';
import logger from '../utils/logger.js';

export interface PrTemplateSourceEntry {
    name: string;
    path: string;
    type: string;
}

/** Reads repository files at one immutable base commit, never from the task checkout. */
export interface PrTemplateSource {
    readFile(path: string, revision: string): Promise<{ content: string } | null>;
    /** Entries of a directory (`''` is the repository root), or null when it does not exist. */
    listDirectory(path: string, revision: string): Promise<PrTemplateSourceEntry[] | null>;
}

export type ResolvedPrTemplate =
    | { kind: 'propr'; path: string; template: ParsedPrTemplate }
    | { kind: 'github'; path: string; content: string };

/** Where GitHub looks for a pull request template, in its own precedence order. */
const GITHUB_TEMPLATE_DIRECTORIES = ['.github', '', 'docs'];
const MAX_LISTED_COMMITS = 20;
const MAX_FILES_CHANGED = 50;

async function readTemplateFile(source: PrTemplateSource, path: string, revision: string): Promise<string | undefined> {
    const file = await source.readFile(path, revision);
    if (!file) return undefined;
    if (Buffer.byteLength(file.content) > PR_TEMPLATE_MAX_BYTES) throw new PrTemplateError(`${path} exceeds ${PR_TEMPLATE_MAX_BYTES / 1024} KiB`);
    return file.content;
}

/**
 * GitHub's own template: `pull_request_template.md` in `.github/`, the root or
 * `docs/` (any case), or the default of a `PULL_REQUEST_TEMPLATE/` directory:
 * `default.md`, or its only Markdown file.
 */
export async function findGitHubPullRequestTemplate(source: PrTemplateSource, revision: string): Promise<{ path: string; content: string } | undefined> {
    for (const directory of GITHUB_TEMPLATE_DIRECTORIES) {
        const entries = await source.listDirectory(directory, revision);
        if (!entries) continue;
        const file = entries.find(entry => entry.type === 'file' && /^pull_request_template\.md$/i.test(entry.name));
        const content = file && await readTemplateFile(source, file.path, revision);
        if (file && content?.trim()) return { path: file.path, content };
        const folder = entries.find(entry => entry.type === 'dir' && /^pull_request_template$/i.test(entry.name));
        if (!folder) continue;
        const templates = (await source.listDirectory(folder.path, revision) ?? [])
            .filter(entry => entry.type === 'file' && /\.md$/i.test(entry.name));
        const chosen = templates.find(entry => /^default\.md$/i.test(entry.name)) ?? (templates.length === 1 ? templates[0] : undefined);
        const chosenContent = chosen && await readTemplateFile(source, chosen.path, revision);
        if (chosen && chosenContent?.trim()) return { path: chosen.path, content: chosenContent };
    }
    return undefined;
}

export async function loadPrTemplate(source: PrTemplateSource, revision: string, options: { githubFallback: boolean }): Promise<ResolvedPrTemplate | undefined> {
    const content = await readTemplateFile(source, PR_TEMPLATE_PATH, revision);
    if (content !== undefined) return { kind: 'propr', path: PR_TEMPLATE_PATH, template: parsePrTemplate(content) };
    if (!options.githubFallback) return undefined;
    const github = await findGitHubPullRequestTemplate(source, revision);
    return github && { kind: 'github', ...github };
}

export interface PrTemplateValueInput {
    issueNumber?: number;
    issueTitle?: string;
    model?: string | null;
    summary?: string | null;
    sessionId?: string | null;
    cost?: number;
    totalTokens?: number;
    executionTime?: string;
    branch?: string;
    repository?: string;
    commits?: Array<{ sha?: string; message: string }>;
    filesChanged?: string[];
}

function codeSpan(text: string): string {
    return `\`${text.replaceAll('`', '\\`')}\``;
}

/**
 * Placeholder values. Untrusted text takes the same path as ProPR's default
 * description: agent output through sanitizeAgentReport, everything through
 * secret redaction. The renderer additionally neutralizes HTML in both.
 */
export function buildPrTemplateValues(input: PrTemplateValueInput): PrTemplateValues {
    const files = [...new Set((input.filesChanged ?? []).map(file => file.trim()).filter(Boolean))];
    const listedFiles = files.slice(0, MAX_FILES_CHANGED).map(file => `- ${codeSpan(file)}`);
    if (files.length > listedFiles.length) listedFiles.push(`- …and ${files.length - listedFiles.length} more`);
    const commits = (input.commits ?? []).slice(0, MAX_LISTED_COMMITS)
        .map(commit => `- ${commit.sha ? `${codeSpan(commit.sha.slice(0, 7))} ` : ''}${redactSecrets(commit.message.split('\n')[0].trim())}`);
    return {
        issue_number: input.issueNumber === undefined ? '' : String(input.issueNumber),
        issue_title: redactSecrets((input.issueTitle ?? '').replace(/\s+/g, ' ').trim()),
        model: getModelShortName(input.model ?? undefined),
        agent: input.model ? getAgentTypeFromModel(input.model) : '',
        cost: `$${(input.cost ?? 0).toFixed(2)}`,
        tokens: (input.totalTokens ?? 0).toLocaleString('en-US'),
        execution_time: input.executionTime ?? '',
        branch: input.branch ?? '',
        commits: commits.join('\n'),
        files_changed: listedFiles.join('\n'),
        summary: redactSecrets(sanitizeAgentReport(input.summary)),
        session_id: input.sessionId ?? '',
        repository: input.repository ?? '',
    };
}

export interface PullRequestDescription {
    title: string;
    body: string;
    /** Template that shaped the description, when one was applied. */
    template?: { kind: ResolvedPrTemplate['kind']; path: string };
    /** Why a template was found but not applied; the description is ProPR's default. */
    error?: string;
}

/** Apply an already-loaded template. Throws PrTemplateError when it cannot be rendered. */
export function applyPrTemplate(template: ResolvedPrTemplate | undefined, pieces: readonly PrBodyPiece[], defaultTitle: string, values: PrTemplateValues): PullRequestDescription {
    if (!template) return { title: defaultTitle, body: defaultPrBody(pieces) };
    if (template.kind === 'github') {
        return { title: defaultTitle, body: redactSecrets(composeWithRepositoryTemplate(pieces, template.content)), template: { kind: template.kind, path: template.path } };
    }
    const tooLarge = template.template.problems.find(problem => problem.kind === 'too_large');
    if (tooLarge) throw new PrTemplateError(tooLarge.message);
    const { sections } = template.template;
    // Without body sections (the commented `propr init` scaffold, or a title-only
    // template) the description stays byte-identical to ProPR's default.
    const overridesBody = PR_TEMPLATE_BODY_SECTIONS.some(section => sections[section] !== undefined);
    if (!overridesBody && sections.title === undefined) return { title: defaultTitle, body: defaultPrBody(pieces) };
    return {
        title: composePrTitle(defaultTitle, template.template, values),
        body: overridesBody ? redactSecrets(composePrBody(pieces, template.template, values)) : defaultPrBody(pieces),
        template: { kind: template.kind, path: template.path },
    };
}

/**
 * Load and apply the repository's template. Never throws: a template that
 * cannot be read or rendered is logged, reported through `onError` (callers
 * record it on the task timeline) and replaced by the default description.
 */
export async function describePullRequest(options: {
    pieces: readonly PrBodyPiece[];
    defaultTitle: string;
    values: PrTemplateValues;
    loadTemplate?: () => Promise<ResolvedPrTemplate | undefined>;
    /** Longest description the caller can publish; GitHub's limit by default. */
    maxBodyLength?: number;
    onError?: (message: string) => Promise<void> | void;
    context?: Record<string, unknown>;
}): Promise<PullRequestDescription> {
    const { pieces, defaultTitle, values } = options;
    try {
        const description = applyPrTemplate(await options.loadTemplate?.(), pieces, defaultTitle, values);
        // Placeholders can expand a small template past what GitHub accepts.
        const maxBodyLength = options.maxBodyLength ?? PR_BODY_MAX_LENGTH;
        if (description.template && description.body.length > maxBodyLength) {
            throw new PrTemplateError(`The description rendered from ${description.template.path} is ${description.body.length} characters, over the ${maxBodyLength}-character limit`);
        }
        return description;
    } catch (error) {
        const message = (error as Error)?.message || String(error);
        logger.warn({ ...options.context, error: message }, 'Pull request template could not be applied; using the default description');
        try {
            await options.onError?.(message);
        } catch (reportError) {
            logger.warn({ ...options.context, error: (reportError as Error).message }, 'Failed to report pull request template error');
        }
        return { title: defaultTitle, body: defaultPrBody(pieces), error: message };
    }
}
