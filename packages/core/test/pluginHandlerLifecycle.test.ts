import test from 'node:test';
import assert from 'node:assert/strict';
import type { PluginHandlerInput, PluginJsonValue } from '@propr/shared';
import { runPluginHandler } from '../src/plugins/pluginHandlerRunner.js';
import { createPluginHttp, type PluginHttpTransport, type PluginHttpTransportRequest } from '../src/plugins/pluginHttp.js';
import { PluginStore } from '../src/plugins/pluginStore.js';
import { githubPluginProprBackend } from '../src/plugins/pluginProprBackend.js';
import { pluginStateStore, requireInstallation } from '../src/plugins/pluginStateStore.js';
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
  const clean = { ok: true, textHasProbe: false, parsedHasProbe: false, jsonHasProbe: false, headersHaveProbe: false, parsedHeadersHaveProbe: false };

  // JSON.stringify escaping (the fixture echo transport): `\"` and `\\`.
  assert.deepEqual(await probe(f.http.transport), clean);
  assert.equal(f.http.requests[0].headers.authorization, `Bearer ${ESCAPED_SECRET}`, 'the upstream did receive the credential');
  // Every character \u-escaped, `/` escaped, and the credential as an object key.
  const echo = (body: (authorization: string) => string): PluginHttpTransport => async request => ({ status: 200, headers: {}, body: Buffer.from(body(request.headers.authorization ?? '')) });
  assert.deepEqual(await probe(echo(authorization => unicodeEscapedJson({ authorization }))), clean);
  assert.deepEqual(await probe(echo(authorization => JSON.stringify({ token: authorization.slice(7) }).split('/').join('\\/'))), clean);
  assert.deepEqual(await probe(echo(authorization => JSON.stringify({ [authorization.slice(7)]: 1 }))), clean);

  // The same escapes in JSON-valued response headers: alone, an object, joined with another value, and escaped twice.
  const unicodeEscaped = (value: string) => [...value].map(c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`).join('');
  const echoHeader = (header: (authorization: string) => string): PluginHttpTransport => async request => ({ status: 200, headers: { 'x-echo': header(request.headers.authorization ?? '') }, body: Buffer.from('{}') });
  for (const header of [
    (authorization: string) => `"${unicodeEscaped(authorization)}"`,
    (authorization: string) => unicodeEscapedJson({ token: authorization.slice(7) }),
    (authorization: string) => `"${unicodeEscaped(authorization.slice(7))}", other`,
    (authorization: string) => JSON.stringify(`"${unicodeEscaped(authorization.slice(7))}"`),
  ]) {
    const result = await probe(echoHeader(header));
    assert.deepEqual(result, clean, header.toString());
  }
});

test('a JSON-valued response header without the credential reaches the handler unchanged', async () => {
  const value = '{"note":"\\u0041 \\"quoted\\""}';
  const response = await createPluginHttp({ outboundHosts: ['api.fixture.example'], credential: async () => ESCAPED_SECRET, lookup, transport: async () => ({ status: 200, headers: { 'x-meta': value }, body: Buffer.from('') }) })('https://api.fixture.example/v1');
  assert.equal(response.headers['x-meta'], value);
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

test('a request resuming after an uninstall never acquires or sends a reinstall\'s credential', async t => {
  const REPLACEMENT = 'replacement-installation-token-7c41f2';
  for (const variant of ['uninstalled', 'reinstalled', 'reinstalled with injected secret'] as const) {
    const f = await pluginHandlerFixture(t, { secret: 'plugin-http-credential-sentinel-5d0e9a' });
    const dns = deferred();
    const reached = deferred();
    const heldLookup = async (host: string) => { reached.resolve(); await dns.promise; return lookup(host); };
    // The injected-secret variant reads only by plugin id and name, as a custom source could: dispatch authorization alone must refuse.
    const connectionSecret = variant === 'reinstalled with injected secret'
      ? (id: string, name: string) => new PluginStore(f.database, ENVIRONMENT, async () => [f.manifest]).connectionSecret(id, name)
      : undefined;
    const running = runPluginHandler(FIXTURE_ID, 'fetchUrl', invoke({ url: 'https://api.fixture.example/v1/mutate', connection: 'api-token', init: { method: 'POST', json: { change: true } } }), { ...f.options, lookup: heldLookup, ...(connectionSecret ? { connectionSecret } : {}) });
    await reached.promise;

    await f.store.setEnabled('1', FIXTURE_ID, false);
    await f.store.uninstall('1', FIXTURE_ID, FIXTURE_ID);
    if (variant !== 'uninstalled') {
      const later = new PluginStore(f.database, ENVIRONMENT, async () => [f.manifest], () => Date.now() + 60_000);
      await later.install('1', FIXTURE_ID);
      await later.setConnection('1', FIXTURE_ID, 'api-token', REPLACEMENT);
      await later.setEnabled('1', FIXTURE_ID, true);
    }
    dns.resolve();
    const run = await running;
    assert.equal(run.outcome, 'succeeded', run.error ?? '');
    assert.deepEqual(run.result, { ok: false, code: 'unavailable', message: 'The plugin is no longer installed' }, variant);
    assert.equal(f.http.requests.length, 0, `${variant}: nothing reached the transport`);
    assert.equal(JSON.stringify(run).includes(REPLACEMENT), false, variant);
  }
});

const unicodeEscaped = (value: string) => [...value].map(c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`).join('');
/** Each round of JSON decoding turns `\u005c` into the backslash of the next escape: `rounds` decodes before the text appears. */
const deeplyEscaped = (value: string, rounds: number) => [...value].map(c => `\\${'u005c'.repeat(rounds - 1)}u${c.charCodeAt(0).toString(16).padStart(4, '0')}`).join('');
/** What a handler can recover from text: every JSON string literal in it, parsed again and again. */
function recoverable(text: string): string[] {
  const found: string[] = [];
  const visit = (value: string, depth: number) => {
    found.push(value);
    if (depth > 64) return;
    for (const literal of value.match(/"(?:[^"\\]|\\.)*"/g) ?? []) {
      try { visit(JSON.parse(literal) as string, depth + 1); } catch { /* not a JSON string */ }
    }
    // A bare escaped run (no quotes left after decoding) parsed as a string of its own.
    if (value.includes('\\')) { try { const next = JSON.parse(`"${value}"`) as string; if (next !== value) visit(next, depth + 1); } catch { /* not decodable */ } }
  };
  visit(text, 0);
  return found;
}

