import test from 'node:test';
import assert from 'node:assert/strict';
import type { PluginHandlerInput, PluginJsonValue } from '@propr/shared';
import { runPluginHandler } from '../src/plugins/pluginHandlerRunner.js';
import { createPluginHttp, type PluginHttpTransport, type PluginHttpTransportRequest } from '../src/plugins/pluginHttp.js';
import { PluginStore } from '../src/plugins/pluginStore.js';
import { pluginStateStore } from '../src/plugins/pluginStateStore.js';
import { ENVIRONMENT, FIXTURE_ID, lookup, pluginHandlerFixture } from './helpers/pluginHandlerFixture.js';

const invoke = (payload: PluginJsonValue = {}): PluginHandlerInput => ({ kind: 'invoke', payload });
/** Header-valid, but a JSON string must escape it: a quotation mark and a backslash. */
const ESCAPED_SECRET = 'fixture"quoted\\back/slash-5d0e9a';

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const tick = () => new Promise(resolve => setTimeout(resolve, 20));

/** JSON with every character of every string escaped as \uXXXX, as some serializers write it. */
const unicodeEscapedJson = (value: Record<string, string>) => `{${Object.entries(value).map(([k, v]) => `"${k}":"${[...v].map(c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`).join('')}"`).join(',')}}`;

test('a JSON-escaped echo of the credential is scrubbed before the handler can decode it', async t => {
  const f = await pluginHandlerFixture(t, { secret: ESCAPED_SECRET });
  const probe = async (transport: PluginHttpTransport) => {
    const run = await runPluginHandler(FIXTURE_ID, 'fetchProbe', invoke({ url: 'https://api.fixture.example/v1', connection: 'api-token', probe: ESCAPED_SECRET }), { ...f.options, transport });
    assert.equal(run.outcome, 'succeeded', run.error ?? '');
    return run.result as Record<string, unknown>;
  };
  const clean = { ok: true, textHasProbe: false, parsedHasProbe: false, jsonHasProbe: false, headersHaveProbe: false };

  // JSON.stringify escaping (the fixture echo transport): `\"` and `\\`.
  assert.deepEqual(await probe(f.http.transport), clean);
  assert.equal(f.http.requests[0].headers.authorization, `Bearer ${ESCAPED_SECRET}`, 'the upstream did receive the credential');
  // Every character \u-escaped, `/` escaped, and the credential as an object key.
  const echo = (body: (authorization: string) => string): PluginHttpTransport => async request => ({ status: 200, headers: {}, body: Buffer.from(body(request.headers.authorization ?? '')) });
  assert.deepEqual(await probe(echo(authorization => unicodeEscapedJson({ authorization }))), clean);
  assert.deepEqual(await probe(echo(authorization => JSON.stringify({ token: authorization.slice(7) }).split('/').join('\\/'))), clean);
  assert.deepEqual(await probe(echo(authorization => JSON.stringify({ [authorization.slice(7)]: 1 }))), clean);
});

test('text() of a non-JSON body holds no JSON-escaped credential, and a clean JSON body is returned unchanged', async () => {
  const transportFor = (body: (authorization: string) => string): PluginHttpTransport => async request => ({ status: 200, headers: { 'x-echo': JSON.stringify(request.headers.authorization) }, body: Buffer.from(body(request.headers.authorization ?? '')) });
  const fetchWith = (transport: PluginHttpTransport) => createPluginHttp({ outboundHosts: ['api.fixture.example'], credential: async () => ESCAPED_SECRET, lookup, transport })('https://api.fixture.example/v1');
  const escaped = JSON.stringify(ESCAPED_SECRET).slice(1, -1);

  const html = await fetchWith(transportFor(authorization => `<script>var auth = ${JSON.stringify(authorization)};</script>`));
  const text = await html.text();
  assert.equal(text.includes(escaped), false, text);
  assert.equal(text.includes(ESCAPED_SECRET), false, text);
  assert.equal(html.headers['x-echo'].includes(escaped), false, html.headers['x-echo']);

  const untouched = '{ "a" : [1, 2],\n  "b": "\\u0041" }';
  assert.equal(await (await fetchWith(transportFor(() => untouched))).text(), untouched, 'formatting is kept when no credential was found');
});

test('a request whose DNS lookup or credential resolves after the handler timed out is never sent', async t => {
  const f = await pluginHandlerFixture(t, { secret: 'plugin-http-credential-sentinel-5d0e9a' });
  const fetchPayload = invoke({ url: 'https://api.fixture.example/v1/mutate', connection: 'api-token', init: { method: 'POST', json: { change: true } } });

  // DNS held until after the time limit.
  const dns = deferred();
  const lookups: string[] = [];
  const slowLookup = async (host: string) => { lookups.push(host); await dns.promise; return lookup(host); };
  const timedOut = await runPluginHandler(FIXTURE_ID, 'fetchUrl', fetchPayload, { ...f.options, lookup: slowLookup, timeoutMs: 100 });
  assert.equal(timedOut.timedOut, true);
  assert.deepEqual(lookups, ['api.fixture.example'], 'the lookup had started before the timeout');
  dns.resolve();
  await tick();
  assert.equal(f.http.requests.length, 0, 'nothing reached the transport after the run ended');

  // The connection secret held until after the time limit.
  const secret = deferred<string>();
  const slowSecret = await runPluginHandler(FIXTURE_ID, 'fetchUrl', fetchPayload, { ...f.options, connectionSecret: () => secret.promise, timeoutMs: 100 });
  assert.equal(slowSecret.timedOut, true);
  secret.resolve('late-secret');
  await tick();
  assert.equal(f.http.requests.length, 0);

  // A request in flight when the run ends gets the aborted signal, which the default transport uses to cancel.
  const inFlight: PluginHttpTransportRequest[] = [];
  const hanging: PluginHttpTransport = request => { inFlight.push(request); return new Promise(() => undefined); };
  const cancelled = await runPluginHandler(FIXTURE_ID, 'fetchUrl', fetchPayload, { ...f.options, transport: hanging, timeoutMs: 100 });
  assert.equal(cancelled.timedOut, true);
  assert.equal(inFlight.length, 1);
  assert.equal(inFlight[0].signal?.aborted, true);
});

