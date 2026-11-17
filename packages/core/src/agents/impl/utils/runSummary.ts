/**
 * Chooses the text ProPR publishes as a run's summary and commit subject.
 *
 * A Claude Code run can outlive its own summary: when a background monitor,
 * watcher or command reports after the agent answered, Claude Code feeds the
 * notification back as a new user turn and the model replies to it. That
 * reply ("The monitor only expired; my summary above still holds.") then ends
 * the stream and lands in the result line. The selection below is structural
 * first: the conversation is split at those injected turns, and a reply that
 * only reacts to one is not the run's answer. Short status notes and
 * back-references are recognised by their shape and wording as a second check.
 */
import { getFinalAnswerText, getTextFromClaudeContent } from './claudeOutputHelpers.js';

type LogEntry = { type?: string; message?: Record<string, unknown>; content?: unknown };

/** Shown instead of a summary when the agent never wrote a substantive one. */
export const NO_AGENT_SUMMARY_TEXT = 'The agent did not provide a summary.';

/** A status note is at most this long; a real summary of a change rarely is. */
const SHORT_TEXT_LENGTH = 320;
/** The last N assistant messages searched for a summary when no answer qualifies. */
const RECENT_MESSAGE_WINDOW = 6;

/** Claude Code's own prompt to resume a reply cut at the output-token limit. */
const CONTINUATION_PROMPT = /output token limit|resume directly/i;
/** What a back-reference points at: an earlier answer of the agent's. */
const REFERENCED_ANSWER = '(?:summary|report|answer|write-?up|recap)';
/**
 * A pointer back to an earlier answer. Naming a summary is not enough ("The
 * previous summary rendering now handles empty responses." reports a change):
 * the sentence must place the answer above or earlier, say it still holds, or
 * say the work was already summarised.
 */
const BACK_REFERENCE = new RegExp([
    `\\b(?:${REFERENCED_ANSWER}|results?)\\s+(?:above|earlier)\\b`,
    `\\b(?:above|earlier|previous|prior|last|my|the)\\s+${REFERENCED_ANSWER}\\s+(?:(?:is|remains)\\s+)?(?:still\\s+)?(?:holds|stands|applies|unchanged|accurate|valid|current|correct)\\b`,
    '\\b(?:it|that|this|everything|all of (?:it|that))\\s+still (?:holds|stands|applies)\\b',
    '\\b(?:already )?(?:summari[sz]ed|reported|described) (?:above|earlier|already)\\b'
].join('|'), 'i');
const ANNOUNCES_SUMMARY = /\b(?:summari[sz]ing (?:now|the (?:work|changes|results))|(?:i(?:'ll| will)|let me|now i(?:'ll| will)) (?:now )?(?:summari[sz]e|write (?:up )?(?:the|a|my) summary))\b/i;
const COMPLETION_ONLY = /^(?:(?:the )?(?:verification|validation|work|task|run|everything)\s+(?:is\s+)?(?:now\s+)?(?:complete|completed|done|finished)|all done)[.!]?$/i;
/** What reports to the agent from outside its turn: a notification or a background operation. */
const NOTIFIER = '(?:notification|notice|monitor|watcher|timeout|probe|background (?:task|command|job|run|process|build|suite)|(?:check|test|suite) run)s?';
/**
 * A word that opens a subordinate or relative clause. Words like these between
 * a notifier and an event predicate mean the predicate belongs to another
 * clause ("The background job now retries requests that timed out").
 */
const CLAUSE_OPENER = '(?:that|which|who|whom|whose|where|whereas|when|whenever|while|if|unless|because|since|after|before|until|till|once|whether|though|although)';
/** One word of a notification's subject or of the words before its predicate; never a clause opener. */
const SUBJECT_WORD = `(?!${CLAUSE_OPENER}(?![\\w-]))`;
/**
 * What may stand between a notifier and its own predicate: words that open no
 * clause ("The watcher I set on the check run timed out"), or a clause set off
 * by commas ("The background job, which I started earlier, timed out").
 */
