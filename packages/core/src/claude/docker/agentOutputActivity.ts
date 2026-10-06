/**
 * Provider-neutral classification of one agent output record for the activity
 * watchdog. Every supported agent streams newline-delimited JSON (Claude
 * stream-json, Codex exec events, OpenCode parts, Antigravity events, Vibe
 * session messages); only the few shapes that matter here are recognized:
 * assistant text, the start of a tool call and its end. Anything else is plain
 * activity. One record can carry several of them (a message starting two tool
 * calls), so a record classifies to a list, in record order. Tool transitions
 * carry the provider's call id when it has one, so a start and its end pair up.
 */
export type AgentOutputActivity =
    | { kind: 'text'; text: string }
    | { kind: 'tool_start'; id?: string }
    | { kind: 'tool_end'; id?: string }
    | { kind: 'activity' };

const ACTIVITY: AgentOutputActivity = { kind: 'activity' };
const TOOL_ID_KEYS = ['tool_use_id', 'tool_call_id', 'call_id', 'callID', 'tool_id', 'id'] as const;
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

function toolId(record: JsonRecord): string | undefined {
    for (const key of TOOL_ID_KEYS) {
        const value = record[key];
        if (typeof value === 'string' && value) return value;
    }
    return undefined;
}

function toolStart(record: JsonRecord): AgentOutputActivity {
    const id = toolId(record);
    return id ? { kind: 'tool_start', id } : { kind: 'tool_start' };
}

function toolEnd(record: JsonRecord): AgentOutputActivity {
    const id = toolId(record);
    return id ? { kind: 'tool_end', id } : { kind: 'tool_end' };
}

/** Every tool transition in a message, in order; consecutive text blocks join into one. */
function classifyContentBlocks(content: unknown, fromUser: boolean): AgentOutputActivity[] {
    if (!Array.isArray(content)) return [];
    const activities: AgentOutputActivity[] = [];
    let text: string | null = null;
    const flushText = () => {
        // Prompts and other user turns are activity, never agent text.
        if (text !== null) activities.push(fromUser ? ACTIVITY : { kind: 'text', text });
        text = null;
    };
    for (const block of content) {
        if (!isRecord(block)) continue;
        const type = lower(block.type);
        if (type === 'text' && typeof block.text === 'string') { text = (text ?? '') + block.text; continue; }
        if (!TOOL_START_TYPES.has(type) && !TOOL_END_TYPES.has(type)) continue;
        flushText();
        activities.push(TOOL_START_TYPES.has(type) ? toolStart(block) : toolEnd(block));
    }
    flushText();
    return activities;
}

function classifyToolPart(part: JsonRecord): AgentOutputActivity {
    const status = isRecord(part.state) ? lower(part.state.status) : lower(part.status);
    return FINISHED_TOOL_STATUSES.has(status) ? toolEnd(part) : toolStart(part);
}

/** Claude stream-json and Antigravity transcripts: whole messages. */
function classifyMessage(event: JsonRecord, type: string): AgentOutputActivity[] {
    if (!isRecord(event.message)) return [];
    const fromUser = type === 'user' || lower(event.message.role) === 'user';
    return classifyContentBlocks(event.message.content, fromUser);
}

/** OpenAI-style chat messages (Vibe session transcripts): assistant text, tool calls and tool results. */
function classifyChatMessage(event: JsonRecord): AgentOutputActivity[] | null {
    // These records have no `type`; typed events with a role belong to the other protocols.
    if (event.type !== undefined) return null;
    const role = lower(event.role);
    if (role === 'tool') return [toolEnd(event)];
    if (role !== 'assistant') return null;
    // Each assistant message is one text delta, with or without tool calls, so whitespace-only replies count.
    const activities: AgentOutputActivity[] = typeof event.content === 'string' && event.content ? [{ kind: 'text', text: event.content }] : [];
    const calls = Array.isArray(event.tool_calls) ? event.tool_calls : [];
    for (const call of calls) {
        if (isRecord(call)) activities.push(toolStart(call));
    }
    return activities.length > 0 ? activities : [ACTIVITY];
}

/** Claude partial-message stream events. */
function classifyStreamEvent(event: JsonRecord): AgentOutputActivity {
    const delta = isRecord(event.event) ? event.event.delta : undefined;
    return isRecord(delta) && typeof delta.text === 'string' ? { kind: 'text', text: delta.text } : ACTIVITY;
}

/** Codex exec --json items. */
function classifyCodexItem(item: JsonRecord, type: string): AgentOutputActivity {
    const itemType = lower(item.type);
    if (CODEX_TOOL_ITEMS.has(itemType)) return type === 'item.completed' ? toolEnd(item) : toolStart(item);
    if (itemType === 'agent_message' && typeof item.text === 'string') return { kind: 'text', text: item.text };
    return ACTIVITY;
}

/** Codex legacy protocol messages. */
function classifyCodexMessage(msg: JsonRecord): AgentOutputActivity {
    const msgType = lower(msg.type);
    if (msgType.endsWith('_begin')) return toolStart(msg);
    if (msgType.endsWith('_end')) return toolEnd(msg);
    if (msgType === 'agent_message_delta' && typeof msg.delta === 'string') return { kind: 'text', text: msg.delta };
    if (msgType === 'agent_message' && typeof msg.message === 'string') return { kind: 'text', text: msg.message };
    return ACTIVITY;
}

/** OpenCode parts. */
function classifyPart(part: JsonRecord): AgentOutputActivity | null {
    const partType = lower(part.type);
    if (TOOL_START_TYPES.has(partType)) return classifyToolPart(part);
    if (TOOL_END_TYPES.has(partType)) return toolEnd(part);
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
    if (TOOL_END_TYPES.has(type)) return toolEnd(event);
    if (!['message', 'text', 'delta'].includes(type) || lower(event.role) === 'user') return ACTIVITY;
    const text = flatText(event);
    return text === null ? ACTIVITY : { kind: 'text', text };
}

function classifySingleEvent(event: JsonRecord, type: string): AgentOutputActivity {
    if (type === 'stream_event') return classifyStreamEvent(event);
    if (type.startsWith('item.') && isRecord(event.item)) return classifyCodexItem(event.item, type);
    if (isRecord(event.msg)) return classifyCodexMessage(event.msg);
    const part = isRecord(event.part) ? classifyPart(event.part) : null;
    return part ?? classifyFlatEvent(event, type);
}

function classifyEvent(event: JsonRecord): AgentOutputActivity[] {
    const type = lower(event.type);
    const message = classifyMessage(event, type);
    if (message.length > 0) return message;
    return classifyChatMessage(event) ?? [classifySingleEvent(event, type)];
}

/** Classifies one complete output record; never empty. */
export function classifyAgentOutputLine(line: string): AgentOutputActivity[] {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) return [ACTIVITY];
    try {
        const event: unknown = JSON.parse(trimmed);
        return isRecord(event) ? classifyEvent(event) : [ACTIVITY];
    } catch {
        return [ACTIVITY];
    }
}
