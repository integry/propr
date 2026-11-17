import { z } from 'zod';
import { PLUGIN_MANIFEST_VERSION, pluginManifestSchema } from './plugins.js';
import * as pluginSdk from './pluginSdk.js';
import type {
  PluginCommandInput, PluginContext, PluginEventInput, PluginInvokeInput, PluginLogger, PluginSettingOptionsInput, PluginStateStore, PluginWebhookInput,
} from './pluginSdk.js';
import {
  REPOSITORY_EVENT_TYPES, type EpicQueueAdvancedEventPayload, type EpicQueueBlockedEventPayload, type PlanIssueStatusChangedEventPayload, type RepositoryEvent,
  type ReviewScoredEventPayload, type TaskEventPayload, type TaskTerminalEventPayload, type UltrafixEndedEventPayload,
  type UltrafixStartedEventPayload,
} from './repositoryEvents.js';

/**
 * The plugin interface as data, so its compatibility can be checked.
 *
 * Three parts of the interface must stay compatible for plugins already
 * written against them:
 *
 * - **The manifest.** Additive changes keep `manifestVersion`. A breaking
 *   change (a field removed, retyped, made required, restricted to an enum,
 *   an enum value dropped, or a length, entry-count or value limit added or
 *   tightened) needs a new `manifestVersion`, and ProPR keeps reading the old
 *   version for at least one minor release (`PLUGIN_SUPPORTED_MANIFEST_VERSIONS`).
 * - **Event payloads.** Additive only within a domain: a payload key is never
 *   removed or retyped, a literal value a field takes (`source: 'review'`) is
 *   never removed or replaced, an event type is never removed.
 * - **The handler SDK.** `ctx` members, `ctx.propr` operations (and the
 *   permission each needs), `ctx.state` and `ctx.log` methods, input envelope
 *   fields, error codes and the runtime exports of the SDK module are
 *   additive only. An object plugins pass in gains optional members only.
 *
 * `buildPluginContract()` describes the current interface. The shared
 * package's contract test reads the TypeScript sources with the compiler
 * (`packages/shared/test/support/pluginContractSource.ts`): it checks the
 * payload and envelope descriptors below against the real field types, and
 * adds the declared type of every SDK member (`sdk.types`: `ctx` members,
 * `ctx.state` and `ctx.propr` parameters and results, input envelope fields
 * and the shared types they reach). It compares that with the committed snapshot
 * (`packages/shared/test/contracts/plugin-contract.snapshot.json`) using
 * `comparePluginContract()`, and fails on any breaking change.
 */

/** Manifest versions ProPR reads. A new version is appended; an old one stays for at least one minor release. */
export const PLUGIN_SUPPORTED_MANIFEST_VERSIONS: readonly number[] = [PLUGIN_MANIFEST_VERSION];

/**
 * Payload fields of each journal event, as `key: type`. A key ending in `?`
 * may be absent. Types are `string`, `number`, `boolean`, `string[]`,
 * `number[]`, each optionally `| null`; a literal type is written as its
 * primitive (`source: 'review' | 'ultrafix'` as `string`). Keep this in step
 * with the payload interfaces of `repositoryEvents.ts`: the type checks below
 * compare the keys, and the shared package's contract test compares each type
 * with the field's declared type. The snapshot it checks records the literal
 * values too, read from the interfaces.
 */
export const PLUGIN_EVENT_PAYLOAD_FIELDS = {
  'pull_request.opened': { baseRef: 'string | null', draft: 'boolean' },
  'pull_request.head_changed': { previousHeadSha: 'string | null' },
  'pull_request.review_scored': { score: 'number', goal: 'number | null', goalReached: 'boolean | null', source: 'string', cycle: 'number | null', reviewerModel: 'string | null' },
  'pull_request.ultrafix_started': { goal: 'number', maxCycles: 'number', workEpoch: 'number' },
  'pull_request.ultrafix_ended': { outcome: 'string', finalScore: 'number | null', reason: 'string | null', workEpoch: 'number' },
  'pull_request.auto_merge_decision': {
    reason: 'string', arm: 'boolean', opportunity: 'string', prNumber: 'number', 'action?': 'string', 'matchedPaths?': 'string[]', 'method?': 'string',
    'detail?': 'string', 'headSha?': 'string', 'baseRef?': 'string', 'policyPath?': 'string', 'baseSha?': 'string',
  },
  'pull_request.merged': {},
  'pull_request.closed': {},
  'epic_queue.started': { issues: 'number[]', advanceOn: 'string', parallel: 'boolean' },
  'epic_queue.advanced': { fromIssue: 'number', toIssue: 'number', cursor: 'number' },
  'epic_queue.blocked': { headIssue: 'number | null', blockedReason: 'string' },
  'epic_queue.completed': { 'fromIssue?': 'number', cursor: 'number' },
  'plan_issue.status_changed': { from: 'string | null', to: 'string' },
  'task.queued': { taskId: 'string', kind: 'string', issueNumber: 'number | null', prNumber: 'number | null', agent: 'string | null', model: 'string | null', attempts: 'number' },
  'task.started': { taskId: 'string', kind: 'string', issueNumber: 'number | null', prNumber: 'number | null', agent: 'string | null', model: 'string | null', attempts: 'number' },
  'task.completed': taskTerminalFields(),
  'task.failed': taskTerminalFields(),
  'task.cancelled': taskTerminalFields(),
} as const satisfies Record<string, Record<string, string>>;

