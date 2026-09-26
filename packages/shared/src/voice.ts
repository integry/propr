import {
  parseISO8601Timestamp,
  type ISO8601Timestamp,
} from './notifications.js';

/** Briefing filters supported by the on-demand voice experience. */
export const VOICE_BRIEFING_SCOPES = ['all', 'running', 'attention'] as const;
export type VoiceBriefingScope = (typeof VOICE_BRIEFING_SCOPES)[number];

/** Closed set of structured entries that may appear in a briefing. */
export const VOICE_BRIEFING_ITEM_KINDS = ['task', 'plan', 'system'] as const;
export type VoiceBriefingItemKind = (typeof VOICE_BRIEFING_ITEM_KINDS)[number];

/** Actions the browser may resolve without interpreting briefing prose. */
export const VOICE_BRIEFING_ACTIONS = ['open', 'stop', 'follow_up'] as const;
export type VoiceBriefingAction = (typeof VOICE_BRIEFING_ACTIONS)[number];

/** Maximum number of prioritized entries included in a short briefing. */
export const VOICE_BRIEFING_MAX_ITEMS = 8;

export interface VoiceBriefingItem {
  /** Human-speakable stable reference within this response, such as task 2. */
  reference: string;
  position: number;
  kind: VoiceBriefingItemKind;
  id: string;
  title: string;
  repository: string | null;
  status: string;
  summary: string;
  href: string;
  requiresAttention: boolean;
  actions: VoiceBriefingAction[];
  updatedAt: ISO8601Timestamp;
}

/** Aggregate snapshot counts, including entries omitted from the visible items. */
export interface VoiceBriefingCounts {
  running: number;
  queued: number;
  attention: number;
  plans: number;
  total: number;
}

export interface VoiceBriefingResponse {
  generatedAt: ISO8601Timestamp;
  scope: VoiceBriefingScope;
  headline: string;
  /** Text intended for browser speech synthesis as well as visual fallback. */
  speechText: string;
  counts: VoiceBriefingCounts;
  /** A prioritized, bounded subset; counts still describe the complete snapshot. */
  items: VoiceBriefingItem[];
}

/**
 * The MVP is a short browser-initiated request, not a streaming audio service.
 * These literal values make that product and privacy boundary explicit.
 */
export interface VoiceCapabilitiesResponse {
  mode: 'on_demand';
  serverAudio: false;
  persistentSession: false;
  rawAudioAccepted: false;
  transcriptStored: false;
}

/** Minimal runtime-schema surface shared by API and browser consumers. */
export interface RuntimeVoiceSchema<T> {
  parse(value: unknown): T;
}

function invalid(path: string, expectation: string): never {
  throw new TypeError(`${path}: expected ${expectation}`);
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (
    typeof value !== 'object'
    || value === null
    || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype
      && Object.getPrototypeOf(value) !== null)
  ) {
    return invalid(path, 'an object');
  }
  return value as Record<string, unknown>;
}

function assertOnlyKnownProperties(
  value: Record<string, unknown>,
  allowedProperties: readonly string[],
  path: string,
): void {
  const allowed = new Set(allowedProperties);
  const unknownProperty = Object.keys(value).find(property => !allowed.has(property));
  if (unknownProperty !== undefined) {
    invalid(`${path}.${unknownProperty}`, 'a known property');
  }
}

function stringValue(value: unknown, path: string, maximum: number): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maximum) {
    return invalid(path, `a non-empty string no longer than ${maximum} characters`);
  }
  return value;
}

function nonnegativeInteger(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    return invalid(path, 'a nonnegative safe integer');
  }
  return Number(value);
}

function positiveInteger(value: unknown, path: string): number {
  const parsed = nonnegativeInteger(value, path);
  return parsed > 0 ? parsed : invalid(path, 'a positive safe integer');
}

