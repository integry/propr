import { stripWorkflowAgentStderrPrefix } from '../../../workflow/workflowExecution.js';

const PRINT_TIMEOUT_NOTICE = /^\[agy\] print timeout after (\S+?)(?=\s|;|$)/;
const PRINT_TIMEOUT_TEXT = /print timeout after (\S+?)(?=\s|;|$)/i;
const AGY_ERROR_LINE = /^AGY_ERROR:?\s*(.*)$/;

export interface AntigravityPrintTimeout {
    /** The deadline the CLI reports, e.g. `3600s`, when it names one. */
    duration?: string;
    /** The CLI's own `AGY_ERROR` explanation, when it printed one. */
    detail?: string;
    message: string;
}

function diagnosticLines(stderr: string): string[] {
    return stderr.split('\n').map(line => stripWorkflowAgentStderrPrefix(line.trim()).trim()).filter(Boolean);
}

/** The human-readable part of an `AGY_ERROR` payload; it is JSON from CLI 1.5.0, plain text before. */
function agyErrorDetail(payload: string): string | undefined {
    const text = payload.trim();
    if (!text) return undefined;
    try {
        const parsed = JSON.parse(text) as Record<string, unknown>;
        for (const key of ['short_error', 'message', 'error', 'details']) {
            const value = parsed[key];
            if (typeof value === 'string' && value.trim()) return value.trim();
        }
        return text;
    } catch {
        return text;
    }
}

/**
 * Recognises a run that Antigravity's own `--print-timeout` cut short. From CLI
 * 1.5.0 such a run exits with code 3, prints an `AGY_ERROR` line and writes
 * `[agy] print timeout after ...` to stderr; the response it printed is partial.
 */
export function detectAntigravityPrintTimeout(stderr: string | undefined, exitCode: number | null | undefined): AntigravityPrintTimeout | undefined {
    if (!stderr) return undefined;
    const lines = diagnosticLines(stderr);
    const notice = lines.map(line => PRINT_TIMEOUT_NOTICE.exec(line)).find(Boolean);
    const agyErrors = lines.map(line => AGY_ERROR_LINE.exec(line)).filter((match): match is RegExpExecArray => !!match)
        .map(match => agyErrorDetail(match[1])).filter((detail): detail is string => !!detail);
    const timeoutError = agyErrors.find(detail => PRINT_TIMEOUT_TEXT.test(detail));
    if (!notice && !timeoutError) return undefined;

    const duration = notice?.[1] ?? (timeoutError ? PRINT_TIMEOUT_TEXT.exec(timeoutError)?.[1] : undefined);
    const detail = timeoutError ?? agyErrors.pop();
    const exitNote = typeof exitCode === 'number' ? ` (exit code ${exitCode})` : '';
    const message = `Antigravity CLI hit its --print-timeout${duration ? ` after ${duration}` : ''}${exitNote} before the run finished; the response is partial.`
        + `${detail ? ` AGY_ERROR: ${detail}` : ''}`;
    return { duration, detail, message };
}
