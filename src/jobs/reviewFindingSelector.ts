import type { Job } from 'bullmq';
import type { Logger } from 'pino';
import type { Redis } from 'ioredis';
import type { CommentJobData } from '@propr/core';
import {
    MAX_REVIEW_FEEDBACK_SELECTION,
    type ReviewFeedbackSelection,
    emptyReviewFeedbackSelection,
    isEmptyReviewFeedbackSelection,
    isMalformedReviewFeedbackToken,
    normalizeReviewFeedbackId,
    reviewFeedbackSelectionSize,
} from '@propr/shared';
import { formatActionableFindings, gatherUnprocessedReviewComments } from './reviewCommentGatherer.js';
import type { AIReviewComment, ActionableFinding, ReviewSuggestion } from './reviewCommentGatherer.js';
import { formatRecordFields } from './reviewRecordFields.js';

/**
 * Everything a `/fix` command line carried: what was selected, what was typed,
 * and which tokens looked like identifiers but were not.
 */
export interface FixSelection extends ReviewFeedbackSelection {
    /** Command-line remainder plus every following line, verbatim and trimmed. */
    instructions: string;
    /** Selector-shaped tokens that are not valid identifiers, e.g. `S0`. */
    malformedIds: string[];
}

/** Historic alias; the selection now carries both namespaces. */
export type FixFindingSelection = FixSelection;

/**
 * Parse the text that follows the `/fix` keyword.
 *
 * Only the FIRST line can carry identifiers. That boundary is what makes the
 * free-text half of this feature possible at all: without it, a user whose
 * instructions happen to begin with `S3 should also change` would have their
 * prose eaten as a selector. Everything below the command line is prose by
 * construction, which is also how the user documentation describes it.
 *
 * Parsing stops at the first non-selector token on the command line; that token
 * and the rest of the line join the instructions. A `;` still closes the
 * selector clause explicitly, and commas still separate selectors, both of which
 * `/fix` has always accepted. Selector-shaped-but-invalid tokens do NOT stop
 * parsing — they are collected for reporting, because reclassifying `S0` as
 * prose turns a typo into a silently empty request. Resolution then fails the
 * request closed and reports them (see `resolveReviewFeedback`).
 */
export function parseFixSelection(text: string | undefined | null): FixSelection {
    const selection: FixSelection = { ...emptyReviewFeedbackSelection(), instructions: '', malformedIds: [] };
    if (!text) return selection;
    // Normalise line endings first so a CRLF comment body from the GitHub web UI
    // parses identically to an LF one.
    const [commandLine = '', ...following] = text.replace(/\r\n?/g, '\n').split('\n');
    const tokens = [...commandLine.matchAll(/[^,\s]+/g)].map(match => ({ value: match[0], start: match.index }));
    const seen = new Set<string>();
    /** Offset on the command line where instruction text begins, if any. */
    let proseStart: number | null = null;

    for (const token of tokens) {
        const terminator = token.value.indexOf(';');
        const core = terminator === -1 ? token.value : token.value.slice(0, terminator);
        if (core !== '') {
            const resolved = normalizeReviewFeedbackId(core);
            if (resolved) {
                if (!seen.has(resolved.id)) {
                    seen.add(resolved.id);
                    (resolved.kind === 'finding' ? selection.findingIds : selection.suggestionIds).push(resolved.id);
                }
            } else if (isMalformedReviewFeedbackToken(core)) {
                selection.malformedIds.push(core.toUpperCase());
            } else {
                proseStart = token.start;
                break;
            }
        }
        if (terminator !== -1) {
            proseStart = token.start + terminator + 1;
            break;
        }
    }

    const remainderOfCommandLine = proseStart === null ? '' : commandLine.slice(proseStart).trim();
    selection.instructions = [remainderOfCommandLine, ...following].join('\n').trim();
    return selection;
}

/**
 * Backward-compatible shim for call sites and tests that still ask only for
 * findings. Kept deliberately: it documents the old contract as a projection of
 * the new one rather than as a second implementation.
 */