test('a response body that spells the credential only after decoding its JSON escapes is withheld', async () => {
  const fetchWith = (body: (secret: string) => string, headers: (secret: string) => Record<string, string> = () => ({})) => createPluginHttp({
    outboundHosts: ['api.fixture.example'], credential: async () => ESCAPED_SECRET, lookup,
    transport: async request => { const secret = (request.headers.authorization ?? '').slice(7); return { status: 200, headers: headers(secret), body: Buffer.from(body(secret)) }; },
  })('https://api.fixture.example/v1');
  const leaks = (text: string) => recoverable(text).some(value => value.includes(ESCAPED_SECRET));

  // HTML: the credential \u-escaped inside a script, which the handler extracts and parses.
  const html = await fetchWith(secret => `<html><script>var auth = "${unicodeEscaped(secret)}";</script></html>`);
  const htmlText = await html.text();
  const script = htmlText.match(/var auth = ("(?:[^"\\]|\\.)*");/);
  assert.equal(script ? (JSON.parse(script[1]) as string).includes(ESCAPED_SECRET) : false, false, htmlText);
  assert.equal(leaks(htmlText), false, htmlText);

  // JSON holding another JSON document as a string, the credential \u-escaped inside it: that string is withheld, the rest kept.
  const nested = await fetchWith(secret => JSON.stringify({ keep: 'visible', doc: unicodeEscapedJson({ token: secret }) }));
  const nestedJson = await nested.json<{ keep: string; doc: string }>();
  assert.equal(nestedJson.keep, 'visible');
  assert.equal((() => { try { return JSON.stringify(JSON.parse(nestedJson.doc)).includes(ESCAPED_SECRET); } catch { return false; } })(), false, nestedJson.doc);
  assert.equal(leaks(await nested.text()), false, await nested.text());

  // Deeper than any fixed round count: in an HTML body and in a header, ten decodes deep, and beyond what is checked.
  for (const rounds of [10, 40]) {
    const deep = await fetchWith(secret => `<p>${deeplyEscaped(secret, rounds)}</p>`, secret => ({ 'x-echo': `"${deeplyEscaped(secret, rounds)}"` }));
    assert.equal(leaks(await deep.text()), false, `body, ${rounds} rounds`);
    assert.equal(leaks(deep.headers['x-echo']), false, `header, ${rounds} rounds`);
  }
  assert.ok(recoverable(`<p>${deeplyEscaped(ESCAPED_SECRET, 10)}</p>`).some(value => value.includes(ESCAPED_SECRET)), 'the probe does recover an unscrubbed deep escape');

  // Escapes that spell nothing secret reach the handler unchanged.
  const clean = '<script>var note = "\\u0041\\u0042 \\"quoted\\"";</script>';
  assert.equal(await (await fetchWith(() => clean)).text(), clean);
  const cleanNested = JSON.stringify({ doc: unicodeEscapedJson({ token: 'not the credential' }) });
  assert.equal(await (await fetchWith(() => cleanNested)).text(), cleanNested);
});

