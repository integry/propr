/**
 * Commit subjects for commits ProPR makes: a short imperative conventional-commit
 * line that says what changed, kept apart from the agent's run summary (which
 * stays in the commit body). The AI marker lives in a `ProPR-Agent` trailer, not
 * in the subject. Dependency-free; the small-model call that proposes the
 * description lives in core (`generateCommitSubject`).
 */
import { isDependencyLockfile, isDependencyManifest, isDocumentationFile, isTestFile } from './changedFileKinds.js';
import { stripStatusSlot } from './prTitleStatusSlot.js';
import { truncateAtWord } from './text.js';

/** Hard cap on the whole subject line, type prefix included. */
export const COMMIT_SUBJECT_MAX_CHARS = 72;

/** Git trailer key that marks a commit made by a ProPR agent run. */
export const PROPR_AGENT_TRAILER = 'ProPR-Agent';

export type CommitType = 'feat' | 'fix' | 'docs' | 'test' | 'ci' | 'build' | 'refactor' | 'perf' | 'chore';

/** Old ProPR subjects (`feat(ai): …`, `fix(ai): …`) and any other conventional prefix. */
const CONVENTIONAL_PREFIX = /^([a-z]+)(?:\(([^)]*)\))?!?:\s*/i;

/** Splits a subject into its conventional-commit parts; recognizes old `type(ai):` history and new `type:` subjects. */
export function parseCommitSubject(subject: string): { type: string | null; scope: string | null; description: string } {
    const line = subject.split('\n')[0].trim();
    const match = CONVENTIONAL_PREFIX.exec(line);
    if (!match) return { type: null, scope: null, description: line };
    return { type: match[1].toLowerCase(), scope: match[2] ?? null, description: line.slice(match[0].length).trim() };
}

/** True for a commit made by a ProPR agent: the new trailer, or the old `(ai)` scope in the subject. */
export function isProprAgentCommit(message: string): boolean {
    if (parseCommitSubject(message).scope?.toLowerCase() === 'ai') return true;
    return new RegExp(`^${PROPR_AGENT_TRAILER}:\\s*\\S`, 'mi').test(message);
}

function isCiFile(path: string): boolean {
    return /^\.github\/(?:workflows|actions)\//.test(path)
        || /(?:^|\/)(?:\.gitlab-ci\.ya?ml|\.circleci\/|azure-pipelines\.ya?ml|Jenkinsfile$|\.buildkite\/)/.test(path);
}

function isDependencyFile(path: string): boolean {
    return isDependencyLockfile(path) || isDependencyManifest(path);
}

/** Documentation, minus dependency manifests that share a docs extension (`requirements.txt`, `docs/package.json`). */
function isDocsChangeFile(path: string): boolean {
    return isDocumentationFile(path) && !isDependencyFile(path);
}

/** One class covering every changed path, or null when the paths are mixed or there are none. */
function pathClass(paths: readonly string[]): CommitType | null {
    const files = paths.map(p => p.trim()).filter(Boolean);
    if (files.length === 0) return null;
    // Tests first: a test fixture under docs/ or a `.md` snapshot is still a test change.
    if (files.every(isTestFile)) return 'test';
    if (files.every(isDependencyFile)) return 'build';
    if (files.every(isDocsChangeFile)) return 'docs';
    if (files.every(isCiFile)) return 'ci';
    if (files.every(f => isTestFile(f) || isDocsChangeFile(f))) return 'test';
    return null;
}

/** Keyword classes, in the order a tie at the same position is broken. */
const KEYWORD_TYPES: ReadonlyArray<[CommitType, RegExp]> = [
    ['fix', /\b(?:fix(?:es|ed|ing)?|bug|broken|crash(?:es|ed)?|regression|repair|correct|resolve[sd]?|prevent|stop|no longer|fail(?:s|ed|ing|ure)?|wrong|incorrect|missing|flak(?:e|y|iness)|hang(?:s|ing)?|leak(?:s)?|error)\b/i],
    ['feat', /\b(?:add(?:s|ed)?|new|support(?:s)?|introduce[sd]?|allow(?:s)?|enable[sd]?|implement(?:s|ed)?|expose[sd]?|create[sd]?)\b/i],
    ['perf', /\b(?:speed up|faster|perf(?:ormance)?|optimi[sz]e[sd]?|cache[sd]?)\b/i],
    ['refactor', /\b(?:refactor(?:s|ed)?|rename[sd]?|restructure[sd]?|simplif(?:y|ies|ied)|extract(?:s|ed)?|split|clean ?up|reorgani[sz]e[sd]?|deduplicate[sd]?)\b/i],
    ['docs', /\b(?:docs?|documentation|readme|changelog|guide)\b/i],
    ['test', /\b(?:tests?|spec|coverage)\b/i],
    ['ci', /\b(?:ci|workflow|pipeline)\b/i],
    ['build', /\b(?:bump|upgrade|dependenc(?:y|ies)|lockfile)\b/i],
];