export function parseFixFindingSelection(text: string | undefined | null): FixSelection {
    return parseFixSelection(text);
}

/** What the gathered reviews could and could not satisfy from one selection. */
export interface FixFeedbackResolution {
    /** Review comments narrowed to the selected records. */
    comments: AIReviewComment[];
    /** Identifiers the live reviews actually offered. */
    selected: ReviewFeedbackSelection;
    /** Requested identifiers no current review offers. */
    unresolved: ReviewFeedbackSelection;
    malformedIds: string[];
}

function sortNewestFirst(comments: AIReviewComment[]): AIReviewComment[] {
    return [...comments].sort((left, right) =>
        new Date(right.created_at).getTime() - new Date(left.created_at).getTime()
        || right.id - left.id,
    );
}

/**
 * Filter gathered review comments down to the selection, reporting anything the
 * live reviews no longer offer instead of dropping it silently.
 *
 * A selection that names nothing keeps the pre-existing meaning: every
 * unprocessed actionable finding, and no suggestions. Suggestions are opt-in by
 * construction — that is the whole point of the blocker/suggestion boundary, and
 * this default is what preserves it for every caller that does not name one.
 *
 * A requested identifier that appears in more than one review resolves against
 * the newest of them, which is how legacy reviews that reused `F1` stay
 * unambiguous.
 */
export function resolveReviewFeedback(
    comments: AIReviewComment[],
    selection: FixSelection,
): FixFeedbackResolution {
    // A selector-shaped typo fails the whole request closed. Falling back to the
    // bare meaning of `/fix` would address every pending blocker instead of the
    // records the user named, and honouring only the valid half would act on a
    // request that was partly not understood. Both are silent substitutions; a
    // posted message naming the bad identifier is not.
    if (selection.malformedIds.length > 0) {
        return {
            comments: [],
            selected: emptyReviewFeedbackSelection(),
            unresolved: emptyReviewFeedbackSelection(),
            malformedIds: selection.malformedIds,
        };
    }
    if (isEmptyReviewFeedbackSelection(selection)) {
        const bare = comments
            .map(comment => ({
                ...comment,
                body: formatActionableFindings(comment.actionableFindings),
                suggestions: [] as ReviewSuggestion[],
            }))
            .filter(comment => comment.actionableFindings.length > 0);
        return {
            comments: bare,
            selected: {
                findingIds: bare.flatMap(comment => comment.actionableFindings.map(finding => finding.id.toUpperCase())),
                suggestionIds: [],
            },
            unresolved: emptyReviewFeedbackSelection(),
            malformedIds: selection.malformedIds,
        };
    }

    const requestedFindings = new Set(selection.findingIds);
    const requestedSuggestions = new Set(selection.suggestionIds);
    const findingOwner = new Map<string, number>();
    const suggestionOwner = new Map<string, number>();
    for (const comment of sortNewestFirst(comments)) {
        for (const finding of comment.actionableFindings) {
            const id = finding.id.toUpperCase();
            if (requestedFindings.has(id) && !findingOwner.has(id)) findingOwner.set(id, comment.id);
        }
        for (const suggestion of comment.suggestions) {
            const id = suggestion.id.toUpperCase();
            if (requestedSuggestions.has(id) && !suggestionOwner.has(id)) suggestionOwner.set(id, comment.id);
        }
    }

    const filtered = comments
        .map(comment => {
            const actionableFindings = comment.actionableFindings.filter(finding =>
                findingOwner.get(finding.id.toUpperCase()) === comment.id,
            );
            const suggestions = comment.suggestions.filter(suggestion =>
                suggestionOwner.get(suggestion.id.toUpperCase()) === comment.id,
            );
            return { ...comment, body: formatActionableFindings(actionableFindings), actionableFindings, suggestions };
        })
        // A review that contributes nothing to this selection is dropped entirely,
        // so its prose cannot widen the scope the user asked for.
        .filter(comment => comment.actionableFindings.length > 0 || comment.suggestions.length > 0);

    return {
        comments: filtered,
        selected: {
            findingIds: selection.findingIds.filter(id => findingOwner.has(id)),
            suggestionIds: selection.suggestionIds.filter(id => suggestionOwner.has(id)),
        },
        unresolved: {
            findingIds: selection.findingIds.filter(id => !findingOwner.has(id)),
            suggestionIds: selection.suggestionIds.filter(id => !suggestionOwner.has(id)),
        },
        malformedIds: selection.malformedIds,
    };
}

