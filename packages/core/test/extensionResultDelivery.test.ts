import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { request as httpRequest, ServerResponse } from 'node:http';
import { createHash, createPrivateKey, randomUUID, sign } from 'node:crypto';
import { canonicalFleetJson as canonical, EXTENSION_RESULT_DELIVERY_SCHEMA, extensionPublicResultSchemas, parseExtensionResultDelivery, encryptFleetExtensionSecret } from '@propr/shared';
import { verifyDelivery } from '../../../docs/contracts/extension-result-delivery-v1/verifier.mjs';
const hash = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
const digest = (v: unknown) => hash(canonical(v));
const skill = Buffer.from('---\nname: delivery-skill\ndescription: Public descriptor only\n---\nSENTINEL-SKILL-CONTENTS');
mock.module('../src/auth/githubAuth.js', { namedExports: { getAuthenticatedOctokit: async () => ({ request: async (route: string) => ({ data: route.includes('/git/commits/') ? { sha: 'a'.repeat(40), tree: { sha: 'b'.repeat(40) } } : route.includes('/git/trees/') ? { truncated: false, tree: [{ path: 'skills/demo/SKILL.md', type: 'blob', mode: '100644', sha: createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${skill.length}\0`), skill])).digest('hex'), size: skill.length }] } : { encoding: 'base64', content: skill.toString('base64') } }) }) } });
const { fixture, input } = await import('./helpers/extensionAuthorityV2Fixture.js');
const select = (p: any) => ({ instanceId: p.instanceId, profileId: p.profileId, revision: p.revision });
async function deliver(f: any, native: any, work?: any) {
  work ??= await f.newWork(native);
  const request = f.request(work);
  const admitted = await f.send(canonical(f.envelope(request)));
  assert.deepEqual(admitted.wire.delivery, { state: 'unavailable' });
  const r = f.request(work, 'dispatch'), e = f.envelope(r, native);
  const reply = await f.send(canonical(e)); assert.equal(reply.status, 200, reply.raw);
  const verified = verifyDelivery(reply.deliveryRaw, r, native, e.routing, f.trust, f.spki(f.core), await f.extensions.recipientVerificationKey(), Date.now(), new Set());
  assert.equal(verified.delivery.state, 'available');
  const retry = await f.send(canonical(e)); assert.deepEqual(retry.body, reply.body);
  assert.deepEqual(retry.wire.delivery, { state: 'unavailable' });
  for (const phase of ['completion', 'status']) {
    const response = await f.send(canonical(f.envelope(f.request(work, phase))));
    assert.equal(response.status, 200); assert.deepEqual(response.wire.delivery, { state: 'unavailable' });
  }
  return { result: verified.delivery.native.result, r, e, reply, work };
}

test('all fourteen actions deliver complete strictly parsed results through real SQLite and Unix listener', async t => {
  const f = await fixture(t); const seen = new Set<string>();
  const run = async (n: any) => { seen.add(n.action); return deliver(f, n); };
  const p = (await run({ action: 'profile.create', input: { ...input, enabled: true }, sealed: [] })).result.profile;
  await run({ action: 'profile.list' }); await run({ action: 'profile.read', selection: select(p) });
  await run({ action: 'profile.history', profileId: p.profileId }); await run({ action: 'catalog.list' });
  await run({ action: 'profile.validate', selection: select(p) });
  await run({ action: 'selection.validate', selection: select(p), context: { runtime: 'claude', agentAlias: 'claude-main', repositories: [], allowWrite: false } });
  const imported = await run({ action: 'skill.import', repository: 'synthetic/skills', commit: 'a'.repeat(40), directory: 'skills/demo' });
  assert.equal(imported.result.bundle.name, 'delivery-skill');
  assert.ok(!imported.reply.deliveryRaw.includes('SENTINEL-SKILL-CONTENTS'));
  await run({ action: 'skill.list' });
  const next = await run({ action: 'profile.update', input: { ...input, enabled: true }, selection: select(p), sealed: [] });
  const disabled = await run({ action: 'profile.disable', selection: select(next.result.profile) });
  await run({ action: 'profile.delete', selection: select(disabled.result.profile) });
  await run({ action: 'operation.status', targetOperationId: next.work.extension.operationId });
  const intent = { action: 'profile.create', input: { ...input, mcpServers: [{ kind: 'https', name: 'docs', url: 'https://8.8.8.8/mcp', enabled: false, tools: [], capability: 'read', authentication: 'bearer' }] } };
  await run({ action: 'recipient.issue', intent, mutationOperationId: randomUUID(), server: 'docs', field: 'bearerToken' });
  assert.deepEqual([...seen].sort(), Object.keys(extensionPublicResultSchemas).sort());
  const retained = canonical(await f.db('extension_authority_v2_receipts')) + canonical(await f.db('extension_authority_v2_intents'))
    + (await Promise.all((await fs.readdir(f.control)).filter(n => n.startsWith('extension-')).map(n => fs.readFile(path.join(f.control, n), 'utf8')))).join('');
  for (const sentinel of [input.name, 'SENTINEL-SKILL-CONTENTS', 'publicKey', 'ciphertext', 'mcpServers', 'privateKey']) assert.ok(!retained.includes(sentinel));
});

test('lost recipient reply is unavailable on retry; a distinct acquisition for the same intent can be consumed only by its mutation', async t => {
  const f = await fixture(t);
  const intent = { action: 'profile.create', input: { ...input, mcpServers: [{ kind: 'https', name: 'docs', url: 'https://8.8.8.8/mcp', enabled: false, tools: [], capability: 'read', authentication: 'bearer' }] } };
  const mutation = await f.newWork({ ...intent, sealed: [] });
  const native = { action: 'recipient.issue', intent, mutationOperationId: mutation.extension.operationId, server: 'docs', field: 'bearerToken' };
  const lost = await f.newWork(native); await f.invoke(f.request(lost));
  const r = f.request(lost, 'dispatch'), raw = canonical(f.envelope(r, native));
  let oldPublicKey = '';
  await assert.rejects(f.plane.invokeDelivery(raw, response => {
    assert.equal(response.delivery.state, 'available');
    oldPublicKey = (response.delivery as any).native.result.publicKey;
    throw Error('synthetic write failure');
  }), /unavailable/);
  // Replay must not derive a recipient or require its independent signing key.
  const keyProbe = t.mock.method(f.extensions, 'recipientVerificationKey', async () => { throw Error('recipient key unavailable'); });
  const retry = await f.send(raw); assert.equal(retry.status, 200); assert.deepEqual(retry.wire.delivery, { state: 'unavailable' });
  keyProbe.mock.restore();
  const acquired = await deliver(f, native);
  assert.notEqual(acquired.result.publicKey, oldPublicKey);
  for (const acquisition of [lost, acquired.work]) {
    const wrong = await f.newWork({ ...intent, sealed: [] }); wrong.acquisitionOperationId = acquisition.extension.operationId;
    assert.equal((await f.send(canonical(f.envelope(f.request(wrong))))).status, 403);
  }
  const sealed = await encryptFleetExtensionSecret(acquired.result, 'SENTINEL-DELIVERY-TOKEN', { verificationKey: await f.extensions.recipientVerificationKey(), expectedBinding: acquired.result.binding });
  const save = { ...intent, sealed: [sealed] }; mutation.extension.requestDigest = digest(save); mutation.acquisitionOperationId = acquired.work.extension.operationId;
  const saved = await deliver(f, save, mutation); assert.equal(saved.result.profile.secrets.docs.configured, true);
  const ledger = canonical(await f.db('extension_authority_v2_receipts'));
  for (const s of [oldPublicKey, acquired.result.publicKey, sealed.ciphertext, 'SENTINEL-DELIVERY-TOKEN']) assert.ok(!ledger.includes(s));
  await f.restart();
  assert.deepEqual((await f.send(raw)).wire.delivery, { state: 'unavailable' });
});

test('socket abort during dispatch commits at most once and restart retry is receipt-only', async t => {
  const f = await fixture(t), native = { action: 'profile.create', input, sealed: [] };
  const work = await f.newWork(native); await f.invoke(f.request(work));
  const r = f.request(work, 'dispatch'), raw = canonical(f.envelope(r, native));
  const conn = await f.db.client.acquireConnection(); await f.db.client.releaseConnection(conn);
  let committed!: () => void; const done = new Promise<void>(resolve => { committed = resolve; });
  const exec = conn.exec.bind(conn); let commits = 0;
  t.mock.method(conn, 'exec', (sql: string) => { const result = exec(sql); if (sql === 'COMMIT' && ++commits === 2) committed(); return result; });
  let calls = 0; const dispatch = f.extensions.dispatchAtomic.bind(f.extensions);
  let req: ReturnType<typeof httpRequest>;
  t.mock.method(f.extensions, 'dispatchAtomic', async (...args: Parameters<typeof dispatch>) => { calls++; const value = await dispatch(...args); req.destroy(); return value; });
  // The fixture listener's pathname is owned by its current runtime.
  req = httpRequest({ socketPath: path.join(f.control, `data-${(await f.fleet.runtime()).runtimeGeneration}.sock`), path: '/extensions/authority/v2/invoke', method: 'POST', headers: { 'Content-Type': 'application/json' } });
  req.on('error', () => {}); req.end(raw);
  await done;
  const retry = await f.send(raw); assert.equal(retry.status, 200); assert.deepEqual(retry.wire.delivery, { state: 'unavailable' });
  assert.equal(calls, 1); assert.equal((await f.db('extension_profiles')).length, 1);
  await f.restart(); assert.deepEqual((await f.send(raw)).wire.delivery, { state: 'unavailable' });
});

test('standalone and producer parsers reject substitutions, unknown fields, noncanonical and oversized results', async () => {
  const f = JSON.parse(await fs.readFile('docs/contracts/extension-result-delivery-v1/fixtures.json', 'utf8'));
  const core = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.alloc(32, 71)]), type: 'pkcs8', format: 'der' });
  const check = (item: any, raw: string, expected = item.expected, native = item.native, recipientSPKI = f.recipientSPKI) => verifyDelivery(raw, expected, native, item.routing, f.trust, f.coreSPKI, recipientSPKI, f.nowMs, new Set());
  for (const item of f.fixtures) {
    check(item, item.first); check(item, item.replay);
    parseExtensionResultDelivery(item.first, item.expected, item.native, digest, () => {});
    for (const raw of [item.first + '\n', '{"contract":"duplicate",' + item.first.slice(1), ' '.repeat(288 * 1024 + 1)]) assert.throws(() => check(item, raw), /unavailable/);
    const changes = [ (v: any) => { v.extra = true; }, (v: any) => { v.delivery.native.result.extra = 'SENTINEL'; },
      (v: any) => { v.delivery.action = 'wrong'; }, (v: any) => { v.delivery.native.operationId = randomUUID(); },
      (v: any) => { v.receipt.statement.result.nativeResultDigest = '0'.repeat(64); } ];
    for (const change of changes) { const v = JSON.parse(item.first); change(v); assert.throws(() => check(item, canonical(v)), /unavailable/); }
    for (const field of ['workDigest', 'acquisitionOperationId', 'extensionInstanceId', 'coreAuthorityEpoch']) {
      const expected = structuredClone(item.expected); expected.work[field] = field === 'coreAuthorityEpoch' ? '3' : randomUUID();
      assert.throws(() => check(item, item.first, expected), /unavailable/);
    }
    for (const field of Object.keys(item.expected.work.scope)) {
      const expected = structuredClone(item.expected); expected.work.scope[field] = 'substituted';
      assert.throws(() => check(item, item.first, expected), /unavailable/);
    }
  }
  const recipient = f.fixtures.find((x: any) => x.native.action === 'recipient.issue');
  assert.throws(() => check(recipient, recipient.first, recipient.expected, recipient.native, f.coreSPKI), /unavailable/);
  // Resign the authority receipt after corrupting the result: digest/signature
  // correctness must not bypass public schema or independently retained bindings.
  const resign = (v: any) => {
    const s = v.receipt.statement; s.result.nativeResultDigest = digest(v.delivery.native); s.resultDigest = digest(s.result);
    v.receipt.signature = sign(null, Buffer.from(canonical(s)), core).toString('base64url'); return canonical(v);
  };
  for (const field of ['mutationOperationId', 'server', 'field', 'audience', 'extensionInstanceId', 'intentDigest', 'assertion']) {
    const v = JSON.parse(recipient.first); v.delivery.native.result.binding[field] = field === 'assertion' ? { ...v.delivery.native.result.binding.assertion, runtimeGeneration: randomUUID() } : field === 'intentDigest' ? 'b'.repeat(64) : field.endsWith('Id') ? randomUUID() : 'substitution';
    assert.throws(() => check(recipient, resign(v)), /unavailable/);
  }
  const list = f.fixtures.find((x: any) => x.native.action === 'profile.list');
  const unicode = JSON.parse(list.first); unicode.delivery.native.result.profiles[0].name = 'public-\uFFFD';
  const utf8 = Buffer.from(resign(unicode)); check(list, utf8 as any);
  const offset = utf8.indexOf(Buffer.from('\uFFFD')); assert.ok(offset > 0);
  const malformed = Buffer.concat([utf8.subarray(0, offset), Buffer.from([0xff]), utf8.subarray(offset + 3)]);
  assert.throws(() => check(list, malformed as any), /unavailable/);
  const overBudget = JSON.parse(list.first);
  const profiles = overBudget.delivery.native.result.profiles, p = profiles[0];
  while (Buffer.byteLength(canonical(overBudget.delivery.native)) <= 256 * 1024) profiles.push(p);
  const large = resign(overBudget); assert.ok(Buffer.byteLength(large) < 288 * 1024);
  assert.throws(() => check(list, large), /unavailable/);
  assert.throws(() => parseExtensionResultDelivery(large, list.expected, list.native, digest, () => {}), /unavailable/);
  for (const change of [(p: any) => { p.name = 'x'.repeat(101); }, (p: any) => { p.secrets.docs = { bearerToken: 'SENTINEL' }; },
    (p: any) => { p.mcpServers = [{ kind: 'https', name: 'docs', enabled: true, tools: [], capability: 'read', authentication: 'none', url: 'https://user:password@example.com' }]; },
    (p: any) => { p.mcpServers = [{ kind: 'https', name: 'docs', enabled: true, tools: [], capability: 'read', authentication: 'none', url: 'https://8.8.8.8/mcp', token: 'SENTINEL' }]; }, (p: any) => { p.secrets.docs = { fields: ['bearerToken', 'SENTINEL'], configured: true }; }, (p: any) => { p.skillBundles = Array(9).fill({}); }, (p: any) => { p.instanceId = randomUUID(); }]) {
    const v = JSON.parse(list.first); change(v.delivery.native.result.profiles[0]); const raw = resign(v);
    assert.throws(() => check(list, raw), /unavailable/);
    assert.throws(() => parseExtensionResultDelivery(raw, list.expected, list.native, digest, () => {}), /unavailable/);
  }
});

test('delivery bundle schema, exact source pins and checksums', async () => {
  const root = 'docs/contracts/extension-result-delivery-v1/';
  assert.equal(await fs.readFile(root + 'schema.json', 'utf8'), EXTENSION_RESULT_DELIVERY_SCHEMA);
  for (const line of (await fs.readFile(root + 'SHA256SUMS', 'utf8')).trim().split('\n')) {
    const [pin, name] = line.split('  '); assert.equal(hash(await fs.readFile(root + name)), pin, name);
  }
  for (const [file, pin] of Object.entries(JSON.parse(await fs.readFile(root + 'source-pins.json', 'utf8')))) assert.equal(hash(await fs.readFile(file)), pin, file);
});

test('invalid public output rolls back before exposure and leaves receipt-free intent; status has no delivery', async t => {
  const f = await fixture(t), native = { action: 'profile.create', input, sealed: [] };
  const work = await f.newWork(native); await f.invoke(f.request(work));
  const dispatch = f.extensions.dispatchAtomic.bind(f.extensions);
  t.mock.method(f.extensions, 'dispatchAtomic', async (...args: Parameters<typeof dispatch>) => {
    const outcome = await dispatch(...args);
    (outcome.result as any).result.profile.token = 'SENTINEL-UNSAFE-NATIVE-DIAGNOSTIC';
    return outcome;
  });
  const r = f.request(work, 'dispatch'), raw = canonical(f.envelope(r, native));
  assert.equal((await f.send(raw)).status, 403);
  assert.equal((await f.db('extension_profiles')).length, 0);
  assert.equal(await f.db('extension_authority_v2_receipts').where({ challenge: r.challenge }).first(), undefined);
  assert.equal((await f.send(raw)).status, 403);
  const status = await f.send(canonical(f.envelope(f.request(work, 'status'))));
  assert.equal(status.body.statement.result.state, 'incomplete'); assert.deepEqual(status.wire.delivery, { state: 'unavailable' });
});

test('response callback observes committed SQLite state; shutdown and write failure cannot undo it', async t => {
  const f = await fixture(t), native = { action: 'profile.create', input, sealed: [] };
  const work = await f.newWork(native); await f.invoke(f.request(work));
  const connection = await f.db.client.acquireConnection(); await f.db.client.releaseConnection(connection);
  const r = f.request(work, 'dispatch'), raw = canonical(f.envelope(r, native));
  let delivered = false;
  await assert.rejects(f.plane.invokeDelivery(raw, response => {
    assert.equal(connection.inTransaction, false);
    assert.equal(connection.prepare('SELECT count(*) AS n FROM extension_profiles').get().n, 1);
    assert.equal(connection.prepare('SELECT count(*) AS n FROM extension_authority_v2_receipts WHERE challenge=?').get(r.challenge).n, 1);
    assert.equal(response.delivery.state, 'available'); delivered = true; f.plane.shutdown(); throw Error('synthetic response-write failure');
  }), /unavailable/);
  assert.ok(delivered); await f.restart();
  const retry = await f.send(raw); assert.equal(retry.status, 200); assert.deepEqual(retry.wire.delivery, { state: 'unavailable' });
  assert.equal((await f.db('extension_profiles')).length, 1);
});


test('shutdown before commit exposes no delivery and rolls back native work without reopening dispatch', async t => {
  const f = await fixture(t), native = { action: 'profile.create', input, sealed: [] };
  const work = await f.newWork(native); await f.invoke(f.request(work));
  const dispatch = f.extensions.dispatchAtomic.bind(f.extensions);
  t.mock.method(f.extensions, 'dispatchAtomic', async (...args: Parameters<typeof dispatch>) => {
    const outcome = await dispatch(...args); f.plane.shutdown(); return outcome;
  });
  const r = f.request(work, 'dispatch'), raw = canonical(f.envelope(r, native));
  await assert.rejects(f.plane.invokeDelivery(raw, () => assert.fail('uncommitted delivery')), /unavailable/);
  assert.equal((await f.db('extension_profiles')).length, 0);
  await f.restart(); assert.equal((await f.send(raw)).status, 403);
  const status = await f.send(canonical(f.envelope(f.request(work, 'status'))));
  assert.equal(status.body.statement.result.state, 'incomplete'); assert.deepEqual(status.wire.delivery, { state: 'unavailable' });
});


test('asynchronous Unix response-write error is redacted and retains committed receipt without delivery', async t => {
  const f = await fixture(t), native = { action: 'profile.create', input, sealed: [] };
  const work = await f.newWork(native); await f.invoke(f.request(work));
  const r = f.request(work, 'dispatch'), raw = canonical(f.envelope(r, native));
  const original = ServerResponse.prototype.end;
  const fault = t.mock.method(ServerResponse.prototype, 'end', function (this: ServerResponse, ...args: any[]) {
    if (this.req.url === '/extensions/authority/v2/invoke' && this.statusCode === 200) {
      queueMicrotask(() => this.emit('error', Error('SENTINEL-UNSAFE-NATIVE-DIAGNOSTIC')));
      return this;
    }
    return (original as any).apply(this, args);
  });
  try { await assert.rejects(f.send(raw), /socket hang up|reset/i); }
  finally { fault.mock.restore(); }
  const retry = await f.send(raw); assert.equal(retry.status, 200); assert.deepEqual(retry.wire.delivery, { state: 'unavailable' });
  assert.equal((await f.db('extension_profiles')).length, 1);
});