function enumValue<T extends readonly string[]>(
  value: unknown,
  choices: T,
  path: string,
): T[number] {
  if (typeof value !== 'string' || !choices.includes(value)) {
    return invalid(path, `one of ${choices.join(', ')}`);
  }
  return value as T[number];
}

function nullableRepository(value: unknown, path: string): string | null {
  if (value === null) return null;
  const repository = stringValue(value, path, 255);
  return /^[^/\s]+\/[^/\s]+$/.test(repository)
    ? repository
    : invalid(path, 'a repository in owner/name form or null');
}

function safeApplicationPath(value: unknown, path: string): string {
  const href = stringValue(value, path, 2_048);
  const hasControlCharacter = [...href].some(character => character.charCodeAt(0) < 32);
  if (!href.startsWith('/') || href.startsWith('//') || href.includes('\\') || hasControlCharacter) {
    return invalid(path, 'a safe same-origin application path');
  }
  return href;
}

function timestampValue(value: unknown, path: string): ISO8601Timestamp {
  try {
    return parseISO8601Timestamp(value);
  } catch {
    return invalid(path, 'a canonical ISO-8601 UTC timestamp');
  }
}

/** Parse a request scope, defaulting an omitted scope to the complete snapshot. */
export function parseVoiceBriefingScope(value: unknown): VoiceBriefingScope {
  return value === undefined
    ? 'all'
    : enumValue(value, VOICE_BRIEFING_SCOPES, 'voiceBriefing.scope');
}

export function parseVoiceBriefingItem(value: unknown): VoiceBriefingItem {
  const item = record(value, 'voiceBriefing.item');
  assertOnlyKnownProperties(item, [
    'reference',
    'position',
    'kind',
    'id',
    'title',
    'repository',
    'status',
    'summary',
    'href',
    'requiresAttention',
    'actions',
    'updatedAt',
  ], 'voiceBriefing.item');

  const kind = enumValue(item.kind, VOICE_BRIEFING_ITEM_KINDS, 'voiceBriefing.item.kind');
  const position = positiveInteger(item.position, 'voiceBriefing.item.position');
  const actionsValue = item.actions;
  if (!Array.isArray(actionsValue)) {
    return invalid('voiceBriefing.item.actions', 'an array');
  }
  const actions = actionsValue.map((action, index) => enumValue(
    action,
    VOICE_BRIEFING_ACTIONS,
    `voiceBriefing.item.actions[${index}]`,
  ));
  if (new Set(actions).size !== actions.length) {
    return invalid('voiceBriefing.item.actions', 'unique actions');
  }

  const reference = stringValue(item.reference, 'voiceBriefing.item.reference', 40);
  // A predictable spoken reference lets follow-up commands resolve structured
  // entries without parsing generated prose or locale-sensitive titles.
  if (reference !== `${kind} ${position}`) {
    return invalid('voiceBriefing.item.reference', `${kind} ${position}`);
  }

  return {
    reference,
    position,
    kind,
    id: stringValue(item.id, 'voiceBriefing.item.id', 255),
    title: stringValue(item.title, 'voiceBriefing.item.title', 160),
    repository: nullableRepository(item.repository, 'voiceBriefing.item.repository'),
    status: stringValue(item.status, 'voiceBriefing.item.status', 80),
    summary: stringValue(item.summary, 'voiceBriefing.item.summary', 320),
    href: safeApplicationPath(item.href, 'voiceBriefing.item.href'),
    requiresAttention: typeof item.requiresAttention === 'boolean'
      ? item.requiresAttention
      : invalid('voiceBriefing.item.requiresAttention', 'a boolean'),
    actions,
    updatedAt: timestampValue(item.updatedAt, 'voiceBriefing.item.updatedAt'),
  };
}