/** Preserved signature for callers that only need the filtered comments. */
export function selectReviewFeedback(
    comments: AIReviewComment[],
    selection: FixSelection,
): AIReviewComment[] {
    return resolveReviewFeedback(comments, selection).comments;
}

/**
 * Selected feedback is the authorization boundary for `/fix`: a run is
 * authorized when it resolved to at least one finding OR at least one
 * explicitly requested suggestion. Suggestions count here — an explicit
 * `/fix S3` is a real request and must not fall through to the "nothing to do"
 * path — but counting them here changes nothing about whether blockers are
 * required, which is decided by `getPendingReviewState`, not by this predicate.
 */
export function hasAuthorizedFixFeedback(selected: FixFeedbackResolution | AIReviewComment[]): boolean {
    const comments = Array.isArray(selected) ? selected : selected.comments;
    return comments.some(comment => comment.actionableFindings.length > 0 || comment.suggestions.length > 0);
}

export async function prepareFixReviewFeedback(params: {
    job: Job<CommentJobData>;
    allComments: Array<{ id: number; body: string | null; user: { login: string; type?: string }; created_at: string }>;
    repoOwner: string;
    repoName: string;
    pullRequestNumber: number;
    redisClient: Redis;
    correlatedLogger: Logger;
}): Promise<{
    isFixMode: boolean;
    fixSelection: FixSelection;
    resolution: FixFeedbackResolution;
    selectedReviewComments: AIReviewComment[];
    reviewCommentsSection: string;
}> {
    const { job, allComments, repoOwner, repoName, pullRequestNumber, redisClient, correlatedLogger } = params;
    const emptySelection: FixSelection = { ...emptyReviewFeedbackSelection(), instructions: '', malformedIds: [] };
    const emptyResolution: FixFeedbackResolution = {
        comments: [], selected: emptyReviewFeedbackSelection(), unresolved: emptyReviewFeedbackSelection(), malformedIds: [],
    };
    if (job.data.commandMode !== 'fix') {
        return {
            isFixMode: false,
            fixSelection: emptySelection,
            resolution: emptyResolution,
            selectedReviewComments: [],
            reviewCommentsSection: '',
        };
    }

    const unprocessedReviewComments = await gatherUnprocessedReviewComments(allComments, {
        repoOwner, repoName, pullRequestNumber, redisClient, correlatedLogger,
    });
    // Automated Ultrafix always selects all F# blockers and never suggestions:
    // optional work is acted on solely because a human named it.
    const fixSelection = job.data.ultrafixMeta
        ? { ...emptySelection, instructions: job.data.commandInstructions || '' }
        : parseFixSelection(job.data.commandInstructions);
    // Cap explicit requests only. A bare `/fix` inherits whatever blockers the
    // reviews published, and rejecting that would be a regression.
    if (!isEmptyReviewFeedbackSelection(fixSelection) && reviewFeedbackSelectionSize(fixSelection) > MAX_REVIEW_FEEDBACK_SELECTION) {
        throw new Error(`A single /fix run addresses at most ${MAX_REVIEW_FEEDBACK_SELECTION} review items.`);
    }
    // The agent must receive the user's prose, not the raw token list. Leaving
    // `F20 S3 S5` at the head of the instructions would read to the model as
    // unexplained noise, and the structured section below already states scope.
    job.data.commandInstructions = fixSelection.instructions || undefined;
    const resolution = resolveReviewFeedback(unprocessedReviewComments, fixSelection);
    return {
        isFixMode: true,
        fixSelection,
        resolution,
        selectedReviewComments: resolution.comments,
        reviewCommentsSection: formatReviewCommentsSection(resolution.comments, resolution.selected),
    };
}