function taskTerminalFields() {
  return {
    taskId: 'string', kind: 'string', issueNumber: 'number | null', prNumber: 'number | null', agent: 'string | null', model: 'string | null', attempts: 'number',
    status: 'string', terminalReason: 'string | null', durationMs: 'number | null', pullRequest: 'string | null', failureCategory: 'string | null',
  } as const;
}

/** The fields of the journal event every event handler receives (`input.event`). */
export const PLUGIN_EVENT_ENVELOPE_FIELDS = {
  seq: 'number', repository: 'string', domain: 'string', type: 'string', entityId: 'string', prNumber: 'number | null', issueNumber: 'number | null',
  planId: 'string | null', headSha: 'string | null', payload: 'object', occurredAt: 'string',
} as const;

/** The handler SDK surface. Lists are sorted where order carries no meaning. */
export const PLUGIN_SDK_CONTEXT_MEMBERS = ['pluginId', 'settings', 'repositories', 'propr', 'http', 'state', 'log', 'signal'] as const;
export const PLUGIN_SDK_STATE_METHODS = ['get', 'set', 'delete', 'update', 'keys'] as const;
export const PLUGIN_SDK_LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
/** Fields of each handler input envelope, by `kind`; `?` marks an optional field. */
export const PLUGIN_SDK_INPUT_FIELDS = {
  event: ['kind', 'event', 'deliveryId', 'attempt', 'manual?'],
  webhook: ['kind', 'webhook', 'headers', 'body', 'receivedAt', 'deliveryId', 'attempt'],
  command: ['kind', 'command', 'args', 'repository', 'number', 'target', 'actor', 'commentId', 'deliveryId', 'attempt'],
  invoke: ['kind', 'payload'],
  setting_options: ['kind', 'setting'],
} as const;

// Compile-time checks: the lists above name exactly the members of the SDK and payload types.
type FieldKey<T> = { [K in keyof T & string]-?: object extends Pick<T, K> ? `${K}?` : K }[keyof T & string];
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const assertExact = <T extends true>(): T | undefined => undefined;
type Payloads = typeof PLUGIN_EVENT_PAYLOAD_FIELDS;
type PayloadKeys<E extends keyof Payloads> = keyof Payloads[E] & string;
assertExact<Exact<FieldKey<PluginContext>, typeof PLUGIN_SDK_CONTEXT_MEMBERS[number]>>();
assertExact<Exact<keyof PluginStateStore, typeof PLUGIN_SDK_STATE_METHODS[number]>>();
assertExact<Exact<keyof PluginLogger, typeof PLUGIN_SDK_LOG_LEVELS[number]>>();
assertExact<Exact<FieldKey<PluginEventInput>, typeof PLUGIN_SDK_INPUT_FIELDS.event[number]>>();
assertExact<Exact<FieldKey<PluginWebhookInput>, typeof PLUGIN_SDK_INPUT_FIELDS.webhook[number]>>();
assertExact<Exact<FieldKey<PluginCommandInput>, typeof PLUGIN_SDK_INPUT_FIELDS.command[number]>>();
assertExact<Exact<FieldKey<PluginInvokeInput>, typeof PLUGIN_SDK_INPUT_FIELDS.invoke[number]>>();
assertExact<Exact<FieldKey<PluginSettingOptionsInput>, typeof PLUGIN_SDK_INPUT_FIELDS.setting_options[number]>>();
assertExact<Exact<keyof RepositoryEvent, keyof typeof PLUGIN_EVENT_ENVELOPE_FIELDS>>();
assertExact<Exact<FieldKey<ReviewScoredEventPayload>, PayloadKeys<'pull_request.review_scored'>>>();
assertExact<Exact<FieldKey<UltrafixStartedEventPayload>, PayloadKeys<'pull_request.ultrafix_started'>>>();
assertExact<Exact<FieldKey<UltrafixEndedEventPayload>, PayloadKeys<'pull_request.ultrafix_ended'>>>();
assertExact<Exact<FieldKey<EpicQueueAdvancedEventPayload>, PayloadKeys<'epic_queue.advanced'>>>();
assertExact<Exact<FieldKey<EpicQueueBlockedEventPayload>, PayloadKeys<'epic_queue.blocked'>>>();
assertExact<Exact<FieldKey<PlanIssueStatusChangedEventPayload>, PayloadKeys<'plan_issue.status_changed'>>>();
assertExact<Exact<FieldKey<TaskEventPayload>, PayloadKeys<'task.queued'>>>();
assertExact<Exact<FieldKey<TaskTerminalEventPayload>, PayloadKeys<'task.completed'>>>();

