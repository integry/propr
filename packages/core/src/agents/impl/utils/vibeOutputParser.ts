interface VibeJsonOutput {
    type?: string;
    session_id?: string;
    sessionId?: string;
    model?: string;
    result?: string;
    response?: string;
    output?: string;
    text?: string;
    error?: string;
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
        return [value as VibeJsonOutput];
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

function pickText(event: VibeJsonOutput): string | undefined {
    return event.result || event.response || event.output || event.text;
}

export function parseVibeOutput(output: string): ParsedVibeOutput {
    const jsonObjects = parseJsonObjects(output);
    if (jsonObjects.length === 0) {
        const summary = output.trim();
        return { summary: summary || undefined };
    }

    const textEvent = [...jsonObjects].reverse().find(event => pickText(event));
    const sessionEvent = [...jsonObjects].reverse().find(event => event.session_id || event.sessionId);
    const modelEvent = [...jsonObjects].reverse().find(event => event.model);
    const usageEvent = [...jsonObjects].reverse().find(event => event.usage || event.token_usage);
    const errorEvent = jsonObjects.find(event => event.error || event.type === 'error');

    return {
        sessionId: sessionEvent?.session_id || sessionEvent?.sessionId,
        model: modelEvent?.model,
        summary: textEvent ? pickText(textEvent) : output.trim() || undefined,
        error: errorEvent ? (errorEvent.error || 'Vibe reported an error') : undefined,
        tokenUsage: usageEvent?.usage || usageEvent?.token_usage
    };
}
