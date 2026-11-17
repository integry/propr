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
 *   change (a field removed, retyped, made required, or an enum value
 *   dropped) needs a new `manifestVersion`, and ProPR keeps reading the old
 *   version for at least one minor release (`PLUGIN_SUPPORTED_MANIFEST_VERSIONS`).
 * - **Event payloads.** Additive only within a domain: a payload key is never
 *   removed or retyped, an event type is never removed.
 * - **The handler SDK.** `ctx` members, `ctx.propr` operations (and the
 *   permission each needs), `ctx.state` and `ctx.log` methods, input envelope
 *   fields, error codes and the runtime exports of the SDK module are
 *   additive only.
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
 * `number[]`, each optionally `| null`. Keep this in step with the payload
 * interfaces of `repositoryEvents.ts`: the type checks below compare the keys,
 * and the shared package's contract test compares each type with the field's
 * declared type.
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

/** One manifest field: its JSON type, whether it must be present, and its allowed values when it is an enum. */
export interface PluginManifestContractField { type: string; required: boolean; enum?: (string | number | boolean)[] }
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
     * text, e.g. `PluginStateStore.get` → `(key: string) => Promise<…>`.
     * Absent from `buildPluginContract()`, which runs without the compiler.
     */
    types?: Record<string, string>;
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

/** The current plugin interface. */
export function buildPluginContract(): PluginContract {
  const manifest: Record<string, PluginManifestContractField> = {};
  for (const { path, node, required } of walkPluginManifestSchema()) {
    const values = enumOf(node);
    manifest[path] = { type: jsonSchemaTypeName(node), required, ...(values ? { enum: [...values] } : {}) };
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

/** Compare `key: type` maps where a removed key, a changed type or a required key made optional breaks readers. */
function compareFields(what: string, previous: Record<string, string>, current: Record<string, string>, result: PluginContractComparison) {
  const now = new Map(Object.entries(current).map(([key, type]) => [fieldName(key), { key, type }]));
  const before = new Set(Object.keys(previous).map(fieldName));
  for (const [key, type] of Object.entries(previous)) {
    const match = now.get(fieldName(key));
    if (!match) result.breaking.push(`${what}: field ${fieldName(key)} was removed`);
    else if (match.type !== type) result.breaking.push(`${what}: field ${fieldName(key)} changed type from ${type} to ${match.type}`);
    else if (!optional(key) && optional(match.key)) result.breaking.push(`${what}: field ${fieldName(key)} is no longer always present`);
  }
  for (const key of Object.keys(current)) if (!before.has(fieldName(key))) result.additions.push(`${what}: field ${fieldName(key)} was added`);
}

function compareList(what: string, previous: readonly string[], current: readonly string[], result: PluginContractComparison) {
  for (const name of previous) if (!current.includes(name)) result.breaking.push(`${what}: ${name} was removed`);
  for (const name of current) if (!previous.includes(name)) result.additions.push(`${what}: ${name} was added`);
}

/** The object a manifest field belongs to: `connections[]{type=token}.secretUrl.hosts` → `connections[]{type=token}.secretUrl`; `''` for the top level. */
const objectPath = (path: string) => path.replace(/(?:^|\.)(?:[^.]+)$/, '');

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
    for (const value of field.enum ?? []) if (now.enum && !now.enum.includes(value)) result.breaking.push(`manifest: field ${path} no longer accepts ${JSON.stringify(value)} ${bump}`);
    for (const value of now.enum ?? []) if (field.enum && !field.enum.includes(value)) result.additions.push(`manifest: field ${path} accepts ${JSON.stringify(value)}`);
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
      else if (now[member] !== type) result.breaking.push(`sdk: type ${member} changed from ${type} to ${now[member]}`);
    }
    for (const member of Object.keys(now)) if (!(member in sdk.types)) result.additions.push(`sdk: type ${member} was added`);
  }
  return result;
}
