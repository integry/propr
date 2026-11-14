import test from 'node:test';
import assert from 'node:assert/strict';
import { PLUGIN_STATE_LIMITS, type PluginHandlerInput, type PluginJsonValue } from '@propr/shared';
import { runPluginHandler } from '../src/plugins/pluginHandlerRunner.js';
import { FIXTURE_ID, pluginHandlerFixture } from './helpers/pluginHandlerFixture.js';

const invoke = (payload: PluginJsonValue = {}): PluginHandlerInput => ({ kind: 'invoke', payload });
const SENTINEL = 'plugin-http-credential-sentinel-5d0e9a';

test('runPluginHandler runs a fixture handler and returns its outcome, result, duration and redacted logs', async t => {
  const f = await pluginHandlerFixture(t);
  const run = await runPluginHandler(FIXTURE_ID, 'succeed', invoke(), f.options);
  assert.equal(run.outcome, 'succeeded', run.error ?? '');
  assert.equal(run.timedOut, false);
  assert.equal(run.error, null);
  assert.ok(run.durationMs >= 0);
  assert.deepEqual(run.result, { greeting: 'hi', repositories: ['owner/allowed'] });
  assert.deepEqual(run.logs.map(l => [l.level, l.message]).slice(0, 1), [['info', 'fixture handler ran']]);
  assert.deepEqual(run.logs[0].fields, { kind: 'invoke', greeting: 'hi' });
  assert.doesNotMatch(JSON.stringify(run.logs), /ghp_0123456789/, 'log lines pass the secret redaction');
  assert.match(run.logs[1].message, /REDACTED/);
});