/** The keyword class that appears earliest in `text`; null when none does. */
function keywordClass(text: string): CommitType | null {
    let best: { type: CommitType; index: number } | null = null;
    for (const [type, pattern] of KEYWORD_TYPES) {
        const index = text.search(pattern);
        if (index >= 0 && (!best || index < best.index)) best = { type, index };
    }
    return best?.type ?? null;
}

const TYPE_ALIASES: Record<string, CommitType> = {
    feat: 'feat', feature: 'feat', fix: 'fix', bugfix: 'fix', docs: 'docs', doc: 'docs', test: 'test', tests: 'test',
    ci: 'ci', build: 'build', deps: 'build', refactor: 'refactor', perf: 'perf', chore: 'chore',
};

/** Conventional types that are not inferred but still dropped from a proposed description. */
const STRIPPED_TYPES: ReadonlySet<string> = new Set(['merge', 'revert', 'style']);

/**
 * The conventional-commit type of a change, from its changed paths and its
 * title (issue or PR title, then the proposed description). A path set of one
 * kind (all docs, all tests, all CI, all dependency files) decides; otherwise
 * an explicit conventional prefix on the title, then the earliest keyword.
 * Unclear changes are `chore`, never `feat` by default.
 */
export function inferCommitType(options: {
    paths?: readonly string[]; title?: string | null; description?: string | null;
    /** Type when neither paths nor wording decide; `chore` unless given. */
    defaultType?: CommitType;
}): CommitType {
    const byPath = pathClass(options.paths ?? []);
    if (byPath) return byPath;
    for (const text of [options.title, options.description]) {
        if (!text) continue;
        const prefixed = parseCommitSubject(cleanCommitTitle(text) ?? text).type;
        if (prefixed && TYPE_ALIASES[prefixed]) return TYPE_ALIASES[prefixed];
    }
    for (const text of [options.title, options.description]) {
        const found = text ? keywordClass(cleanCommitTitle(text) ?? text) : null;
        if (found) return found;
    }
    return options.defaultType ?? 'chore';
}

