interface JsonLineMessage {
    type?: string;
    event?: string;
    message?: { id?: string; model?: string };
    session_id?: string;
    conversation_id?: string;
    thread_id?: string;
    init?: { conversation_id?: string };
}

export interface SessionLineInspectionContext {
    messageTimestamps: Map<string, string>;
    state: { sessionIdDetected: boolean };
    onSessionId?: (sessionId: string, conversationId?: string) => void | Promise<void>;
    invokeExecutionCallback: (callback: () => void | Promise<void>) => void;
}

function resolveSessionId(message: JsonLineMessage): string | undefined {
    if (message.session_id) return message.session_id;
    if (message.thread_id) return message.thread_id;
    if (message.event !== 'init') return undefined;
    return message.conversation_id || message.init?.conversation_id;
}

export function inspectSessionMessageLine(
    line: string,
    timestamp: string,
    context: SessionLineInspectionContext,
): void {
    if (!line.trim()) return;
    try {
        const message: JsonLineMessage = JSON.parse(line);
        if (message.type === 'assistant' || message.type === 'user') {
            const messageId = message.message?.id
                || `${message.type}-${JSON.stringify(message).substring(0, 100)}`;
            context.messageTimestamps.set(messageId, timestamp);
        }
        const detectedSessionId = resolveSessionId(message);
        if (!context.state.sessionIdDetected && context.onSessionId && detectedSessionId) {
            context.state.sessionIdDetected = true;
            const conversationId = message.conversation_id || message.init?.conversation_id;
            context.invokeExecutionCallback(() => context.onSessionId!(detectedSessionId, conversationId));
        }
    } catch { /* non-JSON provider output */ }
}