test('a throwing handler, a hanging handler and other failures return a failed outcome without throwing', async t => {
  const f = await pluginHandlerFixture(t);
  const thrown = await runPluginHandler(FIXTURE_ID, 'throws', invoke(), f.options);
  assert.equal(thrown.outcome, 'failed');
  assert.equal(thrown.timedOut, false);
  assert.equal(thrown.error, 'fixture handler failure');
  assert.deepEqual(thrown.logs.map(l => l.message), ['about to fail']);

  const started = Date.now();
  const hung = await runPluginHandler(FIXTURE_ID, 'hangs', invoke(), { ...f.options, timeoutMs: 150 });
  assert.equal(hung.outcome, 'failed');
  assert.equal(hung.timedOut, true);
  assert.match(hung.error ?? '', /did not finish within/);
  assert.ok(Date.now() - started < 5_000);
  assert.deepEqual(hung.logs.map(l => l.message), ['hanging'], 'nothing the handler does after the time limit is logged');
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(await f.database('plugin_state').where({ plugin_id: FIXTURE_ID, state_key: 'late' }).first(), undefined, 'ctx refuses calls once the run has ended');

  for (const [handler, pattern] of [['missing', /has no handler missing/], ['notAFunction', /has no handler/], ['returnsTooMuch', /more than 16384 bytes/], ['constructor', /has no handler/], ['../x', /Invalid handler name/]] as const) {
    const run = await runPluginHandler(FIXTURE_ID, handler, invoke(), f.options);
    assert.equal(run.outcome, 'failed', handler);
    assert.match(run.error ?? '', pattern, handler);
  }
  // A broken handler source, an unknown plugin and a disabled plugin fail the same way.
  assert.equal((await runPluginHandler(FIXTURE_ID, 'succeed', invoke(), { ...f.options, handlers: async () => { throw new Error('registry unavailable'); } })).error, 'registry unavailable');
  assert.match((await runPluginHandler('not-installed', 'succeed', invoke(), f.options)).error ?? '', /not in this ProPR's registry/);
  await f.store.setEnabled('1', FIXTURE_ID, false);
  assert.match((await runPluginHandler(FIXTURE_ID, 'succeed', invoke(), f.options)).error ?? '', /is not enabled/);
});

test('the official registry loads example-pack handlers through the plugin registry', async t => {
  const f = await pluginHandlerFixture(t);
  const { getOfficialPlugin } = await import('../../plugins/src/index.js');
  const example = getOfficialPlugin('example-pack', { includeDevelopment: true })!;
  assert.ok(example.assets.handlers?.endsWith('example-pack/handlers.ts'));
  const { loadPluginHandlers } = await import('../../plugins/src/index.js');
  const handlers = await loadPluginHandlers('example-pack', { includeDevelopment: true });
  assert.equal(typeof handlers?.recordEvent, 'function');
  assert.equal(await loadPluginHandlers('example-pack', { includeDevelopment: false }), null, 'a development plugin is hidden without the flag');
  const record = { installedVersion: '0.1.0', enabled: true, settings: {}, repositories: null, grantedPermissions: example.manifest.permissions, acknowledgements: {}, installedBy: '1', installedAt: 0, updatedBy: '1', updatedAt: 0 };
  // ctx.state writes need the installation to exist: the row the record describes.
  await f.database('plugin_installations').insert({ plugin_id: 'example-pack', manifest_version: '0.1.0', enabled: true, granted_permissions: JSON.stringify(example.manifest.permissions), installed_by: '1', installed_at: 0, updated_by: '1', updated_at: 0 });
  const run = await runPluginHandler({ pluginId: 'example-pack', manifest: example.manifest, record }, 'recordEvent', {
    kind: 'event', event: { seq: 12, repository: 'owner/allowed', domain: 'task', type: 'completed', entityId: 'task-1', prNumber: null, issueNumber: 3, planId: null, headSha: null, payload: {}, occurredAt: '' },
  }, { ...f.options, handlers: async id => loadPluginHandlers(id, { includeDevelopment: true }) });
  assert.equal(run.outcome, 'succeeded', run.error ?? '');
  assert.deepEqual(run.result, { repository: 'owner/allowed', cursor: 12 });
  assert.match(run.logs[0].message, /task task-1 is completed/);
});

test('ctx.state enforces its key, size and key-count limits and is deleted on uninstall', async t => {
  const f = await pluginHandlerFixture(t);
  const state = async (payload: PluginJsonValue) => (await runPluginHandler(FIXTURE_ID, 'useState', invoke(payload), f.options)).result as { ok: boolean; value?: PluginJsonValue; code?: string };

  assert.deepEqual(await state({ op: 'set', key: 'pr:owner/allowed#7', value: { thread: 'C123/1700000000.1' } }), { ok: true });
  assert.deepEqual(await state({ op: 'get', key: 'pr:owner/allowed#7' }), { ok: true, value: { thread: 'C123/1700000000.1' } });
  assert.deepEqual(await state({ op: 'keys', prefix: 'pr:' }), { ok: true, value: ['pr:owner/allowed#7'] });

  // Too large a value, a bad key and an over-long key are refused.
  assert.equal((await state({ op: 'set', key: 'big', value: 'x'.repeat(PLUGIN_STATE_LIMITS.valueBytes) })).code, 'state_limit');
  assert.equal((await state({ op: 'set', key: 'has space', value: 1 })).code, 'invalid_input');
  assert.equal((await state({ op: 'set', key: 'k'.repeat(PLUGIN_STATE_LIMITS.keyLength + 1), value: 1 })).code, 'invalid_input');

  // The total size limit: fill with values just under the per-value limit.
  const chunk = 'y'.repeat(PLUGIN_STATE_LIMITS.valueBytes - 100);
  const fits = Math.floor(PLUGIN_STATE_LIMITS.totalBytes / (chunk.length + 2));
  for (let i = 0; i < fits; i++) assert.deepEqual(await state({ op: 'set', key: `chunk:${i}`, value: chunk }), { ok: true }, `chunk ${i}`);
  assert.equal((await state({ op: 'set', key: 'chunk:over', value: chunk })).code, 'state_limit');
  // Rewriting an existing key replaces its bytes instead of adding to them.
  assert.deepEqual(await state({ op: 'set', key: 'chunk:0', value: chunk }), { ok: true });
  for (let i = 0; i < fits; i++) await state({ op: 'delete', key: `chunk:${i}` });

  // The key-count limit.
  const rows = Array.from({ length: PLUGIN_STATE_LIMITS.keys - 1 }, (_, i) => ({ plugin_id: FIXTURE_ID, state_key: `n:${i}`, value: '1', bytes: 1, updated_at: 0 }));
  for (let i = 0; i < rows.length; i += 100) await f.database('plugin_state').insert(rows.slice(i, i + 100));
  assert.equal(await f.database('plugin_state').where({ plugin_id: FIXTURE_ID }).count({ n: '*' }).first().then(r => Number(r?.n)), PLUGIN_STATE_LIMITS.keys);
  assert.equal((await state({ op: 'set', key: 'one-too-many', value: 1 })).code, 'state_limit');
  assert.deepEqual(await state({ op: 'set', key: 'n:0', value: 2 }), { ok: true }, 'an existing key can still be rewritten at the limit');

  // Another plugin's state is separate and survives this plugin's uninstall.
  await f.database('plugin_state').insert({ plugin_id: 'other-plugin', state_key: 'kept', value: '1', bytes: 1, updated_at: 0 });
  await f.store.setEnabled('1', FIXTURE_ID, false);
  await f.store.uninstall('1', FIXTURE_ID, FIXTURE_ID);
  assert.equal(await f.database('plugin_state').where({ plugin_id: FIXTURE_ID }).first(), undefined);
  assert.ok(await f.database('plugin_state').where({ plugin_id: 'other-plugin' }).first());
  const uninstall = await f.database('plugin_audit').where({ plugin_id: FIXTURE_ID, action: 'uninstall' }).first();
  assert.equal(JSON.parse(uninstall.detail).stateKeys, PLUGIN_STATE_LIMITS.keys);
});

test('ctx.http injects the connection credential, which the handler and the logs never see', async t => {
  const f = await pluginHandlerFixture(t, { secret: SENTINEL });
  const run = await runPluginHandler(FIXTURE_ID, 'fetchUrl', invoke({ url: 'https://api.fixture.example/v1/items?page=2', connection: 'api-token', init: { method: 'POST', json: { a: 1 } } }), f.options);
  assert.equal(run.outcome, 'succeeded', run.error ?? '');
  const result = run.result as { ok: boolean; status: number; headers: Record<string, string>; body: string };
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.status, 200);

  // The upstream received the credential on the checked address, with the original host as TLS identity.
  const [sent] = f.http.requests;
  assert.equal(sent.headers.authorization, `Bearer ${SENTINEL}`);
  assert.equal(sent.address, '93.184.216.34');
  assert.equal(sent.url.hostname, 'api.fixture.example');
  assert.equal(sent.url.search, '?page=2');
  assert.equal(sent.method, 'POST');
  assert.equal(sent.body?.toString(), '{"a":1}');
  assert.equal(sent.headers['content-type'], 'application/json');

  // Sentinel: in no spelling anywhere the handler or its caller can see (ctx, response headers and body, logs, result).
  const visible = JSON.stringify(run);
  for (const spelling of [SENTINEL, Buffer.from(SENTINEL).toString('base64'), Buffer.from(`Bearer ${SENTINEL}`).toString('base64')]) {
    assert.equal(visible.includes(spelling), false, `${spelling} leaked`);
  }
  assert.match(result.headers['x-echo-authorization'], /REDACTED/);
  // The upstream also echoed the credential as a header name: that header is dropped, the others are kept.
  assert.deepEqual(Object.keys(result.headers).sort(), ['content-type', 'x-echo-authorization']);
  assert.equal(JSON.stringify(await f.database('plugin_audit').select()).includes(SENTINEL), false);
});

