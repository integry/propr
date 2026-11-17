import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  PLUGIN_EVENT_PAYLOAD_FIELDS, PLUGIN_SUPPORTED_MANIFEST_VERSIONS, buildPluginContract, comparePluginContract, pluginEventNames, type PluginContract,
} from '../src/pluginContract.js';
import { PLUGIN_MANIFEST_VERSION } from '../src/plugins.js';
import {
  PLUGIN_EVENT_PAYLOAD_INTERFACES, PLUGIN_SDK_SOURCE, REPOSITORY_EVENTS_SOURCE, buildSourcePluginContract, editedSource, pluginContractSourceMismatches,
  readPluginContractSource,
} from './support/pluginContractSource.js';

const SNAPSHOT = new URL('./contracts/plugin-contract.snapshot.json', import.meta.url);
const FIXTURE = new URL('./fixtures/plugin-contract/breaking-previous.json', import.meta.url);
const readJson = (url: URL) => JSON.parse(readFileSync(url, 'utf8')) as PluginContract;
const UPDATE = 'Run npm run plugins:contract:update to record it.';
// The interface as the TypeScript sources declare it, read once (the compiler takes a second or two).
const SOURCE = readPluginContractSource();
const CURRENT = buildSourcePluginContract(SOURCE);
/** The contract after editing one shared source file, compared with the committed snapshot. */
const breakingAfterEdit = (file: string, search: string, replacement: string) => {
  const source = readPluginContractSource({ overrides: editedSource(file, search, replacement) });
  return { mismatches: pluginContractSourceMismatches(source), breaking: comparePluginContract(readJson(SNAPSHOT), buildSourcePluginContract(source)).breaking };
};

test('the plugin interface keeps every promise of the committed snapshot', () => {
  const { breaking } = comparePluginContract(readJson(SNAPSHOT), CURRENT);
  assert.deepEqual(breaking, [], `Breaking plugin interface change. Payloads and the SDK are additive only; a breaking manifest change needs a new manifestVersion (see "Compatibility rules" in docs/docs/plugins/authoring.md).\n${breaking.join('\n')}`);
});

test('the committed snapshot records the current interface', () => {
  const { additions } = comparePluginContract(readJson(SNAPSHOT), CURRENT);
  assert.deepEqual(additions, [], `The plugin interface grew. ${UPDATE}\n${additions.join('\n')}`);
  assert.deepEqual(CURRENT, readJson(SNAPSHOT), `The snapshot is out of date. ${UPDATE}`);
});

test('the payload and envelope types written in pluginContract.ts are the types the interfaces declare', () => {
  assert.deepEqual(pluginContractSourceMismatches(SOURCE), []);
  for (const event of Object.keys(PLUGIN_EVENT_PAYLOAD_INTERFACES)) assert.ok(event in PLUGIN_EVENT_PAYLOAD_FIELDS, event);
  // The SDK walk reaches the operations' parameters and results, not only the member names.
  for (const member of ['PluginStateStore.get', 'PluginProprClient.getPullRequest', 'PluginPullRequestSummary.draft', 'PluginContext.http', 'PluginEventInput.manual?']) {
    assert.ok(member in CURRENT.sdk.types!, member);
  }
});

test('retyping a payload field in its interface, keeping its name, is a breaking change', () => {
  const { mismatches, breaking } = breakingAfterEdit(REPOSITORY_EVENTS_SOURCE, '  score: number;\n', '  score: string;\n');
  assert.match(mismatches.join('\n'), /PLUGIN_EVENT_PAYLOAD_FIELDS\['pull_request\.review_scored'\].*"score":"string"/);
  assert.deepEqual(breaking, ['events: pull_request.review_scored payload: field score changed type from number to string']);
});

