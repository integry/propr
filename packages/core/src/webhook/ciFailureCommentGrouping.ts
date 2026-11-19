/**
 * One CI-failure comment per head commit, best effort.
 *
 * Before a new CI-failure comment is posted, the PR's comments are read once:
 * a ProPR-authored CI-failure comment carrying the same head-commit marker is
 * edited to list the new check instead of posting a second comment (which
 * would start a second follow-up run for the same commit). This is best
 * effort: two deliveries arriving together can both post, or both edit from
 * the same snapshot so the later edit drops the earlier check's entry; that is
 * accepted. Any read or edit failure falls back to posting, so no failure
 * report is dropped.
 */
import type logger from '../utils/logger.js';
import type { CancellationProvenanceOctokit } from './ciCancellationProvenance.js';
import { checkTitle, dependencyLineNames } from './ciFailureCommentText.js';

type Log = ReturnType<typeof logger.withCorrelation>;

const HEAD_MARKER_PREFIX = '<!-- propr:ci-failure-head';
const MARKER_BLOCK_START = '\n<!-- propr:ci-failure-';
const SINGLE_FAILURE_INSTRUCTION = 'Please investigate and fix this CI failure.';
const MULTIPLE_FAILURES_INSTRUCTION = 'Please investigate and fix these CI failures.';
const SECTION_SEPARATOR = '\n\n---\n\n';
const TITLE_PREFIX = 'CI failed: ';
const CHECK_LINE_PREFIX = '- Check: `';
const COMMIT_LINE_PREFIX = '- Commit: ';

export interface ExistingCiFailureComment {
    id: number;
    body: string;
}

export interface CiFailureCommentScan {
    /** A ProPR comment already reports this exact check on this head. */
    duplicate: boolean;
    /** The ProPR CI-failure comment for the same head commit, if any. */
    sameHead: ExistingCiFailureComment | null;
}

export function buildCiFailureHeadMarker(sha: string): string {
    return `${HEAD_MARKER_PREFIX} sha="${sha.toLowerCase()}" -->`;
}

/** Reads app-authored comments for this check's key and for this head commit. */
export function scanCiFailureComments(
    comments: unknown[],
    { dedupeKey, sha, botUsernames }: { dedupeKey: string; sha: string; botUsernames: Set<string> },
): CiFailureCommentScan {
    const keyMarker = `key="${dedupeKey}"`;
    const headMarker = buildCiFailureHeadMarker(sha);
    const scan: CiFailureCommentScan = { duplicate: false, sameHead: null };
    for (const comment of comments) {
        if (typeof comment !== 'object' || comment === null) continue;
        const { id, body, user } = comment as { id?: unknown; body?: unknown; user?: { login?: unknown } | null };
        if (typeof body !== 'string' || typeof user?.login !== 'string' || !botUsernames.has(user.login)) continue;
        if (body.includes(keyMarker)) scan.duplicate = true;
        if (!scan.sameHead && typeof id === 'number' && body.includes(headMarker)) scan.sameHead = { id, body };
    }
    return scan;
}

/**
 * Adds one check to an existing same-head comment: its name joins the title,
 * its details and evidence join the listed ones, and its key marker joins the
 * hidden markers at the end, so redeliveries of it stay deduplicated. The
 * checks are then ordered so that every check whose dependency line names
 * another listed check comes after it, whatever order they arrived in; checks
 * with no such relation keep their arrival order. The title follows the same
 * order and the shared commit line moves to the first check's section.
 */
export function appendCheckToCiFailureComment(
    body: string,
    check: { name: string; title: string; section: string[]; marker: string },
): string {
    const markerAt = body.indexOf(MARKER_BLOCK_START);
    const content = markerAt === -1 ? body.trimEnd() : body.slice(0, markerAt).trimEnd();
    const markers = [markerAt === -1 ? '' : body.slice(markerAt + 1).trimEnd(), check.marker].filter(Boolean).join('\n');
    const [title, ...rest] = content.split('\n');
    const instructionAt = rest.indexOf(SINGLE_FAILURE_INSTRUCTION);
    if (instructionAt !== -1) rest[instructionAt] = MULTIPLE_FAILURES_INSTRUCTION;
    const ordered = orderByDependencies(title, rest, check);
    if (ordered) return [...ordered, '', markers].join('\n');
    return [`${title}, ${check.title}`, ...rest, '', '---', '', ...check.section, '', markers].join('\n');
}