/** One manifest field: its JSON type, whether it must be present, its allowed values when it is an enum, and its limits. */
export interface PluginManifestContractField {
  type: string; required: boolean; enum?: (string | number | boolean)[];
  /**
   * Length, entry-count and value limits by JSON Schema keyword (`minLength`, `maxLength`, `minItems`, `maxItems`,
   * `minimum` or `exclusiveMinimum`, `maximum` or `exclusiveMaximum`). `items.` prefixes a limit on a list's entries,
   * as in `items.maxLength`. Where variants of a union disagree, the loosest limit any of them allows.
   */
  bounds?: Record<string, number>;
}
export interface PluginContract {
  manifestVersion: number;
  /** Manifest fields by path: `.` between properties, `[]` for list items, `<key>` for map values, `{type=token}` for one variant of a union. */
  manifest: Record<string, PluginManifestContractField>;
  events: { envelope: Record<string, string>; payloads: Record<string, Record<string, string>> };
  sdk: {
    context: string[];
    propr: Record<string, string>;
    state: string[];
    log: string[];
    inputs: Record<string, string[]>;
    errorCodes: string[];
    /** Runtime exports of the SDK module (`@propr/shared`'s `pluginSdk`). */
    exports: string[];
    /**
     * Declared types of the SDK, read from the sources by the contract test:
     * `Interface.member` (`?` when optional) or a type alias's name → its type
     * text, e.g. `PluginStateStore.get` → `(key: string) => Promise<…>`; an
     * exported function as `name()` → its signature, and an exported class as
     * `Class.constructor`, `Class.member` and `Class extends`.
     * Absent from `buildPluginContract()`, which runs without the compiler.
     */
    types?: Record<string, string>;
    /**
     * The interfaces in `types` that plugins supply rather than receive: the
     * ones reached through a parameter, such as `PluginListEventsInput` of
     * `ctx.propr.listEvents`. A new required member of one breaks the plugins
     * that already build it. Absent from `buildPluginContract()`, like `types`.
     */
    suppliedTypes?: string[];
  };
}

type JsonSchema = {
  type?: string | string[]; const?: unknown; enum?: unknown[]; properties?: Record<string, JsonSchema>; required?: string[];
  items?: JsonSchema; additionalProperties?: JsonSchema | boolean; oneOf?: JsonSchema[]; anyOf?: JsonSchema[]; allOf?: JsonSchema[];
  default?: unknown; [key: string]: unknown;
};

/** The manifest's JSON Schema, as authors write it (the input side: defaults make fields optional). */
export function pluginManifestJsonSchema(): JsonSchema {
  return z.toJSONSchema(pluginManifestSchema, { io: 'input', unrepresentable: 'any', target: 'draft-2020-12' }) as JsonSchema;
}

/** The discriminator of a union: the property every variant fixes with `const`. */
export function jsonSchemaDiscriminator(variants: JsonSchema[]): string | null {
  const first = variants[0]?.properties ?? {};
  return Object.keys(first).find(key => variants.every(v => v.properties?.[key] && 'const' in (v.properties[key] as object))) ?? null;
}

/** A short type name of a JSON Schema node. */
export function jsonSchemaTypeName(node: JsonSchema): string {
  return [...new Set(typeNames(node))].join(' | ');
}