test('allowing undefined in a required payload or envelope field is a breaking change', () => {
  const required = breakingAfterEdit(REPOSITORY_EVENTS_SOURCE, '  score: number;\n', '  score: number | undefined;\n');
  assert.match(required.mismatches.join('\n'), /PLUGIN_EVENT_PAYLOAD_FIELDS\['pull_request\.review_scored'\].*"score":"number \| undefined"/);
  assert.deepEqual(required.breaking, ['events: pull_request.review_scored payload: field score changed type from number to number | undefined']);
  const nullable = breakingAfterEdit(REPOSITORY_EVENTS_SOURCE, '  goal: number | null;\n  goalReached', '  goal: number | null | undefined;\n  goalReached');
  assert.deepEqual(nullable.breaking, ['events: pull_request.review_scored payload: field goal changed type from number | null to number | null | undefined']);
  const envelope = breakingAfterEdit(REPOSITORY_EVENTS_SOURCE, '  seq: number;\n  repository: string;\n', '  seq: number | undefined;\n  repository: string;\n');
  assert.ok(envelope.mismatches.some(message => message.startsWith('PLUGIN_EVENT_ENVELOPE_FIELDS')), envelope.mismatches.join('\n'));
  assert.ok(envelope.breaking.includes('event envelope: field seq changed type from number to number | undefined'), envelope.breaking.join('\n'));
  // An optional field's `?` already says it may be absent, so `?: number` reads as `number` and is only an addition.
  const optional = readPluginContractSource({ overrides: editedSource(REPOSITORY_EVENTS_SOURCE, '  score: number;\n', '  score: number;\n  rank?: number | undefined;\n') });
  assert.equal(optional.payloads['pull_request.review_scored']['rank?'], 'number');
  assert.deepEqual(comparePluginContract(readJson(SNAPSHOT), buildSourcePluginContract(optional)).breaking, []);
});

test('retyping an inherited payload field or an envelope field in the source is a breaking change', () => {
  const inherited = breakingAfterEdit(REPOSITORY_EVENTS_SOURCE, '  attempts: number;\n', '  attempts: number | null;\n');
  for (const event of ['task.queued', 'task.started', 'task.completed', 'task.failed', 'task.cancelled']) {
    assert.ok(inherited.breaking.includes(`events: ${event} payload: field attempts changed type from number to number | null`), inherited.breaking.join('\n'));
  }
  const envelope = breakingAfterEdit(REPOSITORY_EVENTS_SOURCE, '  seq: number;\n  repository: string;\n', '  seq: string;\n  repository: string;\n');
  assert.ok(envelope.mismatches.some(message => message.startsWith('PLUGIN_EVENT_ENVELOPE_FIELDS')), envelope.mismatches.join('\n'));
  assert.ok(envelope.breaking.includes('event envelope: field seq changed type from number to string'), envelope.breaking.join('\n'));
  assert.ok(envelope.breaking.includes('sdk: type RepositoryEvent.seq changed from number to string'), envelope.breaking.join('\n'));
});

test('changing a ctx.state method\'s parameters or result in PluginStateStore is a breaking change', () => {
  const parameter = breakingAfterEdit(PLUGIN_SDK_SOURCE, 'set(key: string, value: PluginJsonValue): Promise<void>;', 'set(key: string, value: string): Promise<void>;');
  assert.deepEqual(parameter.breaking, ['sdk: type PluginStateStore.set changed from (key: string, value: PluginJsonValue) => Promise<void> to (key: string, value: string) => Promise<void>']);
  const result = breakingAfterEdit(PLUGIN_SDK_SOURCE, 'delete(key: string): Promise<boolean>;', 'delete(key: string): Promise<void>;');
  assert.deepEqual(result.breaking, ['sdk: type PluginStateStore.delete changed from (key: string) => Promise<boolean> to (key: string) => Promise<void>']);
});

test('changing a ctx.propr operation, or the type it returns, in the source is a breaking change', () => {
  const operation = breakingAfterEdit(PLUGIN_SDK_SOURCE, 'getTask(taskId: string): Promise<PluginTaskSummary>;', 'getTask(repository: string, taskId: string): Promise<PluginTaskSummary>;');
  assert.deepEqual(operation.breaking, ['sdk: type PluginProprClient.getTask changed from (taskId: string) => Promise<PluginTaskSummary> to (repository: string, taskId: string) => Promise<PluginTaskSummary>']);
  const returned = breakingAfterEdit(PLUGIN_SDK_SOURCE, 'draft: boolean; merged: boolean;', 'draft: boolean | null; merged: boolean;');
  assert.deepEqual(returned.breaking, ['sdk: type PluginPullRequestSummary.draft changed from boolean to boolean | null']);
  const removed = breakingAfterEdit(PLUGIN_SDK_SOURCE, '  keys(prefix?: string): Promise<string[]>;\n', '');
  assert.ok(removed.breaking.includes('sdk: type PluginStateStore.keys was removed'), removed.breaking.join('\n'));
});

