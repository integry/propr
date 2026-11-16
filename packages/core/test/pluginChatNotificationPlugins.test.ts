import test, { mock, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { PLUGIN_CONNECTION_URL, PluginSdkError, type PluginContext, type PluginEventInput, type PluginHandlerInput, type PluginHandlerModule } from '@propr/shared';

/**
 * The chat notification plugins (Slack, Discord, Microsoft Teams) end to end
 * against SQLite: webhook URLs stored as secret URL `token` connections
 * through the real plugin store (save-time host checks), sent through the
 * real handler runner and `ctx.http` (the stored URL is the request's URL;
 * the handler never sees it) and delivered by the real dispatcher
 * (Retry-After and permanent failures).
 */
await mock.module('../src/utils/eventPublisher.js', { namedExports: { getEventPublisher: () => ({ publishActivity: async () => true }) } });
const { getOfficialPlugin, loadPluginHandlers } = await import('../../plugins/src/index.js');
const { extensionTestResources } = await import('./helpers/extensionTestResources.js');
const { drain } = await import('./helpers/pluginDispatcherFixture.js');
const { PluginError, PluginStore } = await import('../src/plugins/pluginStore.js');
const { PluginDispatcher } = await import('../src/plugins/pluginDispatcher.js');
const { runPluginHandler } = await import('../src/plugins/pluginHandlerRunner.js');
const { listPluginActivity } = await import('../src/plugins/pluginDeliveries.js');
const { appendRepositoryEvent } = await import('../src/services/repositoryEventJournal.js');
const migrations = await Promise.all([
  '20261013210000_extension_profiles', '20261013220000_extension_grant_network', '20261113000000_extension_library', '20261113120000_extension_oauth',
  '20261114000000_plugin_installations', '20261114180000_plugin_state', '20261112160000_create_repository_events', '20261114120000_add_task_repository_event_domain',
  '20261115000000_plugin_event_deliveries', '20261116000000_plugin_webhook_keys', '20261116120000_plugin_command_settings',
].map(name => import(`../src/db/migrations/${name}.js`) as Promise<{ up: (database: unknown) => Promise<void> }>));

const ENVIRONMENT = { SYSTEM_TASK_SECRET: 'plugin-chat-test-root' };
const manifests = ['slack', 'discord', 'teams'].map(id => getOfficialPlugin(id, { includeDevelopment: false })!.manifest);
const catalog = async () => manifests;
const SLACK_URL = 'https://hooks.slack.com/services/T0001/B0001/secretpart0123456789abcd';
const SLACK_URL_2 = 'https://hooks.slack.com/services/T0001/B0002/otherpart0123456789abcd';

interface Sent { url: string; address: string; headers: Record<string, string>; body: string }

async function setup(t: TestContext) {
  const database = extensionTestResources(t).database();
  await database.schema.createTable('instance_members', c => { c.string('github_user_id').primary(); c.string('role'); });
  await database('instance_members').insert([{ github_user_id: '1', role: 'admin' }, { github_user_id: '2', role: 'member' }]);
  await database.schema.createTable('agent_definitions', c => { c.string('id').primary(); c.string('name'); });
  for (const { up } of migrations) await up(database);
  const addresses: Record<string, string> = { 'hooks.slack.com': '34.192.0.10' };
  const lookup = async (host: string) => {
    if (!addresses[host]) throw new Error('ENOTFOUND');
    return [{ address: addresses[host], family: 4 }];
  };
  const store = new PluginStore(database, ENVIRONMENT, catalog);
  store.hostLookup = lookup;
  const sent: Sent[] = [];
  let answer: { status: number; headers?: Record<string, string>; body?: string } = { status: 200, body: 'ok' };
  const options = {
    database, environment: ENVIRONMENT, catalog, lookup,
    handlers: (id: string) => loadPluginHandlers(id, { includeDevelopment: false }),
    transport: async (request: { url: URL; address: string; headers: Record<string, string>; body?: Buffer }) => {
      sent.push({ url: request.url.toString(), address: request.address, headers: { ...request.headers }, body: request.body?.toString('utf8') ?? '' });
      return { status: answer.status, headers: answer.headers ?? {}, body: Buffer.from(answer.body ?? '') };
    },
  };
  return { database, store, sent, addresses, options, answerWith: (next: typeof answer) => { answer = next; } };
}

const refused = (status: number, pattern: RegExp) => (error: unknown) => {
  assert.ok(error instanceof PluginError, String(error));
  assert.equal(error.status, status, error.message);
  assert.match(error.message, pattern);
  return true;
};

const merged = (seq: number, repository = 'acme/api'): PluginEventInput => ({
  kind: 'event', deliveryId: `evt-${seq}-notify`, attempt: 1,
  event: { seq, repository, domain: 'pull_request', type: 'merged', entityId: '12', prNumber: 12, issueNumber: null, planId: null, headSha: null, payload: {}, occurredAt: '2026-11-16T12:00:00.000Z' },
});

test('a webhook URL is stored only on the vendor\'s documented host and path, and is never shown again', async t => {
  const s = await setup(t);
  for (const [id, good, bad, pattern] of [
    ['slack', SLACK_URL, 'https://hooks.example.com/services/T/B/x', /^Default webhook URL: The URL must be on one of hooks\.slack\.com, hooks\.slack-gov\.com, not hooks\.example\.com$/],
    ['discord', 'https://discord.com/api/webhooks/1/tok', 'https://discord.com/api/v10/channels/1/messages', /^Default webhook URL: The URL's path must start with \/api\/webhooks\/ or \/api\/v10\/webhooks\/$/],
    ['teams', 'https://default01.cd.environment.api.powerplatform.com:443/powerautomate/automations/direct/workflows/a/triggers/manual/paths/invoke?sig=s', 'https://contoso.webhook.office.com/webhookb2/x',
      /^Default webhook URL: The URL must be on one of \*\.environment\.api\.powerplatform\.com, \*\.logic\.azure\.com, not contoso\.webhook\.office\.com$/],
  ] as const) {
    await s.store.install('1', id);
    await assert.rejects(s.store.setConnection('1', id, 'default-webhook', bad), refused(400, pattern), id);
    await assert.rejects(s.store.setConnection('1', id, 'default-webhook', good.replace('https:', 'http:')), refused(400, /^Default webhook URL: The URL must be an https:\/\/ URL$/));
    const view = await s.store.setConnection('1', id, 'default-webhook', good);
    const connection = view.connections.find(c => c.name === 'default-webhook')!;
    assert.equal(connection.state, 'connected');
    assert.equal(JSON.stringify(view).includes(good), false, 'the stored URL is never part of the view');
    assert.equal(JSON.stringify(await s.store.get('1', id)).includes(good), false);
  }
});

test('the real ctx.http posts to the stored URL without a credential header, and the handler never sees the URL', async t => {
  const s = await setup(t);
  await s.store.install('1', 'slack');
  await s.store.setConnection('1', 'slack', 'default-webhook', SLACK_URL);
  await s.store.setConnection('1', 'slack', 'webhook-2', SLACK_URL_2);
  await s.store.updateSettings('1', 'slack', { repositoryDestinations: { 'acme/web': 'webhook-2' } });
  await s.store.setEnabled('1', 'slack', true);

  const run = await runPluginHandler('slack', 'notify', merged(9), s.options);
  assert.equal(run.outcome, 'succeeded', run.error ?? '');
  assert.deepEqual(run.result, { event: 'pull_request.merged', kind: 'pull_request.merged', destination: 'default-webhook', skipped: null });
  const web = await runPluginHandler('slack', 'notify', merged(10, 'acme/web'), s.options);
  assert.equal(web.outcome, 'succeeded', web.error ?? '');
  assert.deepEqual(s.sent.map(r => r.url), [SLACK_URL, SLACK_URL_2]);
  const [request] = s.sent;
  assert.equal(request.address, '34.192.0.10', 'the checked address is dialled');
  assert.equal(request.headers.authorization, undefined, 'a webhook URL is never sent as a credential');
  assert.equal(JSON.parse(request.body).text, 'Pull request #12 merged in acme/api');
  assert.equal(JSON.stringify([run, web]).includes('secretpart'), false, 'the URL is in neither the result nor the logs');

  const probe = async (call: (ctx: PluginContext) => Promise<unknown>) => {
    let outcome: unknown;
    const handlers = async (): Promise<PluginHandlerModule> => ({ probe: async (_input: PluginHandlerInput, ctx: PluginContext) => {
      try { outcome = await call(ctx); } catch (error) { outcome = error instanceof PluginSdkError ? error.code : String(error); }
    } });
    const result = await runPluginHandler('slack', 'probe', { kind: 'invoke', payload: {} }, { ...s.options, handlers });
    assert.equal(result.outcome, 'succeeded', result.error ?? '');
    return { outcome, result };
  };
  // A response echoing the URL (or its path) reaches the handler scrubbed, and names the placeholder, not the URL.
  s.answerWith({ status: 200, headers: { 'x-echo': SLACK_URL }, body: `posted to ${SLACK_URL} at ${new URL(SLACK_URL).pathname}` });
  const echoed = await probe(async ctx => {
    const response = await ctx.http('default-webhook')(PLUGIN_CONNECTION_URL, { method: 'POST', body: '{}' });
    ctx.log.info(`got ${await response.text()}`);
    return { url: response.url, header: response.headers['x-echo'], text: await response.text() };
  });
  assert.deepEqual(echoed.outcome, { url: PLUGIN_CONNECTION_URL, header: '[REDACTED]', text: 'posted to [REDACTED] at [REDACTED]' });
  assert.equal(JSON.stringify(echoed.result).includes('secretpart'), false);

  const before = s.sent.length;
  assert.equal((await probe(ctx => ctx.http('default-webhook')(SLACK_URL, { method: 'POST', body: '{}' }))).outcome, 'invalid_input', 'a webhook connection sends only to its stored URL');
  assert.equal((await probe(ctx => ctx.http('default-webhook')(PLUGIN_CONNECTION_URL, { method: 'POST', body: '{}', signature: { header: 'x-sig' } }))).outcome, 'invalid_input');
  assert.equal((await probe(ctx => ctx.http()('https://hooks.slack.com/services/T/B/x', { method: 'POST', body: '{}' }))).outcome, 'host_not_allowed', 'without the connection no host is allowed');
  assert.equal((await probe(ctx => ctx.http('webhook-3')(PLUGIN_CONNECTION_URL, { method: 'POST', body: '{}' }))).outcome, 'connection_unavailable');
  s.addresses['hooks.slack.com'] = '10.0.0.5';
  assert.equal((await probe(ctx => ctx.http('default-webhook')(PLUGIN_CONNECTION_URL, { method: 'POST', body: '{}' }))).outcome, 'private_address', 'the stored URL\'s host must still resolve publicly');
  assert.equal(s.sent.length, before, 'none of the refused requests was sent');
});

test('a query-bearing Teams URL echoed as separate path, query and signature fields reaches neither the handler nor its logs', async t => {
  const s = await setup(t);
  const workflow = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
  const sig = 'SiGnAtUrE_0123456789abcdefGHIJKLmnopqrstuvwx';
  const teamsUrl = `https://prod-12.westus.logic.azure.com:443/workflows/${workflow}/triggers/manual/paths/invoke?api-version=2016-06-01&sp=%2Ftriggers%2Fmanual%2Frun&sv=1.0&sig=${sig}`;
  s.addresses['prod-12.westus.logic.azure.com'] = '20.42.0.10';
  await s.store.install('1', 'teams');
  await s.store.setConnection('1', 'teams', 'default-webhook', teamsUrl);
  await s.store.setEnabled('1', 'teams', true);
  const url = new URL(teamsUrl);
  const echo = { path: url.pathname, query: url.search, rawQuery: url.search.slice(1), sig, sp: url.searchParams.get('sp'), workflow, version: 'api-version=2016-06-01' };
  s.answerWith({ status: 200, headers: { 'content-type': 'application/json', 'x-sig': sig }, body: JSON.stringify(echo) });
  let seen: unknown;
  const handlers = async (): Promise<PluginHandlerModule> => ({ probe: async (_input: PluginHandlerInput, ctx: PluginContext) => {
    const response = await ctx.http('default-webhook')(PLUGIN_CONNECTION_URL, { method: 'POST', body: '{}' });
    const text = await response.text();
    const fields = JSON.parse(text) as Record<string, string>;
    // Logging the separate components, or the raw values, is redacted as well.
    ctx.log.info(`echo ${fields.path} ${fields.query} ${fields.sig}`, { fields });
    ctx.log.info(`raw ${url.pathname} ${url.search.slice(1)} ${sig} ${workflow}`);
    seen = { header: response.headers['x-sig'], fields };
  } });
  const run = await runPluginHandler('teams', 'probe', { kind: 'invoke', payload: {} }, { ...s.options, handlers });
  assert.equal(run.outcome, 'succeeded', run.error ?? '');
  assert.equal(s.sent[0].url, new URL(teamsUrl).href);
  assert.deepEqual(seen, {
    header: '[REDACTED]',
    fields: { path: '[REDACTED]', query: '[REDACTED]', rawQuery: '[REDACTED]', sig: '[REDACTED]', sp: '/triggers/manual/run', workflow: '[REDACTED]', version: 'api-version=2016-06-01' },
  });
  const everything = JSON.stringify([seen, run]);
  for (const secret of [sig, workflow, url.pathname, url.search.slice(1)]) assert.equal(everything.includes(secret), false, `${secret} leaked`);
  const messages = run.logs.map(line => line.message).filter(message => /^(echo|raw) /.test(message));
  assert.equal(messages.length, 2);
  assert.match(messages[0], /^echo \[REDACTED\] \[REDACTED\] \[REDACTED\]$/);
  assert.match(messages[1], /^raw \[REDACTED\] \[REDACTED\] \[REDACTED\] \[REDACTED\]$/);
});

test('through the dispatcher, a 429 with Retry-After is retried after the delay and a permanent error fails the delivery at once', async t => {
  const s = await setup(t);
  await s.store.install('1', 'slack');
  await s.store.setConnection('1', 'slack', 'default-webhook', SLACK_URL);
  await s.store.setEnabled('1', 'slack', true);
  const clock = { now: 1_800_000_000_000 };
  const dispatcher = new PluginDispatcher({ ...s.options, now: () => clock.now, timeoutMs: 5_000, pauseAfterFailures: 100, notify: async () => undefined });
  const append = (type: string, prNumber: number) => appendRepositoryEvent(s.database, { repository: 'acme/api', domain: 'pull_request', type, entityId: prNumber, prNumber, payload: {} }, { publish: false });
  const deliveries = async () => (await listPluginActivity(s.database, 'slack')).deliveries;

  await append('merged', 12);
  s.answerWith({ status: 429, headers: { 'retry-after': '45' }, body: 'rate_limited' });
  assert.equal(await drain(dispatcher), 1);
  let [record] = await deliveries();
  assert.equal(record.status, 'retrying');
  assert.equal(record.nextAttemptAt, clock.now + 45_000, 'the next attempt waits for Slack\'s Retry-After');
  assert.equal(record.error, 'Slack answered HTTP 429 (rate_limited) for the default webhook; it asked to retry after 45 s');
  clock.now += 44_999;
  assert.equal(await drain(dispatcher), 0, 'nothing is sent before the delay');
  clock.now += 1;
  s.answerWith({ status: 200, body: 'ok' });
  assert.equal(await drain(dispatcher), 1);
  [record] = await deliveries();
  assert.equal(record.status, 'succeeded'); assert.equal(record.attempt, 2);
  assert.equal(s.sent.length, 2);

  // head_changed is not subscribed: nothing is delivered.
  await append('head_changed', 12);
  assert.equal(await drain(dispatcher), 0);

  s.answerWith({ status: 404, body: 'no_service' });
  await append('closed', 13);
  assert.equal(await drain(dispatcher), 1);
  const failed = (await deliveries()).find(d => d.eventType === 'pull_request.closed')!;
  assert.equal(failed.status, 'failed'); assert.equal(failed.attempt, 1); assert.equal(failed.nextAttemptAt, null);
  assert.equal(failed.error, 'Slack refused the message to the default webhook with HTTP 404 (no_service); it is not retried. Check its webhook URL and that the channel still exists');
  assert.equal(JSON.stringify(await deliveries()).includes('secretpart'), false);
  await dispatcher.stop();
});
