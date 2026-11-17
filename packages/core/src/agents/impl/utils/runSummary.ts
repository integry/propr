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
const BACK_REFERENCE = /\b(?:summary|report|answer|write-?up|recap|results?)\s+(?:above|earlier|before)\b|\b(?:above|earlier|previous|prior)\s+(?:summary|report|answer|write-?up|recap)\b|\bstill (?:holds|stands|applies)\b/i;
const ANNOUNCES_SUMMARY = /\b(?:summari[sz]ing (?:now|the (?:work|changes|results))|(?:i(?:'ll| will)|let me|now i(?:'ll| will)) (?:now )?(?:summari[sz]e|write (?:up )?(?:the|a|my) summary))\b/i;
const COMPLETION_ONLY = /^(?:(?:the )?(?:verification|validation|work|task|run|everything)\s+(?:is\s+)?(?:now\s+)?(?:complete|completed|done|finished)|all done)[.!]?$/i;
const ABOUT_NOTIFICATION = /\b(?:notification|notice|monitor|watcher|timed out|timeout|background (?:task|command|job|run|process)|probe|re-?arm)/i;
/**
 * A sentence that asserts the agent's own work has not finished yet. Matched
 * only at the start of a sentence (after an optional "Summary:" style label),
 * so a completed change that mentions such wording ("Changed the label to
 * Waiting for the notification") is not an unfinished run.
 */
const UNFINISHED_WORK_SENTENCE = new RegExp([
    '^(?:(?:summary|status|update|progress)\\s*:\\s*)?(?:',
    'still (?:running|in progress|executing)\\b',
    '|(?:(?:i[\'\u2019]m|i am|we[\'\u2019]re|we are) )?(?:(?:still|currently|now) )?(?:keep )?waiting (?:for|on|until)\\b.*\\b(?:notification|completion|complete|finish|finishes|done|suites?|tests?|run|build|job|task|command|monitor|watcher|background|results?)\\b',
    '|(?:i(?:[\'\u2019]ll| will) |will )(?:keep waiting|report|summari[sz]e|post|follow up|update)\\b.*\\b(?:once|when|after) (?:it|they|the|that|this)\\b',
    ')'
].join(''), 'i');
/** Unfinished-work notes are status messages, not reports; a longer text is a report. */
const UNFINISHED_WORK_MAX_LENGTH = SHORT_TEXT_LENGTH;
/** Leads of a first sentence that reports a completed change, not a notification. */
const COMPLETED_CHANGE = /^(?:i\s+)?(?:fixed|added|updated|changed|implemented|removed|made|resolved|corrected|replaced|renamed|refactored|moved|rewrote|reworked|extended|split|restored|reverted|adjusted|raised|lowered|increased|reduced|bumped)\b/i;
/** A short reply to a notification that says nothing needs doing. */
const NO_ACTION = /\b(?:nothing (?:else |more |further )?(?:to do|is needed|needed|to change)|no (?:further |other )?(?:action|changes?) (?:is |are )?(?:needed|required)|(?:doesn'?t|does not) change anything|nothing (?:has )?changed)\b/i;

interface AnswerCandidate {
    text: string;
    /** The answer ends a turn that began with an injected notification. */
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
    /** The turn began with an injected notification. */
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
    const ordered = [...starts].sort((a, b) => a - b);
    return ordered.map((start, position) => ({
        start,
        end: ordered[position + 1] ?? conversationLog.length,
        afterNotification: start !== firstAssistant && isInjectedTurn(conversationLog[start])
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
 * injected notification. Any message there must be judged as a possible reply
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

function firstSentence(text: string): string {
    return text.trim().split(/(?<=[.!?…])\s|\n/)[0] ?? '';
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
        .replace(/`[^`\n]*`|"[^"\n]*"|\u201c[^\u201d\n]*\u201d|\u2018[^\u2019\n]*\u2019|(?<![\w])'[^'\n]*'(?![\w])/g, '\u2026');
}

function sentences(text: string): string[] {
    return text.split(/(?<=[.!?\u2026])\s+|\n+|;\s+/).map(sentence => sentence.trim()).filter(Boolean);
}

/**
 * True when a final message asserts the agent is still waiting for work it
 * started. Markdown formatting does not matter; the assertion must open a
 * sentence and must not sit inside quoted text.
 */
export function reportsUnfinishedWork(text: string | null | undefined): boolean {
    const prose = plainProse(text?.trim() ?? '');
    if (!prose || prose.length > UNFINISHED_WORK_MAX_LENGTH) return false;
    return sentences(prose).some(sentence => UNFINISHED_WORK_SENTENCE.test(sentence));
}

/** The first sentence reacts to a notification rather than reporting a change. */
function opensAboutNotification(text: string): boolean {
    const first = firstSentence(plainProse(text));
    return ABOUT_NOTIFICATION.test(first) && !COMPLETED_CHANGE.test(first);
}

/**
 * True for a message that reports the run's status rather than its work: a
 * reply to a notification, a pointer back to an earlier summary, an
 * announcement that the summary follows, or a note that work is still running.
 * Being short and after a notification is not enough on its own: a concise
 * summary of a fix made in that turn is kept.
 */
export function isRunStatusNote(text: string | null | undefined, options: { afterNotification?: boolean } = {}): boolean {
    const trimmed = text?.trim() ?? '';
    if (!trimmed) return true;
    if (reportsUnfinishedWork(trimmed)) return true;
    const short = isShort(trimmed);
    if (options.afterNotification && (BACK_REFERENCE.test(trimmed) || opensAboutNotification(trimmed) || (short && NO_ACTION.test(trimmed)))) return true;
    if (!short) return false;
    return BACK_REFERENCE.test(trimmed)
        || ANNOUNCES_SUMMARY.test(trimmed)
        || COMPLETION_ONLY.test(trimmed);
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
 * substantive turn answer wins, then the longest of the last few assistant
 * messages, then any earlier short answer that is not itself a status note.
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
    const substantive = earlier.find(candidate => !isShort(candidate.text));
    if (substantive) return { summary: substantive.text, unfinishedWork };

    // Judge each message in its own turn, so a reply to a notification that
    // was rejected above cannot come back as the longest recent message.
    const recent = recentAssistantMessages(params.conversationLog, notificationEntries(turns))
        .filter(message => message.text !== finalText && !isShort(message.text) && !isRunStatusNote(message.text, message))
        .map(message => message.text);
    const longest = recent.reduce<string | null>((best, text) => (!best || text.length > best.length ? text : best), null);
    if (longest) return { summary: longest, unfinishedWork };

    return { summary: earlier[0]?.text ?? null, unfinishedWork };
}
