import type { TestContext } from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PluginManifest } from '@propr/shared';
import { getOfficialPlugin, loadPluginHandlers } from '../../../plugins/src/index.js';
import { extensionTestResources } from './extensionTestResources.js';
import { up as identityMigration } from '../../src/db/migrations/20261013210000_extension_profiles.js';
import { up as grantMigration } from '../../src/db/migrations/20261013220000_extension_grant_network.js';
import { up as libraryMigration } from '../../src/db/migrations/20261113000000_extension_library.js';
import { up as oauthMigration } from '../../src/db/migrations/20261113120000_extension_oauth.js';
import { up as pluginMigration } from '../../src/db/migrations/20261114000000_plugin_installations.js';
import { up as stateMigration } from '../../src/db/migrations/20261114180000_plugin_state.js';
import { up as journalMigration } from '../../src/db/migrations/20261112160000_create_repository_events.js';
import { up as taskDomainMigration } from '../../src/db/migrations/20261114120000_add_task_repository_event_domain.js';
import { up as deliveriesMigration } from '../../src/db/migrations/20261115000000_plugin_event_deliveries.js';
import { up as webhookKeysMigration } from '../../src/db/migrations/20261116000000_plugin_webhook_keys.js';
import { up as commandSettingsMigration } from '../../src/db/migrations/20261116120000_plugin_command_settings.js';
import { PluginStore } from '../../src/plugins/pluginStore.js';
import type { PluginProprBackend } from '../../src/plugins/pluginProprClient.js';
import type { PluginHttpTransport, PluginHttpTransportRequest } from '../../src/plugins/pluginHttp.js';
import type { RunPluginHandlerOptions } from '../../src/plugins/pluginHandlerRunner.js';

/** A registry root holding the `fixture-handlers` plugin (and the lint-only `fixture-imports-core` folder). */
export const FIXTURE_REGISTRY = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'plugins');
export const FIXTURE_ID = 'fixture-handlers';
/** The event subscription fixture plugin. */
export const EVENTS_FIXTURE_ID = 'fixture-events';
export const fixtureManifest = (id = FIXTURE_ID): PluginManifest => getOfficialPlugin(id, { root: FIXTURE_REGISTRY, includeDevelopment: true })!.manifest;
export const ENVIRONMENT = { SYSTEM_TASK_SECRET: 'plugin-handler-test-root' };

/** Hosts the fake resolver knows: one public, one private. */
export const lookup = async (host: string) => {
  if (host === 'api.fixture.example') return [{ address: '93.184.216.34', family: 4 }];
  if (host === 'private.fixture.example') return [{ address: '10.0.0.5', family: 4 }];
  throw new Error('ENOTFOUND');
};

/**
 * A transport that echoes the request's headers (the injected Authorization included) back, as a careless upstream would:
 * in a header value, and the credential itself in a header name.
 */
export function echoTransport() {
  const requests: PluginHttpTransportRequest[] = [];
  const transport: PluginHttpTransport = async request => {
    requests.push(request);
    const authorization = request.headers.authorization ?? '';
    return {
      status: 200,
      headers: { 'content-type': 'application/json', 'x-echo-authorization': authorization, ...(authorization ? { [`x-echo-${authorization.slice('Bearer '.length)}`]: 'echoed' } : {}) },
      body: Buffer.from(JSON.stringify({ path: request.url.pathname, authorization, base64: Buffer.from(authorization).toString('base64') })),
    };
  };
  return { transport, requests };
}