function typeNames(node: JsonSchema): string[] {
  if ('const' in node) return [JSON.stringify(node.const)];
  const variants = node.oneOf ?? node.anyOf;
  if (variants) return variants.flatMap(typeNames);
  if (node.type === 'array') {
    const inner = node.items ? jsonSchemaTypeName(node.items) : 'unknown';
    return [inner.includes(' | ') ? `(${inner})[]` : `${inner}[]`];
  }
  if (Array.isArray(node.type)) return node.type;
  if (node.type === 'object' && node.additionalProperties && typeof node.additionalProperties === 'object' && !node.properties) return ['map'];
  return [node.type ?? 'unknown'];
}

/** Every manifest field by path, in schema order, with the node it comes from. */
export function walkPluginManifestSchema(schema: JsonSchema = pluginManifestJsonSchema()): { path: string; node: JsonSchema; required: boolean }[] {
  const rows: { path: string; node: JsonSchema; required: boolean }[] = [];
  const visit = (node: JsonSchema, path: string) => {
    const variants = node.oneOf ?? node.anyOf;
    if (variants) {
      const key = jsonSchemaDiscriminator(variants);
      if (key) {
        for (const variant of variants) visitObject(variant, `${path}{${key}=${String((variant.properties![key] as JsonSchema).const)}}`);
        return;
      }
    }
    if (node.type === 'array' && node.items) return visit(node.items, `${path}[]`);
    if (node.type === 'object') visitObject(node, path);
  };
  const visitObject = (node: JsonSchema, path: string) => {
    for (const [key, child] of Object.entries(node.properties ?? {})) {
      const at = path ? `${path}.${key}` : key;
      rows.push({ path: at, node: child, required: (node.required ?? []).includes(key) });
      visit(child, at);
    }
    if (node.additionalProperties && typeof node.additionalProperties === 'object') {
      const at = `${path}.<key>`;
      rows.push({ path: at, node: node.additionalProperties, required: false });
      visit(node.additionalProperties, at);
    }
  };
  visit(schema, '');
  return rows;
}

function enumOf(node: JsonSchema): (string | number | boolean)[] | undefined {
  const values = node.enum ?? (node.type === 'array' ? node.items?.enum : undefined);
  return values ? (values as (string | number | boolean)[]) : undefined;
}

type LimitSide = 'lower' | 'upper';
interface LimitKind { types: string[]; keywords: Record<LimitSide, string>; exclusive?: Record<LimitSide, string> }
/**
 * The limits a manifest field can have, by kind and the JSON types they apply to. Each kind has a lower and an upper
 * side; `exclusive` names the keyword that excludes the limit itself.
 */
const LIMIT_KINDS: Record<string, LimitKind> = {
  length: { types: ['string'], keywords: { lower: 'minLength', upper: 'maxLength' } },
  'entry count': { types: ['array'], keywords: { lower: 'minItems', upper: 'maxItems' } },
  value: { types: ['number', 'integer'], keywords: { lower: 'minimum', upper: 'maximum' }, exclusive: { lower: 'exclusiveMinimum', upper: 'exclusiveMaximum' } },
};
const SIDES: LimitSide[] = ['lower', 'upper'];
interface Limit { value: number; exclusive: boolean }
/** A field's limits by `<items. prefix><kind>`: a kind is present when the field takes values of it, a side when it is limited. */
type Limits = Map<string, Partial<Record<LimitSide, Limit>>>;
/** What each recorded keyword limits. */
const LIMIT_KEYWORDS = new Map<string, { kind: string; side: LimitSide; exclusive: boolean }>();
for (const [kind, { keywords, exclusive }] of Object.entries(LIMIT_KINDS)) {
  for (const side of SIDES) {
    LIMIT_KEYWORDS.set(keywords[side], { kind, side, exclusive: false });
    if (exclusive) LIMIT_KEYWORDS.set(exclusive[side], { kind, side, exclusive: true });
  }
}

/** Whether limit `a` accepts fewer values than `b` (no limit accepts every value). */
function stricter(side: LimitSide, a: Limit | undefined, b: Limit | undefined): boolean {
  if (!a) return false;
  if (!b) return true;
  if (a.value !== b.value) return side === 'lower' ? a.value > b.value : a.value < b.value;
  return a.exclusive && !b.exclusive;
}

/** Add a recorded limit; JSON Schema applies both keywords of a side (`minimum` and `exclusiveMinimum`), so the stricter one counts. */
function addLimit(limits: Limits, key: string, side: LimitSide, limit: Limit) {
  const sides = limits.get(key) ?? {};
  if (stricter(side, limit, sides[side])) sides[side] = limit;
  limits.set(key, sides);
}

