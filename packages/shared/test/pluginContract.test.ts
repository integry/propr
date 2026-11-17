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

test('a new manifest version may change the manifest, while the old version is still read', () => {
  const previous = { ...structuredClone(readJson(FIXTURE)), manifestVersion: 0 };
  const current = buildPluginContract();
  assert.ok(comparePluginContract(previous, current).breaking.includes(`manifest: manifestVersion 0 is no longer read; keep reading it for at least one minor release after ${PLUGIN_MANIFEST_VERSION}`));
  const stillRead = comparePluginContract(previous, current, { supportedManifestVersions: [0, PLUGIN_MANIFEST_VERSION] });
  assert.ok(!stillRead.breaking.some(message => message.startsWith('manifest:')), stillRead.breaking.join('\n'));
  assert.ok(stillRead.additions.includes(`manifest: manifestVersion ${PLUGIN_MANIFEST_VERSION} was added`));
});
