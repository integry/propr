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
/** Step states that end a tool call; `DONE` is the only successful one. Mirrors the live projector. */
const TERMINAL_STEP_STATES = new Set(['DONE', 'ERROR', 'FAILED', 'CANCELED', 'CANCELLED']);

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
    const status = normalize(event.status);
    const toolUse = { type: 'assistant', timestamp: event.created_at, message: { role: 'assistant', content: [{ type: 'tool_use', id, name: event.type, input: parsed.input }] }, ...stepMetadata(event) };
    // An unfinished step (e.g. RUNNING when the run timed out) has no result yet; a step error ends it.
    if (!TERMINAL_STEP_STATES.has(status) && parsed.error === undefined) return [toolUse];
    const isError = parsed.error !== undefined || isAntigravityToolStepError(status, content);
    return [
        toolUse,
        { type: 'user', timestamp: event.created_at, isError, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: parsed.output, is_error: isError }] }, ...stepMetadata(event) },
    ];
}

function stepKey(update: AntigravityStreamStepUpdateEvent['step_update']): string {
    return `${update.conversation_id}:${update.step_index}`;
}

type StreamStepUpdate = AntigravityStreamStepUpdateEvent['step_update'];
const STREAM_TOOL_STEP = 'TOOL';
const COMMAND_EXIT_CODE = /Command exited with code (-?\d+)/;

function isStreamToolStep(update: StreamStepUpdate): boolean {
    return normalize(update.step_type) === STREAM_TOOL_STEP;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The tool's output text: agy 1.5 reports it in `tool_info.output` once the step is DONE. */
export function antigravityStreamToolOutput(update: StreamStepUpdate): string {
    const output = isRecord(update.tool_info) ? update.tool_info.output : undefined;
    return typeof output === 'string' ? output : update.text_delta ?? '';
}

/** A tool step failed when agy says so, or when its command reported a non-zero exit code. */
export function isAntigravityToolStepError(state: string, output: string): boolean {
    if (normalize(state) !== 'DONE') return true;
    const exit = COMMAND_EXIT_CODE.exec(output);
    return exit !== null && Number(exit[1]) !== 0;
}

/** Whether the stream reports any agy 1.5 `tool` step; only then does it replace the transcript's tool steps. */
export function hasAntigravityStreamToolSteps(events: AntigravityOutputEvent[]): boolean {
    return events.some(event => isAntigravityStreamEvent(event) && event.event === 'step_update' && isStreamToolStep(event.step_update));
}

/** Folds every update of one tool step: the latest state wins, and name, parameters and output survive later updates that omit them. */
function mergeToolUpdate(previous: StreamStepUpdate | undefined, update: StreamStepUpdate): StreamStepUpdate {
    if (!previous) return update;
    const previousInfo = isRecord(previous.tool_info) ? previous.tool_info : {};
    const info = isRecord(update.tool_info) ? update.tool_info : {};
    return { ...previous, ...update, tool_name: update.tool_name ?? previous.tool_name, tool_info: { ...previousInfo, ...info } };
}

/** A streamed tool step converts at step granularity: its merged updates stand for all of them. */
function streamToolStepToClaudeEvents(update: StreamStepUpdate): unknown[] {
    const meta = { session_id: update.conversation_id, conversation_id: update.conversation_id, antigravity: { type: update.step_type, status: update.state, step_index: update.step_index } };
    const info = isRecord(update.tool_info) ? update.tool_info : {};
    const name = update.tool_name || (typeof info.name === 'string' && info.name) || update.step_type;
    const input = isRecord(info.parameters) ? info.parameters : {};
    const id = `antigravity-step-${update.conversation_id}-${update.step_index}`;
    const toolUse = { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] }, ...meta };
    // A step whose latest update is not terminal never reported completion: keep the call, not a result.
    if (!TERMINAL_STEP_STATES.has(normalize(update.state))) return [toolUse];
    const output = antigravityStreamToolOutput(update);
    const isError = isAntigravityToolStepError(update.state, output);
    return [
        toolUse,
        { type: 'user', isError, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: output, is_error: isError }] }, ...meta },
    ];
}

function streamNarrationToClaudeEvents(update: StreamStepUpdate): unknown[] {
    const meta = { session_id: update.conversation_id, conversation_id: update.conversation_id, antigravity: { type: update.step_type, status: update.state, step_index: update.step_index } };
    return update.text_delta ? [{ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: update.text_delta }] }, ...meta }] : [];
}

/**
 * Whether the terminal response adds nothing to the final streamed answer:
 * it is empty, equal to it, or a truncated copy of it. Mirrors the live projector.
 */
function repeatsFinalNarration(response: string | undefined, narration: string): boolean {
    const answer = (response ?? '').trim();
    return !answer || narration.trim().startsWith(answer);
}

/**
 * The persisted trace of one implementation run. Usage stays on the run's
 * token totals: stream usage is cumulative, so it is not repeated per step.
 * Stream `tool` steps become tool calls; `user_input` and other non-tool steps
 * carry no content of their own and are skipped. The terminal response is
 * kept unless it repeats, or is a truncated copy of, the conversation's final
 * narration: the text streamed since its latest init or new tool step.
 */
export function buildAntigravityConversationLog(events: AntigravityOutputEvent[]): unknown[] {
    const aggregated = aggregateDeltaMessages(events);
    const toolUpdates = new Map<string, StreamStepUpdate>();
    for (const event of aggregated) {
        if (!isAntigravityStreamEvent(event) || event.event !== 'step_update' || !isStreamToolStep(event.step_update)) continue;
        const update = event.step_update;
        toolUpdates.set(stepKey(update), mergeToolUpdate(toolUpdates.get(stepKey(update)), update));
    }
    const finalNarration = new Map<string, string>();
    const emittedSteps = new Set<string>();
    const log: unknown[] = [];
    aggregated.forEach((event, position) => {
        if (isTranscriptEvent(event)) { log.push(...transcriptStepToClaudeEvents(event, position)); return; }
        if (!isAntigravityStreamEvent(event)) { log.push(convertEventToClaudeFormat(event)); return; }
        if (event.event === 'init') { finalNarration.set(event.conversation_id, ''); log.push({ type: 'system', session_id: event.conversation_id, conversation_id: event.conversation_id, model: event.init.model, message: { content: [] } }); return; }
        if (event.event === 'result') {
            const { conversation_id: conversationId, status, response } = event.result;
            const text = repeatsFinalNarration(response, finalNarration.get(conversationId) ?? '') ? [] : [{ type: 'text', text: response }];
            finalNarration.set(conversationId, '');
            log.push({ type: 'result', session_id: conversationId, conversation_id: conversationId, status: status.toLowerCase(), isError: status.toUpperCase() === 'ERROR', message: { content: text } });
            return;
        }
        const update = event.step_update;
        if (normalize(update.step_type) === AGENT_RESPONSE) {
            finalNarration.set(update.conversation_id, (finalNarration.get(update.conversation_id) ?? '') + (update.text_delta ?? ''));
            log.push(...streamNarrationToClaudeEvents(update));
            return;
        }
        if (!isStreamToolStep(update)) return;
        const key = stepKey(update);
        if (emittedSteps.has(key)) return;
        emittedSteps.add(key);
        // Narration before a tool call is progress, not the final answer.
        finalNarration.set(update.conversation_id, '');
        log.push(...streamToolStepToClaudeEvents(toolUpdates.get(key) ?? update));
    });
    return log;
}
