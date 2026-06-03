interface VibeJsonOutput {
    type?: string;
    role?: string;
    session_id?: string;
    sessionId?: string;
    model?: string;
    result?: unknown;
    response?: unknown;
    output?: unknown;
    text?: unknown;
    content?: unknown;
    message?: unknown;
    delta?: unknown;
    data?: unknown;
    error?: unknown;
    reasoning_content?: unknown;
    message_id?: string;
    reasoning_message_id?: string;
    tool_call_id?: string;
    name?: string;
    tool_calls?: VibeToolCall[];
    usage?: {
        input_tokens?: number;
        output_tokens?: number;
    };
    token_usage?: {
        input_tokens?: number;
        output_tokens?: number;
    };
}

interface VibeToolCall {
    id?: string;
    function?: {
        name?: string;
        arguments?: unknown;
    };
}

interface ParsedVibeOutput {
    sessionId?: string;
    model?: string;
    summary?: string;
    error?: string;
    incomplete?: boolean;
    tokenUsage?: { input_tokens?: number; output_tokens?: number };
}

interface ConversationContentItem {
    type: 'text' | 'tool_use' | 'tool_result';
    text?: string;
    id?: string;
    name?: string;
    input?: unknown;
    tool_use_id?: string;
    content?: unknown;
    is_error?: boolean;
}

export interface VibeConversationLogEntry {
    type: 'assistant' | 'user';
    timestamp: string;
    message: {
        id?: string;
        content: ConversationContentItem[];
        usage?: {
            input_tokens?: number;
            output_tokens?: number;
        };
    };
}

const FINAL_EVENT_TYPES = new Set(['final', 'result', 'completed', 'complete', 'response']);

function jsonEventsFromValue(value: unknown): VibeJsonOutput[] {
    if (Array.isArray(value)) {
        return value.flatMap(item => jsonEventsFromValue(item));
    }
    if (value && typeof value === 'object') {
        return [value as VibeJsonOutput];
    }
    return [];
}

function tryParseJson(text: string): VibeJsonOutput[] {
    try {
        return jsonEventsFromValue(JSON.parse(text));
    } catch {
        return [];
    }
}

function parseJsonObjects(output: string): VibeJsonOutput[] {
    const trimmed = output.trim();
    const wholeDocument = trimmed ? tryParseJson(trimmed) : [];
    if (wholeDocument.length > 0) {
        return wholeDocument;
    }
    return output
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean)
        .flatMap(line => tryParseJson(line));
}

function joinTextParts(parts: string[]): string {
    return parts.reduce((combined, part) => {
        if (!combined) {
            return part;
        }
        if (!part) {
            return combined;
        }
        const hasBoundaryWhitespace = /\s$/.test(combined) || /^\s/.test(part);
        return hasBoundaryWhitespace ? `${combined}${part}` : `${combined}\n${part}`;
    }, '');
}

function textFromValue(value: unknown, depth = 0): string | undefined {
    if (depth > 8) {
        return undefined;
    }
    if (typeof value === 'string') {
        return value;
    }
    if (Array.isArray(value)) {
        const parts = value.map(item => textFromValue(item, depth + 1)).filter((text): text is string => Boolean(text));
        return parts.length > 0 ? joinTextParts(parts) : undefined;
    }
    if (value && typeof value === 'object') {
        return pickText(value as VibeJsonOutput, depth + 1);
    }
    return undefined;
}

function pickText(event: VibeJsonOutput, depth = 0): string | undefined {
    return textFromValue(event.result, depth)
        || textFromValue(event.response, depth)
        || textFromValue(event.output, depth)
        || textFromValue(event.text, depth)
        || textFromValue(event.content, depth)
        || textFromValue(event.message, depth)
        || textFromValue(event.delta, depth)
        || textFromValue(event.data, depth);
}

function pickError(event: VibeJsonOutput): string | undefined {
    if (typeof event.error === 'string') {
        return event.error;
    }
    if (event.error && typeof event.error === 'object') {
        const errorText = pickText(event.error as VibeJsonOutput);
        if (errorText) {
            return errorText;
        }
    }
    return event.type === 'error' ? 'Vibe reported an error' : undefined;
}

function findTextEvent(jsonObjects: VibeJsonOutput[]): { event: VibeJsonOutput; index: number; isFinal: boolean } | undefined {
    for (let index = jsonObjects.length - 1; index >= 0; index--) {
        const event = jsonObjects[index];
        if (event.type !== 'error' && event.type && FINAL_EVENT_TYPES.has(event.type) && pickText(event)) {
            return { event, index, isFinal: true };
        }
    }
    for (let index = jsonObjects.length - 1; index >= 0; index--) {
        const event = jsonObjects[index];
        if (event.type !== 'error' && event.role === 'assistant' && pickText(event)) {
            return { event, index, isFinal: true };
        }
    }
    for (let index = jsonObjects.length - 1; index >= 0; index--) {
        const event = jsonObjects[index];
        if (event.type !== 'error' && event.role !== 'system' && pickText(event)) {
            return { event, index, isFinal: false };
        }
    }
    return undefined;
}