test('a handler resuming after its plugin was uninstalled cannot recreate state, nor hand it to a reinstall', async t => {
  for (const reinstall of [false, true]) {
    const f = await pluginHandlerFixture(t);
    const held = deferred();
    const reached = deferred();
    const backend = { ...f.backend, getIssue: async () => { reached.resolve(); await held.promise; throw new Error('released'); } };
    const running = runPluginHandler(FIXTURE_ID, 'suspendThenSet', invoke({ key: 'resumed' }), { ...f.options, backend });
    await reached.promise;

    await f.store.setEnabled('1', FIXTURE_ID, false);
    await f.store.uninstall('1', FIXTURE_ID, FIXTURE_ID);
    if (reinstall) {
      // A later installation with the same id: the old run must not write into it.
      const later = new PluginStore(f.database, ENVIRONMENT, async () => [f.manifest], () => Date.now() + 60_000);
      await later.install('1', FIXTURE_ID);
    }
    held.resolve();
    const run = await running;
    assert.equal(run.outcome, 'succeeded', run.error ?? '');
    assert.deepEqual(run.result, { ok: false, code: 'unavailable', message: 'The plugin is no longer installed' }, `reinstall: ${reinstall}`);
    assert.equal(await f.database('plugin_state').where({ plugin_id: FIXTURE_ID }).first(), undefined, `reinstall: ${reinstall}`);
  }
});

test('a handler resuming after an uninstall cannot read, list or delete a reinstall\'s state', async t => {
  for (const op of ['get', 'keys', 'delete'] as const) {
    const f = await pluginHandlerFixture(t);
    const held = deferred();
    const reached = deferred();
    const backend = { ...f.backend, getIssue: async () => { reached.resolve(); await held.promise; throw new Error('released'); } };
    const running = runPluginHandler(FIXTURE_ID, 'suspendThenSet', invoke({ key: 'mapping', op }), { ...f.options, backend });
    await reached.promise;

    await f.store.setEnabled('1', FIXTURE_ID, false);
    await f.store.uninstall('1', FIXTURE_ID, FIXTURE_ID);
    const later = new PluginStore(f.database, ENVIRONMENT, async () => [f.manifest], () => Date.now() + 60_000);
    await later.install('1', FIXTURE_ID);
    // The new installation's own state, written through its own (unguarded) store.
    await pluginStateStore(f.database, FIXTURE_ID).set('mapping', 'new installation');

    held.resolve();
    const run = await running;
    assert.equal(run.outcome, 'succeeded', run.error ?? '');
    assert.deepEqual(run.result, { ok: false, code: 'unavailable', message: 'The plugin is no longer installed' }, op);
    assert.equal(await pluginStateStore(f.database, FIXTURE_ID).get('mapping'), 'new installation', op);
  }
});

test('a state write or delete is refused and rolled back when the run ends during its queries', async t => {
  const f = await pluginHandlerFixture(t);
  const installedAt = Number((await f.database('plugin_installations').where({ plugin_id: FIXTURE_ID }).first('installed_at')).installed_at);
  await pluginStateStore(f.database, FIXTURE_ID).set('kept', 'before');
  // Abort the run when a given statement is sent: the cancellation lands while that query is outstanding.
  const abortOn = (match: (sql: string) => boolean) => {
    const controller = new AbortController();
    const listener = (query: { sql: string }) => { if (match(query.sql.toLowerCase())) controller.abort(); };
    f.database.on('query', listener);
    t.after(() => f.database.removeListener('query', listener));
    return pluginStateStore(f.database, FIXTURE_ID, Date.now, { installedAt, signal: controller.signal });
  };
  const ended = { code: 'unavailable', message: 'This handler run has ended' };

  // While the aggregate count/size query is held: nothing is written.
  await assert.rejects(abortOn(sql => sql.includes('coalesce(sum')).set('fresh', 'late'), ended);
  // During the insert itself: the write is rolled back.
  await assert.rejects(abortOn(sql => sql.startsWith('insert into')).set('kept', 'late'), ended);
  // During the delete: the row stays.
  await assert.rejects(abortOn(sql => sql.startsWith('delete from')).delete('kept'), ended);

  const unguarded = pluginStateStore(f.database, FIXTURE_ID);
  assert.deepEqual(await unguarded.keys(), ['kept']);
  assert.equal(await unguarded.get('kept'), 'before');
  // A live guard with the current installation still works.
  const live = pluginStateStore(f.database, FIXTURE_ID, Date.now, { installedAt, signal: new AbortController().signal });
  await live.set('kept', 'after');
  assert.equal(await live.get('kept'), 'after');
  assert.equal(await live.delete('kept'), true);
});