test('a handler resuming after its plugin was uninstalled cannot create an issue or a task, nor act for a reinstall', async t => {
  for (const [operation, args] of [['createIssue', ['owner/allowed', { title: 'late', body: 'after uninstall' }]], ['createTask', ['owner/allowed', 3]], ['commentOnIssue', ['owner/allowed', 3, 'late']]] as const) {
    for (const reinstall of [false, true]) {
      const f = await pluginHandlerFixture(t);
      const held = deferred();
      const reached = deferred();
      const backend = { ...f.backend, getIssue: async () => { reached.resolve(); await held.promise; throw new Error('released'); } };
      const running = runPluginHandler(FIXTURE_ID, 'suspendThenPropr', invoke({ operation, args: args as unknown as PluginJsonValue[] }), { ...f.options, backend });
      await reached.promise;

      await f.store.setEnabled('1', FIXTURE_ID, false);
      await f.store.uninstall('1', FIXTURE_ID, FIXTURE_ID);
      if (reinstall) {
        const later = new PluginStore(f.database, ENVIRONMENT, async () => [f.manifest], () => Date.now() + 60_000);
        await later.install('1', FIXTURE_ID);
        await later.setRepositories('1', FIXTURE_ID, ['owner/allowed']);
        await later.setEnabled('1', FIXTURE_ID, true);
      }
      held.resolve();
      const run = await running;
      const label = `${operation}, reinstall: ${reinstall}`;
      assert.equal(run.outcome, 'succeeded', run.error ?? '');
      assert.deepEqual(run.result, { ok: false, code: 'unavailable', message: 'The plugin is no longer installed' }, label);
      assert.deepEqual(f.calls, [], `${label}: nothing reached the backend`);
      // The held read is recorded too (it failed); the mutation after the uninstall is recorded as refused.
      const refused = (await f.database('plugin_audit').where({ plugin_id: FIXTURE_ID, action: 'handler_refused' }).orderBy('id').select('detail')).map(row => JSON.parse(row.detail) as { operation: string; reason: string });
      assert.deepEqual(refused.map(r => [r.operation, r.reason]), [['getIssue', 'unavailable'], [operation, 'unavailable']], label);
    }
  }
});

test('the GitHub backend rechecks the installation after the App client or the queue is ready, before dispatching', async t => {
  const f = await pluginHandlerFixture(t);
  const installedAt = Number((await f.database('plugin_installations').where({ plugin_id: FIXTURE_ID }).first('installed_at')).installed_at);
  const signal = new AbortController().signal;
  const authorize = () => f.database.transaction(trx => requireInstallation(trx, FIXTURE_ID, { installedAt, signal }));
  const sent: string[] = [];
  const backend = githubPluginProprBackend({
    database: f.database, signal, authorize,
    github: async () => ({ request: async (route: string) => { sent.push(route); return { data: { number: 1, html_url: 'u' } }; } }),
    issueQueue: async () => ({ add: async (_name: string, _data: unknown, options: Record<string, unknown>) => { sent.push(String(options.jobId)); } }),
  });
  // A live installation is served.
  assert.equal((await backend.createIssue('owner/allowed', { title: 't', body: 'b', labels: [] })).number, 1);
  assert.equal((await backend.createTask('owner/allowed', 3, { requestedBy: 'plugin:x' })).jobId, 'issue-owner-allowed-3');
  assert.deepEqual(sent, ['POST /repos/{owner}/{repo}/issues', 'issue-owner-allowed-3']);
  sent.length = 0;

  // Uninstalled while the App token is fetched and while the queue is initialized.
  const held = { token: deferred(), queue: deferred() };
  const heldBackend = githubPluginProprBackend({
    database: f.database, signal, authorize,
    github: async () => { await held.token.promise; return { request: async (route: string) => { sent.push(route); return { data: {} }; } }; },
    issueQueue: async () => { await held.queue.promise; return { add: async (_n: string, _d: unknown, options: Record<string, unknown>) => { sent.push(String(options.jobId)); } }; },
  });
  const issue = heldBackend.createIssue('owner/allowed', { title: 't', body: 'b', labels: [] });
  const task = heldBackend.createTask('owner/allowed', 3, { requestedBy: 'plugin:x' });
  await tick();
  await f.store.setEnabled('1', FIXTURE_ID, false);
  await f.store.uninstall('1', FIXTURE_ID, FIXTURE_ID);
  held.token.resolve(); held.queue.resolve();
  await assert.rejects(issue, { code: 'unavailable', message: 'The plugin is no longer installed' });
  await assert.rejects(task, { code: 'unavailable', message: 'The plugin is no longer installed' });
  // A custom enqueue is refused the same way.
  const custom = githubPluginProprBackend({ database: f.database, signal, authorize, enqueueIssueTask: async (_data, jobId) => { sent.push(jobId); } });
  await assert.rejects(custom.createTask('owner/allowed', 3, { requestedBy: 'plugin:x' }), { code: 'unavailable' });
  assert.deepEqual(sent, [], 'nothing was sent or queued');
});