function findRelevantError(jsonObjects: VibeJsonOutput[], textEvent?: { index: number; isFinal: boolean }): string | undefined {
    if (textEvent && !textEvent.isFinal) {
        return undefined;
    }

    for (let index = jsonObjects.length - 1; index >= 0; index--) {
        const error = pickError(jsonObjects[index]);
        if (error && index > (textEvent?.index ?? -1)) {
            return error;
        }
    }
    return undefined;
}

function parseToolInput(input: unknown): unknown {
    if (typeof input !== 'string') {
        return input;
    }
    try {
        return JSON.parse(input);
    } catch {
        return input;
    }
}

function buildTextItem(text: string): ConversationContentItem {
    return { type: 'text', text };
}

function hasContentItems(items: ConversationContentItem[]): boolean {
    return items.some(item => item.type !== 'text' || Boolean(item.text?.trim()));
}

function buildAssistantConversationEntry(event: VibeJsonOutput, index: number): VibeConversationLogEntry | undefined {
    const content: ConversationContentItem[] = [];
    const reasoningText = textFromValue(event.reasoning_content);
    const messageText = textFromValue(event.content);

    if (reasoningText) {
        content.push(buildTextItem(reasoningText));
    }
    if (messageText) {
        content.push(buildTextItem(messageText));
    }
    for (const toolCall of event.tool_calls || []) {
        const toolName = toolCall.function?.name || 'tool';
        content.push({
            type: 'tool_use',
            id: toolCall.id,
            name: toolName,
            input: parseToolInput(toolCall.function?.arguments)
        });
    }

    if (!hasContentItems(content)) {
        return undefined;
    }

    return {
        type: 'assistant',
        timestamp: new Date().toISOString(),
        message: {
            id: event.message_id || event.reasoning_message_id || `vibe-assistant-${index}`,
            content,
            usage: event.usage || event.token_usage
        }
    };
}

function buildUserConversationEntry(event: VibeJsonOutput, index: number): VibeConversationLogEntry | undefined {
    const userText = textFromValue(event.content);
    if (!userText) {
        return undefined;
    }
    return {
        type: 'user',
        timestamp: new Date().toISOString(),
        message: {
            id: event.message_id || `vibe-user-${index}`,
            content: [buildTextItem(userText)],
            usage: event.usage || event.token_usage
        }
    };
}

function buildToolResultConversationEntry(event: VibeJsonOutput, index: number): VibeConversationLogEntry | undefined {
    const resultText = textFromValue(event.content) || textFromValue(event.result) || textFromValue(event.output);
    if (!resultText && !event.error) {
        return undefined;
    }

    return {
        type: 'user',
        timestamp: new Date().toISOString(),
        message: {
            id: event.message_id || event.tool_call_id || `vibe-tool-${index}`,
            content: [{
                type: 'tool_result',
                tool_use_id: event.tool_call_id,
                content: resultText || event.error,
                is_error: typeof resultText === 'string' && resultText.includes('<tool_error>')
            }],
            usage: event.usage || event.token_usage
        }
    };
}

export function parseVibeConversationLog(output: string): VibeConversationLogEntry[] {
    const jsonObjects = parseJsonObjects(output);
    const conversationLog: VibeConversationLogEntry[] = [];

    jsonObjects.forEach((event, index) => {
        if (event.role === 'system') {
            return;
        }
        const entry = event.role === 'assistant'
            ? buildAssistantConversationEntry(event, index)
            : event.role === 'tool'
                ? buildToolResultConversationEntry(event, index)
                : event.role === 'user'
                    ? buildUserConversationEntry(event, index)
                    : undefined;
        if (entry) {
            conversationLog.push(entry);
        }
    });

    return conversationLog;
}

export function parseVibeOutput(output: string): ParsedVibeOutput {
    const jsonObjects = parseJsonObjects(output);
    if (jsonObjects.length === 0) {
        const summary = output.trim();
        return { summary: summary || undefined };
    }

    const textEvent = findTextEvent(jsonObjects);
    const sessionEvent = [...jsonObjects].reverse().find(event => event.session_id || event.sessionId);
    const modelEvent = [...jsonObjects].reverse().find(event => event.model);
    const usageEvent = [...jsonObjects].reverse().find(event => event.usage || event.token_usage);
    const error = findRelevantError(jsonObjects, textEvent);

    return {
        sessionId: sessionEvent?.session_id || sessionEvent?.sessionId,
        model: modelEvent?.model,
        summary: textEvent ? pickText(textEvent.event) : output.trim() || undefined,
        error,
        incomplete: textEvent ? !textEvent.isFinal : true,
        tokenUsage: usageEvent?.usage || usageEvent?.token_usage
    };
}
