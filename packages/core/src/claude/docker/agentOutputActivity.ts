/**
 * Provider-neutral classification of one agent output record for the activity
 * watchdog. Every supported agent streams newline-delimited JSON (Claude
 * stream-json, Codex exec events, OpenCode parts, Antigravity events); only
 * the few shapes that matter here are recognized: assistant text, the start of
 * a tool call and its end. Anything else is plain activity.
 */
export type AgentOutputActivity =
    | { kind: 'text'; text: string }
    | { kind: 'tool_start' }
    | { kind: 'tool_end' }
    | { kind: 'activity' };

const ACTIVITY: AgentOutputActivity = { kind: 'activity' };
const TOOL_START: AgentOutputActivity = { kind: 'tool_start' };
const TOOL_END: AgentOutputActivity = { kind: 'tool_end' };
const TOOL_START_TYPES = new Set(['tool_use', 'tool_call', 'tool']);
const TOOL_END_TYPES = new Set(['tool_result', 'tool_response']);
const CODEX_TOOL_ITEMS = new Set(['command_execution', 'mcp_tool_call', 'web_search', 'file_change']);
const FINISHED_TOOL_STATUSES = new Set(['completed', 'error', 'failed', 'cancelled']);

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function lower(value: unknown): string {
    return typeof value === 'string' ? value.toLowerCase() : '';
}

function classifyContentBlocks(content: unknown): AgentOutputActivity | null {
    if (!Array.isArray(content)) return null;
    let text: string | null = null;
    for (const block of content) {
        if (!isRecord(block)) continue;
        const type = lower(block.type);
        if (TOOL_START_TYPES.has(type)) return TOOL_START;
        if (TOOL_END_TYPES.has(type)) return TOOL_END;
        if (type === 'text' && typeof block.text === 'string') text = (text ?? '') + block.text;
    }
    return text === null ? null : { kind: 'text', text };
}

function classifyToolPart(part: JsonRecord): AgentOutputActivity {
    const status = isRecord(part.state) ? lower(part.state.status) : lower(part.status);
    return FINISHED_TOOL_STATUSES.has(status) ? TOOL_END : TOOL_START;
}

/** Claude stream-json and Antigravity transcripts: whole messages. */
function classifyMessage(event: JsonRecord, type: string): AgentOutputActivity | null {
    if (!isRecord(event.message)) return null;
    const blocks = classifyContentBlocks(event.message.content);
    // Prompts and other user turns are activity, never agent text.
    const fromUser = type === 'user' || lower(event.message.role) === 'user';
    if (!blocks) return null;
    return fromUser && blocks.kind === 'text' ? ACTIVITY : blocks;
}

/** Claude partial-message stream events. */
function classifyStreamEvent(event: JsonRecord): AgentOutputActivity {
    const delta = isRecord(event.event) ? event.event.delta : undefined;
    return isRecord(delta) && typeof delta.text === 'string' ? { kind: 'text', text: delta.text } : ACTIVITY;
}

/** Codex exec --json items. */
function classifyCodexItem(item: JsonRecord, type: string): AgentOutputActivity {
    const itemType = lower(item.type);
    if (CODEX_TOOL_ITEMS.has(itemType)) return type === 'item.completed' ? TOOL_END : TOOL_START;
    if (itemType === 'agent_message' && typeof item.text === 'string') return { kind: 'text', text: item.text };
    return ACTIVITY;
}

/** Codex legacy protocol messages. */
function classifyCodexMessage(msg: JsonRecord): AgentOutputActivity {
    const msgType = lower(msg.type);
    if (msgType.endsWith('_begin')) return TOOL_START;
    if (msgType.endsWith('_end')) return TOOL_END;
    if (msgType === 'agent_message_delta' && typeof msg.delta === 'string') return { kind: 'text', text: msg.delta };
    if (msgType === 'agent_message' && typeof msg.message === 'string') return { kind: 'text', text: msg.message };
    return ACTIVITY;
}

/** OpenCode parts. */
function classifyPart(part: JsonRecord): AgentOutputActivity | null {
    const partType = lower(part.type);
    if (TOOL_START_TYPES.has(partType)) return classifyToolPart(part);
    if (TOOL_END_TYPES.has(partType)) return TOOL_END;
    if (partType === 'text' && typeof part.text === 'string') return { kind: 'text', text: part.text };
    return null;
}

function flatText(event: JsonRecord): string | null {
    for (const value of [event.content, event.delta, event.text]) {
        if (typeof value === 'string') return value;
    }
    return null;
}

/** Flat tool and message events (Antigravity legacy, generic). */
function classifyFlatEvent(event: JsonRecord, type: string): AgentOutputActivity {
    if (TOOL_START_TYPES.has(type)) return classifyToolPart(event);
    if (TOOL_END_TYPES.has(type)) return TOOL_END;
    if (!['message', 'text', 'delta'].includes(type) || lower(event.role) === 'user') return ACTIVITY;
    const text = flatText(event);
    return text === null ? ACTIVITY : { kind: 'text', text };
}

function classifyEvent(event: JsonRecord): AgentOutputActivity {
    const type = lower(event.type);
    const message = classifyMessage(event, type);
    if (message) return message;
    if (type === 'stream_event') return classifyStreamEvent(event);
    if (type.startsWith('item.') && isRecord(event.item)) return classifyCodexItem(event.item, type);
    if (isRecord(event.msg)) return classifyCodexMessage(event.msg);
    const part = isRecord(event.part) ? classifyPart(event.part) : null;
    return part ?? classifyFlatEvent(event, type);
}

export function classifyAgentOutputLine(line: string): AgentOutputActivity {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) return ACTIVITY;
    try {
        const event: unknown = JSON.parse(trimmed);
        return isRecord(event) ? classifyEvent(event) : ACTIVITY;
    } catch {
        return ACTIVITY;
    }
}