interface ListedSection {
    name: string;
    lines: string[];
}

/**
 * The comment content with `check` added and every listed check placed after
 * the listed checks its dependency line names; null when the comment's layout
 * is not the one `buildCommentContent` writes (the check is then appended).
 */
function orderByDependencies(
    title: string,
    rest: string[],
    check: { name: string; title: string; section: string[] },
): string[] | null {
    const [blank, instruction, separator, ...sectionLines] = rest;
    if (blank !== '' || separator !== '' || ![SINGLE_FAILURE_INSTRUCTION, MULTIPLE_FAILURES_INSTRUCTION].includes(instruction)) return null;
    const listed: ListedSection[] = [];
    for (const lines of sectionLines.join('\n').split(SECTION_SEPARATOR).map(section => section.split('\n'))) {
        const name = sectionCheckName(lines);
        if (name === null) return null;
        listed.push({ name, lines });
    }
    // The title must be the one written for the listed checks, so it can be rebuilt.
    if (title !== `${TITLE_PREFIX}${listed.map(section => checkTitle(section)).join(', ')}`) return null;
    // The commit line follows the first check's result.
    if (!listed[0].lines[2]?.startsWith(COMMIT_LINE_PREFIX)) return null;
    const [commitLine] = listed[0].lines.splice(2, 1);

    const ordered = dependencyOrder([...listed, { name: check.name, lines: [...check.section] }]);
    ordered[0].lines.splice(2, 0, commitLine);
    return [
        `${TITLE_PREFIX}${ordered.map(section => checkTitle(section)).join(', ')}`,
        blank, instruction, separator,
        ...ordered.map(section => section.lines.join('\n')).join(SECTION_SEPARATOR).split('\n'),
    ];
}

/**
 * The sections with each one after every other section its dependency line
 * names, keeping the given order otherwise: each step takes the first section
 * whose named sections are all placed. A dependency cycle (not possible in a
 * valid workflow) is broken by taking the first remaining section.
 */
function dependencyOrder(sections: ListedSection[]): ListedSection[] {
    const needs = sections.map(section => sections.filter(other =>
        other !== section && section.lines.some(line => dependencyLineNames(line, other.name))));
    const remaining = sections.map((section, index) => ({ section, needs: needs[index] }));
    const placed = new Set<ListedSection>();
    const ordered: ListedSection[] = [];
    while (remaining.length > 0) {
        const readyAt = remaining.findIndex(entry => entry.needs.every(other => placed.has(other)));
        const [{ section }] = remaining.splice(readyAt === -1 ? 0 : readyAt, 1);
        placed.add(section);
        ordered.push(section);
    }
    return ordered;
}

/** The check name of a section, read back from its `- Check:` line. */
function sectionCheckName(section: string[]): string | null {
    const line = section[0];
    if (!line?.startsWith(CHECK_LINE_PREFIX) || !line.endsWith('`')) return null;
    return line.slice(CHECK_LINE_PREFIX.length, -1).replace(/\\([\\`])/gu, '$1');
}

/**
 * Edits the head's existing comment. Editing a ProPR CI-failure comment starts
 * no follow-up of its own (one was already requested for this commit). False
 * when the edit failed; the caller then posts a new comment instead.
 */
export async function editCiFailureComment(
    octokit: CancellationProvenanceOctokit,
    target: { owner: string; repo: string; commentId: number; body: string },
    log: Log,
): Promise<boolean> {
    try {
        await octokit.request('PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}', {
            owner: target.owner, repo: target.repo, comment_id: target.commentId, body: target.body,
        });
        log.info({ owner: target.owner, repo: target.repo, commentId: target.commentId }, 'Listed failed check on the existing CI-failure comment for this head');
        return true;
    } catch (error) {
        log.warn({ commentId: target.commentId, error: (error as Error).message }, 'Could not add the failed check to the existing CI-failure comment; posting a new one');
        return false;
    }
}