/** First-person wording (agent narration) and test-result reports have no place in a subject. */
// Case-sensitive: "I" is the pronoun; "In", "i18n" and "I/O" are not.
const FIRST_PERSON_SINGULAR = /(?:^|[^\w'/])I(?:'m|'ve|'ll|'d)?(?![\w'/])/;
const FIRST_PERSON_OTHER = /\b(?:me|my|we|we've|we're|we'll|our)\b/i;
const TEST_REPORT = /\b(?:tests?|checks?|suites?|typecheck|lint|build)\s+(?:now\s+|all\s+|still\s+)?(?:pass(?:es|ed)?|are green|is green|succeed(?:s|ed)?)\b|\b\d+\s*(?:of|\/)\s*\d+\s+(?:tests?\s+)?pass/i;

/** True when `description` reads as a commit subject: present, not narration, not a test report. */
export function isAcceptableCommitDescription(description: string | null | undefined): description is string {
    const text = (description ?? '').trim();
    if (text.length < 3) return false;
    if (FIRST_PERSON_SINGULAR.test(text) || FIRST_PERSON_OTHER.test(text)) return false;
    return !TEST_REPORT.test(text);
}

/**
 * Normalizes a proposed subject description: first line only, no markdown,
 * quotes, label or conventional prefix, no trailing period, lower-case first
 * letter unless the first word is an acronym or identifier.
 */
export function normalizeCommitDescription(raw: string | null | undefined): string {
    let text = (raw ?? '').split('\n').map(line => line.trim()).find(Boolean) ?? '';
    text = text.replace(/^#+\s*/, '').replace(/\*\*|__/g, '').replace(/^(?:commit\s+)?(?:subject|title|message)\s*:\s*/i, '');
    text = text.replace(/^["'`“‘]+|["'`”’]+$/g, '').trim();
    const parsed = parseCommitSubject(text);
    // Only a real conventional prefix is dropped: "Fleet: rotate keys" keeps its "Fleet:".
    if (parsed.type && (TYPE_ALIASES[parsed.type] || STRIPPED_TYPES.has(parsed.type))) text = parsed.description;
    text = text.replace(/\s+/g, ' ').replace(/[.。]+$/u, '').trim();
    if (/^[A-Z](?:[a-z]|\s)/.test(text) && !/^I\s/.test(text)) text = text[0].toLowerCase() + text.slice(1);
    return text;
}

/**
 * A PR or issue title as a subject description: no `[N by Model]` prefix, no
 * status slot, no trailing `(#N)`, no conventional prefix. Null when empty.
 */
export function cleanCommitTitle(title: string | null | undefined): string | null {
    let text = (stripStatusSlot(title ?? '') ?? '').trim();
    // Plain index scans, not `\s*…\s*$` regexes: those backtrack polynomially on long whitespace runs.
    if (text.startsWith('[')) {
        const close = text.indexOf(']');
        if (close > 0 && /\bby\b/i.test(text.slice(1, close))) text = text.slice(close + 1).trim();
    }
    const issueRef = /\(#\d+\)$/.exec(text);
    if (issueRef) text = text.slice(0, issueRef.index).trim();
    return text || null;
}

/** `type: description`, cut at a word boundary to fit `COMMIT_SUBJECT_MAX_CHARS`. */
export function formatCommitSubject(type: string, description: string, max = COMMIT_SUBJECT_MAX_CHARS): string {
    const prefix = `${type}: `;
    return `${prefix}${truncateAtWord(description.trim(), Math.max(1, max - prefix.length))}`;
}

export interface BuildCommitSubjectOptions {
    /** Description the small model proposed; used only when it reads as a subject. */
    generated?: string | null;
    /** PR or issue title: the fallback when generation failed or was rejected. Never the run summary. */
    title?: string | null;
    /** Last resort when there is no usable title, for example `resolve issue #12`. */
    fallback: string;
    /** Changed paths, for the conventional-commit type. */
    paths?: readonly string[];
    /** Forces the type (merge commits, recovery commits). */
    type?: string;
}

/** The subject line: generated description, else the title, else the fallback; type inferred unless given. */
export function buildCommitSubject(options: BuildCommitSubjectOptions): string {
    const generated = normalizeCommitDescription(options.generated);
    // The title passes the same check: an issue titled "I cannot log in" or "All tests pass" is no subject either.
    const fromTitle = normalizeCommitDescription(cleanCommitTitle(options.title));
    const description = [generated, fromTitle].find(isAcceptableCommitDescription)
        ?? (normalizeCommitDescription(options.fallback) || options.fallback);
    const type = options.type ?? inferCommitType({ paths: options.paths, title: options.title, description });
    return formatCommitSubject(type, description);
}

/** `ProPR-Agent: <agent alias>/<model>`; the alias is omitted when unknown. */
export function proprAgentTrailer(agentAlias: string | null | undefined, model: string | null | undefined): string {
    const value = [agentAlias?.trim(), model?.trim()].filter(Boolean).join('/') || 'unknown';
    return `${PROPR_AGENT_TRAILER}: ${value}`;
}

/** Subject, blank line, body, blank line, trailers (git reads trailers from the last paragraph only). */
export function assembleCommitMessage(subject: string, body: string | null | undefined, trailers: readonly string[] = []): string {
    const parts = [subject.trim()];
    const text = (body ?? '').trim();
    if (text) parts.push(text);
    if (trailers.length > 0) parts.push(trailers.join('\n'));
    return parts.join('\n\n');
}

/** Removes a trailing `ProPR-Agent` trailer paragraph, for showing a commit body as prose. */
export function stripProprAgentTrailer(message: string): string {
    return message.replace(new RegExp(`\\n*^${PROPR_AGENT_TRAILER}:[^\\n]*$`, 'gm'), '').trimEnd();
}

/** The conventional type of a new-style ProPR subject (`fix: …`); null for old `feat(ai): …` history or none. */
function trustedSubjectType(subject: string): CommitType | null {
    const parsed = parseCommitSubject(subject);
    if (!parsed.type || parsed.scope?.toLowerCase() === 'ai') return null;
    return TYPE_ALIASES[parsed.type] ?? null;
}

/**
 * Squash fields for merging a sub-PR into an epic branch. The subject is built
 * from the sub-PR title (never from the first commit's first paragraph), with
 * ` (#N)` like GitHub's own squash title. The body is the first commit's
 * message without its subject when that subject is a new-style one; an old
 * summary-as-subject commit keeps its whole message, so no summary text is lost.
 */
export function epicSquashCommitFields(
    pull: { number: number; title?: string | null },
    firstCommitMessage?: string | null,
): { commit_title: string; commit_message?: string } {
    const suffix = ` (#${pull.number})`;
    const first = (firstCommitMessage ?? '').trim();
    const [firstSubject = '', ...rest] = first.split('\n');
    const trustedType = trustedSubjectType(firstSubject);
    const fromTitle = normalizeCommitDescription(cleanCommitTitle(pull.title));
    const fromCommit = trustedType ? normalizeCommitDescription(firstSubject) : '';
    const description = [fromTitle, fromCommit].find(isAcceptableCommitDescription) ?? `merge pull request #${pull.number}`;
    // The title's wording decides; the first commit's own type only breaks a tie.
    const type = inferCommitType({ title: pull.title, description, defaultType: trustedType ?? undefined });
    const subject = formatCommitSubject(type, description, COMMIT_SUBJECT_MAX_CHARS - suffix.length) + suffix;
    const body = (trustedType ? rest.join('\n') : first).trim();
    return body ? { commit_title: subject, commit_message: body } : { commit_title: subject };
}