test('a required property added to an SDK input plugins build is a breaking change; an optional one is not', () => {
  assert.ok(SOURCE.suppliedTypes.includes('PluginListEventsInput'), SOURCE.suppliedTypes.join(', '));
  // Received interfaces are not supplied: a new member of a summary or of ctx breaks no plugin.
  for (const received of ['PluginContext', 'PluginPullRequestSummary', 'PluginEventInput']) assert.ok(!SOURCE.suppliedTypes.includes(received), received);
  const search = 'export interface PluginListEventsInput { repository: string;';
  const required = breakingAfterEdit(PLUGIN_SDK_SOURCE, search, `${search} cursor: number;`);
  assert.deepEqual(required.breaking, ['sdk: type PluginListEventsInput.cursor was added as a required member of PluginListEventsInput, which plugins supply']);
  const optional = breakingAfterEdit(PLUGIN_SDK_SOURCE, search, `${search} cursor?: number;`);
  assert.deepEqual(optional.breaking, []);
  // Reached through a parameter of a function ctx returns: ctx.http(...)'s init.
  const nested = breakingAfterEdit(PLUGIN_SDK_SOURCE, 'export interface PluginHttpRequestInit {', 'export interface PluginHttpRequestInit {\n  mode: string;');
  assert.deepEqual(nested.breaking, ['sdk: type PluginHttpRequestInit.mode was added as a required member of PluginHttpRequestInit, which plugins supply']);
  // A required member of an interface plugins only receive stays an addition.
  const output = breakingAfterEdit(PLUGIN_SDK_SOURCE, 'export interface PluginCreatedIssue { repository: string;', 'export interface PluginCreatedIssue { repository: string; title: string;');
  assert.deepEqual(output.breaking, []);
});

test('changing the signature of an exported SDK function, keeping its name, is a breaking change', () => {
  for (const member of ['definePluginHandler()', 'definePluginWebhookResponder()', 'clampPluginRetryAfter()', 'parsePluginRetryAfter()', 'parsePluginSettingOptions()']) {
    assert.ok(member in CURRENT.sdk.types!, member);
  }
  const helper = 'export const definePluginHandler = <I extends PluginHandlerInput, R extends PluginHandlerResultValue = void>(handler: PluginHandler<I, R>): PluginHandler<I, R> => handler;';
  const argument = breakingAfterEdit(PLUGIN_SDK_SOURCE, helper, 'export const definePluginHandler = <I extends PluginHandlerInput, R extends PluginHandlerResultValue = void>(name: string, handler: PluginHandler<I, R>): PluginHandler<I, R> => handler;');
  assert.deepEqual(argument.breaking, [
    'sdk: type definePluginHandler() changed from <I extends PluginHandlerInput, R extends PluginHandlerResultValue = void>(handler: PluginHandler<I, R>) => PluginHandler<I, R> to <I extends PluginHandlerInput, R extends PluginHandlerResultValue = void>(name: string, handler: PluginHandler<I, R>) => PluginHandler<I, R>',
  ]);
  const result = breakingAfterEdit(PLUGIN_SDK_SOURCE, 'export function parsePluginRetryAfter(value: string | null | undefined, now: number = Date.now()): number | null {', 'export function parsePluginRetryAfter(value: string | null | undefined, now: number = Date.now()): number | undefined {');
  assert.deepEqual(result.breaking, ['sdk: type parsePluginRetryAfter() changed from (value: string | null | undefined, now: number = Date.now()) => number | null to (value: string | null | undefined, now: number = Date.now()) => number | undefined']);
  // A type reached only through an exported function's signature is recorded too.
  const responder = breakingAfterEdit(PLUGIN_SDK_SOURCE, 'export interface PluginWebhookRequest { webhook: string;', 'export interface PluginWebhookRequest { webhook: number;');
  assert.deepEqual(responder.breaking, ['sdk: type PluginWebhookRequest.webhook changed from string to number']);
  // What a plugin returns from a function it passes in is supplied; what ProPR passes the handler a helper returns is not.
  assert.ok(SOURCE.suppliedTypes.includes('PluginWebhookResponse'), SOURCE.suppliedTypes.join(', '));
  for (const received of ['PluginContext', 'PluginWebhookRequest']) assert.ok(!SOURCE.suppliedTypes.includes(received), received);
  const removed = breakingAfterEdit(PLUGIN_SDK_SOURCE, 'export const clampPluginRetryAfter = (ms: number): number =>', 'const clampPluginRetryAfter = (ms: number): number =>');
  assert.ok(removed.breaking.includes('sdk: type clampPluginRetryAfter() was removed'), removed.breaking.join('\n'));
});

