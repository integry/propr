import test, { mock, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { PluginSdkError, type PluginEventInput, type PluginHandlerInput, type PluginHandlerModule, type PluginContext } from '@propr/shared';

/**
 * The official `webhooks` plugin end to end against SQLite: installed through
 * the real plugin store (save-time URL checks), run through the real handler
 * runner and `ctx.http` (call-time host checks and signing) and delivered by
 * the real dispatcher (Retry-After and permanent failures). Journal appends
 * publish no activity event (no Redis in tests).
 */
await mock.module('../src/utils/eventPublisher.js', { namedExports: { getEventPublisher: () => ({ publishActivity: async () => true }) } });
const { getOfficialPlugin, loadPluginHandlers } = await import('../../plugins/src/index.js');
const { extensionTestResources } = await import('./helpers/extensionTestResources.js');
const { drain } = await import('./helpers/pluginDispatcherFixture.js');
const { PluginError, PluginStore } = await import('../src/plugins/pluginStore.js');
const { PluginDispatcher } = await import('../src/plugins/pluginDispatcher.js');
const { runPluginHandler } = await import('../src/plugins/pluginHandlerRunner.js');
const { listPluginActivity, retryPluginDelivery } = await import('../src/plugins/pluginDeliveries.js');
const { appendRepositoryEvent } = await import('../src/services/repositoryEventJournal.js');
const migrations = await Promise.all([
  '20261013210000_extension_profiles', '20261013220000_extension_grant_network', '20261113000000_extension_library', '20261113120000_extension_oauth',
  '20261114000000_plugin_installations', '20261114180000_plugin_state', '20261112160000_create_repository_events', '20261114120000_add_task_repository_event_domain',
  '20261115000000_plugin_event_deliveries', '20261116000000_plugin_webhook_keys', '20261116120000_plugin_command_settings',
].map(name => import(`../src/db/migrations/${name}.js`) as Promise<{ up: (database: unknown) => Promise<void> }>));

const ID = 'webhooks';
const SECRET = 'whsec-core-test-0123456789abcdef0123456789';
const ENVIRONMENT = { SYSTEM_TASK_SECRET: 'plugin-webhooks-test-root' };
const manifest = getOfficialPlugin(ID, { includeDevelopment: false })!.manifest;
const catalog = async () => [manifest];

/** Hosts the fake resolver knows: two public, one private. */
const ADDRESSES: Record<string, string> = { 'hooks.public.example': '93.184.216.34', 'hooks.second.example': '93.184.216.35', 'hooks.private.example': '10.0.0.5' };

interface Sent { host: string; address: string; headers: Record<string, string>; body: string }

async function setup(t: TestContext) {
  const database = extensionTestResources(t).database();
  await database.schema.createTable('instance_members', c => { c.string('github_user_id').primary(); c.string('role'); });
  await database('instance_members').insert([{ github_user_id: '1', role: 'admin' }, { github_user_id: '2', role: 'member' }]);
  await database.schema.createTable('agent_definitions', c => { c.string('id').primary(); c.string('name'); });
  for (const { up } of migrations) await up(database);
  const addresses = { ...ADDRESSES };
  const lookups: string[] = [];
  const lookup = async (host: string) => {
    lookups.push(host);
    if (!addresses[host]) throw new Error('ENOTFOUND');
    return [{ address: addresses[host], family: 4 }];
  };
  const store = new PluginStore(database, ENVIRONMENT, catalog);
  store.hostLookup = lookup;
  const sent: Sent[] = [];
  let answer: { status: number; headers?: Record<string, string> } = { status: 204 };
  /** Answers of particular hosts, ahead of `answer`. */
  const hostAnswers: Record<string, { status: number; headers?: Record<string, string> }> = {};
  const options = {
    database, environment: ENVIRONMENT, catalog, lookup,
    handlers: (id: string) => loadPluginHandlers(id, { includeDevelopment: false }),
    transport: async (request: { url: URL; address: string; headers: Record<string, string>; body?: Buffer }) => {
      sent.push({ host: request.url.hostname, address: request.address, headers: { ...request.headers }, body: request.body?.toString('utf8') ?? '' });
      const reply = hostAnswers[request.url.hostname] ?? answer;
      return { status: reply.status, headers: reply.headers ?? {}, body: Buffer.from('ok') };
    },
  };
  const answerWith = (next: typeof answer) => { answer = next; };
  return { database, store, lookups, addresses, sent, options, answerWith, hostAnswers };
}

const refused = (status: number, pattern: RegExp) => (error: unknown) => {
  assert.ok(error instanceof PluginError, String(error));
  assert.equal(error.status, status, error.message);
  assert.match(error.message, pattern);
  return true;
};
const verifies = (sent: Sent, secret = SECRET) => sent.headers['x-propr-signature'] === `sha256=${createHmac('sha256', secret).update(`${sent.headers['x-propr-timestamp']}.${sent.body}`).digest('hex')}`;

test('a target URL to a private address or plain HTTP is refused at save time', async t => {
  const s = await setup(t);
  await s.store.install('1', ID);
  for (const [url, pattern] of [
    ['http://hooks.public.example/propr', /^target1Url must be an https:\/\/ URL, not http$/],
    ['https://10.0.0.5/propr', /^target1Url must name a public host such as hooks\.example\.com, not an IP address$/],
    ['https://localhost/propr', /^target1Url must name a public host/],
    ['https://hooks.private.example/propr', /^target1Url must point to a public address: hooks\.private\.example resolves to a private, loopback or reserved address$/],
    ['https://hooks.unknown.example/propr', /^target1Url could not be checked: hooks\.unknown\.example could not be resolved$/],
  ] as const) {
    await assert.rejects(s.store.updateSettings('1', ID, { target1Url: url }), refused(400, pattern), url);
  }
  // A non-administrator causes no lookup.
  const before = s.lookups.length;
  await assert.rejects(s.store.updateSettings('2', ID, { target1Url: 'https://hooks.second.example/x' }), refused(403, /administrator/));
  assert.equal(s.lookups.length, before);

  const view = await s.store.updateSettings('1', ID, { target1Url: 'https://hooks.public.example/propr', target2Url: 'https://hooks.second.example/in' });
  assert.equal(view.installation!.settings.target1Url, 'https://hooks.public.example/propr');
  assert.deepEqual(view.manifest!.outboundHostsFromSettings, ['target1Url', 'target2Url', 'target3Url']);

  // A URL saved before is not looked up again, so a DNS failure never blocks saving another setting.
  delete s.addresses['hooks.public.example']; delete s.addresses['hooks.second.example'];
  const lookups = s.lookups.length;
  await s.store.updateSettings('1', ID, { target1Url: 'https://hooks.public.example/propr', target2Url: 'https://hooks.second.example/in', target1Events: ['task.completed'] });
  assert.equal(s.lookups.length, lookups);
});

async function enabled(s: Awaited<ReturnType<typeof setup>>, settings: Record<string, unknown> = { target1Url: 'https://hooks.public.example/propr' }) {
  await s.store.install('1', ID);
  await s.store.updateSettings('1', ID, settings);
  await s.store.setConnection('1', ID, 'target-1-secret', SECRET);
  await s.store.setEnabled('1', ID, true);
}

const merged = (seq: number): PluginEventInput => ({
  kind: 'event', deliveryId: `evt-${seq}-deliver`, attempt: 1,
  event: { seq, repository: 'acme/api', domain: 'pull_request', type: 'merged', entityId: '12', prNumber: 12, issueNumber: null, planId: null, headSha: null, payload: {}, occurredAt: '2026-11-16T12:00:00.000Z' },
});

test('the real ctx.http signs each delivery with the target secret and reaches only hosts derived from the settings', async t => {
  const s = await setup(t);
  await enabled(s);
  const run = await runPluginHandler(ID, 'deliver', merged(9), s.options);
  assert.equal(run.outcome, 'succeeded', run.error ?? '');
  assert.deepEqual(run.result, { event: 'pull_request.merged', delivered: ['target-1'] });
  assert.equal(s.sent.length, 1);
  const [request] = s.sent;
  assert.equal(request.host, 'hooks.public.example'); assert.equal(request.address, '93.184.216.34', 'the checked address is dialled');
  assert.ok(verifies(request), 'the signature verifies with the documented algorithm');
  assert.equal(request.headers.authorization, undefined, 'a signing secret is never sent as a credential');
  assert.equal(JSON.stringify(request).includes(SECRET), false);
  assert.equal(JSON.parse(request.body).id, 'evt-9-deliver.target-1');
  assert.equal(JSON.stringify(run).includes(SECRET), false);

  // A handler of the plugin trying other hosts, unsigned requests or a signature without a signing connection.
  const probe = async (call: (ctx: PluginContext) => Promise<unknown>) => {
    let code: string | undefined;
    const handlers = async (): Promise<PluginHandlerModule> => ({ probe: async (_input: PluginHandlerInput, ctx: PluginContext) => { try { await call(ctx); code = 'sent'; } catch (error) { code = error instanceof PluginSdkError ? error.code : String(error); } } });
    const result = await runPluginHandler(ID, 'probe', { kind: 'invoke', payload: {} }, { ...s.options, handlers });
    assert.equal(result.outcome, 'succeeded', result.error ?? '');
    return code;
  };
  const signature = { header: 'x-sig' };
  assert.equal(await probe(ctx => ctx.http('target-1-secret')('https://hooks.second.example/in', { method: 'POST', body: '{}', signature })), 'host_not_allowed', 'a host not derived from the settings is refused at call time');
  assert.equal(await probe(ctx => ctx.http('target-1-secret')('http://hooks.public.example/propr', { method: 'POST', body: '{}', signature })), 'insecure_url');
  assert.equal(await probe(ctx => ctx.http('target-1-secret')('https://hooks.public.example/propr', { method: 'POST', body: '{}' })), 'invalid_input', 'a signing connection needs a signature');
  assert.equal(await probe(ctx => ctx.http()('https://hooks.public.example/propr', { method: 'POST', body: '{}', signature })), 'invalid_input', 'a signature needs a signing connection');
  assert.equal(await probe(ctx => ctx.http('target-1-secret')('https://hooks.public.example/propr', { method: 'POST', body: '{}', headers: { 'x-sig': 'mine' }, signature })), 'invalid_input', 'the handler cannot set the signature header');
  assert.equal(await probe(ctx => ctx.http('target-2-secret')('https://hooks.public.example/propr', { method: 'POST', body: '{}', signature })), 'connection_unavailable', 'an unset secret sends nothing');
  // The host now resolves to a private address: refused on the request, as the endpoint policy requires.
  s.addresses['hooks.public.example'] = '127.0.0.1';
  assert.equal(await probe(ctx => ctx.http('target-1-secret')('https://hooks.public.example/propr', { method: 'POST', body: '{}', signature })), 'private_address');
  assert.equal(s.sent.length, 1, 'none of the refused requests was sent');
});

test('through the dispatcher, a 429 with Retry-After is retried after the delay and a permanent error fails the delivery at once', async t => {
  const s = await setup(t);
  await enabled(s);
  const clock = { now: 1_800_000_000_000 };
  const dispatcher = new PluginDispatcher({ ...s.options, now: () => clock.now, timeoutMs: 5_000, pauseAfterFailures: 100, notify: async () => undefined });
  const append = async (type: string, prNumber: number) => {
    const result = await appendRepositoryEvent(s.database, { repository: 'acme/api', domain: 'pull_request', type, entityId: prNumber, prNumber, payload: {} }, { publish: false });
    return (result as { seq: number }).seq;
  };
  const deliveries = async () => (await listPluginActivity(s.database, ID)).deliveries;

  const seq = await append('merged', 12);
  s.answerWith({ status: 429, headers: { 'retry-after': '90' } });
  assert.equal(await drain(dispatcher), 1);
  let [record] = await deliveries();
  assert.equal(record.status, 'retrying'); assert.equal(record.attempt, 1);
  assert.equal(record.nextAttemptAt, clock.now + 90_000, 'the next attempt waits for the target\'s Retry-After, not the 1 minute schedule');
  assert.equal(record.error, 'Target 1 (hooks.public.example) answered HTTP 429; it asked to retry after 90 s');
  clock.now += 89_999;
  assert.equal(await drain(dispatcher), 0, 'nothing is sent before the delay');
  clock.now += 1;
  s.answerWith({ status: 200 });
  assert.equal(await drain(dispatcher), 1);
  [record] = await deliveries();
  assert.equal(record.status, 'succeeded'); assert.equal(record.attempt, 2);
  assert.equal(s.sent.length, 2);
  assert.deepEqual(s.sent.map(r => r.headers['x-propr-delivery']), [`evt-${seq}-deliver.target-1`, `evt-${seq}-deliver.target-1`], 'the same delivery id on the retry');
  assert.ok(s.sent.every(r => verifies(r)));

  // Unselected events produce nothing: head_changed is not subscribed.
  await append('head_changed', 12);
  assert.equal(await drain(dispatcher), 0);

  s.answerWith({ status: 410 });
  await append('closed', 13);
  assert.equal(await drain(dispatcher), 1);
  const failed = (await deliveries()).find(d => d.eventType === 'pull_request.closed')!;
  assert.equal(failed.status, 'failed'); assert.equal(failed.attempt, 1); assert.equal(failed.nextAttemptAt, null);
  assert.equal(failed.error, 'Target 1 (hooks.public.example) refused the delivery with HTTP 410; it is not retried. Check the target URL and the endpoint\'s configuration');
  assert.equal(await drain(dispatcher), 0, 'a permanent failure is not retried');
  await dispatcher.stop();
});

test('through the dispatcher, a manual Retry asks again the target that refused and skips the one that has the event', async t => {
  const s = await setup(t);
  await enabled(s, { target1Url: 'https://hooks.public.example/propr', target2Url: 'https://hooks.second.example/in' });
  await s.store.setConnection('1', ID, 'target-2-secret', SECRET);
  const clock = { now: 1_800_000_000_000 };
  const dispatcher = new PluginDispatcher({ ...s.options, now: () => clock.now, timeoutMs: 5_000, pauseAfterFailures: 100, notify: async () => undefined });
  await appendRepositoryEvent(s.database, { repository: 'acme/api', domain: 'pull_request', type: 'merged', entityId: 12, prNumber: 12, payload: {} }, { publish: false });
  s.hostAnswers['hooks.second.example'] = { status: 410 };
  assert.equal(await drain(dispatcher), 1);
  const [failed] = (await listPluginActivity(s.database, ID)).deliveries;
  assert.equal(failed.status, 'failed'); assert.match(failed.error!, /^Target 2 \(hooks\.second\.example\) refused the delivery with HTTP 410/);
  assert.deepEqual(s.sent.map(r => r.host), ['hooks.public.example', 'hooks.second.example']);

  // The administrator fixes target 2 and selects Retry.
  s.hostAnswers['hooks.second.example'] = { status: 200 };
  await retryPluginDelivery(s.database, ID, String(failed.id), '1', clock.now);
  assert.equal(await drain(dispatcher), 1);
  const [done] = (await listPluginActivity(s.database, ID)).deliveries;
  assert.equal(done.status, 'succeeded'); assert.equal(done.attempt, 2);
  assert.deepEqual(s.sent.map(r => r.host), ['hooks.public.example', 'hooks.second.example', 'hooks.second.example'], 'target 1 already had it');
  await dispatcher.stop();
});