test('a credential logged before the handler acquires it is redacted from the returned logs', async t => {
  const f = await pluginHandlerFixture(t, { secret: SENTINEL });
  // The input carries the opaque token (an upstream callback payload, say); the handler logs it before its first authenticated request.
  const note = `callback for ${SENTINEL} with ${Buffer.from(SENTINEL).toString('base64')} and ${encodeURIComponent(`/${SENTINEL}`)}`;
  const run = await runPluginHandler(FIXTURE_ID, 'logThenFetch', invoke({ url: 'https://api.fixture.example/v1', connection: 'api-token', note }), f.options);
  assert.equal(run.outcome, 'succeeded', run.error ?? '');
  assert.equal(f.http.requests[0]?.headers.authorization, `Bearer ${SENTINEL}`, 'the credential was acquired after the line was logged');
  assert.deepEqual(run.logs.map(l => [l.level, l.message]).slice(0, 1), [['info', 'callback for [REDACTED] with [REDACTED] and %2F[REDACTED]']]);
  assert.deepEqual(run.logs[0].fields, { note: 'callback for [REDACTED] with [REDACTED] and %2F[REDACTED]' });
  const visible = JSON.stringify(run);
  for (const spelling of [SENTINEL, Buffer.from(SENTINEL).toString('base64'), encodeURIComponent(SENTINEL)]) {
    assert.equal(visible.includes(spelling), false, `${spelling} leaked`);
  }
  assert.equal(JSON.stringify(await f.database('plugin_audit').select()).includes(SENTINEL), false);
});

