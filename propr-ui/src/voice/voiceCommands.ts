import type {
  VoiceBriefingAction,
  VoiceBriefingItem,
  VoiceBriefingItemKind,
  VoiceBriefingResponse,
  VoiceBriefingScope,
} from '@propr/shared';

export const MAX_VOICE_FOLLOW_UP_INSTRUCTION_LENGTH = 1_000;

export type ParsedVoiceCommand =
  | { type: 'briefing'; scope: VoiceBriefingScope }
  | { type: 'repeat' }
  | { type: 'open'; item: VoiceBriefingItem }
  | {
    type: 'pending_action';
    action: 'stop';
    item: VoiceBriefingItem;
    requiresConfirmation: true;
  }
  | {
    type: 'pending_action';
    action: 'follow_up';
    item: VoiceBriefingItem;
    instruction: string;
    requiresConfirmation: true;
  }
  | { type: 'confirm' }
  | { type: 'cancel' }
  | { type: 'invalid'; reason: string };

export type VoiceCommandResult = ParsedVoiceCommand;

const SPOKEN_NUMBERS: Readonly<Record<string, number>> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
};

const SIMPLE_COMMANDS: Readonly<Record<string, ParsedVoiceCommand>> = {
  'catch me up': { type: 'briefing', scope: 'all' },
  'give me a briefing': { type: 'briefing', scope: 'all' },
  'brief me': { type: 'briefing', scope: 'all' },
  'what is running': { type: 'briefing', scope: 'running' },
  "what's running": { type: 'briefing', scope: 'running' },
  'running status': { type: 'briefing', scope: 'running' },
  'what needs attention': { type: 'briefing', scope: 'attention' },
  'what requires attention': { type: 'briefing', scope: 'attention' },
  'attention status': { type: 'briefing', scope: 'attention' },
  repeat: { type: 'repeat' },
  'repeat that': { type: 'repeat' },
  'repeat the briefing': { type: 'repeat' },
  'say that again': { type: 'repeat' },
  confirm: { type: 'confirm' },
  cancel: { type: 'cancel' },
  'never mind': { type: 'cancel' },
};

interface ParsedReference {
  kind: VoiceBriefingItemKind;
  position: number;
}

const REFERENCE_PATTERN = '(task|plan|system)\\s+([a-z]+|\\d+)';
const DIRECT_ACTION_PATTERN = new RegExp(`^(open|stop)\\s+${REFERENCE_PATTERN}[.!?]*$`, 'i');
const FOLLOW_UP_PATTERN = new RegExp(`^follow[\\s-]+up\\s+${REFERENCE_PATTERN}\\s+to\\s+(.+)$`, 'is');

function invalid(reason: string): ParsedVoiceCommand {
  return { type: 'invalid', reason };
}

function normalizeCommandText(transcript: string): string {
  return transcript
    .normalize('NFKC')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u2010-\u2015]/g, '-')
    .trim()
    .replace(/\s+/g, ' ')
    .trim();
}

function withoutLeadingCourtesy(text: string): string {
  return text.replace(/^please\s+/i, '');
}

function withoutCourtesy(text: string): string {
  return withoutLeadingCourtesy(text)
    .replace(/\s+please[.!?]*$/i, '');
}

function parsePosition(token: string): number | null {
  const spoken = SPOKEN_NUMBERS[token.toLowerCase()];
  if (spoken !== undefined) return spoken;
  if (!/^[1-9]\d*$/.test(token)) return null;
  const numeric = Number(token);
  return Number.isSafeInteger(numeric) ? numeric : null;
}

function parseReference(kind: string, positionToken: string): ParsedReference | null {
  const position = parsePosition(positionToken);
  if (position === null) return null;
  return { kind: kind.toLowerCase() as VoiceBriefingItemKind, position };
}

function resolveReference(
  reference: ParsedReference,
  briefing: VoiceBriefingResponse | null | undefined,
): VoiceBriefingItem | ParsedVoiceCommand {
  if (!briefing) {
    return invalid('Get a briefing first so the reference can be resolved.');
  }

  const matches = briefing.items.filter(item => (
    item.kind === reference.kind && item.position === reference.position
  ));
  if (matches.length === 0) {
    return invalid(
      `${reference.kind} ${reference.position} is not in the latest briefing.`,
    );
  }
  if (matches.length > 1) {
    return invalid(
      `${reference.kind} ${reference.position} is ambiguous in the latest briefing.`,
    );
  }
  return matches[0];
}

