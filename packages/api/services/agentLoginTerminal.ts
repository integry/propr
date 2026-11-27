/**
 * Terminal output sanitizer for agent login sessions: drops escape
 * sequences and unsafe control characters and normalises carriage returns,
 * so provider CLIs render as plain text in the browser.
 */

export type TerminalEscapeState = 'text' | 'escape' | 'escape_intermediate' | 'csi'
  | 'control_string' | 'control_string_escape';

export interface TerminalSanitizerState {
  escapeState: TerminalEscapeState;
  outputEndedWithCarriageReturn?: boolean;
}

type EscapeSequenceState = Exclude<TerminalEscapeState, 'text'>;

const CONTROL_STRING_STARTS = new Set([']', 'P', 'X', '^', '_']);
const C1_CONTROL_STRING_STARTS = new Set(['\u0090', '\u0098', '\u009d', '\u009e', '\u009f']);
const CSI_FINAL_CHARACTER = /[\u0040-\u007e]/u;
const ESCAPE_INTERMEDIATE_CHARACTER = /[\u0020-\u002f]/u;
const UNSAFE_CONTROL_RANGES = [[0x00, 0x08], [0x0b, 0x0c], [0x0e, 0x1a], [0x1c, 0x1f], [0x7f, 0x9f]];

const ESCAPE_TRANSITIONS: Record<
  EscapeSequenceState,
  (value: string) => TerminalEscapeState
> = {
  escape: value => {
    if (value === '[') return 'csi';
    if (CONTROL_STRING_STARTS.has(value)) return 'control_string';
    return ESCAPE_INTERMEDIATE_CHARACTER.test(value) ? 'escape_intermediate' : 'text';
  },
  escape_intermediate: value => (
    ESCAPE_INTERMEDIATE_CHARACTER.test(value) ? 'escape_intermediate' : 'text'
  ),
  csi: value => CSI_FINAL_CHARACTER.test(value) ? 'text' : 'csi',
  control_string: value => {
    if (value === '\u0007' || value === '\u009c') return 'text';
    return value === '\u001b' ? 'control_string_escape' : 'control_string';
  },
  control_string_escape: value => {
    if (value === '\\' || value === '\u009c') return 'text';
    return value === '\u001b' ? 'control_string_escape' : 'control_string';
  },
};

function startEscapeSequence(value: string): EscapeSequenceState | undefined {
  if (value === '\u001b') return 'escape';
  if (value === '\u009b') return 'csi';
  if (C1_CONTROL_STRING_STARTS.has(value)) return 'control_string';
  return undefined;
}

function isUnsafeControlCharacter(value: string): boolean {
  const code = value.charCodeAt(0);
  return UNSAFE_CONTROL_RANGES.some(([start, end]) => code >= start && code <= end);
}

export function sanitizeTerminalChunk(session: TerminalSanitizerState, chunk: string): string {
  let sanitized = '';
  for (const value of chunk) {
    const state = session.escapeState;
    if (state !== 'text') {
      session.escapeState = ESCAPE_TRANSITIONS[state](value);
      continue;
    }
    const escapeState = startEscapeSequence(value);
    if (escapeState) {
      session.escapeState = escapeState;
      continue;
    }
    if (value === '\r') {
      sanitized += '\n';
      session.outputEndedWithCarriageReturn = true;
      continue;
    }
    if (value === '\n' && session.outputEndedWithCarriageReturn) {
      session.outputEndedWithCarriageReturn = false;
      continue;
    }
    session.outputEndedWithCarriageReturn = false;
    if (!isUnsafeControlCharacter(value)) sanitized += value;
  }
  return sanitized;
}
