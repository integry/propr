import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  PLUGIN_EVENT_PAYLOAD_FIELDS, PLUGIN_SUPPORTED_MANIFEST_VERSIONS, buildPluginContract, comparePluginContract, pluginEventNames, type PluginContract,
} from '../src/pluginContract.js';
import { PLUGIN_MANIFEST_VERSION } from '../src/plugins.js';

const SNAPSHOT = new URL('./contracts/plugin-contract.snapshot.json', import.meta.url);
const FIXTURE = new URL('./fixtures/plugin-contract/breaking-previous.json', import.meta.url);
const readJson = (url: URL) => JSON.parse(readFileSync(url, 'utf8')) as PluginContract;
const UPDATE = 'Run npm run plugins:contract:update to record it.';

test('the plugin interface keeps every promise of the committed snapshot', () => {
  const { breaking } = comparePluginContract(readJson(SNAPSHOT), buildPluginContract());
  assert.deepEqual(breaking, [], `Breaking plugin interface change. Payloads and the SDK are additive only; a breaking manifest change needs a new manifestVersion (see "Compatibility rules" in docs/docs/plugins/authoring.md).\n${breaking.join('\n')}`);
});

test('the committed snapshot records the current interface', () => {
  const { additions } = comparePluginContract(readJson(SNAPSHOT), buildPluginContract());
  assert.deepEqual(additions, [], `The plugin interface grew. ${UPDATE}\n${additions.join('\n')}`);
  assert.deepEqual(buildPluginContract(), readJson(SNAPSHOT), `The snapshot is out of date. ${UPDATE}`);
});

test('every journal event type has a payload contract, and nothing else does', () => {
  assert.deepEqual(Object.keys(PLUGIN_EVENT_PAYLOAD_FIELDS).sort(), pluginEventNames().sort());
});

test('the current manifest version is read', () => {
  assert.ok(PLUGIN_SUPPORTED_MANIFEST_VERSIONS.includes(PLUGIN_MANIFEST_VERSION));
});

test('the fixture of an earlier interface shows every kind of breaking change', () => {
  const { breaking } = comparePluginContract(readJson(FIXTURE), buildPluginContract());
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
  ];
  for (const message of expected) assert.ok(breaking.includes(message), `expected "${message}" in\n${breaking.join('\n')}`);
  // Nothing the fixture lists unchanged is reported.
  assert.ok(!breaking.some(message => /field (id|seq|baseRef|cursor) /.test(message) || /getIssue|permission_denied|definePluginHandler/.test(message)), breaking.join('\n'));
});

test('a breaking change to the current interface fails the comparison', () => {
  const snapshot = readJson(SNAPSHOT);
  const changed = structuredClone(buildPluginContract());
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
  const previous = structuredClone(buildPluginContract());
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
  const { breaking, additions } = comparePluginContract(previous, buildPluginContract());
  assert.deepEqual(breaking, []);
  for (const message of [
    'events: pull_request.opened payload: field draft was added', 'events: event type epic_queue.started was added', 'sdk: ctx.propr.removeLabel was added',
    'sdk: event input: field manual was added', 'manifest: field connections[]{type=token}.authorization was added', 'manifest: field category accepts "context"',
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