const NOTIFIER_TO_PREDICATE = `(?:\\s+${SUBJECT_WORD}\\S+|,\\s+[^,;]+,(?=\\s)){0,8}?`;
/**
 * A notifier identified as a notifier or by its source ("That notification is
 * the probe I started", "The notice was from the watcher"). An article alone
 * identifies nothing: "The background job is a persistent worker that retries
 * failed requests" describes the product.
 */
const NOTIFIER_IDENTIFICATION = `(?:is|was)\\s+(?:(?:only|just)\\s+)?(?:from\\b|(?:the|my|a|an)\\s+(?:${SUBJECT_WORD}[\\w-]+\\s+){0,4}?${NOTIFIER}\\b)`;
/**
 * A sentence about a notification event itself ("The monitor timed out after
 * the batch finished", "That notification is the probe I started"). Only the
 * event, in the past tense or as an identification, counts, and only as the
 * notifier's own predicate: a sentence about what a background job now does
 * ("The background job now retries failed requests", "...retries requests
 * that timed out") describes the product.
 */
const NOTIFICATION_EVENT = new RegExp([
    `^(?:(?:the|that|this|my|its|a|an|one)\\s+)?(?:${SUBJECT_WORD}[\\w"'\u2019-]+\\s+){0,3}?${NOTIFIER}\\b${NOTIFIER_TO_PREDICATE}\\s+(?:(?:only|just|also|simply)\\s+)?(?:timed out|expired|fired|finished|completed|ended|stopped|exited|reported|came from|comes from|${NOTIFIER_IDENTIFICATION})`,
    `^(?:it|that|this)\\s+(?:is|was)\\s+(?:(?:only|just)\\s+)?(?:the|my|a|an)\\s+(?:${SUBJECT_WORD}[\\w-]+\\s+){0,4}?${NOTIFIER}\\b`
].join('|'), 'i');
/** A sentence that dismisses a notification as needing nothing from the agent. */
const DISMISSES_NOTIFICATION = /\b(?:says nothing about|(?:doesn'?t|does not|don'?t|do not) need (?:to )?(?:re-?arm(?:ing)?|restart(?:ing)?|re-?run(?:ning)?)|needs? no (?:re-?arming|restart|re-?run)|no need to (?:re-?arm|restart|re-?run))\b/i;
/** A sentence that only reports verification ("All 28 suites now pass."); never enough on its own. */
const VERIFICATION_ONLY = /^(?:(?:and|so)\s+)?(?:all\s+)?(?:(?:the|of the)\s+)?(?:\d+\s+)?(?:(?:related|existing|new|regression|affected|remaining|unit|e2e)\s+)*(?:suites?|tests?|checks?|builds?|lint|typecheck)\s+(?:still\s+|now\s+)?(?:pass(?:es|ed)?|succeed(?:s|ed)?|(?:is|are)\s+(?:green|clean|passing))[.!]?$/i;
/** What a still-waiting note waits on: a pronoun for it, or a named running operation. */
const RUNNING_WORK_SUBJECT = '(?:it|they|that|this|the (?:[\\w-]+\\s+){0,4}?(?:suites?|tests?|runs?|builds?|jobs?|tasks?|commands?|monitors?|watchers?|batch(?:es)?|process(?:es)?|probes?))';
/**
 * An optional inline status label that may open a sentence ("Summary: Fixed
 * the timeout."). Sentence classifiers skip it, so a labelled sentence is read
 * by what it says rather than by its label.
 */
const INLINE_LABEL = '(?:(?:summary|status|update|progress)\\s*:\\s*)?';
/** The operation finishing, as the event the note waits for. */
const RUNNING_WORK_FINISHES = '(?:\\s+(?:finish(?:es)?|complete[sd]?|returns?|ends?|reports?(?: back)?)|(?:\\s+(?:is|are)|[\'\u2019](?:s|re)) (?:done|finished|complete|over))\\b';
/**
 * A sentence that asserts the agent's own work has not finished yet. Matched
 * only at the start of a sentence (after an optional "Summary:" style label),
 * so a completed change that mentions such wording ("Changed the label to
 * Waiting for the notification") is not an unfinished run.
 */
