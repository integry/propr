import test from 'node:test';
import assert from 'node:assert/strict';
import type { PluginHandlerInput, PluginJsonValue } from '@propr/shared';
import { runPluginHandler } from '../src/plugins/pluginHandlerRunner.js';
import { createPluginHttp, scrubCredentialValues, type PluginHttpTransport, type PluginHttpTransportRequest } from '../src/plugins/pluginHttp.js';
import { PluginStore } from '../src/plugins/pluginStore.js';
import { githubPluginProprBackend } from '../src/plugins/pluginProprBackend.js';
import { pluginStateStore, requireInstallation } from '../src/plugins/pluginStateStore.js';
import { installationAuthorizer } from '../src/plugins/pluginContext.js';
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
  const clean = { ok: true, textHasProbe: false, parsedHasProbe: false, jsonHasProbe: false, headersHaveProbe: false, parsedHeadersHaveProbe: false, headerNamesHaveProbe: false, urlDecodedHasProbe: false };

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

test('a response header whose name echoes the credential, in any spelling or case, never reaches the handler', async t => {
  // Mixed case and a `/`: names arrive lowercased, so the base64 and `%2F` spellings arrive folded too.
  const secret = 'Mixed/Case-Sentinel-5d0e9a';
  const f = await pluginHandlerFixture(t, { secret });
  const unicodeEscaped = (value: string) => [...value].map(c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`).join('');
  const names = (token: string) => [
    `X-${token}`, `x-${token.toLowerCase()}`, `x-b64-${Buffer.from(token).toString('base64url').toLowerCase()}`,
    `x-hex-${Buffer.from(token).toString('hex')}`, `x-url-${encodeURIComponent(token).toLowerCase()}`, `x-json-${unicodeEscaped(token)}`,
    `x-full-${encodeURIComponent(`Bearer ${token}`).toLowerCase()}`,
  ];
  const transport: PluginHttpTransport = async request => ({
    status: 200, body: Buffer.from('{}'),
    headers: { 'Content-Type': 'application/json', 'X-Request-Id': 'req-1', ...Object.fromEntries(names(request.headers.authorization!.slice(7)).map(name => [name, 'innocuous'])) },
  });
  const payload = { url: 'https://api.fixture.example/v1', connection: 'api-token' };

  const probed = await runPluginHandler(FIXTURE_ID, 'fetchProbe', invoke({ ...payload, probe: secret }), { ...f.options, transport });
  assert.equal(probed.outcome, 'succeeded', probed.error ?? '');
  assert.equal((probed.result as { headerNamesHaveProbe: boolean }).headerNamesHaveProbe, false);

  // The handler sees the other headers, by their lowercased names, unchanged.
  const fetched = await runPluginHandler(FIXTURE_ID, 'fetchUrl', invoke(payload), { ...f.options, transport });
  const { headers } = fetched.result as { headers: Record<string, string> };
  assert.deepEqual(headers, { 'content-type': 'application/json', 'x-request-id': 'req-1' });
  assert.equal(JSON.stringify(fetched).toLowerCase().includes(secret.toLowerCase()), false);
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

/** A credential with a character `encodeURIComponent` escapes (`/`, as `%2F`). */
const PERCENT_SECRET = 'plugin/credential-sentinel-5d0e9a';
/** `encodeURIComponent` with lowercase hex digits (`%2f`), as some encoders write it. */
const lowerHexEncoded = (value: string) => encodeURIComponent(value).replace(/%[0-9A-F]{2}/g, escape => escape.toLowerCase());
/** Every character percent-escaped, letters included. */
const everyCharEscaped = (value: string) => [...value].map(c => `%${c.charCodeAt(0).toString(16).padStart(2, '0')}`).join('');
/** Whether URL-decoding `text` again and again (each escape alone, as `unescape()` does: `%2f`, `%u002f`) spells `secret`. */
function urlRecovers(text: string, secret: string): boolean {
  for (let current = text, round = 0; round < 8; round++) {
    if (current.includes(secret)) return true;
    const next = current.replace(/%(?:u[0-9a-f]{4}|[0-9a-f]{2})/gi, escape => String.fromCharCode(parseInt(escape.replace(/^%u?/i, ''), 16)));
    if (next === current) return false;
    current = next;
  }
  return false;
}

test('a percent-encoded echo of the credential, in either case of hex digits, is scrubbed before the handler can decode it', async t => {
  const f = await pluginHandlerFixture(t, { secret: PERCENT_SECRET });
  const clean = { ok: true, textHasProbe: false, parsedHasProbe: false, jsonHasProbe: false, headersHaveProbe: false, parsedHeadersHaveProbe: false, headerNamesHaveProbe: false, urlDecodedHasProbe: false };
  // The upstream echoes the credential encoded: in a header value, a form-style header and a JSON or form body.
  const echo = (encode: (secret: string) => string, body: 'json' | 'form' = 'json'): PluginHttpTransport => async request => {
    const encoded = encode((request.headers.authorization ?? '').slice('Bearer '.length));
    return { status: 200, headers: { 'x-echo': encoded, 'x-form': `token=${encoded}&page=2` }, body: Buffer.from(body === 'json' ? JSON.stringify({ token: encoded, keep: 'visible' }) : `token=${encoded}&page=2`) };
  };
  const probe = async (transport: PluginHttpTransport) => {
    const run = await runPluginHandler(FIXTURE_ID, 'fetchProbe', invoke({ url: 'https://api.fixture.example/v1', connection: 'api-token', probe: PERCENT_SECRET }), { ...f.options, transport });
    assert.equal(run.outcome, 'succeeded', run.error ?? '');
    return run.result;
  };
  const encodings: [string, (secret: string) => string][] = [
    ['lowercase hex', lowerHexEncoded],
    ['the header value, lowercase hex', secret => lowerHexEncoded(`Bearer ${secret}`)],
    ['every character escaped', everyCharEscaped],
    ['every character escaped, uppercase hex', secret => everyCharEscaped(secret).toUpperCase()],
    ['URL-encoded twice', secret => encodeURIComponent(lowerHexEncoded(secret))],
    ['%u escapes', secret => secret.replace('/', '%u002f')],
  ];
  for (const [name, encode] of encodings) {
    for (const body of ['json', 'form'] as const) assert.deepEqual(await probe(echo(encode, body)), clean, `${name}, ${body} body`);
  }
  // A percent escape inside a JSON escape: JSON.parse turns `\u0025` into the `%` of `%2f`.
  const viaJson = (secret: string) => secret.replace('/', '\\u00252f');
  assert.deepEqual(await probe(async request => {
    const secret = (request.headers.authorization ?? '').slice('Bearer '.length);
    return { status: 200, headers: { 'x-echo': `"${viaJson(secret)}"` }, body: Buffer.from(`{"token":"${viaJson(secret)}"}`) };
  }), clean, 'percent escape inside a JSON escape');

  // The returned run (result and logs) holds no spelling that URL-decodes to the credential.
  const fetched = await runPluginHandler(FIXTURE_ID, 'fetchUrl', invoke({ url: 'https://api.fixture.example/v1', connection: 'api-token' }), { ...f.options, transport: echo(lowerHexEncoded) });
  assert.equal(fetched.outcome, 'succeeded', fetched.error ?? '');
  assert.equal(urlRecovers(JSON.stringify(fetched), PERCENT_SECRET), false, JSON.stringify(fetched));

  // A single-level escape is replaced in place, so the rest of the value is kept; escapes that spell nothing secret are untouched.
  const fetchWith = (transport: PluginHttpTransport) => createPluginHttp({ outboundHosts: ['api.fixture.example'], credential: async () => PERCENT_SECRET, lookup, transport })('https://api.fixture.example/v1');
  const inPlace = await fetchWith(echo(lowerHexEncoded, 'form'));
  assert.equal(await inPlace.text(), 'token=[REDACTED]&page=2');
  assert.equal(inPlace.headers['x-form'], 'token=[REDACTED]&page=2');
  assert.deepEqual(await (await fetchWith(echo(lowerHexEncoded))).json(), { token: '[REDACTED]', keep: 'visible' });
  const untouched = 'next=%2fitems%3fpage%3d2 %41%u0042 100% sure';
  const kept = await fetchWith(async () => ({ status: 200, headers: { 'x-next': untouched }, body: Buffer.from(untouched) }));
  assert.equal(await kept.text(), untouched);
  assert.equal(kept.headers['x-next'], untouched);
});

test('a credential percent-encoded in a handler input never reaches its log lines or result', async t => {
  const f = await pluginHandlerFixture(t, { secret: PERCENT_SECRET });
  const logged = async (note: string) => {
    const run = await runPluginHandler(FIXTURE_ID, 'fetchThenLog', invoke({ url: 'https://api.fixture.example/v1', connection: 'api-token', note }), f.options);
    assert.equal(run.outcome, 'succeeded', run.error ?? '');
    return run;
  };
  // Lowercase hex is replaced in place, in the message, its fields and the result.
  const inPlace = await logged(`callback for ${lowerHexEncoded(PERCENT_SECRET)} on page 2`);
  const expected = 'callback for [REDACTED] on page 2';
  assert.deepEqual([inPlace.logs.at(-1)?.message, inPlace.logs.at(-1)?.fields, inPlace.result], [expected, { note: expected }, { note: expected }]);
  for (const note of [everyCharEscaped(PERCENT_SECRET), encodeURIComponent(lowerHexEncoded(PERCENT_SECRET)), `see ${PERCENT_SECRET.replace('/', '%u002f')}`]) {
    const run = await logged(note);
    assert.equal(urlRecovers(JSON.stringify(run), PERCENT_SECRET), false, JSON.stringify(run));
  }
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

/** A credential with letters in both cases: its hex encoding differs from itself in any case, and its own case matters. */
const HEX_SECRET = 'Plugin-Credential-Sentinel-5d0e9a';
const upperHex = (value: string) => Buffer.from(value).toString('hex').toUpperCase();
/** Hex digits alternating in case, as a handler could not care about: `Buffer.from(mixed, 'hex')` decodes it all the same. */
const mixedHex = (value: string) => [...Buffer.from(value).toString('hex')].map((c, i) => (i % 2 ? c.toUpperCase() : c)).join('');
/** Whether `text` holds a run of hex digits, in any case, that decodes to `secret` (what a handler recovers with `Buffer.from(run, 'hex')`). */
const hexRecovers = (text: string, secret: string) => (text.match(/[0-9a-fA-F]{2,}/g) ?? []).some(run => Buffer.from(run, 'hex').toString('utf8').includes(secret));

test('an uppercase or mixed-case hex echo of the credential is scrubbed from the body, the headers, the logs and the result', async t => {
  const f = await pluginHandlerFixture(t, { secret: HEX_SECRET });
  const echo = (encode: (value: string) => string, body: 'json' | 'text'): PluginHttpTransport => async request => {
    const authorization = request.headers.authorization ?? '';
    const secret = encode(authorization.slice('Bearer '.length));
    const header = encode(authorization);
    return {
      status: 200, headers: { 'x-echo-token': secret, 'x-echo-header': `v=${header}; path=/` },
      body: Buffer.from(body === 'json' ? JSON.stringify({ token: secret, header, keep: 'visible' }) : `token=${secret}&header=${header}&keep=visible`),
    };
  };
  for (const [name, encode] of [['uppercase hex', upperHex], ['mixed-case hex', mixedHex]] as const) {
    for (const body of ['json', 'text'] as const) {
      const run = await runPluginHandler(FIXTURE_ID, 'fetchUrl', invoke({ url: 'https://api.fixture.example/v1', connection: 'api-token' }), { ...f.options, transport: echo(encode, body) });
      const label = `${name}, ${body} body`;
      assert.equal(run.outcome, 'succeeded', run.error ?? '');
      const result = run.result as { body: string; headers: Record<string, string> };
      // Replaced in place: the rest of the value is kept.
      assert.equal(result.body, body === 'json' ? JSON.stringify({ token: '[REDACTED]', header: '[REDACTED]', keep: 'visible' }) : 'token=[REDACTED]&header=[REDACTED]&keep=visible', label);
      assert.deepEqual(result.headers, { 'x-echo-token': '[REDACTED]', 'x-echo-header': 'v=[REDACTED]; path=/' }, label);
      // Nothing handler-visible (the result, its logged copy) decodes to the credential.
      assert.equal(hexRecovers(JSON.stringify(run), HEX_SECRET), false, label);
    }
    // json() of the parsed body, through the HTTP client directly.
    const response = await createPluginHttp({ outboundHosts: ['api.fixture.example'], credential: async () => HEX_SECRET, lookup, transport: echo(encode, 'json') })('https://api.fixture.example/v1');
    assert.deepEqual(await response.json(), { token: '[REDACTED]', header: '[REDACTED]', keep: 'visible' }, name);
  }
  // The same spellings in a log line and a result, through the run's redaction.
  assert.deepEqual(scrubCredentialValues({ a: `id ${upperHex(HEX_SECRET)} b`, [mixedHex(`Bearer ${HEX_SECRET}`)]: 1 }, [HEX_SECRET]), { a: 'id [REDACTED] b', '[REDACTED]': 1 });
  // Ordinary spellings stay case-sensitive: another case of the secret is a different value, and so is its base64.
  const other = { a: HEX_SECRET.toUpperCase(), b: Buffer.from(HEX_SECRET).toString('base64').toLowerCase(), c: 'ABCDEF0123' };
  assert.deepEqual(scrubCredentialValues(other, [HEX_SECRET]), other);
  const kept = await createPluginHttp({ outboundHosts: ['api.fixture.example'], credential: async () => HEX_SECRET, lookup, transport: async () => ({ status: 200, headers: { 'x-id': 'DEADBEEF' }, body: Buffer.from(HEX_SECRET.toUpperCase()) }) })('https://api.fixture.example/v1');
  assert.equal(await kept.text(), HEX_SECRET.toUpperCase());
  assert.equal(kept.headers['x-id'], 'DEADBEEF');
});

/** Administrative changes to the fixture installation while a handler is suspended, and the refusal each must cause. */
const RESTRICTIONS = [
  ['disabled', async (f: Awaited<ReturnType<typeof pluginHandlerFixture>>) => { await f.store.setEnabled('1', FIXTURE_ID, false); }, { code: 'unavailable', message: 'The plugin is disabled' }],
  ['limited to another repository', async (f: Awaited<ReturnType<typeof pluginHandlerFixture>>) => { await f.store.setRepositories('1', FIXTURE_ID, ['owner/other']); }, { code: 'repository_not_allowed', message: 'This plugin is no longer enabled for owner/allowed' }],
  ['permission revoked', async (f: Awaited<ReturnType<typeof pluginHandlerFixture>>) => {
    const row = await f.database('plugin_installations').where({ plugin_id: FIXTURE_ID }).first('granted_permissions');
    const granted = (JSON.parse(row.granted_permissions) as string[]).filter(permission => permission !== 'issues.create' && permission !== 'tasks.create');
    await f.database('plugin_installations').where({ plugin_id: FIXTURE_ID }).update({ granted_permissions: JSON.stringify(granted) });
  }, { code: 'permission_denied', message: /is no longer granted to this plugin$/ }],
] as const;

test('a handler resuming after its installation was disabled or restricted cannot create an issue or a task', async t => {
  for (const [operation, args] of [['createIssue', ['owner/allowed', { title: 'late', body: 'after restriction' }]], ['createTask', ['owner/allowed', 3]]] as const) {
    for (const [change, restrict, expected] of RESTRICTIONS) {
      const f = await pluginHandlerFixture(t);
      const held = deferred();
      const reached = deferred();
      const backend = { ...f.backend, getIssue: async () => { reached.resolve(); await held.promise; throw new Error('released'); } };
      const running = runPluginHandler(FIXTURE_ID, 'suspendThenPropr', invoke({ operation, args: args as unknown as PluginJsonValue[] }), { ...f.options, backend });
      await reached.promise;
      await restrict(f);
      held.resolve();
      const run = await running;
      const label = `${operation}, ${change}`;
      assert.equal(run.outcome, 'succeeded', run.error ?? '');
      const result = run.result as { ok: boolean; code: string; message: string };
      assert.equal(result.ok, false, label);
      assert.equal(result.code, expected.code, label);
      assert.match(result.message, expected.message instanceof RegExp ? expected.message : new RegExp(`^${expected.message}$`), label);
      assert.deepEqual(f.calls, [], `${label}: nothing reached the backend`);
      // The mutation is recorded as refused with the refusal's code; no attempt was recorded for it.
      const audit = (await f.database('plugin_audit').where({ plugin_id: FIXTURE_ID }).whereIn('action', ['handler_attempt', 'handler_refused']).orderBy('id').select('action', 'detail'))
        .map(row => [row.action, (JSON.parse(row.detail) as { operation: string; reason?: string }).operation, (JSON.parse(row.detail) as { reason?: string }).reason]);
      assert.deepEqual(audit, [['handler_refused', 'getIssue', 'unavailable'], ['handler_refused', operation, expected.code]], label);
    }
  }
});

test('an authenticated request resuming after its installation was disabled is never sent', async t => {
  const f = await pluginHandlerFixture(t, { secret: HEX_SECRET });
  for (const stage of ['lookup', 'credential'] as const) {
    const held = deferred();
    const reached = deferred();
    const heldLookup = async (host: string) => { if (stage === 'lookup') { reached.resolve(); await held.promise; } return lookup(host); };
    const connectionSecret = stage === 'credential' ? async () => { reached.resolve(); await held.promise; return HEX_SECRET; } : undefined;
    const running = runPluginHandler(FIXTURE_ID, 'fetchUrl', invoke({ url: 'https://api.fixture.example/v1/mutate', connection: 'api-token', init: { method: 'POST', json: { change: true } } }), { ...f.options, lookup: heldLookup, ...(connectionSecret ? { connectionSecret } : {}) });
    await reached.promise;
    await f.store.setEnabled('1', FIXTURE_ID, false);
    held.resolve();
    const run = await running;
    assert.equal(run.outcome, 'succeeded', run.error ?? '');
    assert.deepEqual(run.result, { ok: false, code: 'unavailable', message: 'The plugin is disabled' }, stage);
    assert.equal(f.http.requests.length, 0, `${stage}: nothing reached the transport`);
    assert.equal(run.logs.some(line => line.message === 'ctx.http request to api.fixture.example refused: unavailable'), true, stage);
    await f.store.setEnabled('1', FIXTURE_ID, true);
  }
  // An unauthenticated request carries no credential of the installation and is not bound to its enabled state.
  await f.store.setEnabled('1', FIXTURE_ID, false);
  const plain = await createPluginHttp({ outboundHosts: ['api.fixture.example'], lookup, transport: f.http.transport })('https://api.fixture.example/v1');
  assert.equal(plain.status, 200);
});

test('the GitHub backend rechecks the installation\'s enabled state, grants and repository limit right before dispatching', async t => {
  const f = await pluginHandlerFixture(t, { repositories: ['owner/allowed', 'owner/second'] });
  const installedAt = Number((await f.database('plugin_installations').where({ plugin_id: FIXTURE_ID }).first('installed_at')).installed_at);
  const authorize = installationAuthorizer(f.database, FIXTURE_ID, f.manifest, { installedAt, signal: new AbortController().signal }).call;
  const sent: string[] = [];
  const held = { token: deferred(), queue: deferred() };
  const backend = githubPluginProprBackend({
    database: f.database, signal: new AbortController().signal, authorize,
    github: async () => { await held.token.promise; return { request: async (route: string) => { sent.push(route); return { data: { number: 1, html_url: 'u', id: 5 } }; } }; },
    issueQueue: async () => { await held.queue.promise; return { add: async (_n: string, _d: unknown, options: Record<string, unknown>) => { sent.push(String(options.jobId)); } }; },
  });
  // The limit changes to exclude owner/allowed while the App token is fetched and the queue is initialized: nothing for it is sent, a call on owner/second is.
  const refused = [backend.createIssue('owner/allowed', { title: 't', body: 'b', labels: [] }), backend.createTask('owner/allowed', 3, { requestedBy: 'plugin:x' }), backend.addLabel('owner/allowed', 3, 'late')];
  const allowed = backend.createIssue('owner/second', { title: 't', body: 'b', labels: [] });
  await tick();
  await f.store.setRepositories('1', FIXTURE_ID, ['owner/second']);
  held.token.resolve(); held.queue.resolve();
  for (const call of refused) await assert.rejects(call, { code: 'repository_not_allowed', message: 'This plugin is no longer enabled for owner/allowed' });
  assert.equal((await allowed).number, 1);
  assert.deepEqual(sent, ['POST /repos/{owner}/{repo}/issues'], 'only the still-allowed repository was reached');
  sent.length = 0;
  // Disabled: every dispatch is refused, the custom enqueue included; reads too.
  await f.store.setEnabled('1', FIXTURE_ID, false);
  await assert.rejects(backend.createIssue('owner/second', { title: 't', body: 'b', labels: [] }), { code: 'unavailable', message: 'The plugin is disabled' });
  await assert.rejects(backend.getIssue('owner/second', 3), { code: 'unavailable', message: 'The plugin is disabled' });
  const custom = githubPluginProprBackend({ database: f.database, authorize, enqueueIssueTask: async (_data, jobId) => { sent.push(jobId); } });
  await assert.rejects(custom.createTask('owner/second', 3, { requestedBy: 'plugin:x' }), { code: 'unavailable', message: 'The plugin is disabled' });
  await f.store.setEnabled('1', FIXTURE_ID, true);
  // A grant revoked: the commenting read and the comment carry the comment permission, the label the label permission.
  const row = await f.database('plugin_installations').where({ plugin_id: FIXTURE_ID }).first('granted_permissions');
  await f.database('plugin_installations').where({ plugin_id: FIXTURE_ID }).update({ granted_permissions: JSON.stringify((JSON.parse(row.granted_permissions) as string[]).filter(p => p !== 'issues.comment')) });
  await assert.rejects(backend.comment('owner/second', 3, 'late', 'issue'), { code: 'permission_denied' });
  await backend.addLabel('owner/second', 3, 'ok');
  assert.deepEqual(sent, ['POST /repos/{owner}/{repo}/issues/{issue_number}/labels'], 'the revoked permission\'s read was not sent either');
});

test('a handler resuming after its repository limit changed cannot read a task of the repository it started with', async t => {
  // getTask names no repository, so the authorization before the read passes on tasks.read alone; the task's repository is checked once it is read.
  for (const [change, restrict, expected] of RESTRICTIONS) {
    const f = await pluginHandlerFixture(t);
    const held = deferred();
    const reached = deferred();
    const backend = { ...f.backend, getIssue: async () => { reached.resolve(); await held.promise; throw new Error('released'); } };
    const running = runPluginHandler(FIXTURE_ID, 'suspendThenPropr', invoke({ operation: 'getTask', args: ['task-1'] }), { ...f.options, backend });
    await reached.promise;
    if (change === 'permission revoked') {
      await f.database('plugin_installations').where({ plugin_id: FIXTURE_ID }).update({ granted_permissions: JSON.stringify(['issues.read']) });
    } else {
      await restrict(f);
    }
    held.resolve();
    const run = await running;
    assert.equal(run.outcome, 'succeeded', run.error ?? '');
    const result = run.result as { ok: boolean; code: string; message: string; value?: unknown };
    assert.equal(result.ok, false, change);
    assert.equal(result.code, expected.code, change);
    assert.equal(result.value, undefined, `${change}: the task was not returned`);
    // The limit changed: the refusal names the task's repository no more than the handler did.
    if (change === 'limited to another repository') assert.equal(result.message, 'This plugin is no longer enabled for the task\'s repository');
    else assert.match(result.message, expected.message instanceof RegExp ? expected.message : new RegExp(`^${expected.message}$`), change);
    // Only the repository restriction is discovered after the read: the task itself is read, then withheld. The other changes refuse before the backend.
    assert.deepEqual(f.calls.map(c => c.operation), change === 'limited to another repository' ? ['getTask'] : [], change);
    const refused = (await f.database('plugin_audit').where({ plugin_id: FIXTURE_ID, action: 'handler_refused' }).orderBy('id').select('detail')).map(row => JSON.parse(row.detail) as { operation: string; reason: string });
    assert.deepEqual(refused.map(r => [r.operation, r.reason]), [['getIssue', 'unavailable'], ['getTask', expected.code]], change);
  }
  // Unchanged, the same suspended read returns the task: the recheck refuses only what the administrator took away.
  const f = await pluginHandlerFixture(t);
  const backend = { ...f.backend, getIssue: async () => { throw new Error('released'); } };
  const run = await runPluginHandler(FIXTURE_ID, 'suspendThenPropr', invoke({ operation: 'getTask', args: ['task-1'] }), { ...f.options, backend });
  assert.equal((run.result as { ok: boolean; value: { repository: string } }).ok, true);
  assert.equal((run.result as { ok: boolean; value: { repository: string } }).value.repository, 'owner/allowed');
});
