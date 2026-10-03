import type { Job } from 'bullmq';
import type { Logger } from 'pino';
import type { Redis } from 'ioredis';
import type { CommentJobData } from '@propr/core';
import {
    MAX_REVIEW_FEEDBACK_SELECTION,
    REVIEW_FEEDBACK_SELECT_ALL_KEYWORD,
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
    /** A human explicitly requested every pending finding and suggestion. */
    selectAll?: true;
    /** Command-line remainder plus every following line, verbatim and trimmed. */
    instructions: string;
    /** Invalid identifiers or incompatible selector clauses, e.g. `S0` or `ALL S3`. */
    malformedIds: string[];
}

/** Historic alias; the selection now carries both namespaces. */
export type FixFindingSelection = FixSelection;

/** The two halves of a `/fix` command, kept apart by intake. */
export interface FixCommandText {
    /** Verbatim command-line arguments. The ONLY place selectors are read from. */
    commandLine?: string | null;
    /** Everything below the command line. Instruction prose by construction. */
    bodyInstructions?: string | null;
}

/**
 * Parse one `/fix` command whose command-line boundary intake preserved.
 *
 * Only the command line can carry identifiers. That boundary is what makes the
 * free-text half of this feature possible at all: without it, a user whose
 * instructions happen to begin with `S3 should also change` would have their
 * prose eaten as a selector. Everything below the command line is prose by
 * construction, which is also how the user documentation describes it. The
 * boundary is taken from the caller rather than rediscovered in joined text,
 * because a join cannot be undone: `/fix` with no arguments and prose below it
 * produces text whose first line is prose, and no amount of newline handling
 * here could tell that apart from a selector line.
 * The `all` shorthand must stand alone, apart from commas/whitespace or a `;`
 * introducing instructions. `all the tests` remains ordinary instruction prose.
 * Combining `all` with selector-shaped tokens fails the whole request closed.
 *
 * Parsing stops at the first non-selector token on the command line; that token
 * and the rest of the line join the instructions. A `;` still closes the
 * selector clause explicitly, and commas still separate selectors, both of which
 * `/fix` has always accepted. Selector-shaped-but-invalid tokens do NOT stop
 * parsing — they are collected for reporting, because reclassifying `S0` or the
 * unsupported range `F1-F2` as prose turns a typo into a silently empty request,
 * which then widens to every pending blocker. Resolution fails the request
 * closed and reports them (see `resolveReviewFeedback`).
 */
export function parseFixCommand(command: FixCommandText): FixSelection {
    const selection: FixSelection = { ...emptyReviewFeedbackSelection(), instructions: '', malformedIds: [] };
    // Normalise line endings first so a CRLF comment body from the GitHub web UI
    // parses identically to an LF one. A command line cannot hold a newline; if
    // one ever arrives, only its first line is read as the command line and the
    // remainder stays prose.
    const [commandLine = '', ...extraCommandLines] = (command.commandLine ?? '').replace(/\r\n?/g, '\n').split('\n');
    const following = [
        ...extraCommandLines,
        ...(command.bodyInstructions ? command.bodyInstructions.replace(/\r\n?/g, '\n').split('\n') : []),
    ];
    const allMatch = new RegExp(`^${REVIEW_FEEDBACK_SELECT_ALL_KEYWORD}[,\\s]*(?:;(.*))?$`, 'i').exec(commandLine.trim());
    if (allMatch) {
        return {
            ...selection,
            selectAll: true,
            instructions: [allMatch[1] ?? '', ...following].join('\n').trim(),
        };
    }
    // Inspect only the selector clause. IDs after `;` or on following lines
    // are instructions, while `all S3` must never fall back to bare `/fix`.
    const selectorClause = commandLine.split(';', 1)[0].trim();
    const selectorTokens = selectorClause.split(/[,\s]+/);
    if (selectorTokens[0]?.toLowerCase() === REVIEW_FEEDBACK_SELECT_ALL_KEYWORD
        && selectorTokens.slice(1).some(token => normalizeReviewFeedbackId(token) || isMalformedReviewFeedbackToken(token))) {
        return { ...selection, malformedIds: [selectorClause.toUpperCase()] };
    }
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
 * Parse an already-joined `/fix` body, whose first line is the command line.
 *
 * This is the shape the worker sees for a job queued before intake carried the
 * boundary, and the shape every direct caller (tests included) finds convenient.
 * It is a projection of `parseFixCommand`, never a second implementation.
 */
export function parseFixSelection(text: string | undefined | null): FixSelection {
    const normalized = (text ?? '').replace(/\r\n?/g, '\n');
    const firstNewline = normalized.indexOf('\n');
    return parseFixCommand(firstNewline === -1
        ? { commandLine: normalized }
        : { commandLine: normalized.slice(0, firstNewline), bodyInstructions: normalized.slice(firstNewline + 1) });
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
    /**
     * Requested identifiers no current review offers. Nonempty means nothing was
     * selected at all: the request is refused as a whole so the caller can name
     * these back to the user.
     */
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
 * Filter gathered review comments down to the selection, refusing the whole
 * request when any named record is missing or malformed rather than quietly
 * acting on the half that resolved.
 *
 * A selection that names nothing keeps the pre-existing meaning: every
 * unprocessed actionable finding, and no suggestions. Suggestions are opt-in by
 * construction: only a human naming suggestions or requesting `all` opts in.
 * The `all` shorthand selects every pending record without an explicit-ID cap.
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
    if (selection.selectAll) {
        const all = comments.filter(comment => comment.actionableFindings.length > 0 || comment.suggestions.length > 0);
        return {
            comments: all,
            selected: selectedReviewFeedbackIds(all),
            unresolved: emptyReviewFeedbackSelection(),
            malformedIds: [],
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

    const unresolved: ReviewFeedbackSelection = {
        findingIds: selection.findingIds.filter(id => !findingOwner.has(id)),
        suggestionIds: selection.suggestionIds.filter(id => !suggestionOwner.has(id)),
    };
    // A named record no current review offers fails the whole request closed,
    // exactly as a malformed token does and exactly as the MCP tool does before
    // it posts anything. Acting on the available half would be a silent partial
    // substitution, and worse: the unavailable half would never be reported,
    // because only the "nothing was selected" path names identifiers back to the
    // user. Whether the record went stale between the request and this
    // resolution cannot be closed atomically, so the request is refused and the
    // identifier named instead of guessed at.
    if (!isEmptyReviewFeedbackSelection(unresolved)) {
        return {
            comments: [],
            selected: emptyReviewFeedbackSelection(),
            unresolved,
            malformedIds: selection.malformedIds,
        };
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
        unresolved,
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
    // optional work is acted on solely because a human requested it.
    const commandMeta = job.data.commandMeta;
    const fixSelection = job.data.ultrafixMeta
        ? { ...emptySelection, instructions: job.data.commandInstructions || '' }
        // Selectors come from the command line intake preserved, so a `/fix`
        // whose instructions merely begin with `S3 is already done` selects
        // nothing. Falling back to the joined text keeps a job queued by an
        // earlier deploy working, with the behaviour it was queued under.
        : commandMeta?.mode === 'fix' && typeof commandMeta.commandLine === 'string'
            ? parseFixCommand({ commandLine: commandMeta.commandLine, bodyInstructions: commandMeta.bodyInstructions })
            : parseFixSelection(job.data.commandInstructions);
    // Cap explicit IDs only. Bare `/fix` and `/fix all` inherit the pending
    // records without a cap.
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
