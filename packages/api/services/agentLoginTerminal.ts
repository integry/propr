import { AGENT_LOGIN_TERMINAL } from './agentLoginDocker.js';

const MAX_CONTROL_STRING_LENGTH = 16 * 1024;
const MAX_ESCAPE_SEQUENCE_LENGTH = 64;
const MAX_EMITTED_TERMINAL_LINKS = 128;

export type TerminalEscapeState = 'text' | 'escape' | 'escape_intermediate' | 'csi'
  | 'control_string' | 'control_string_escape' | 'control_string_discard'
  | 'control_string_discard_escape';
type EscapeSequenceState = Exclude<TerminalEscapeState, 'text'>;

export interface TerminalSanitizerState {
  escapeState: TerminalEscapeState;
  controlStringKind?: string;
  controlStringBuffer: string;
  escapeSequenceLength?: number;
  emittedTerminalLinks: Set<string>;
  outputEndedWithCarriageReturn?: boolean;
}

const CONTROL_STRING_STARTS = new Set([']', 'P', 'X', '^', '_']);
const C1_CONTROL_STRING_STARTS = new Set(['\u0090', '\u0098', '\u009d', '\u009e', '\u009f']);
const CSI_FINAL_CHARACTER = /[\u0040-\u007e]/u;
const ESCAPE_INTERMEDIATE_CHARACTER = /[\u0020-\u002f]/u;
const UNSAFE_UNICODE_FORMAT_CHARACTER = /\p{Cf}/u;
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
  control_string_discard: value => {
    if (value === '\u0007' || value === '\u009c') return 'text';
    return value === '\u001b' ? 'control_string_discard_escape' : 'control_string_discard';
  },
  control_string_discard_escape: value => {
    if (value === '\\' || value === '\u009c') return 'text';
    return value === '\u001b' ? 'control_string_discard_escape' : 'control_string_discard';
  },
};

export function buildDockerAttachCommand(args: string[]): string {
  const shellQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;
  const dockerCommand = ['docker', ...args].map(shellQuote).join(' ');
  return `stty rows ${AGENT_LOGIN_TERMINAL.rows} cols ${AGENT_LOGIN_TERMINAL.columns}; exec ${dockerCommand}`;
}

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

function startControlString(session: TerminalSanitizerState, kind: string): void {
  session.controlStringKind = kind;
  session.controlStringBuffer = '';
  session.escapeSequenceLength = 0;
}

function appendControlString(
  session: TerminalSanitizerState,
  value: string,
  nextState: TerminalEscapeState,
): void {
  if (session.controlStringBuffer.length >= MAX_CONTROL_STRING_LENGTH) {
    session.controlStringKind = undefined;
    session.controlStringBuffer = '';
    session.escapeState = nextState === 'control_string_escape'
      ? 'control_string_discard_escape'
      : 'control_string_discard';
    return;
  }
  session.controlStringBuffer += value;
  session.escapeState = nextState;
}

function controlStringEscapeState(value: string): TerminalEscapeState {
  return value === '\u001b' ? 'control_string_escape' : 'control_string';
}

function advanceEscapeSequence(
  session: TerminalSanitizerState,
  state: EscapeSequenceState,
  value: string,
): void {
  if (state === 'control_string_discard' || state === 'control_string_discard_escape') {
    session.escapeState = ESCAPE_TRANSITIONS[state](value);
    if (session.escapeState === 'text') session.escapeSequenceLength = 0;
    return;
  }
  const length = (session.escapeSequenceLength ?? 0) + 1;
  if (length > MAX_ESCAPE_SEQUENCE_LENGTH) {
    session.escapeState = 'text';
    session.escapeSequenceLength = 0;
    return;
  }
  session.escapeState = ESCAPE_TRANSITIONS[state](value);
  session.escapeSequenceLength = session.escapeState === 'text' ? 0 : length;
}

function terminalLinkTarget(payload: string): string | undefined {
  if (!payload.startsWith('8;')) return undefined;
  const targetSeparator = payload.indexOf(';', 2);
  if (targetSeparator < 0) return undefined;
  const target = payload.slice(targetSeparator + 1);
  if (!target.startsWith('http://') && !target.startsWith('https://')) return undefined;
  if ([...target].some(value => {
    const code = value.charCodeAt(0);
    return code <= 0x20 || isUnsafeControlCharacter(value) || UNSAFE_UNICODE_FORMAT_CHARACTER.test(value);
  })) return undefined;
  try {
    const parsed = new URL(target);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;
    return parsed.href;
  } catch {
    return undefined;
  }
}

function finishControlString(session: TerminalSanitizerState): string {
  const kind = session.controlStringKind;
  const payload = session.controlStringBuffer;
  session.controlStringKind = undefined;
  session.controlStringBuffer = '';

  // OSC 8 hyperlinks carry the complete target separately from the rendered
  // label. Preserve one validated HTTP(S) target as plain text for linkifying.
  if (kind !== ']') return '';
  const target = terminalLinkTarget(payload);
  if (!target || session.emittedTerminalLinks.has(target)) return '';
  if (session.emittedTerminalLinks.size >= MAX_EMITTED_TERMINAL_LINKS) {
    const oldest = session.emittedTerminalLinks.values().next().value;
    if (oldest !== undefined) session.emittedTerminalLinks.delete(oldest);
  }
  session.emittedTerminalLinks.add(target);
  return `\n${target}\n`;
}

export function sanitizeTerminalChunk(session: TerminalSanitizerState, chunk: string): string {
  let sanitized = '';
  for (const value of chunk) {
    const state = session.escapeState;
    if (state !== 'text') {
      if (state === 'escape' && CONTROL_STRING_STARTS.has(value)) {
        startControlString(session, value);
        session.escapeState = 'control_string';
        continue;
      }
      if (state === 'control_string') {
        if (value === '\u0007' || value === '\u009c') {
          sanitized += finishControlString(session);
          session.escapeState = 'text';
        } else if (value === '\u001b') {
          session.escapeState = 'control_string_escape';
        } else {
          appendControlString(session, value, 'control_string');
        }
        continue;
      }
      if (state === 'control_string_escape') {
        if (value === '\\' || value === '\u009c') {
          sanitized += finishControlString(session);
          session.escapeState = 'text';
        } else {
          appendControlString(session, value, controlStringEscapeState(value));
        }
        continue;
      }
      advanceEscapeSequence(session, state, value);
      continue;
    }
    const escapeState = startEscapeSequence(value);
    if (escapeState) {
      if (escapeState === 'control_string') {
        startControlString(session, value === '\u009d' ? ']' : value);
      }
      session.escapeState = escapeState;
      session.escapeSequenceLength = escapeState === 'control_string' ? 0 : 1;
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