test('changing an exported SDK error class\'s constructor or members is a breaking change', () => {
  const constructor = breakingAfterEdit(PLUGIN_SDK_SOURCE, 'constructor(message: string, options: { retryAfterMs?: number | null; permanent?: boolean } = {}) {', 'constructor(message: string, options: { retryAfterMs: number | null; permanent?: boolean }) {');
  assert.deepEqual(constructor.breaking, [
    'sdk: type PluginDeliveryError.constructor changed from (message: string, options: { retryAfterMs?: number | null; permanent?: boolean } = {}) => PluginDeliveryError to (message: string, options: { retryAfterMs: number | null; permanent?: boolean }) => PluginDeliveryError',
  ]);
  const order = breakingAfterEdit(PLUGIN_SDK_SOURCE, 'constructor(readonly code: PluginSdkErrorCode, message: string) { super(message); }', 'constructor(message: string, readonly code: PluginSdkErrorCode) { super(message); }');
  assert.deepEqual(order.breaking, ['sdk: type PluginSdkError.constructor changed from (readonly code: PluginSdkErrorCode, message: string) => PluginSdkError to (message: string, readonly code: PluginSdkErrorCode) => PluginSdkError']);
  // A parameter property is a public member: no longer declaring it removes `error.code`.
  const parameterProperty = breakingAfterEdit(PLUGIN_SDK_SOURCE, 'constructor(readonly code: PluginSdkErrorCode, message: string) { super(message); }', 'constructor(code: PluginSdkErrorCode, message: string) { super(message); }');
  assert.ok(parameterProperty.breaking.includes('sdk: type PluginSdkError.code was removed'), parameterProperty.breaking.join('\n'));
  const member = breakingAfterEdit(PLUGIN_SDK_SOURCE, '  readonly permanent: boolean;\n', '  readonly permanent: boolean | undefined;\n');
  assert.deepEqual(member.breaking, ['sdk: type PluginDeliveryError.permanent changed from readonly boolean to readonly boolean | undefined']);
  const base = breakingAfterEdit(PLUGIN_SDK_SOURCE, 'export class PluginSdkError extends Error {', 'export class PluginSdkError {\n  readonly message: string = \'\';');
  assert.ok(base.breaking.includes('sdk: type PluginSdkError extends was removed'), base.breaking.join('\n'));
});

