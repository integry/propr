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

function flattenJsonValue(value: unknown): VibeJsonOutput[] {
    if (Array.isArray(value)) {
        return value.flatMap(item => flattenJsonValue(item));
    }
    if (value && typeof value === 'object') {
        const objectValue = value as Record<string, unknown>;
        return [
            objectValue as VibeJsonOutput,
            ...Object.entries(objectValue)
                .filter(([key]) => key !== 'error')
                .flatMap(([, item]) => flattenJsonValue(item))
        ];
    }
    return [];
}

function tryParseJson(text: string): VibeJsonOutput[] {
    try {
        return flattenJsonValue(JSON.parse(text));
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

function textFromValue(value: unknown): string | undefined {
    if (typeof value === 'string') {
        return value;
    }
    if (Array.isArray(value)) {
        const parts = value.map(item => textFromValue(item)).filter((text): text is string => Boolean(text));
        return parts.length > 0 ? parts.join('') : undefined;
    }
    if (value && typeof value === 'object') {
        return pickText(value as VibeJsonOutput);
    }
    return undefined;
}

function pickText(event: VibeJsonOutput): string | undefined {
    return textFromValue(event.result)
        || textFromValue(event.response)
        || textFromValue(event.output)
        || textFromValue(event.text)
        || textFromValue(event.content)
        || textFromValue(event.message)
        || textFromValue(event.delta)
        || textFromValue(event.data);
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

export function parseVibeOutput(output: string): ParsedVibeOutput {
    const jsonObjects = parseJsonObjects(output);
    if (jsonObjects.length === 0) {
        const summary = output.trim();
        return { summary: summary || undefined };
    }

    const textEvent = [...jsonObjects].reverse().find(event => event.type !== 'error' && pickText(event));
    const sessionEvent = [...jsonObjects].reverse().find(event => event.session_id || event.sessionId);
    const modelEvent = [...jsonObjects].reverse().find(event => event.model);
    const usageEvent = [...jsonObjects].reverse().find(event => event.usage || event.token_usage);
    const error = jsonObjects.map(event => pickError(event)).find(Boolean);

    return {
        sessionId: sessionEvent?.session_id || sessionEvent?.sessionId,
        model: modelEvent?.model,
        summary: textEvent ? pickText(textEvent) : output.trim() || undefined,
        error,
        tokenUsage: usageEvent?.usage || usageEvent?.token_usage
    };
}
