/**
 * The stack trace of a Sentry event, trimmed for a GitHub issue body.
 *
 * Only the exception entries are read (`entries[].type === "exception"`), and
 * of each frame only where it is: function, module or file name, line and
 * column, and whether it is the application's own code (`inApp`). Local
 * variables (`vars`), source context, absolute paths, registers and every
 * other entry (request, breadcrumbs, threads, messages) are never read.
 *
 * Trimming:
 * - exceptions: the primary one (Sentry lists it last) first, then the
 *   exceptions it was caused by, at most `exceptions`;
 * - frames: at most `frames` over all exceptions, chosen in-app frames first
 *   (the most recent ones first), then the other frames; shown in call order,
 *   most recent call first, with the number left out;
 * - length: each line at most `lineChars` characters, the whole trace at most
 *   `totalChars`.
 */

export const STACK_TRACE_LIMITS = { exceptions: 3, frames: 20, lineChars: 240, totalChars: 6_000 } as const;
export type StackTraceLimits = { [K in keyof typeof STACK_TRACE_LIMITS]: number };

export interface StackFrame { function: string | null; module: string | null; filename: string | null; lineNo: number | null; colNo: number | null; inApp: boolean }
export interface StackException { type: string | null; value: string | null; frames: StackFrame[] }

const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value.trim() : null);
const position = (value: unknown): number | null => (typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null);
const oneLine = (value: string) => value.replace(/\s+/g, ' ').trim();
const cut = (value: string, chars: number) => { const list = Array.from(value); return list.length > chars ? `${list.slice(0, Math.max(0, chars - 1)).join('')}…` : value; };

function frameOf(raw: unknown): StackFrame | null {
  if (!raw || typeof raw !== 'object') return null;
  const frame = raw as Record<string, unknown>;
  return {
    function: text(frame.function), module: text(frame.module), filename: text(frame.filename),
    lineNo: position(frame.lineNo ?? frame.lineno), colNo: position(frame.colNo ?? frame.colno), inApp: (frame.inApp ?? frame.in_app) === true,
  };
}

/**
 * The exceptions of an event, primary first: from the API's `entries` (an
 * event read with the issue events endpoint) or from an `exception` object
 * (as an issue alert's `data.event` carries it). Frames oldest call first, as
 * Sentry sends them.
 */
export function eventExceptions(event: { entries?: unknown; exception?: unknown } | null | undefined): StackException[] {
  if (!event || typeof event !== 'object') return [];
  const entry = Array.isArray(event.entries) ? (event.entries as { type?: unknown; data?: unknown }[]).find(e => !!e && e.type === 'exception')?.data : event.exception;
  const values = entry && typeof entry === 'object' && Array.isArray((entry as { values?: unknown }).values) ? (entry as { values: unknown[] }).values : [];
  return values.flatMap(raw => {
    if (!raw || typeof raw !== 'object') return [];
    const value = raw as { type?: unknown; value?: unknown; stacktrace?: { frames?: unknown } | null };
    const frames = Array.isArray(value.stacktrace?.frames) ? value.stacktrace!.frames as unknown[] : [];
    return [{ type: text(value.type), value: text(value.value), frames: frames.map(frameOf).filter((f): f is StackFrame => !!f) }];
  }).reverse();
}

const frameLine = (frame: StackFrame) => {
  const where = frame.filename ?? frame.module ?? '?';
  const at = `${where}${frame.lineNo === null ? '' : `:${frame.lineNo}`}${frame.lineNo !== null && frame.colNo !== null ? `:${frame.colNo}` : ''}`;
  return `at ${frame.function ?? '?'} (${at})${frame.inApp ? ' [in app]' : ''}`;
};

/**
 * The frames kept of one exception, most recent call first: in-app frames
 * first (the most recent ones), then the others, at most `budget`.
 */
export function pickFrames(frames: readonly StackFrame[], budget: number): { kept: StackFrame[]; omitted: number } {
  const recentFirst = [...frames].reverse();
  const chosen = new Set([...recentFirst.filter(f => f.inApp), ...recentFirst.filter(f => !f.inApp)].slice(0, Math.max(0, budget)));
  return { kept: recentFirst.filter(f => chosen.has(f)), omitted: frames.length - chosen.size };
}

/** The trimmed stack trace as plain text lines (empty when the event has no exception). */
export function trimStackTrace(exceptions: readonly StackException[], limits: StackTraceLimits = STACK_TRACE_LIMITS): string {
  const lines: string[] = [];
  let budget = limits.frames;
  exceptions.slice(0, limits.exceptions).forEach((exception, index) => {
    const heading = oneLine([exception.type, exception.value].filter(Boolean).join(': ') || 'Exception');
    lines.push(cut(index === 0 ? heading : `Caused by ${heading}`, limits.lineChars));
    const { kept, omitted } = pickFrames(exception.frames, budget);
    budget -= kept.length;
    for (const frame of kept) lines.push(cut(`  ${oneLine(frameLine(frame))}`, limits.lineChars));
    if (omitted > 0) lines.push(`  … ${omitted} more frame${omitted === 1 ? '' : 's'}`);
  });
  if (exceptions.length > limits.exceptions) lines.push(`… ${exceptions.length - limits.exceptions} more exception${exceptions.length - limits.exceptions === 1 ? '' : 's'}`);
  let total = 0;
  const kept: string[] = [];
  for (const line of lines) {
    if (total + line.length + 1 > limits.totalChars) { kept.push('… (trimmed)'); break; }
    kept.push(line);
    total += line.length + 1;
  }
  return kept.join('\n');
}