function resolvedItem(
  reference: ParsedReference | null,
  briefing: VoiceBriefingResponse | null | undefined,
): VoiceBriefingItem | ParsedVoiceCommand {
  if (!reference) {
    return invalid('Use a numeric reference or a spoken number from one through ten.');
  }
  return resolveReference(reference, briefing);
}

function isInvalid(value: VoiceBriefingItem | ParsedVoiceCommand): value is ParsedVoiceCommand {
  return 'type' in value && value.type === 'invalid';
}

function unavailableAction(item: VoiceBriefingItem, action: VoiceBriefingAction): ParsedVoiceCommand {
  const actionName = action === 'follow_up' ? 'follow-up' : action;
  return invalid(`${item.reference} does not advertise the ${actionName} action.`);
}

function parseDirectAction(
  text: string,
  briefing: VoiceBriefingResponse | null | undefined,
): ParsedVoiceCommand | null {
  const match = DIRECT_ACTION_PATTERN.exec(text);
  if (!match) return null;

  const command = match[1].toLowerCase() as 'open' | 'stop';
  const item = resolvedItem(parseReference(match[2], match[3]), briefing);
  if (isInvalid(item)) return item;
  if (!item.actions.includes(command)) return unavailableAction(item, command);

  if (command === 'open') return { type: 'open', item };
  return {
    type: 'pending_action',
    action: 'stop',
    item,
    requiresConfirmation: true,
  };
}

