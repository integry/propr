interface VibeJsonOutput {
    type?: string;
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
    usage?: {
        input_tokens?: number;
        output_tokens?: number;
    };
    token_usage?: {
        input_tokens?: number;
        output_tokens?: number;
    };
}

interface ParsedVibeOutput {
    sessionId?: string;
    model?: string;
    summary?: string;
    error?: string;
    tokenUsage?: { input_tokens?: number; output_tokens?: number };
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

function textFromValue(value: unknown, depth = 0): string | undefined {
    if (depth > 8) {
        return undefined;
    }
    if (typeof value === 'string') {
        return value;
    }
    if (Array.isArray(value)) {
        const parts = value.map(item => textFromValue(item, depth + 1)).filter((text): text is string => Boolean(text));
        return parts.length > 0 ? parts.join('') : undefined;
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

function findTextEvent(jsonObjects: VibeJsonOutput[]): { event: VibeJsonOutput; index: number } | undefined {
    for (let index = jsonObjects.length - 1; index >= 0; index--) {
        const event = jsonObjects[index];
        if (event.type !== 'error' && event.type && FINAL_EVENT_TYPES.has(event.type) && pickText(event)) {
            return { event, index };
        }
    }
    for (let index = jsonObjects.length - 1; index >= 0; index--) {
        const event = jsonObjects[index];
        if (event.type !== 'error' && pickText(event)) {
            return { event, index };
        }
    }
    return undefined;
}

function findRelevantError(jsonObjects: VibeJsonOutput[], textEventIndex: number): string | undefined {
    for (let index = jsonObjects.length - 1; index >= 0; index--) {
        const error = pickError(jsonObjects[index]);
        if (error && index > textEventIndex) {
            return error;
        }
    }
    return undefined;
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
    const error = findRelevantError(jsonObjects, textEvent?.index ?? -1);

    return {
        sessionId: sessionEvent?.session_id || sessionEvent?.sessionId,
        model: modelEvent?.model,
        summary: textEvent ? pickText(textEvent.event) : output.trim() || undefined,
        error,
        tokenUsage: usageEvent?.usage || usageEvent?.token_usage
    };
}
