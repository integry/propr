/** One stream-json user message, as Claude reads it with `--input-format stream-json`. */
export function encodeClaudeUserMessage(text: string): string {
    return `${JSON.stringify({
        type: 'user',
        message: { role: 'user', content: text },
        parent_tool_use_id: null,
        session_id: '',
    })}\n`;
}

/** The final `result` record of a stream-json run; Claude then waits for more input until stdin closes. */
export function isClaudeResultRecord(line: string): boolean {
    if (!line.includes('"result"')) return false;
    try {
        return (JSON.parse(line) as { type?: unknown }).type === 'result';
    } catch {
        return false;
    }
}
