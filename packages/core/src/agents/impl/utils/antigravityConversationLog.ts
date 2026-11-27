/**
 * Converts an Antigravity run's full trace into the Claude-shaped conversation
 * log that execution metrics persist (`llm_execution_details`) and the task
 * page renders. Unlike the analysis filter, every step is kept: tool steps
 * become `tool_use` / `tool_result` pairs.
 */
import {
    aggregateDeltaMessages,
    convertEventToClaudeFormat,
    isAntigravityStreamEvent,
    isTranscriptEvent,
    type AntigravityOutputEvent,
    type AntigravityStreamStepUpdateEvent,
    type AntigravityTranscriptEvent,
} from './antigravityOutputParser.js';

const STEP_HEADER = /^(?:Created|Completed) At:/;
const STEP_ERROR_PREFIX = 'Encountered error in step execution:';
const AGENT_RESPONSE = 'AGENT_RESPONSE';

export interface AntigravityToolStepContent {
    input: Record<string, unknown>;
    output: string;
    error?: string;
}

function normalize(value: string | undefined): string {
    return (value ?? '').trim().toUpperCase();
}

/** Drops the `Created At:` / `Completed At:` header lines; reports whether a blank line followed them. */
function stripStepHeader(content: string): { body: string[]; separated: boolean } {
    const lines = content.replace(/\r\n/g, '\n').split('\n');
    let index = 0;
    while (index < lines.length && STEP_HEADER.test(lines[index].trim())) index++;
    const headerEnd = index;
    while (index < lines.length && !lines[index].trim()) index++;
    return { body: lines.slice(index), separated: index > headerEnd && headerEnd > 0 };
}

/**
 * Splits a tool step's text into the command or target and its output. agy
 * writes the header, a blank line, then the command line and its output; a
 * step without that blank line carries output only, and a failed step reports
 * `Encountered error in step execution: …`.
 */
export function parseAntigravityToolStepContent(stepType: string, content: string | undefined): AntigravityToolStepContent {
    const { body, separated } = stripStepHeader(content ?? '');
    const first = body[0]?.trim() ?? '';
    if (first.startsWith(STEP_ERROR_PREFIX)) {
        return { input: {}, output: body.join('\n').trim(), error: first.slice(STEP_ERROR_PREFIX.length).trim() };
    }
    if (separated && first) {
        return { input: { [normalize(stepType) === 'RUN_COMMAND' ? 'command' : 'target']: first }, output: body.slice(1).join('\n').trim() };
    }
    return { input: {}, output: body.join('\n').trim() };
}

function stepMetadata(event: AntigravityTranscriptEvent) {
    return { antigravity: { source: event.source, type: event.type, status: event.status, step_index: event.step_index } };
}

function textMessage(type: 'user' | 'assistant' | 'system', event: AntigravityTranscriptEvent, text: string) {
    return { type, timestamp: event.created_at, message: { role: type, content: [{ type: 'text', text }] }, ...stepMetadata(event) };
}

function transcriptStepToClaudeEvents(event: AntigravityTranscriptEvent, position: number): unknown[] {
    const type = normalize(event.type);
    const source = normalize(event.source);
    const content = event.content ?? '';
    if (type === 'USER_INPUT' || source === 'USER_EXPLICIT') return [textMessage('user', event, content)];
    if (type === 'PLANNER_RESPONSE') {
        const blocks: Array<Record<string, unknown>> = [];
        if (event.thinking) blocks.push({ type: 'thinking', thinking: event.thinking });
        if (content) blocks.push({ type: 'text', text: content });
        return [{ type: 'assistant', timestamp: event.created_at, message: { role: 'assistant', content: blocks }, ...stepMetadata(event) }];
    }
    if (type === 'ERROR_MESSAGE') {
        const text = [stripStepHeader(content).body.join('\n').trim(), event.error].filter(Boolean).join('\n');
        return [{ type: 'error', timestamp: event.created_at, isError: true, message: { content: [{ type: 'text', text }] }, ...stepMetadata(event) }];
    }
    if (source === 'SYSTEM') return [textMessage('system', event, content)];
    const id = `antigravity-step-${event.step_index ?? `position-${position}`}`;
    const parsed = parseAntigravityToolStepContent(event.type, content);
    const isError = normalize(event.status) === 'ERROR' || parsed.error !== undefined;
    return [
        { type: 'assistant', timestamp: event.created_at, message: { role: 'assistant', content: [{ type: 'tool_use', id, name: event.type, input: parsed.input }] }, ...stepMetadata(event) },
        { type: 'user', timestamp: event.created_at, isError, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: parsed.output, is_error: isError }] }, ...stepMetadata(event) },
    ];
}