/** The limits a JSON Schema node puts on a value; `prefix` is `items.` once per list the node is the entries of. */
function schemaLimits(node: JsonSchema, prefix = ''): Limits {
  const variants = node.oneOf ?? node.anyOf;
  if (variants) {
    // A union accepts a value any variant accepts: a side stays limited only while every variant taking that kind limits it, to the loosest of their limits.
    const merged: Limits = new Map();
    for (const limits of variants.map(variant => schemaLimits(variant, prefix))) {
      for (const [key, sides] of limits) {
        const known = merged.get(key);
        if (!known) { merged.set(key, { ...sides }); continue; }
        for (const side of SIDES) if (known[side] && (!sides[side] || stricter(side, known[side], sides[side]))) known[side] = sides[side];
      }
    }
    return merged;
  }
  const types = 'const' in node ? [] : Array.isArray(node.type) ? node.type : node.type ? [node.type] : [];
  const limits: Limits = new Map();
  for (const [kind, { types: takes }] of Object.entries(LIMIT_KINDS)) if (takes.some(type => types.includes(type))) limits.set(`${prefix}${kind}`, {});
  for (const [keyword, { kind, side, exclusive }] of LIMIT_KEYWORDS) {
    const value = node[keyword];
    if (typeof value === 'number' && limits.has(`${prefix}${kind}`)) addLimit(limits, `${prefix}${kind}`, side, { value, exclusive });
  }
  if (types.includes('array') && node.items) for (const [key, sides] of schemaLimits(node.items, `${prefix}items.`)) limits.set(key, sides);
  return limits;
}

/** The limits as the contract records them: one keyword for each limited side. */
function boundsOf(node: JsonSchema): Record<string, number> | undefined {
  const bounds: Record<string, number> = {};
  for (const [key, sides] of schemaLimits(node)) {
    const at = key.lastIndexOf('.') + 1;
    const { keywords, exclusive } = LIMIT_KINDS[key.slice(at)];
    for (const side of SIDES) {
      const limit = sides[side];
      if (limit) bounds[`${key.slice(0, at)}${limit.exclusive ? exclusive![side] : keywords[side]}`] = limit.value;
    }
  }
  return Object.keys(bounds).length ? bounds : undefined;
}

/** A field's recorded `bounds`, read back as limits. */
function recordedLimits(bounds: Record<string, number> = {}): Limits {
  const limits: Limits = new Map();
  for (const [key, value] of Object.entries(bounds)) {
    const at = key.lastIndexOf('.') + 1;
    const limit = LIMIT_KEYWORDS.get(key.slice(at));
    if (limit) addLimit(limits, `${key.slice(0, at)}${limit.kind}`, limit.side, { value, exclusive: limit.exclusive });
  }
  return limits;
}

/** The current plugin interface; `manifestSchema` is the manifest's JSON Schema (`pluginManifestJsonSchema()`). */
export function buildPluginContract(manifestSchema: JsonSchema = pluginManifestJsonSchema()): PluginContract {
  const manifest: Record<string, PluginManifestContractField> = {};
  for (const { path, node, required } of walkPluginManifestSchema(manifestSchema)) {
    const values = enumOf(node);
    const bounds = boundsOf(node);
    manifest[path] = { type: jsonSchemaTypeName(node), required, ...(values ? { enum: [...values] } : {}), ...(bounds ? { bounds } : {}) };
  }
  const payloads = Object.fromEntries(Object.entries(PLUGIN_EVENT_PAYLOAD_FIELDS).map(([name, fields]) => [name, { ...fields }]));
  return {
    manifestVersion: PLUGIN_MANIFEST_VERSION,
    manifest,
    events: { envelope: { ...PLUGIN_EVENT_ENVELOPE_FIELDS }, payloads },
    sdk: {
      context: [...PLUGIN_SDK_CONTEXT_MEMBERS],
      propr: { ...pluginSdk.PLUGIN_PROPR_OPERATIONS },
      state: [...PLUGIN_SDK_STATE_METHODS],
      log: [...PLUGIN_SDK_LOG_LEVELS],
      inputs: Object.fromEntries(Object.entries(PLUGIN_SDK_INPUT_FIELDS).map(([kind, fields]) => [kind, [...fields]])),
      errorCodes: [...pluginSdk.PLUGIN_SDK_ERROR_CODES],
      exports: Object.keys(pluginSdk).sort(),
    },
  };
}

/** Every event type of the journal, as `<domain>.<type>`. */
export function pluginEventNames(): string[] {
  return Object.entries(REPOSITORY_EVENT_TYPES).flatMap(([domain, types]) => types.map(type => `${domain}.${type}`));
}