const UNFINISHED_WORK_SENTENCE = new RegExp([
    '^', INLINE_LABEL, '(?:',
    'still (?:running|in progress|executing)\\b',
    '|(?:(?:i[\'\u2019]m|i am|we[\'\u2019]re|we are) )?(?:(?:still|currently|now) )?(?:keep )?waiting (?:for|on|until)\\b.*\\b(?:notification|completion|complete|finish|finishes|done|suites?|tests?|run|build|job|task|command|monitor|watcher|background|results?)\\b',
    '|(?:i(?:[\'\u2019]ll| will) |will )keep waiting\\b',
    // A promise to report later counts only when it waits on running work
    // finishing ("I'll report back once the suites finish"), not on a future
    // event ("I'll update the changelog after the next release").
    '|(?:i(?:[\'\u2019]ll| will) |will )(?:report|summari[sz]e|post|follow up|update)\\b.*\\b(?:once|when|after|as soon as) ',
    RUNNING_WORK_SUBJECT, RUNNING_WORK_FINISHES,
    ')'
].join(''), 'i');
/** Unfinished-work notes are status messages, not reports; a longer text is a report. */
const UNFINISHED_WORK_MAX_LENGTH = SHORT_TEXT_LENGTH;
/** Verbs that report a change the agent made. */
const CHANGE_VERB = '(?:fixed|added|updated|changed|implemented|removed|made|resolved|corrected|replaced|renamed|refactored|moved|rewrote|reworked|extended|split|restored|reverted|adjusted|raised|lowered|increased|reduced|bumped)';
/** Leads of a sentence that reports a completed change, not a notification. */
const COMPLETED_CHANGE = new RegExp(`^${INLINE_LABEL}(?:i(?:['\u2019]ve|\\s+have)?\\s+)?(?:now\\s+)?${CHANGE_VERB}\\b`, 'i');
/**
 * A later clause of a sentence that reports a change the agent made ("The
 * watcher reported a retry failure, which I fixed in worker.ts."): after a
 * comma, a coordinating conjunction or "which", the agent itself ("I", "we")
 * reports the change. "...and I changed nothing" reports none.
 */
