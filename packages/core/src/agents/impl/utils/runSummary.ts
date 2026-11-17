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
/** The agent says work it started has not finished yet. */
const UNFINISHED_WORK = /(?:^|[.!?]\s+)(?:summary:\s*)?(?:still (?:running|in progress|executing)|waiting (?:for|on|until)\b)|\b(?:i'm|i am|currently|now|still|i'll keep|keep) waiting (?:for|on|until)\b|\bwaiting for (?:the |a |its )?(?:completion )?notification\b|\bwill (?:report|summari[sz]e|post|follow up|update)\b[^.\n]{0,60}\b(?:once|when|after) (?:it|they|the|that|this)\b/i;

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

/** The final answer of every turn, oldest first; one turn per injected input. */
function answerCandidates(conversationLog: LogEntry[], resultLogIndexes: readonly number[] = []): AnswerCandidate[] {
    const firstAssistant = conversationLog.findIndex(entry => entry?.type === 'assistant');
    if (firstAssistant < 0) return [];
    const starts = new Set<number>([firstAssistant]);
    conversationLog.forEach((entry, index) => {
        if (index > firstAssistant && isInjectedTurn(entry)) starts.add(index);
    });
    // Several result lines in one stream also mark where a turn ended.
    for (const index of resultLogIndexes) if (index > firstAssistant && index < conversationLog.length) starts.add(index);
    const ordered = [...starts].sort((a, b) => a - b);
    return ordered.map((start, position) => {
        const end = ordered[position + 1] ?? conversationLog.length;
        return {
            text: getFinalAnswerText(conversationLog.slice(start, end)),
            afterNotification: start !== firstAssistant && isInjectedTurn(conversationLog[start])
        };
    }).filter(candidate => candidate.text);
}

function isShort(text: string): boolean {
    const lines = text.split('\n').map(line => line.trim()).filter(Boolean);
    const structured = lines.some(line => /^(?:[-*+]\s|\d+[.)]\s|#{1,6}\s|\|)/.test(line));
    return text.length <= SHORT_TEXT_LENGTH && !structured;
}

function firstSentence(text: string): string {
    return text.trim().split(/(?<=[.!?…])\s|\n/)[0] ?? '';
}

/** True when a final message says the agent is still waiting for work it started. */
export function reportsUnfinishedWork(text: string | null | undefined): boolean {
    const trimmed = text?.trim() ?? '';
    return !!trimmed && isShort(trimmed) && UNFINISHED_WORK.test(trimmed);
}

/**
 * True for a message that reports the run's status rather than its work: a
 * reply to a notification, a pointer back to an earlier summary, an
 * announcement that the summary follows, or a note that work is still running.
 */
export function isRunStatusNote(text: string | null | undefined, options: { afterNotification?: boolean } = {}): boolean {
    const trimmed = text?.trim() ?? '';
    if (!trimmed) return true;
    const short = isShort(trimmed);
    if (options.afterNotification && (short || BACK_REFERENCE.test(trimmed) || ABOUT_NOTIFICATION.test(firstSentence(trimmed)))) return true;
    if (!short) return false;
    return BACK_REFERENCE.test(trimmed)
        || ANNOUNCES_SUMMARY.test(trimmed)
        || COMPLETION_ONLY.test(trimmed)
        || reportsUnfinishedWork(trimmed);
}

function recentAssistantTexts(conversationLog: LogEntry[]): string[] {
    const texts: string[] = [];
    for (let index = conversationLog.length - 1; index >= 0 && texts.length < RECENT_MESSAGE_WINDOW; index--) {
        const entry = conversationLog[index];
        if (entry?.type !== 'assistant') continue;
        const text = getTextFromClaudeContent(entry.message?.content);
        if (text && texts[texts.length - 1] !== text) texts.push(text);
    }
    return texts;
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
    const candidates = answerCandidates(params.conversationLog, params.resultLogIndexes);
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

    const recent = recentAssistantTexts(params.conversationLog)
        .filter(text => text !== finalText && !isShort(text) && !isRunStatusNote(text));
    const longest = recent.reduce<string | null>((best, text) => (!best || text.length > best.length ? text : best), null);
    if (longest) return { summary: longest, unfinishedWork };

    return { summary: earlier[0]?.text ?? null, unfinishedWork };
}