export interface PluginContractComparison {
  /** Changes that can break a plugin written against `previous`. */
  breaking: string[];
  /** Additive changes: compatible, but the snapshot should record them. */
  additions: string[];
}

const fieldName = (key: string) => key.replace(/\?$/, '');
const optional = (key: string) => key.endsWith('?');

/** A literal type as the contract writes it: a JSON string, a number, `true` or `false`. */
const LITERAL = String.raw`(?:"(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?|true|false)`;
const LITERAL_UNION_ALIAS = new RegExp(`^(.*?) = (${LITERAL}(?: \\| ${LITERAL})*)$`);
const LITERALS = new RegExp(LITERAL, 'g');
const LITERAL_MEMBER = new RegExp(`^${LITERAL}$`);

/** The members of a union descriptor (`"review" | "ultrafix" | null`), not split inside quotes or brackets (`(string | null)[]`). */
function unionMembers(type: string): string[] {
  const members: string[] = [];
  let depth = 0;
  let quoted = false;
  let start = 0;
  for (let i = 0; i < type.length; i++) {
    const c = type[i];
    if (quoted) {
      if (c === '\\') i++;
      else if (c === '"') quoted = false;
    } else if (c === '"') quoted = true;
    else if ('([{<'.includes(c)) depth++;
    else if (')]}>'.includes(c) && !(c === '>' && type[i - 1] === '=')) depth--;
    else if (depth === 0 && type.startsWith(' | ', i)) {
      members.push(type.slice(start, i));
      start = i + 3;
      i += 2;
    }
  }
  return [...members, type.slice(start)];
}

/** A field type's literal values (`boolean` counting as `true | false`), and the rest of the type. */
function literalMembers(type: string): { literals: string[]; rest: string } {
  const members = unionMembers(type).flatMap(member => (member === 'boolean' ? ['true', 'false'] : [member]));
  return { literals: members.filter(member => LITERAL_MEMBER.test(member)), rest: members.filter(member => !LITERAL_MEMBER.test(member)).sort().join(' | ') };
}

/**
 * A field whose type changed. A reader may branch on a literal value (`source === 'review'`): one the field no
 * longer includes breaks it, and a new one is an addition, while the rest of the type stays the same. Any other
 * change retypes the field. Returns whether the change breaks readers.
 */
function compareFieldType(what: string, name: string, previous: string, current: string, result: PluginContractComparison): boolean {
  const before = literalMembers(previous);
  const after = literalMembers(current);
  if (!before.literals.length || before.rest !== after.rest) {
    result.breaking.push(`${what}: field ${name} changed type from ${previous} to ${current}`);
    return true;
  }
  const removed = before.literals.filter(value => !after.literals.includes(value));
  for (const value of removed) result.breaking.push(`${what}: field ${name} no longer includes ${value}`);
  for (const value of after.literals) if (!before.literals.includes(value)) result.additions.push(`${what}: field ${name} now includes ${value}`);
  return removed.length > 0;
}

/** Compare `key: type` maps where a removed key, a changed type, a removed literal value or a required key made optional breaks readers. */
function compareFields(what: string, previous: Record<string, string>, current: Record<string, string>, result: PluginContractComparison) {
  const now = new Map(Object.entries(current).map(([key, type]) => [fieldName(key), { key, type }]));
  const before = new Set(Object.keys(previous).map(fieldName));
  for (const [key, type] of Object.entries(previous)) {
    const match = now.get(fieldName(key));
    if (!match) {
      result.breaking.push(`${what}: field ${fieldName(key)} was removed`);
      continue;
    }
    const typeBreaks = match.type !== type && compareFieldType(what, fieldName(key), type, match.type, result);
    // A field that only gained a literal value can still have been made optional.
    if (!typeBreaks && !optional(key) && optional(match.key)) result.breaking.push(`${what}: field ${fieldName(key)} is no longer always present`);
  }
  for (const key of Object.keys(current)) if (!before.has(fieldName(key))) result.additions.push(`${what}: field ${fieldName(key)} was added`);
}

function compareList(what: string, previous: readonly string[], current: readonly string[], result: PluginContractComparison) {
  for (const name of previous) if (!current.includes(name)) result.breaking.push(`${what}: ${name} was removed`);
  for (const name of current) if (!previous.includes(name)) result.additions.push(`${what}: ${name} was added`);
}