const CHANGE_CLAUSE = new RegExp(`(?:,|\\b(?:and|then|so|which)\\b)\\s+(?:(?:and|then|so|which)\\s+)?(?:i|we)(?:['\u2019](?:ve|d)|\\s+(?:have|had))?\\s+(?:(?:now|also|then)\\s+)?${CHANGE_VERB}\\b(?!\\s+(?:nothing|anything)\\b)`, 'i');
/** A reply to a notification that says nothing needs doing. */
const NO_ACTION = /\b(?:nothing (?:else |more |further )?(?:to do|is needed|needed|to change)|no (?:further |other )?(?:action|changes?) (?:is |are )?(?:needed|required)|(?:doesn'?t|does not) change anything|nothing (?:has )?changed)\b/i;

interface AnswerCandidate {
    text: string;
    /**
     * The answer ends a turn that began after the run had already answered:
     * with an injected notification, or right after an earlier result line.
     */
    afterNotification: boolean;
}

function userEntryText(entry: LogEntry): string {
    const content = entry.message?.content ?? entry.content;
    if (typeof content === 'string') return content.trim();
    return getTextFromClaudeContent(content);
}

function hasToolResult(entry: LogEntry): boolean {
    const content = entry.message?.content ?? entry.content;
    return Array.isArray(content) && content.some(block =>
        !!block && typeof block === 'object' && (block as { type?: unknown }).type === 'tool_result');
}

/**
 * A user turn the agent did not cause with a tool call: in a one-shot run the
 * only such input after the prompt is a background notification (or a hook
 * message) that Claude Code injects. The output-limit continuation is part of
 * the same answer and does not start a new turn.
 */
function isInjectedTurn(entry: LogEntry): boolean {
    if (entry?.type !== 'user' || hasToolResult(entry)) return false;
    const text = userEntryText(entry);
    return !!text && !CONTINUATION_PROMPT.test(text);
}

interface Turn {
    start: number;
    end: number;
    /**
     * The turn reacts to something after the run answered: it began with an
     * injected notification, or at a result line (the stream went on after the
     * agent's reported answer, so what follows replies to an event, even when
     * the notification itself was not logged).
     */
    afterNotification: boolean;
}

/** The conversation split into turns, oldest first; one turn per injected input. */
function conversationTurns(conversationLog: LogEntry[], resultLogIndexes: readonly number[] = []): Turn[] {
    const firstAssistant = conversationLog.findIndex(entry => entry?.type === 'assistant');
    if (firstAssistant < 0) return [];
    const starts = new Set<number>([firstAssistant]);
    conversationLog.forEach((entry, index) => {
        if (index > firstAssistant && isInjectedTurn(entry)) starts.add(index);
    });
    // Several result lines in one stream also mark where a turn ended.
    for (const index of resultLogIndexes) if (index > firstAssistant && index < conversationLog.length) starts.add(index);
    const resultStarts = new Set(resultLogIndexes);
    const ordered = [...starts].sort((a, b) => a - b);
    return ordered.map((start, position) => ({
        start,
        end: ordered[position + 1] ?? conversationLog.length,
        afterNotification: start !== firstAssistant && (resultStarts.has(start) || isInjectedTurn(conversationLog[start]))
    }));
}

/** The final answer of every turn, oldest first. */
function answerCandidates(conversationLog: LogEntry[], turns: Turn[]): AnswerCandidate[] {
    return turns.map(turn => ({
        text: getFinalAnswerText(conversationLog.slice(turn.start, turn.end)),
        afterNotification: turn.afterNotification
    })).filter(candidate => candidate.text);
}

/**
 * Indexes of the conversation entries that belong to a turn begun by an
 * injected notification or an earlier result line. Any message there must be judged as a possible reply
 * to that notification, not only the turn's final answer.
 */
export function notificationTurnEntryIndexes(conversationLog: LogEntry[], resultLogIndexes: readonly number[] = []): Set<number> {
    return notificationEntries(conversationTurns(conversationLog, resultLogIndexes));
}

function notificationEntries(turns: Turn[]): Set<number> {
    const indexes = new Set<number>();
    for (const turn of turns) {
        if (!turn.afterNotification) continue;
        for (let index = turn.start; index < turn.end; index++) indexes.add(index);
    }
    return indexes;
}

function isShort(text: string): boolean {
    const lines = text.split('\n').map(line => line.trim()).filter(Boolean);
    const structured = lines.some(line => /^(?:[-*+]\s|\d+[.)]\s|#{1,6}\s|\|)/.test(line));
    return text.length <= SHORT_TEXT_LENGTH && !structured;
}

/**
 * Stands in for quoted text. A plain word, so it neither ends a sentence nor
 * breaks the sentence around it ("The watcher `full-suite` timed out" stays one
 * sentence about the watcher).
 */
const QUOTED_PLACEHOLDER = 'quoted';
const QUOTED_SPAN = /`[^`\n]*`|"[^"\n]*"|\u201c[^\u201d\n]*\u201d|\u2018[^\u2019\n]*\u2019|(?<![\w])'[^'\n]*'(?![\w])/g;

/**
 * A quoted span replaced by the placeholder. A quote that itself ends a
 * sentence (`He wrote "Done." Then...`) keeps its closing punctuation, so the
 * next sentence still starts after it.
 */
function replaceQuotedSpan(span: string, offset: number, whole: string): string {
    const closing = /([.!?])\W*$/.exec(span.slice(1, -1));
    const endsSentence = !!closing && /^(?:\s+[A-Z]|\s*$)/.test(whole.slice(offset + span.length));
    return endsSentence ? `${QUOTED_PLACEHOLDER}${closing[1]}` : QUOTED_PLACEHOLDER;
}

/**
 * The prose of a message without Markdown structure: heading and list markers,
 * emphasis, label-only heading lines, and quoted text (a quoted label is
 * product text, not a statement about the run).
 */
function plainProse(text: string): string {
    return text.split('\n')
        .map(line => line.trim()
            .replace(/^(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)+/, '')
            .replace(/(\*\*|__|\*|_)(?=\S)([^*_]+?)\1/g, '$2')
            .trim())
        .filter(line => line && !/^(?:summary|status|update|progress)\s*:?$/i.test(line))
        .join('\n')
        .replace(QUOTED_SPAN, replaceQuotedSpan);
}

function sentences(text: string): string[] {
    return text.split(/(?<=[.!?\u2026])\s+|\n+|;\s+/).map(sentence => sentence.trim()).filter(Boolean);
}

/**
 * The message without Markdown blockquotes and fenced code blocks: quoted or
 * example content ("Updated the progress message to:\n\n> Waiting for the
 * completion notification.") is product text, not the agent's own statement.
 * An unclosed fence runs to the end of the message, as Markdown renders it.
 */
function withoutQuotedBlocks(text: string): string {
    const kept: string[] = [];
    let fence: string | null = null;
    for (const line of text.split('\n')) {
        const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
        if (fence) {
            if (marker && marker[0] === fence[0] && marker.length >= fence.length && !line.trim().slice(marker.length).trim()) fence = null;
            continue;
        }
        if (marker) { fence = marker; continue; }
        if (/^\s*>/.test(line)) continue;
        kept.push(line);
    }
    return kept.join('\n');
}

/**
 * True when a final message asserts the agent is still waiting for work it
 * started. Markdown formatting does not matter; the assertion must open a
 * sentence of the agent's own prose, not sit inside quoted text, a blockquote
 * or a fenced example.
 */
export function reportsUnfinishedWork(text: string | null | undefined): boolean {
    const trimmed = text?.trim() ?? '';
    const prose = plainProse(trimmed);
    if (!prose || prose.length > UNFINISHED_WORK_MAX_LENGTH) return false;
    return sentences(plainProse(withoutQuotedBlocks(trimmed))).some(sentence => UNFINISHED_WORK_SENTENCE.test(sentence));
}

/**
 * A sentence that reports a change the agent made: positive evidence of
 * substance, whether it opens with the change or reports it in a later clause
 * of a sentence that opens with a notification.
 */
function reportsChangeSentence(sentence: string): boolean {
    return COMPLETED_CHANGE.test(sentence) || CHANGE_CLAUSE.test(sentence);
}

/** Longest sentence still read as a bare status line rather than a report. */
const STATUS_SENTENCE_MAX_LENGTH = 120;

type SentenceKind = 'substance' | 'status' | 'notification' | 'verification';

/**
 * What one sentence of a message is. Only affirmative wording makes a sentence
 * a status line; any sentence that is not recognised as one is substance, so
 * a summary is kept whatever verb it opens with.
 */
function classifySentence(raw: string): SentenceKind {
    const sentence = raw.replace(new RegExp(`^${INLINE_LABEL}`, 'i'), '').trim();
    if (!sentence) return 'verification';
    // A sentence reporting a change is a report even when it names a summary
    // ("Fixed the previous summary rendering.").
    if (reportsChangeSentence(sentence)) return 'substance';
    if (COMPLETION_ONLY.test(sentence)) return 'status';
    if (VERIFICATION_ONLY.test(sentence)) return 'verification';
    const bare = sentence.length <= STATUS_SENTENCE_MAX_LENGTH && !/:\s*\S/.test(sentence);
    if (bare && (ANNOUNCES_SUMMARY.test(sentence) || BACK_REFERENCE.test(sentence))) return 'status';
    if (NOTIFICATION_EVENT.test(sentence) || DISMISSES_NOTIFICATION.test(sentence) || (bare && NO_ACTION.test(sentence))) return 'notification';
    return 'substance';
}

/**
 * True for a message that reports the run's status rather than its work: a
 * reply to a notification, a pointer back to an earlier summary, an
 * announcement that the summary follows, or a note that work is still running.
 * Every sentence must be recognised as such a line (verification lines may
 * accompany them), judged on the prose without Markdown so a heading or bullet
 * changes nothing. Remarks about a notification decide only in a turn that
 * reacts to one; a message with any other sentence is a summary and is kept.
 */
export function isRunStatusNote(text: string | null | undefined, options: { afterNotification?: boolean } = {}): boolean {
    const trimmed = text?.trim() ?? '';
    if (!trimmed) return true;
    if (reportsUnfinishedWork(trimmed)) return true;
    const kinds = sentences(plainProse(trimmed)).map(classifySentence);
    if (kinds.length === 0 || kinds.includes('substance')) return false;
    return kinds.includes('status') || (!!options.afterNotification && kinds.includes('notification'));
}

interface RecentMessage {
    text: string;
    /** The message sits in a turn begun by an injected notification. */
    afterNotification: boolean;
}

function recentAssistantMessages(conversationLog: LogEntry[], notificationEntries: Set<number>): RecentMessage[] {
    const messages: RecentMessage[] = [];
    for (let index = conversationLog.length - 1; index >= 0 && messages.length < RECENT_MESSAGE_WINDOW; index--) {
        const entry = conversationLog[index];
        if (entry?.type !== 'assistant') continue;
        const text = getTextFromClaudeContent(entry.message?.content);
        if (text && messages[messages.length - 1]?.text !== text) messages.push({ text, afterNotification: notificationEntries.has(index) });
    }
    return messages;
}

export interface RunSummarySelection {
    /** The summary to publish, or null when the agent wrote none. */
    summary: string | null;
    /** The agent's last message, when it says work is still running. */
    unfinishedWork: string | null;
}

/**
 * Picks the run's summary from its conversation. The reported result (the
 * last message) is kept unless it is a status note; then the most recent
 * earlier turn answer that is not itself a status note wins, short or long,
 * so a newer concise fix summary beats an older long one; only when no turn
 * answer qualifies is the longest of the last few assistant messages used.
 */
export function selectRunSummary(params: {
    resultText?: string | null;
    conversationLog: LogEntry[];
    resultLogIndexes?: readonly number[];
}): RunSummarySelection {
    const turns = conversationTurns(params.conversationLog, params.resultLogIndexes);
    const candidates = answerCandidates(params.conversationLog, turns);
    const last = candidates[candidates.length - 1];
    const resultText = params.resultText?.trim() || '';
    const finalText = resultText || last?.text || '';
    const finalAfterNotification = !!last?.afterNotification;
    const unfinishedWork = reportsUnfinishedWork(finalText) ? finalText : null;

    if (finalText && !isRunStatusNote(finalText, { afterNotification: finalAfterNotification })) {
        return { summary: params.resultText ?? finalText, unfinishedWork };
    }

    const earlier = candidates.slice(0, -1).reverse()
        .filter(candidate => !isRunStatusNote(candidate.text, candidate));
    // Chronology before length: the newest qualifying answer reports the
    // latest repair and verification, even when an older answer is longer.
    if (earlier[0]) return { summary: earlier[0].text, unfinishedWork };

    // Judge each message in its own turn, so a reply to a notification that
    // was rejected above cannot come back as the longest recent message.
    const recent = recentAssistantMessages(params.conversationLog, notificationEntries(turns))
        .filter(message => message.text !== finalText && !isShort(message.text) && !isRunStatusNote(message.text, message))
        .map(message => message.text);
    const longest = recent.reduce<string | null>((best, text) => (!best || text.length > best.length ? text : best), null);
    return { summary: longest, unfinishedWork };
}