test('adding an SDK error code or an event domain in the source is an addition; removing one is a breaking change', () => {
  const snapshot = readJson(SNAPSHOT);
  const codes = 'export const PLUGIN_SDK_ERROR_CODES = [';
  const code = readPluginContractSource({ overrides: editedSource(PLUGIN_SDK_SOURCE, codes, `${codes}\n  'rate_limited',`) });
  // The runtime list (`errorCodes`) is read from the module, so record the same addition there, as the real change would.
  const withCode = buildSourcePluginContract(code);
  withCode.sdk.errorCodes.push('rate_limited');
  const added = comparePluginContract(snapshot, withCode);
  assert.deepEqual(added.breaking, []);
  for (const message of ['sdk: type PluginSdkErrorCode now includes "rate_limited"', 'sdk: error code: rate_limited was added']) assert.ok(added.additions.includes(message), added.additions.join('\n'));
  const domains = "export const REPOSITORY_EVENT_DOMAINS = ['pull_request', 'epic_queue', 'plan_issue', 'task'] as const;";
  const domain = readPluginContractSource({ overrides: editedSource(REPOSITORY_EVENTS_SOURCE, domains, "export const REPOSITORY_EVENT_DOMAINS = ['pull_request', 'epic_queue', 'plan_issue', 'task', 'deployment'] as const;") });
  const addedDomain = comparePluginContract(snapshot, buildSourcePluginContract(domain));
  assert.deepEqual(addedDomain.breaking, []);
  assert.deepEqual(addedDomain.additions, ['sdk: type RepositoryEventDomain now includes "deployment"']);
  // Removals, and changing what the alias is declared as, are still breaking changes.
  const removedCode = breakingAfterEdit(PLUGIN_SDK_SOURCE, "'state_limit',", '');
  assert.deepEqual(removedCode.breaking, ['sdk: type PluginSdkErrorCode no longer includes "state_limit"']);
  const removedDomain = breakingAfterEdit(REPOSITORY_EVENTS_SOURCE, domains, "export const REPOSITORY_EVENT_DOMAINS = ['pull_request', 'epic_queue', 'task'] as const;");
  assert.deepEqual(removedDomain.breaking, ['sdk: type RepositoryEventDomain no longer includes "plan_issue"']);
  const widened = breakingAfterEdit(PLUGIN_SDK_SOURCE, 'export type PluginSdkErrorCode = typeof PLUGIN_SDK_ERROR_CODES[number];', 'export type PluginSdkErrorCode = typeof PLUGIN_SDK_ERROR_CODES[number] | string;');
  assert.equal(widened.breaking.length, 1, widened.breaking.join('\n'));
  assert.match(widened.breaking[0], /^sdk: type PluginSdkErrorCode changed from typeof PLUGIN_SDK_ERROR_CODES\[number\] = .* to typeof PLUGIN_SDK_ERROR_CODES\[number\] \| string = string$/);
});

test('every journal event type has a payload contract, and nothing else does', () => {
  assert.deepEqual(Object.keys(PLUGIN_EVENT_PAYLOAD_FIELDS).sort(), pluginEventNames().sort());
});

test('the current manifest version is read', () => {
  assert.ok(PLUGIN_SUPPORTED_MANIFEST_VERSIONS.includes(PLUGIN_MANIFEST_VERSION));
});

test('the fixture of an earlier interface shows every kind of breaking change', () => {
  const { breaking } = comparePluginContract(readJson(FIXTURE), CURRENT);
  const expected = [
    'manifest: field name changed type from number to string (a breaking manifest change needs a new manifestVersion)',
    'manifest: field homepage became required (a breaking manifest change needs a new manifestVersion)',
    'manifest: field legacyIcon was removed (a breaking manifest change needs a new manifestVersion)',
    'manifest: field category no longer accepts "chat" (a breaking manifest change needs a new manifestVersion)',
    'manifest: new field description is required (a breaking manifest change needs a new manifestVersion)',
    'event envelope: field legacyCursor was removed',
    'events: pull_request.opened payload: field draft changed type from string to boolean',
    'events: pull_request.opened payload: field legacyTitle was removed',
    'events: event type pull_request.reopened was removed',
    'events: epic_queue.completed payload: field fromIssue is no longer always present',
    'sdk: ctx member: secrets was removed',
    'sdk: ctx.propr.getTask now needs tasks.read instead of issues.read',
    'sdk: ctx.propr.deleteRepository was removed',
    'sdk: ctx.state method: clear was removed',
    'sdk: ctx.log level: trace was removed',
    'sdk: event input: field legacyId was removed',
    'sdk: input kind cron was removed',
    'sdk: error code: rate_limited was removed',
    'sdk: export: legacyHelper was removed',
    'sdk: type PluginStateStore.delete changed from (key: string) => Promise<void> to (key: string) => Promise<boolean>',
    'sdk: type PluginStateStore.clear was removed',
  ];
  for (const message of expected) assert.ok(breaking.includes(message), `expected "${message}" in\n${breaking.join('\n')}`);
  // Nothing the fixture lists unchanged is reported.
  assert.ok(!breaking.some(message => /field (id|seq|baseRef|cursor) /.test(message) || /getIssue|permission_denied|definePluginHandler|type PluginProprClient\.getTask/.test(message)), breaking.join('\n'));
});