/** The object a manifest field belongs to: `connections[]{type=token}.secretUrl.hosts` → `connections[]{type=token}.secretUrl`; `''` for the top level. */
const objectPath = (path: string) => path.replace(/(?:^|\.)(?:[^.]+)$/, '');

const describeLimit = (side: LimitSide, { value, exclusive }: Limit) => `${side === 'lower' ? (exclusive ? 'more than' : 'at least') : (exclusive ? 'less than' : 'at most')} ${value}`;

/** A new or stricter limit rejects manifests that met the old one; a looser or lifted limit accepts every one of them. */
function compareLimits(path: string, previous: PluginManifestContractField, current: PluginManifestContractField, bump: string, result: PluginContractComparison) {
  const before = recordedLimits(previous.bounds);
  const now = recordedLimits(current.bounds);
  for (const key of new Set([...before.keys(), ...now.keys()])) {
    const at = key.lastIndexOf('.') + 1;
    // `items.maxLength` limits each entry of the list: `outboundHosts[] length`.
    const what = `${path}${'[]'.repeat(key.slice(0, at).match(/items\./g)?.length ?? 0)} ${key.slice(at)}`;
    for (const side of SIDES) {
      const was = before.get(key)?.[side];
      const is = now.get(key)?.[side];
      const instead = was ? ` instead of ${describeLimit(side, was)}` : '';
      if (is && stricter(side, is, was)) result.breaking.push(`manifest: field ${what} is now limited to ${describeLimit(side, is)}${instead} ${bump}`);
      else if (was && stricter(side, was, is)) result.additions.push(is ? `manifest: field ${what} is now limited to ${describeLimit(side, is)}${instead}` : `manifest: field ${what} is no longer limited to ${describeLimit(side, was)}`);
    }
  }
}

function compareManifest(previous: PluginContract, current: PluginContract, supported: readonly number[], result: PluginContractComparison) {
  if (current.manifestVersion !== previous.manifestVersion) {
    // A new manifest version may change anything, but the previous one must still be read.
    if (!supported.includes(previous.manifestVersion)) result.breaking.push(`manifest: manifestVersion ${previous.manifestVersion} is no longer read; keep reading it for at least one minor release after ${current.manifestVersion}`);
    else result.additions.push(`manifest: manifestVersion ${current.manifestVersion} was added`);
    return;
  }
  const bump = `(a breaking manifest change needs a new manifestVersion)`;
  for (const [path, field] of Object.entries(previous.manifest)) {
    const now = current.manifest[path];
    if (!now) { result.breaking.push(`manifest: field ${path} was removed ${bump}`); continue; }
    if (now.type !== field.type) result.breaking.push(`manifest: field ${path} changed type from ${field.type} to ${now.type} ${bump}`);
    if (now.required && !field.required) result.breaking.push(`manifest: field ${path} became required ${bump}`);
    // An unrestricted field (or list item) that gains an enum rejects every value outside it; dropping an enum is compatible.
    if (now.enum && !field.enum) result.breaking.push(`manifest: field ${path} now only accepts ${now.enum.map(value => JSON.stringify(value)).join(', ')} ${bump}`);
    for (const value of field.enum ?? []) if (now.enum && !now.enum.includes(value)) result.breaking.push(`manifest: field ${path} no longer accepts ${JSON.stringify(value)} ${bump}`);
    for (const value of now.enum ?? []) if (field.enum && !field.enum.includes(value)) result.additions.push(`manifest: field ${path} accepts ${JSON.stringify(value)}`);
    compareLimits(path, field, now, bump, result);
  }
  for (const [path, field] of Object.entries(current.manifest)) {
    if (previous.manifest[path]) continue;
    // A new required field of an object manifests already have breaks them; a new optional one (or one inside a new object) does not.
    const parent = objectPath(path);
    const existed = parent === '' || Object.keys(previous.manifest).some(known => known.startsWith(`${parent}.`));
    if (field.required && existed) result.breaking.push(`manifest: new field ${path} is required ${bump}`);
    else result.additions.push(`manifest: field ${path} was added`);
  }
}

/**
 * The declared text and the literal values of an alias the contract source records expanded, because
 * it follows a runtime list (`typeof PLUGIN_SDK_ERROR_CODES[number] = "permission_denied" | …`).
 */
function literalUnionAlias(text: string): { declared: string; members: string[] } | null {
  const match = LITERAL_UNION_ALIAS.exec(text);
  return match ? { declared: match[1], members: match[2].match(LITERALS) ?? [] } : null;
}