export function parseVoiceBriefingResponse(value: unknown): VoiceBriefingResponse {
  const response = record(value, 'voiceBriefing');
  assertOnlyKnownProperties(response, [
    'generatedAt',
    'scope',
    'headline',
    'speechText',
    'counts',
    'items',
  ], 'voiceBriefing');

  const countsValue = record(response.counts, 'voiceBriefing.counts');
  assertOnlyKnownProperties(countsValue, [
    'running',
    'queued',
    'attention',
    'plans',
    'total',
  ], 'voiceBriefing.counts');

  if (!Array.isArray(response.items)) {
    return invalid('voiceBriefing.items', 'an array');
  }
  if (response.items.length > VOICE_BRIEFING_MAX_ITEMS) {
    return invalid(
      'voiceBriefing.items',
      `an array with at most ${VOICE_BRIEFING_MAX_ITEMS} entries`,
    );
  }

  const counts: VoiceBriefingCounts = {
    running: nonnegativeInteger(countsValue.running, 'voiceBriefing.counts.running'),
    queued: nonnegativeInteger(countsValue.queued, 'voiceBriefing.counts.queued'),
    attention: nonnegativeInteger(countsValue.attention, 'voiceBriefing.counts.attention'),
    plans: nonnegativeInteger(countsValue.plans, 'voiceBriefing.counts.plans'),
    total: nonnegativeInteger(countsValue.total, 'voiceBriefing.counts.total'),
  };
  const items = response.items.map(parseVoiceBriefingItem);
  const references = new Set<string>();
  const kindPositions = new Set<string>();
  items.forEach((item, index) => {
    const kindPosition = `${item.kind}:${item.position}`;
    if (references.has(item.reference)) {
      invalid(
        `voiceBriefing.items[${index}].reference`,
        'a unique spoken reference within the response',
      );
    }
    if (kindPositions.has(kindPosition)) {
      invalid(
        `voiceBriefing.items[${index}]`,
        'a unique kind and position pair within the response',
      );
    }
    references.add(item.reference);
    kindPositions.add(kindPosition);
  });
  if (counts.total < items.length) {
    return invalid(
      'voiceBriefing.counts.total',
      'a count at least as large as the visible item count',
    );
  }
  if (
    counts.total < counts.running
    || counts.total < counts.queued
    || counts.total < counts.attention
    || counts.total < counts.plans
  ) {
    return invalid(
      'voiceBriefing.counts.total',
      'a count at least as large as each constituent aggregate count',
    );
  }

  return {
    generatedAt: timestampValue(response.generatedAt, 'voiceBriefing.generatedAt'),
    scope: enumValue(response.scope, VOICE_BRIEFING_SCOPES, 'voiceBriefing.scope'),
    headline: stringValue(response.headline, 'voiceBriefing.headline', 500),
    speechText: stringValue(response.speechText, 'voiceBriefing.speechText', 4_000),
    counts,
    items,
  };
}

export function parseVoiceCapabilitiesResponse(value: unknown): VoiceCapabilitiesResponse {
  const response = record(value, 'voiceCapabilities');
  assertOnlyKnownProperties(response, [
    'mode',
    'serverAudio',
    'persistentSession',
    'rawAudioAccepted',
    'transcriptStored',
  ], 'voiceCapabilities');

  if (
    response.mode !== 'on_demand'
    || response.serverAudio !== false
    || response.persistentSession !== false
    || response.rawAudioAccepted !== false
    || response.transcriptStored !== false
  ) {
    return invalid(
      'voiceCapabilities',
      'the supported on-demand, browser-audio capability contract',
    );
  }
  return {
    mode: 'on_demand',
    serverAudio: false,
    persistentSession: false,
    rawAudioAccepted: false,
    transcriptStored: false,
  };
}

export const voiceBriefingResponseSchema: RuntimeVoiceSchema<VoiceBriefingResponse> = {
  parse: parseVoiceBriefingResponse,
};

export const voiceCapabilitiesResponseSchema: RuntimeVoiceSchema<VoiceCapabilitiesResponse> = {
  parse: parseVoiceCapabilitiesResponse,
};