test('ctx.http refuses hosts not in outboundHosts, private addresses, plain HTTP and unusable connections', async t => {
  const f = await pluginHandlerFixture(t, { secret: SENTINEL });
  const fetch = async (payload: PluginJsonValue) => {
    const run = await runPluginHandler(FIXTURE_ID, 'fetchUrl', invoke(payload), f.options);
    return { ...(run.result as { ok: boolean; code: string; message: string }), logs: run.logs };
  };
  const cases: [PluginJsonValue, string][] = [
    [{ url: 'https://evil.example/steal', connection: 'api-token' }, 'host_not_allowed'],
    [{ url: 'http://api.fixture.example/v1' }, 'insecure_url'],
    [{ url: 'https://private.fixture.example/v1', connection: 'api-token' }, 'private_address'],
    [{ url: 'https://93.184.216.34/v1' }, 'host_not_allowed'],
    [{ url: 'https://api.fixture.example:8443/v1' }, 'host_not_allowed'],
    [{ url: 'https://user:pass@api.fixture.example/v1' }, 'invalid_input'],
    [{ url: 'https://api.fixture.example/v1', init: { headers: { Host: 'evil.example' } } }, 'invalid_input'],
    [{ url: 'https://api.fixture.example/v1', connection: 'unset-token' }, 'connection_unavailable'],
    [{ url: 'https://api.fixture.example/v1', connection: 'hook-secret' }, 'connection_unavailable'],
    [{ url: 'https://api.fixture.example/v1', connection: 'undeclared' }, 'connection_unavailable'],
  ];
  for (const [payload, code] of cases) {
    const result = await fetch(payload);
    assert.equal(result.ok, false, JSON.stringify(payload));
    assert.equal(result.code, code, `${JSON.stringify(payload)}: ${result.message}`);
  }
  assert.equal(f.http.requests.length, 0, 'no refused request reached the network');
  const refused = await fetch({ url: 'https://evil.example/steal?token=abc', connection: 'api-token' });
  assert.deepEqual(refused.logs.map(l => [l.level, l.message]), [['warn', 'ctx.http request to evil.example refused: host_not_allowed']]);
  assert.equal(JSON.stringify(refused.logs).includes('token=abc'), false, 'only the hostname of a refused URL is logged');
});