function stepKey(update: AntigravityStreamStepUpdateEvent['step_update']): string {
    return `${update.conversation_id}:${update.step_index}`;
}

/** A streamed step converts at step granularity: its latest state stands for all its updates. */
function streamStepToClaudeEvents(update: AntigravityStreamStepUpdateEvent['step_update']): unknown[] {
    const meta = { session_id: update.conversation_id, conversation_id: update.conversation_id, antigravity: { type: update.step_type, status: update.state, step_index: update.step_index } };
    if (normalize(update.step_type) === AGENT_RESPONSE) {
        return update.text_delta ? [{ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: update.text_delta }] }, ...meta }] : [];
    }
    const id = `antigravity-step-${update.conversation_id}-${update.step_index}`;
    const isError = normalize(update.state) === 'ERROR';
    return [
        { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name: update.step_type, input: {} }] }, ...meta },
        { type: 'user', isError, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: update.text_delta ?? '', is_error: isError }] }, ...meta },
    ];
}

/**
 * The persisted trace of one implementation run. Usage stays on the run's
 * token totals: stream usage is cumulative, so it is not repeated per step.
 */
export function buildAntigravityConversationLog(events: AntigravityOutputEvent[]): unknown[] {
    const aggregated = aggregateDeltaMessages(events);
    const latestToolUpdates = new Map<string, AntigravityStreamStepUpdateEvent['step_update']>();
    const streamedText = new Map<string, string>();
    for (const event of aggregated) {
        if (!isAntigravityStreamEvent(event) || event.event !== 'step_update') continue;
        const update = event.step_update;
        if (normalize(update.step_type) === AGENT_RESPONSE) streamedText.set(update.conversation_id, (streamedText.get(update.conversation_id) ?? '') + (update.text_delta ?? ''));
        else latestToolUpdates.set(stepKey(update), update);
    }
    const emittedSteps = new Set<string>();
    const log: unknown[] = [];
    aggregated.forEach((event, position) => {
        if (isTranscriptEvent(event)) { log.push(...transcriptStepToClaudeEvents(event, position)); return; }
        if (!isAntigravityStreamEvent(event)) { log.push(convertEventToClaudeFormat(event)); return; }
        if (event.event === 'init') { log.push({ type: 'system', session_id: event.conversation_id, conversation_id: event.conversation_id, model: event.init.model, message: { content: [] } }); return; }
        if (event.event === 'result') {
            const { conversation_id: conversationId, status, response } = event.result;
            const text = response && response !== streamedText.get(conversationId) ? [{ type: 'text', text: response }] : [];
            log.push({ type: 'result', session_id: conversationId, conversation_id: conversationId, status: status.toLowerCase(), isError: status.toUpperCase() === 'ERROR', message: { content: text } });
            return;
        }
        const update = event.step_update;
        if (normalize(update.step_type) === AGENT_RESPONSE) { log.push(...streamStepToClaudeEvents(update)); return; }
        const key = stepKey(update);
        if (emittedSteps.has(key)) return;
        emittedSteps.add(key);
        log.push(...streamStepToClaudeEvents(latestToolUpdates.get(key) ?? update));
    });
    return log;
}