/**
 * A declared SDK type whose text changed. An alias of a runtime list (`PluginSdkErrorCode`,
 * `RepositoryEventDomain`) grows with the list, which is additive like the list itself (a new error
 * code or event domain); a value it no longer includes, or any other change, breaks plugins.
 */
function compareChangedType(member: string, previous: string, current: string, result: PluginContractComparison) {
  const before = literalUnionAlias(previous);
  const after = literalUnionAlias(current);
  if (!before || !after || before.declared !== after.declared) {
    result.breaking.push(`sdk: type ${member} changed from ${previous} to ${current}`);
    return;
  }
  for (const value of before.members) if (!after.members.includes(value)) result.breaking.push(`sdk: type ${member} no longer includes ${value}`);
  for (const value of after.members) if (!before.members.includes(value)) result.additions.push(`sdk: type ${member} now includes ${value}`);
}

/**
 * The changes from `previous` (the committed snapshot) to `current`. Only
 * what `previous` promised is checked: everything it lists must still be
 * there with the same type.
 */
export function comparePluginContract(previous: PluginContract, current: PluginContract, options: { supportedManifestVersions?: readonly number[] } = {}): PluginContractComparison {
  const result: PluginContractComparison = { breaking: [], additions: [] };
  compareManifest(previous, current, options.supportedManifestVersions ?? PLUGIN_SUPPORTED_MANIFEST_VERSIONS, result);
  compareFields('event envelope', previous.events.envelope, current.events.envelope, result);
  for (const [name, fields] of Object.entries(previous.events.payloads)) {
    const now = current.events.payloads[name];
    if (!now) result.breaking.push(`events: event type ${name} was removed`);
    else compareFields(`events: ${name} payload`, fields, now, result);
  }
  for (const name of Object.keys(current.events.payloads)) if (!previous.events.payloads[name]) result.additions.push(`events: event type ${name} was added`);
  const { sdk } = previous;
  compareList('sdk: ctx member', sdk.context, current.sdk.context, result);
  for (const [operation, permission] of Object.entries(sdk.propr)) {
    const now = current.sdk.propr[operation];
    if (now === undefined) result.breaking.push(`sdk: ctx.propr.${operation} was removed`);
    else if (now !== permission) result.breaking.push(`sdk: ctx.propr.${operation} now needs ${now} instead of ${permission}`);
  }
  for (const operation of Object.keys(current.sdk.propr)) if (sdk.propr[operation] === undefined) result.additions.push(`sdk: ctx.propr.${operation} was added`);
  compareList('sdk: ctx.state method', sdk.state, current.sdk.state, result);
  compareList('sdk: ctx.log level', sdk.log, current.sdk.log, result);
  for (const [kind, fields] of Object.entries(sdk.inputs)) {
    const now = current.sdk.inputs[kind];
    if (!now) { result.breaking.push(`sdk: input kind ${kind} was removed`); continue; }
    const asMap = (list: readonly string[]) => Object.fromEntries(list.map(key => [key, 'field']));
    compareFields(`sdk: ${kind} input`, asMap(fields), asMap(now), result);
  }
  for (const kind of Object.keys(current.sdk.inputs)) if (!sdk.inputs[kind]) result.additions.push(`sdk: input kind ${kind} was added`);
  compareList('sdk: error code', sdk.errorCodes, current.sdk.errorCodes, result);
  compareList('sdk: export', sdk.exports, current.sdk.exports, result);
  // A declared SDK type is promised exactly: a changed parameter or result type can break a plugin compiled against it.
  if (sdk.types) {
    const now = current.sdk.types ?? {};
    for (const [member, type] of Object.entries(sdk.types)) {
      if (!(member in now)) result.breaking.push(`sdk: type ${member} was removed`);
      else if (now[member] !== type) compareChangedType(member, type, now[member], result);
    }
    // A required member added to an interface plugins supply (a parameter of an SDK call) breaks the plugins that build it.
    const supplied = new Set([...(sdk.suppliedTypes ?? []), ...(current.sdk.suppliedTypes ?? [])]);
    const owner = (member: string) => /^([^.[(\s]+)(?:\.|\[|\(| extends$)/.exec(member)?.[1];
    const existing = new Set(Object.keys(sdk.types).map(owner).filter((name): name is string => name !== undefined));
    for (const member of Object.keys(now)) {
      if (member in sdk.types) continue;
      const name = owner(member);
      if (name && supplied.has(name) && existing.has(name) && !optional(member)) result.breaking.push(`sdk: type ${member} was added as a required member of ${name}, which plugins supply`);
      else result.additions.push(`sdk: type ${member} was added`);
    }
  }
  return result;
}