function formatActionableRecord(finding: ActionableFinding, commentId: number): string {
    return [
        `### ${finding.id}: ${finding.title}`,
        formatRecordFields([
            ['Source review comment', String(commentId)],
            ['Violated requirement', finding.violatedRequirement],
            ['Changed-code evidence', finding.evidence],
            ['Why introduced by this PR', finding.introducedByPRExplanation],
            ['Minimum necessary correction', finding.minimumCorrection],
        ]),
    ].join('\n');
}

function formatSuggestionRecord(suggestion: ReviewSuggestion, commentId: number): string {
    return [
        `### ${suggestion.id}: ${suggestion.title}`,
        formatRecordFields([
            ['Source review comment', String(commentId)],
            ['Requested follow-up', suggestion.description],
        ]),
    ].join('\n');
}

export function formatReviewCommentsSection(
    selectedComments: AIReviewComment[],
    selection?: ReviewFeedbackSelection,
): string {
    const actionable = selectedComments.flatMap(comment =>
        comment.actionableFindings.map(finding => formatActionableRecord(finding, comment.id)),
    );
    const suggestions = selectedComments.flatMap(comment =>
        comment.suggestions.map(suggestion => formatSuggestionRecord(suggestion, comment.id)),
    );
    const scope = selection ?? {
        findingIds: selectedComments.flatMap(comment => comment.actionableFindings.map(finding => finding.id)),
        suggestionIds: selectedComments.flatMap(comment => comment.suggestions.map(suggestion => suggestion.id)),
    };
    const lines = ['**Selected Review Finding Records:**', ''];
    if (actionable.length > 0 || suggestions.length > 0) {
        const scopeParts: string[] = [];
        if (scope.findingIds.length > 0) {
            scopeParts.push(`actionable finding${scope.findingIds.length === 1 ? '' : 's'} ${scope.findingIds.join(', ')}`);
        }
        if (scope.suggestionIds.length > 0) {
            scopeParts.push(`requested suggestion${scope.suggestionIds.length === 1 ? '' : 's'} ${scope.suggestionIds.join(', ')}`);
        }
        // `only` is load-bearing: the agent must not treat an unselected record
        // that happens to appear in the quoted review as work it may take on.
        lines.push(`Address ${scopeParts.join(' and ')} only.`,
            '', 'For each selected finding, inspect sibling implementations and callers for the same invalid assumption. '
            + 'Correct verified occurrences of that same defect within PR-changed behavior, and add focused regressions for the affected paths. '
            + 'For asynchronous stateful code, check relevant awaited boundaries, mutation authority, and evidence used to release durable obligations. '
            + 'This is a completeness check for the selected correction, not authorization to implement unselected findings, suggestions, '
            + 'pre-existing problems, or unrelated redesigns. Report independent discoveries separately. '
            + 'Distinguish avoidable stale-state windows from unavoidable races between external APIs; do not pursue impossible atomicity.',
            '', [...actionable, ...suggestions].join('\n\n'));
    } else {
        lines.push('No review findings or suggestions were selected.');
    }
    lines.push('', scope.suggestionIds.length > 0
        ? 'The suggestion records above are non-blocking follow-ups that were explicitly requested for this run. '
            + 'Implement them, but do not let them widen the scope of, substitute for, or relax the required correction of any '
            + 'actionable finding in this run. Suggestions that are not listed above remain out of scope.'
        : 'No suggestion was requested for this run; implement no suggestion record, and request one explicitly by its identifier to have it implemented.');
    return lines.join('\n');
}

/**
 * The canonical identifiers a set of selected review comments covers, which is
 * what the completion comment and the work summary report as addressed.
 */
export function selectedReviewFeedbackIds(comments: AIReviewComment[]): ReviewFeedbackSelection {
    return {
        findingIds: comments.flatMap(comment => comment.actionableFindings.map(finding => finding.id.toUpperCase())),
        suggestionIds: comments.flatMap(comment => comment.suggestions.map(suggestion => suggestion.id.toUpperCase())),
    };
}