/** A backend that records what reached it. */
export function recordingBackend() {
  const calls: { operation: string; args: unknown[] }[] = [];
  const record = <T>(operation: string, result: T) => async (...args: unknown[]) => { calls.push({ operation, args }); return result; };
  const backend: PluginProprBackend = {
    getPullRequest: record('getPullRequest', { repository: 'owner/allowed', number: 7, title: 'PR', state: 'open', url: 'https://github.com/owner/allowed/pull/7', labels: [], author: 'octo', createdAt: '', updatedAt: '', draft: false, merged: false, headRef: 'h', baseRef: 'main', headSha: 'abc' }),
    getIssue: record('getIssue', { repository: 'owner/allowed', number: 3, title: 'Issue', state: 'open', url: 'https://github.com/owner/allowed/issues/3', labels: ['bug'], author: 'octo', createdAt: '', updatedAt: '' }),
    getTask: async (taskId: string) => {
      calls.push({ operation: 'getTask', args: [taskId] });
      if (taskId === 'missing') return null;
      return { taskId, repository: taskId === 'elsewhere' ? 'other/repo' : 'owner/allowed', kind: 'implementation', issueNumber: 3, prNumber: null, state: 'completed', model: null, createdAt: '' };
    },
    listEvents: record('listEvents', []),
    createIssue: record('createIssue', { repository: 'owner/allowed', number: 11, url: 'https://github.com/owner/allowed/issues/11' }),
    createTask: async (repository, issueNumber, attribution) => { calls.push({ operation: 'createTask', args: [repository, issueNumber, attribution] }); return { repository, issueNumber, jobId: `issue-${repository.replace('/', '-')}-${issueNumber}` }; },
    comment: record('comment', { repository: 'owner/allowed', number: 3, id: 99, url: 'https://github.com/owner/allowed/issues/3#issuecomment-99' }),
    addLabel: record('addLabel', undefined),
    removeLabel: record('removeLabel', undefined),
  };
  return { backend, calls };
}

/**
 * An in-memory instance with the fixture plugin installed through the real
 * plugin store: `api-token` set (sealed), limited to `owner/allowed`, enabled.
 */
export async function pluginHandlerFixture(t: TestContext, options: { secret?: string; repositories?: string[] | null; pluginId?: string; official?: boolean; connections?: Record<string, string>; enabled?: boolean } = {}) {
  const database = extensionTestResources(t).database();
  await database.schema.createTable('instance_members', c => { c.string('github_user_id').primary(); c.string('role'); });
  await database('instance_members').insert({ github_user_id: '1', role: 'admin' });
  await database.schema.createTable('agent_definitions', c => { c.string('id').primary(); c.string('name'); });
  for (const migrate of [identityMigration, grantMigration, libraryMigration, oauthMigration, pluginMigration, stateMigration, journalMigration, taskDomainMigration, deliveriesMigration, webhookKeysMigration, commandSettingsMigration]) await migrate(database);
  const pluginId = options.pluginId ?? FIXTURE_ID;
  // `official`: a plugin of the real registry (packages/plugins) instead of the test fixtures.
  const manifest = options.official ? getOfficialPlugin(pluginId, { includeDevelopment: false })!.manifest : fixtureManifest(pluginId);
  const catalog = async () => [manifest];
  const store = new PluginStore(database, ENVIRONMENT, catalog);
  await store.install('1', pluginId);
  if (options.secret) await store.setConnection('1', pluginId, 'api-token', options.secret);
  // Connections set before enabling: a token connection a contributed MCP server uses is required to enable.
  for (const [name, value] of Object.entries(options.connections ?? {})) await store.setConnection('1', pluginId, name, value);
  await store.setRepositories('1', pluginId, options.repositories === undefined ? ['owner/allowed'] : options.repositories);
  if (options.enabled !== false) await store.setEnabled('1', pluginId, true);
  const { backend, calls } = recordingBackend();
  const http = echoTransport();
  const runOptions: RunPluginHandlerOptions = {
    database, environment: ENVIRONMENT, catalog, backend, lookup, transport: http.transport,
    handlers: id => (options.official ? loadPluginHandlers(id, { includeDevelopment: false }) : loadPluginHandlers(id, { root: FIXTURE_REGISTRY, includeDevelopment: true })),
  };
  return { database, store, manifest, backend, calls, http, options: runOptions };
}