test('a breaking change to the current interface fails the comparison', () => {
  const snapshot = readJson(SNAPSHOT);
  const changed = structuredClone(CURRENT);
  delete changed.events.payloads['pull_request.review_scored'].score;
  changed.events.payloads['task.failed'].durationMs = 'string';
  changed.sdk.context = changed.sdk.context.filter(member => member !== 'state');
  delete changed.sdk.propr.createIssue;
  delete changed.manifest['contributes.commands[].needsWrite'];
  assert.deepEqual(comparePluginContract(snapshot, changed).breaking, [
    'manifest: field contributes.commands[].needsWrite was removed (a breaking manifest change needs a new manifestVersion)',
    'events: pull_request.review_scored payload: field score was removed',
    'events: task.failed payload: field durationMs changed type from number | null to string',
    'sdk: ctx member: state was removed',
    'sdk: ctx.propr.createIssue was removed',
  ]);
});

test('additive changes are compatible', () => {
  const previous = structuredClone(CURRENT);
  delete previous.events.payloads['pull_request.opened'].draft;
  delete previous.events.payloads['epic_queue.started'];
  delete previous.sdk.propr.removeLabel;
  previous.sdk.inputs.event = previous.sdk.inputs.event.filter(field => field !== 'manual?');
  delete previous.manifest['connections[]{type=token}.authorization'];
  delete previous.manifest['connections[]{type=token}.secretUrl'];
  delete previous.manifest['connections[]{type=token}.secretUrl.hosts'];
  delete previous.manifest['connections[]{type=token}.secretUrl.pathPrefixes'];
  for (const path of Object.keys(previous.manifest)) if (path.includes('{type=signing_secret}')) delete previous.manifest[path];
  previous.manifest.category.enum = previous.manifest.category.enum!.filter(value => value !== 'context');
  previous.events.payloads['epic_queue.completed'] = { 'fromIssue?': 'number', cursor: 'number' };
  delete previous.sdk.types!['PluginContext.http'];
  const { breaking, additions } = comparePluginContract(previous, CURRENT);
  assert.deepEqual(breaking, []);
  for (const message of [
    'events: pull_request.opened payload: field draft was added', 'events: event type epic_queue.started was added', 'sdk: ctx.propr.removeLabel was added',
    'sdk: event input: field manual was added', 'sdk: type PluginContext.http was added', 'manifest: field connections[]{type=token}.authorization was added', 'manifest: field category accepts "context"',
    // A new union variant with required fields, and a required field inside a new optional object, break no existing manifest.
    'manifest: field connections[]{type=signing_secret}.name was added', 'manifest: field connections[]{type=token}.secretUrl.hosts was added',
  ]) assert.ok(additions.includes(message), `expected "${message}" in\n${additions.join('\n')}`);
});

test('restricting an unrestricted manifest field or list item to an enum is a breaking change; dropping an enum is not', () => {
  const snapshot = readJson(SNAPSHOT);
  const list = 'connections[]{type=oauth}.scopes';
  for (const path of ['name', list]) assert.equal(snapshot.manifest[path].enum, undefined, path);
  assert.equal(snapshot.manifest[list].type, 'string[]');
  const restricted = structuredClone(snapshot);
  restricted.manifest.name.enum = ['github', 'slack'];
  restricted.manifest[list].enum = ['repo'];
  assert.deepEqual(comparePluginContract(snapshot, restricted).breaking, [
    'manifest: field name now only accepts "github", "slack" (a breaking manifest change needs a new manifestVersion)',
    `manifest: field ${list} now only accepts "repo" (a breaking manifest change needs a new manifestVersion)`,
  ]);
  // The reverse, an enum lifted, accepts every value it accepted before.
  const lifted = comparePluginContract(restricted, snapshot);
  assert.deepEqual(lifted.breaking, []);
});

test('a new manifest version may change the manifest, while the old version is still read', () => {
  const previous = { ...structuredClone(readJson(FIXTURE)), manifestVersion: 0 };
  const current = buildPluginContract();
  assert.ok(comparePluginContract(previous, current).breaking.includes(`manifest: manifestVersion 0 is no longer read; keep reading it for at least one minor release after ${PLUGIN_MANIFEST_VERSION}`));
  const stillRead = comparePluginContract(previous, current, { supportedManifestVersions: [0, PLUGIN_MANIFEST_VERSION] });
  assert.ok(!stillRead.breaking.some(message => message.startsWith('manifest:')), stillRead.breaking.join('\n'));
  assert.ok(stillRead.additions.includes(`manifest: manifestVersion ${PLUGIN_MANIFEST_VERSION} was added`));
});