function normalizedInstruction(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

const URL_SCHEME_PATTERN = /\b[a-z][a-z\d+.-]*:\S+/i;
const NETWORK_PATH_PATTERN = /(?:^|[\s"'(\[{<=>])\/\/\S+/i;
const ROOT_RELATIVE_PATH_PATTERN = /(?:^|[\s"'(\[{<=>:])\/(?![\/\s])\S+/i;
const URL_DOT_SEPARATOR_PATTERN = /[\u3002\uFF0E\uFF61]/g;
const BARE_HOST_PATTERN = new RegExp(
  '(?:^|[^@\\w.-])'
    + '(?:[a-z\\d](?:[a-z\\d-]{0,61}[a-z\\d])?\\.)+'
    + '[a-z]{2,63}(?::\\d{1,5})?(?:[/?#]\\S*)?',
  'i',
);
const NETWORK_HOST_PATTERN = new RegExp(
  '(?:^|[^@\\w.-])(?:'
    + 'localhost(?::\\d{1,5})?(?:[/?#]\\S*)?'
    + '|[a-z\\d](?:[a-z\\d-]{0,61}[a-z\\d])?:\\d{1,5}(?:[/?#]\\S*)?'
    + ')',
  'i',
);
function isIpLiteral(value: string): boolean {
  const ipv4Parts = value.split('.');
  const isLegacyIpv4Candidate = ipv4Parts.length > 1
    || /^0x/i.test(value)
    || (/^\d+$/.test(value) && Number(value) > 0xFF_FF_FF);
  if (
    isLegacyIpv4Candidate
    && /^(?:0x[\da-f]+|\d+)(?:\.(?:0x[\da-f]+|\d+)){0,3}$/i.test(value)
  ) {
    try {
      // URL normalizes valid decimal, octal, hexadecimal, and 1-4 component IPv4.
      return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(new URL(`http://${value}/`).hostname);
    } catch {
      return false;
    }
  }

  if (!value.includes(':')) return false;
  try {
    // URL provides the same deterministic IPv6 validation in browsers and tests.
    return new URL(`http://[${value}]/`).hostname.length > 0;
  } catch {
    return false;
  }
}

function containsAuthorityEndpoint(value: string): boolean {
  return value.split(/\s+/).some(rawToken => {
    const token = rawToken
      .replace(/^["'({<=>]+/, '')
      .replace(/["')}>.,!?;]+$/, '');

    if (token.startsWith('[')) {
      const closingBracket = token.indexOf(']');
      if (closingBracket < 0) return false;
      const suffix = token.slice(closingBracket + 1);
      if (!/^(?::\d{1,5})?(?:[/?#]\S*)?$/.test(suffix)) return false;
      return isIpLiteral(token.slice(1, closingBracket));
    }

    const authority = token.split(/[/?#]/, 1)[0];
    if (isIpLiteral(authority)) return true;

    // A lone trailing colon is prose punctuation, not an authority or port.
    if (/^[^:]+:$/.test(token)) return false;

    const isBareInternationalizedHost = token.includes('.') && /[^\x00-\x7F]/.test(token);
    if (!/[:/?#]/.test(token) && !isBareInternationalizedHost) return false;
    try {
      // Requiring endpoint punctuation or a dotted internationalized candidate
      // keeps ordinary words out while URL validates and converts IDNA hosts.
      return new URL(`http://${token}`).hostname.length > 0;
    } catch {
      // Bare IPv6 literals require brackets in URLs and were checked above.
      return false;
    }
  });
}

function containsEndpoint(value: string): boolean {
  const normalizedValue = value.replace(URL_DOT_SEPARATOR_PATTERN, '.');
  return URL_SCHEME_PATTERN.test(normalizedValue)
    || NETWORK_PATH_PATTERN.test(normalizedValue)
    || ROOT_RELATIVE_PATH_PATTERN.test(normalizedValue)
    || BARE_HOST_PATTERN.test(normalizedValue)
    || NETWORK_HOST_PATTERN.test(normalizedValue)
    || containsAuthorityEndpoint(normalizedValue);
}

function parseFollowUp(
  text: string,
  briefing: VoiceBriefingResponse | null | undefined,
): ParsedVoiceCommand | null {
  const match = FOLLOW_UP_PATTERN.exec(text);
  if (!match) return null;

  const instruction = normalizedInstruction(match[3]);
  if (!instruction) return invalid('A follow-up instruction is required.');
  if (instruction.length > MAX_VOICE_FOLLOW_UP_INSTRUCTION_LENGTH) {
    return invalid(
      'Follow-up instructions must be 1,000 characters or fewer.',
    );
  }
  if (containsEndpoint(instruction)) {
    return invalid('Voice follow-up instructions cannot contain a URL or API endpoint.');
  }

  const item = resolvedItem(parseReference(match[1], match[2]), briefing);
  if (isInvalid(item)) return item;
  if (!item.actions.includes('follow_up')) return unavailableAction(item, 'follow_up');

  return {
    type: 'pending_action',
    action: 'follow_up',
    item,
    instruction,
    requiresConfirmation: true,
  };
}

function malformedActionReason(text: string): string | null {
  if (/^(?:open|stop)\b/i.test(text)) {
    return 'Say open or stop followed by task, plan, or system and its number.';
  }
  if (/^follow[\s-]+up\b/i.test(text)) {
    return 'Say follow up, a task, plan, or system number, then “to” and the instruction.';
  }
  return null;
}

/**
 * Parse one recognized transcript against the latest validated briefing.
 *
 * The result is data only. In particular, stop and follow-up are inert pending
 * actions that a separate confirmation flow must approve and execute.
 */
export function parseVoiceCommand(
  transcript: string,
  latestBriefing?: VoiceBriefingResponse | null,
): ParsedVoiceCommand {
  if (typeof transcript !== 'string') return invalid('The voice transcript is invalid.');

  const normalizedText = normalizeCommandText(transcript);
  const followUp = parseFollowUp(withoutLeadingCourtesy(normalizedText), latestBriefing);
  if (followUp) return followUp;

  const text = withoutCourtesy(normalizedText);
  if (!text) return invalid('No voice command was recognized.');

  const simpleText = text.replace(/[.!?]+$/, '').trim().toLowerCase();
  if (Object.prototype.hasOwnProperty.call(SIMPLE_COMMANDS, simpleText)) {
    return SIMPLE_COMMANDS[simpleText];
  }

  const directAction = parseDirectAction(text, latestBriefing);
  if (directAction) return directAction;

  return invalid(
    malformedActionReason(text)
      ?? 'That voice command is not recognized. Try catch me up, repeat, open, stop, or follow up.',
  );
}
