import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import {
  createHostedProviderAuthority, createSelfHostedProviderAuthority, PROVIDER_CATALOG,
  PROVIDER_CATALOG_REVISION, AUTHORITY_SCHEMA, canonicalAuthority, authorityIdentitySchema,
  reservationSchema, enrollmentSchema, classifyProviderCustody,
  type Enrollment, type AuthorityIdentity, type Reservation, type HostedAuthorityPorts,
  type ProviderGrant,
} from '../src/providerAuthority/index.js';
import { TestControlRoot, providerAuthorityStoreConformance } from './helpers/providerAuthorityStoreConformance.js';

const identity: AuthorityIdentity = { tenantId: 'tenant', instanceId: 'instance', predecessorGeneration: 'generation-1',
  stateScope: 'scope', runtimeGeneration: 'runtime-1', hostId: 'host', ownerEpoch: 'owner-1', policyEpoch: 'policy-1' };
function enrollment(who = identity): Enrollment {
  return { identity: structuredClone(who), catalogRevision: PROVIDER_CATALOG_REVISION, observerRevision: 'reader-1',
    issuers: ['claude', 'codex', 'antigravity', 'opencode'].map(provider => ({
      issuerId: `${provider}-creator`, implementationRevision: 'implementation-1', catalogRevision: PROVIDER_CATALOG_REVISION,
      provider, agentKind: `${provider}-agent`, sourceKind: 'run',
      resources: PROVIDER_CATALOG.filter(r => r.provider === provider).map(r => r.key),
    })) } as Enrollment;
}
const successor = { ...identity, predecessorGeneration: 'generation-2', runtimeGeneration: 'runtime-2', ownerEpoch: 'owner-2' };
const resetIntent = { operationId: 'reset-1', predecessor: identity, successor };
async function fixture(options: { store?: TestControlRoot; enrollment?: Enrollment } = {}) {
  const store = options.store ?? new TestControlRoot();
  const enrolled = options.enrollment ?? enrollment();
  let now = 1000;
  let readback: 'unproven' | 'revoked-and-quiescent' = 'unproven';
  let substitute: ((v: Record<string, unknown>) => unknown) | undefined;
  const ports: HostedAuthorityPorts = { store, clock: { now: () => now }, keys: {
    commit: (domain, binding, value) => ({ keyId: 'authority-key-1', digest: createHmac('sha256', 'test-only-key-with-at-least-32-bytes').update(canonicalAuthority({ domain, binding, value })).digest('hex') }),
  }, reader: { implementationRevision: 'reader-1', observe: async request => {
    const result = { ...request, observerRevision: 'reader-1', result: readback === 'unproven' ? { state: readback }
      : { state: readback, evidenceCommitment: 'e'.repeat(64) } };
    return substitute ? substitute(result) : result;
  } } };
  const authority = await createHostedProviderAuthority(enrolled, ports);
  let sequence = 0;
  function reservation(category: Reservation['category'] = 'provider-sessions', resourceKey?: string): Reservation {
    return { identity: structuredClone(enrolled.identity), issuer: structuredClone(enrolled.issuers[0]), category,
      resourceKey: resourceKey ?? (category === 'provider-sessions' ? 'claude:session:launch' : 'claude:credential:claude-home'),
      operationId: `operation-${++sequence}`, attemptId: 'attempt-1' };
  }
  async function close() {
    const inventory = await authority.observeInventory(enrolled.identity);
    for (const issuer of enrolled.issuers) await authority.closeIssuer(enrolled.identity, issuer, inventory.highWater);
  }
  return { authority, store, ports, enrolled, reservation, close,
    setNow: (value: number) => { now = value; },
    prove: () => { readback = 'revoked-and-quiescent'; },
    substitute: (fn?: typeof substitute) => { substitute = fn; },
    restart: () => createHostedProviderAuthority(enrolled, ports),
  };
}
const refused = /provider_authority_unavailable/;

test('control-root adapter conformance: create-only, atomic compare, linearizable read and reopen', async () => {
  const store = new TestControlRoot();
  await providerAuthorityStoreConformance(async () => new TestControlRoot(store.rows));
  assert.equal('delete' in store, false);
});

test('canonical contracts close schemas and distinguish all credential homes and session kinds', () => {
  assert.equal(canonicalAuthority(JSON.parse(AUTHORITY_SCHEMA)), AUTHORITY_SCHEMA);
  assert.equal(canonicalAuthority({ z: 1, a: [true, null, 'x'] }), '{"a":[true,null,"x"],"z":1}');
  for (const bad of [NaN, Infinity, undefined, new Date(), 1.5]) assert.throws(() => canonicalAuthority(bad), refused);
  assert.equal(authorityIdentitySchema.safeParse({ ...identity, extra: 'private' }).success, false);
  assert.equal(enrollmentSchema.safeParse({ ...enrollment(), extra: true }).success, false);
  assert.equal(reservationSchema.safeParse({ identity, issuer: enrollment().issuers[0], category: 'routing-session' }).success, false);
  for (const key of ['claude:credential:claude-home', 'claude:credential:claude-settings', 'codex:credential:codex-home',
    'antigravity:credential:gemini-home', 'opencode:credential:opencode-config', 'opencode:credential:opencode-data']) {
    assert.ok(PROVIDER_CATALOG.some(r => r.key === key));
  }
  for (const origin of ['external-path', 'process-environment', 'shared-operator'] as const) assert.equal(classifyProviderCustody(origin), 'unowned-unqualified');
  assert.equal(classifyProviderCustody('managed-tenant'), 'requires-authority');
  assert.ok(Object.isFrozen(PROVIDER_CATALOG) && Object.isFrozen(PROVIDER_CATALOG[0]));
});

test('hosted constructor fails closed, separate self-hosted mode cannot grant hosted authority', async () => {
  await assert.rejects(createHostedProviderAuthority(enrollment(), undefined as never), refused);
  const f = await fixture();
  await assert.rejects(createHostedProviderAuthority(enrollment(), { ...f.ports, store: { ...f.store, custody: 'tenant-state' } } as never), refused);
  const self = createSelfHostedProviderAuthority();
  assert.equal(self.mode, 'self-hosted-unqualified'); assert.equal('reserve' in self, false); assert.ok(Object.isFrozen(self));
});

test('zero inventory requires exhaustive enrollment and every exact issuer closure', async () => {
  const missing = enrollment(); missing.issuers.pop();
  await assert.rejects(fixture({ enrollment: missing }), refused);
  const f = await fixture();
  assert.equal((await f.authority.observeInventory(identity)).exhaustive, false);
  await f.authority.fenceReset(resetIntent);
  await assert.rejects(f.authority.retireReset(identity), refused);
  for (const issuer of f.enrolled.issuers.slice(0, -1)) await f.authority.closeIssuer(identity, issuer, 0);
  await assert.rejects(f.authority.retireReset(identity), refused);
  await assert.rejects(f.authority.closeIssuer(identity, { ...f.enrolled.issuers.at(-1)!, implementationRevision: 'stale' }, 0), refused);
  await f.close();
  assert.equal((await f.authority.observeInventory(identity)).exhaustive, true);
  assert.equal((await f.authority.retireReset(identity)).state, 'retired');
});

test('append-before-effect, non-reusable attempts, immutable grants and strict purpose separation', async () => {
  const f = await fixture(); const input = f.reservation();
  const reservation = await f.authority.reserveProviderLaunch(input);
  assert.equal((await f.authority.observeInventory(identity)).records[0].phase, 'reserved');
  assert.equal(Object.isFrozen(reservation), true);
  await assert.rejects(f.authority.reserveProviderLaunch(input), refused);
  await assert.rejects(f.authority.reserveCredentialWriter(f.reservation()), refused);
  const grant = await f.authority.claimDispatch(identity, reservation.recordId); await f.authority.consumeGrant(grant, grant.purpose);
  assert.ok(Object.isFrozen(grant) && Object.isFrozen(grant.identity));
  assert.throws(() => { (grant.identity as AuthorityIdentity).tenantId = 'other'; }, TypeError);
  await assert.rejects(f.authority.claimDispatch(identity, reservation.recordId), refused);
  await assert.rejects(f.authority.commitIssuance(structuredClone(grant)), refused);
  await assert.rejects(f.authority.commitCredentialConfig(grant), refused);
  await f.authority.bindSessionId(grant, 'provider-private-id');
  await f.authority.bindSessionId(grant, 'provider-private-id');
  await assert.rejects(f.authority.bindSessionId(grant, 'different-provider-id'), refused);
  await f.authority.commitIssuance(grant);
  await f.authority.finish(grant);
  await assert.rejects(f.authority.finish(grant), refused);
  assert.equal((await f.authority.observeInventory(identity)).records[0].phase, 'finished');
});

test('credential writer/use exclusion survives expiry, renewal invalidates old grants, finish is not revocation', async () => {
  const f = await fixture();
  const reservation = await f.authority.reserveCredentialWriter(f.reservation('provider-credentials'), { locator: '/PRIVATE/home' });
  await assert.rejects(f.authority.reserveCredentialUse(f.reservation('provider-credentials')), refused);
  let grant = await f.authority.claimDispatch(identity, reservation.recordId); await f.authority.consumeGrant(grant, grant.purpose);
  f.setNow(2000); const renewed = await f.authority.renew(grant, 1000);
  await assert.rejects(f.authority.commitIssuance(grant), refused); grant = renewed;
  f.setNow(3000);
  await assert.rejects(f.authority.renew(grant), refused);
  await assert.rejects(f.authority.reserveCredentialWriter(f.reservation('provider-credentials')), refused);
  assert.equal((await f.authority.observeInventory(identity)).records[0].phase, 'unknown-after-crash');
  await f.authority.unknownAfterCrash(identity, reservation.recordId);
  await f.close(); await f.authority.fenceReset(resetIntent);
  await assert.rejects(f.authority.retireReset(identity), refused);
  assert.equal(await f.authority.observeResetRecord(identity, reservation.recordId), 'unproven');
  f.prove(); await f.authority.observeResetRecord(identity, reservation.recordId);
  assert.equal((await f.authority.retireReset(identity)).state, 'retired');
});

test('concurrent reservations and dispatch claims admit one exact CAS winner', async () => {
  const f = await fixture();
  const attempts = await Promise.allSettled([f.authority.reserveProviderLaunch(f.reservation()), f.authority.reserveProviderLaunch(f.reservation())]);
  assert.equal(attempts.filter(a => a.status === 'fulfilled').length, 1);
  const record = (await f.authority.observeInventory(identity)).records[0];
  const claims = await Promise.allSettled([f.authority.claimDispatch(identity, record.recordId), f.authority.claimDispatch(identity, record.recordId)]);
  assert.equal(claims.filter(a => a.status === 'fulfilled').length, 1);
  const inventory = await f.authority.observeInventory(identity);
  assert.equal(inventory.highWater, 1); assert.equal(inventory.records.length, 1);
  await assert.rejects(f.authority.closeIssuer(identity, f.enrolled.issuers[0], 0), refused);
  await f.authority.closeIssuer(identity, f.enrolled.issuers[0], 1);
  await assert.rejects(f.authority.reserveProviderLaunch(f.reservation()), refused);
});

for (const point of ['before-read', 'after-read', 'before-cas', 'after-cas'] as const) {
  test(`reservation crash ${point} reconstructs exactly, without an effect grant`, async () => {
    const f = await fixture(); const input = f.reservation();
    f.store.fault = point;
    await assert.rejects(f.authority.reserveProviderLaunch(input), refused);
    const restarted = await f.restart();
    const inventory = await restarted.observeInventory(identity);
    assert.equal(inventory.records.length, point === 'after-cas' ? 1 : 0);
    if (point === 'after-cas') await assert.rejects(restarted.reserveProviderLaunch(input), refused);
  });
  test(`dispatch crash ${point} never retries an ambiguous claim`, async () => {
    const f = await fixture(); const r = await f.authority.reserveProviderLaunch(f.reservation());
    f.store.fault = point;
    await assert.rejects(f.authority.claimDispatch(identity, r.recordId), refused);
    const restarted = await f.restart();
    if (point === 'after-cas') {
      assert.equal((await restarted.observeInventory(identity)).records[0].phase, 'unknown-after-crash');
      await assert.rejects(restarted.claimDispatch(identity, r.recordId), refused);
    } else assert.ok(await restarted.claimDispatch(identity, r.recordId));
  });
}

test('reset dispatch is at most once through lost replies, expiry and restart, independent readback retires', async () => {
  const f = await fixture(); const r = await f.authority.reserveProviderLaunch(f.reservation());
  await f.authority.claimDispatch(identity, r.recordId); // physical launch may return no session ID
  await f.close(); await f.authority.fenceReset(resetIntent);
  f.store.fault = 'after-cas';
  await assert.rejects(f.authority.claimResetDispatch(identity, r.recordId), refused);
  f.setNow(100000);
  const restarted = await f.restart();
  await assert.rejects(restarted.claimResetDispatch(identity, r.recordId), refused);
  await assert.rejects(restarted.retireReset(identity), refused);
  assert.equal(await restarted.observeResetRecord(identity, r.recordId), 'unproven');
  f.prove(); await restarted.observeResetRecord(identity, r.recordId);
  assert.equal((await restarted.retireReset(identity)).state, 'retired');
});

test('readback substitution cannot prove another identity, incarnation or intent, and caller cannot supply proof', async () => {
  const f = await fixture(); const r = await f.authority.reserveProviderLaunch(f.reservation());
  await f.close(); await f.authority.fenceReset(resetIntent); f.prove();
  for (const field of Object.keys(identity)) {
    f.substitute(o => ({ ...o, identity: { ...(o.identity as object), [field]: 'substituted' } }));
    await assert.rejects(f.authority.observeResetRecord(identity, r.recordId), refused);
  }
  for (const field of ['category', 'resourceKey']) {
    f.substitute(o => ({ ...o, binding: { ...(o.binding as object), [field]: field === 'category' ? 'provider-credentials' : 'codex:session:launch' } }));
    await assert.rejects(f.authority.observeResetRecord(identity, r.recordId), refused);
  }
  for (const field of ['recordId', 'incarnation', 'intentId', 'observerRevision']) {
    f.substitute(o => ({ ...o, [field]: 'substituted' }));
    await assert.rejects(f.authority.observeResetRecord(identity, r.recordId), refused);
  }
  f.substitute(o => ({ ...o, privateLocator: '/PRIVATE/secret' }));
  await assert.rejects(f.authority.observeResetRecord(identity, r.recordId), refused);
  await assert.rejects(f.authority.retireReset(identity), refused);
  f.substitute(); await f.authority.observeResetRecord(identity, r.recordId);
});

test('all identity, provider/category, policy and creator/catalog revisions are exact', async () => {
  const f = await fixture();
  for (const field of Object.keys(identity)) {
    const input = f.reservation(); (input.identity as Record<string, string>)[field] = 'substituted';
    await assert.rejects(f.authority.reserveProviderLaunch(input), refused);
  }
  for (const field of ['implementationRevision', 'catalogRevision', 'provider', 'agentKind', 'sourceKind', 'issuerId'] as const) {
    const input = f.reservation(); (input.issuer as Record<string, unknown>)[field] = field === 'provider' ? 'codex' : 'substituted';
    await assert.rejects(f.authority.reserveProviderLaunch(input), refused);
  }
  const input = f.reservation(); input.issuer.resources.push('codex:session:launch');
  await assert.rejects(f.authority.reserveProviderLaunch(input), refused);
  await assert.rejects(f.authority.reserveProviderLaunch({ ...f.reservation(), resourceKey: 'codex:session:launch' }), refused);
  await assert.rejects(f.authority.reserveProviderLaunch({ ...f.reservation(), category: 'provider-credentials' }), refused);
  await assert.rejects(f.authority.reserveProviderLaunch({ ...f.reservation(), privateLocator: '/private' } as Reservation), refused);
});

test('permanent tombstone and exact successor transfer survive every reopen', async () => {
  const f = await fixture(); const r = await f.authority.reserveProviderLaunch(f.reservation());
  await f.close(); await f.authority.fenceReset(resetIntent);
  await assert.rejects(f.authority.assertAdmission(identity), refused);
  await assert.rejects(f.authority.transferSuccessor(enrollment(successor)), refused);
  f.prove(); await f.authority.observeResetRecord(identity, r.recordId); await f.authority.retireReset(identity);
  await assert.rejects(f.authority.transferSuccessor(enrollment({ ...successor, hostId: 'wrong-host' })), refused);
  await f.authority.transferSuccessor(enrollment(successor));
  await assert.rejects(f.restart(), refused);
  const next = await createHostedProviderAuthority(enrollment(successor), f.ports);
  await next.assertAdmission(successor); await assert.rejects(next.assertAdmission(identity), refused);
  const bytes = [...f.store.rows.values()][0].bytes;
  const retained = JSON.parse(bytes);
  assert.equal(retained.tombstones.length, 1); assert.deepEqual(retained.tombstones[0].identity, identity);
  assert.equal(retained.records.length, 1); assert.equal(retained.transfers.length, 1);
  const badReset = { operationId: 'reset-2', predecessor: successor, successor: identity };
  await assert.rejects(next.fenceReset(badReset), refused);
  assert.equal((await (await createHostedProviderAuthority(enrollment(successor), f.ports)).observeReset(successor)).state, 'active');
});

test('ABA/reissued provider identifiers use distinct commitments and incarnations', async () => {
  const f = await fixture();
  const first = await f.authority.reserveProviderLaunch(f.reservation());
  const g1 = await f.authority.claimDispatch(identity, first.recordId); await f.authority.consumeGrant(g1, g1.purpose); await f.authority.bindSessionId(g1, 'reused-id'); await f.authority.finish(g1);
  const second = await f.authority.reserveProviderLaunch(f.reservation());
  const g2 = await f.authority.claimDispatch(identity, second.recordId); await f.authority.consumeGrant(g2, g2.purpose); await f.authority.bindSessionId(g2, 'reused-id');
  assert.notEqual(first.incarnation, second.incarnation);
  const records = JSON.parse([...f.store.rows.values()][0].bytes).records;
  assert.notEqual(records[0].providerIdCommitment.digest, records[1].providerIdCommitment.digest);
  await assert.rejects(f.authority.reserveProviderLaunch({ ...f.reservation(), replacementOf: first.recordId }), refused);
});

test('private locators and secrets stay in permissioned custody, errors and observations are redacted and deeply frozen', async () => {
  const e = enrollment();
  e.issuers.push({ ...structuredClone(e.issuers[0]), issuerId: 'claude-run-creator' });
  e.issuers[0].sourceKind = 'config';
  e.issuers[0].resources = e.issuers[0].resources.filter(key => key.includes(':credential:'));
  const f = await fixture({ enrollment: e });
  const locator = '/PRIVATE/tenant/provider-home/token'; const value = 'tiny-secret';
  const r = await f.authority.prepareCredentialConfig(f.reservation('provider-credentials'), { locator });
  const grant = await f.authority.claimDispatch(identity, r.recordId); await f.authority.consumeGrant(grant, grant.purpose);
  await f.authority.commitCredentialConfig(grant, value); await f.authority.finish(grant);
  const bytes = [...f.store.rows.values()][0].bytes;
  assert.ok(bytes.includes(locator)); assert.ok(!bytes.includes(value));
  const retainedCommitment = JSON.parse(bytes).records[0].valueCommitment;
  assert.equal(retainedCommitment.keyId, 'authority-key-1');
  assert.notEqual(retainedCommitment.digest, createHash('sha256').update(value).digest('hex'));
  assert.deepEqual(retainedCommitment, f.ports.keys.commit('credential-value', canonicalAuthority({
    binding: grant.binding, incarnation: grant.incarnation }), value));
  assert.equal(JSON.stringify(f.authority), '{"mode":"hosted"}');
  for (const name of ['load', 'change', 'record', 'grant', 'capability', 'initialize', 'ports']) assert.equal(name in f.authority, false);
  const observation = await f.authority.observeInventory(identity);
  const publicBytes = JSON.stringify(observation);
  for (const sentinel of [locator, value, 'privateCustody', 'valueCommitment', 'providerIdCommitment']) assert.ok(!publicBytes.includes(sentinel));
  assert.ok(Object.isFrozen(observation.records[0].binding.issuer.resources));
  assert.throws(() => { (observation.records[0].binding.issuer.resources as string[]).push('mutate'); }, TypeError);
  const config = f.reservation('provider-credentials');
  const result = await f.authority.prepareCredentialConfig(config, { locator });
  config.identity.tenantId = 'mutated-after-call'; config.issuer.resources.length = 0;
  assert.equal((await f.authority.observeInventory(identity)).records.find(x => x.recordId === result.recordId)!.binding.identity.tenantId, identity.tenantId);
  f.store.fault = 'before-read';
  await assert.rejects(f.authority.observeInventory(identity), error => {
    assert.equal(String(error), 'Error: provider_authority_unavailable'); assert.ok(!String(error).includes('PRIVATE')); return true;
  });
});

test('clock rollback, invalid leases and expired reservations never authorize effects', async () => {
  const f = await fixture();
  for (const ttl of [0, -1, 30001, Infinity, 1.5]) await assert.rejects(f.authority.reserve(f.reservation(), 'provider-launch', ttl), refused);
  const r = await f.authority.reserveProviderLaunch(f.reservation());
  f.setNow(999); await assert.rejects(f.authority.claimDispatch(identity, r.recordId), refused);
  f.setNow(31000); await assert.rejects(f.authority.claimDispatch(identity, r.recordId), refused);
  assert.equal((await f.authority.observeInventory(identity)).records[0].phase, 'unknown-after-crash');
});

// Every persisted lifecycle boundary is exercised with failures immediately
// before storage, and after commit but before the caller receives its reply.
for (const boundary of ['issuance', 'session-binding', 'finish', 'renew', 'unknown', 'issuer-close', 'fence',
  'reset-dispatch', 'readback', 'retire', 'transfer', 'resource-retirement', 'consume-grant'] as const) {
  for (const point of ['before-read', 'after-read', 'before-cas', 'after-cas'] as const) {
    test(`lifecycle crash: ${boundary} / ${point}`, async () => {
      const f = await fixture();
      const r = await f.authority.reserveProviderLaunch(f.reservation());
      const grant = await f.authority.claimDispatch(identity, r.recordId);
      if (boundary !== 'consume-grant') await f.authority.consumeGrant(grant, grant.purpose);
      const resetBoundaries = ['reset-dispatch', 'readback', 'retire', 'transfer'];
      if (resetBoundaries.includes(boundary)) { await f.close(); await f.authority.fenceReset(resetIntent); }
      if (['retire', 'transfer'].includes(boundary)) { f.prove(); await f.authority.observeResetRecord(identity, r.recordId); }
      if (boundary === 'transfer') await f.authority.retireReset(identity);
      if (boundary === 'renew') f.setNow(2000);
      f.prove();
      const actions: Record<typeof boundary, () => Promise<unknown>> = {
        'consume-grant': () => f.authority.consumeGrant(grant, 'provider-launch'),
        'resource-retirement': () => f.authority.prepareResourceRetirement(identity, r.recordId, 'retire-resource'),
        issuance: () => f.authority.commitIssuance(grant),
        'session-binding': () => f.authority.bindSessionId(grant, 'PRIVATE-provider-session'),
        finish: () => f.authority.finish(grant), renew: () => f.authority.renew(grant, 5000),
        unknown: () => f.authority.unknownAfterCrash(identity, r.recordId),
        'issuer-close': () => f.authority.closeIssuer(identity, f.enrolled.issuers[0], 1),
        fence: () => f.authority.fenceReset(resetIntent),
        'reset-dispatch': () => f.authority.claimResetDispatch(identity, r.recordId),
        readback: () => f.authority.observeResetRecord(identity, r.recordId),
        retire: () => f.authority.retireReset(identity),
        transfer: () => f.authority.transferSuccessor(enrollment(successor)),
      };
      f.store.fault = point;
      await assert.rejects(actions[boundary](), refused);
      const committed = point === 'after-cas';
      const currentEnrollment = boundary === 'transfer' && committed ? enrollment(successor) : f.enrolled;
      const restarted = await createHostedProviderAuthority(currentEnrollment, f.ports);
      const persisted = JSON.parse([...f.store.rows.values()][0].bytes);
      const record = persisted.records[0];
      switch (boundary) {
        case 'consume-grant':
          if (point === 'before-cas' || committed) {
            await assert.rejects(f.authority.consumeGrant(grant, 'provider-launch'), refused);
            await assert.rejects(f.authority.commitIssuance(grant), refused);
            await assert.rejects(f.authority.bindSessionId(grant, 'PRIVATE-id'), refused);
            await assert.rejects(f.authority.renew(grant), refused);
          } else await f.authority.consumeGrant(grant, 'provider-launch');
          break;
        case 'resource-retirement': assert.equal(record.resetEffect?.kind ?? null, committed ? 'resource-retirement' : null); break;
        case 'issuance': assert.equal(record.phase, committed ? 'issued' : 'dispatched'); break;
        case 'session-binding': assert.equal(record.providerIdCommitment !== null, committed); break;
        case 'finish': assert.equal(record.lease.status, committed ? 'closed' : 'open'); break;
        case 'renew': assert.equal(record.lease.expiresAt, committed ? 7000 : 31000); break;
        case 'unknown': assert.equal(record.phase, committed ? 'unknown-after-crash' : 'dispatched'); break;
        case 'issuer-close': assert.equal(persisted.closures.length, committed ? 1 : 0); break;
        case 'fence': assert.equal(persisted.tombstones.length, committed ? 1 : 0); break;
        case 'reset-dispatch':
          assert.equal(record.resetEffect.dispatch, committed ? 'claimed' : 'unclaimed');
          if (committed) await assert.rejects(restarted.claimResetDispatch(identity, r.recordId), refused);
          break;
        case 'readback': assert.equal(record.resetEffect.readback, committed ? 'revoked-and-quiescent' : 'unproven'); break;
        case 'retire': assert.equal(persisted.reset.retired, committed); break;
        case 'transfer': assert.deepEqual(persisted.enrollment.identity, committed ? successor : identity); break;
      }
      // Process-local grants never regain authority after reconstruction.
      await assert.rejects(restarted.bindSessionId(grant, 'PRIVATE-provider-session'), refused);
    });
  }
}

test('multiple reader leases coexist, exclude writers, and individually close', async () => {
  const f = await fixture();
  const a = await f.authority.reserveCredentialUse(f.reservation('provider-credentials'));
  const b = await f.authority.reserveCredentialUse(f.reservation('provider-credentials'));
  const ga = await f.authority.claimDispatch(identity, a.recordId); await f.authority.consumeGrant(ga, ga.purpose);
  const gb = await f.authority.claimDispatch(identity, b.recordId); await f.authority.consumeGrant(gb, gb.purpose);
  await f.authority.commitIssuance(ga); await f.authority.commitIssuance(gb);
  await f.authority.finish(ga);
  await assert.rejects(f.authority.reserveCredentialWriter(f.reservation('provider-credentials')), refused);
  await f.authority.finish(gb);
  assert.ok(await f.authority.reserveCredentialWriter(f.reservation('provider-credentials')));
});

test('fence interrupts outstanding issuance and renewal but permits positive writer closure', async () => {
  const f = await fixture(); const r = await f.authority.reserveProviderLaunch(f.reservation());
  const grant = await f.authority.claimDispatch(identity, r.recordId); await f.authority.consumeGrant(grant, grant.purpose);
  const intentId = await f.authority.fenceReset(resetIntent);
  assert.equal(await f.authority.fenceReset(resetIntent), intentId);
  await assert.rejects(f.authority.fenceReset({ ...resetIntent, operationId: 'conflicting-reset' }), refused);
  await assert.rejects(f.authority.commitIssuance(grant), refused);
  await assert.rejects(f.authority.renew(grant), refused);
  await assert.rejects(f.authority.bindSessionId(grant, 'id'), refused);
  await assert.rejects(f.authority.claimResetDispatch(identity, r.recordId), refused);
  await f.authority.finish(grant); await f.close();
  const resetGrant = await f.authority.claimResetDispatch(identity, r.recordId);
  assert.equal(resetGrant.purpose, 'reset-effect'); assert.equal(resetGrant.binding.issuer.provider, 'claude');
  assert.ok(resetGrant.effectIntentId);
  await assert.rejects(f.authority.finish(resetGrant), refused);
  await assert.rejects(f.authority.retireReset(identity), refused);
});

test('malformed persisted canonical state and incomplete or duplicated enrollment fail closed', async () => {
  for (const modify of [
    (e: Enrollment) => { e.issuers.push(e.issuers[0]); },
    (e: Enrollment) => { e.issuers[0].resources.push(e.issuers[0].resources[0]); },
    (e: Enrollment) => { e.catalogRevision = 'stale'; },
    (e: Enrollment) => { e.issuers[0].resources.push('claude:arbitrary-host-path'); },
  ]) { const e = enrollment(); modify(e); await assert.rejects(fixture({ enrollment: e }), refused); }
  const f = await fixture();
  await f.authority.reserveProviderLaunch(f.reservation());
  const [key, row] = [...f.store.rows.entries()][0];
  const state = JSON.parse(row.bytes);
  for (const bytes of [JSON.stringify(state, null, 2), row.bytes.replace('"highWater":1', '"highWater":0'),
    row.bytes.replace('"records":[', '"unexpected":"PRIVATE","records":['), `${row.bytes.slice(0, -1)},"highWater":1}`]) {
    f.store.rows.set(key, { ...row, bytes });
    await assert.rejects(f.restart(), refused);
  }
  f.store.rows.set(key, row);
  await f.restart();
});

test('retry authority retires a predecessor incarnation and allows exactly one replacement', async () => {
  const enrolled = enrollment();
  const retryIssuer = { ...structuredClone(enrolled.issuers[0]), issuerId: 'claude-retry-creator', sourceKind: 'retry' as const };
  retryIssuer.resources = retryIssuer.resources.filter(key => key.includes(':session:'));
  enrolled.issuers.push(retryIssuer);
  const f = await fixture({ enrollment: enrolled });
  const initial = await f.authority.reserveProviderLaunch(f.reservation());
  const initialGrant = await f.authority.claimDispatch(identity, initial.recordId); await f.authority.consumeGrant(initialGrant, initialGrant.purpose);
  await f.authority.bindSessionId(initialGrant, 'same-provider-id');
  const retry = { ...f.reservation(), issuer: retryIssuer, replacementOf: initial.recordId };
  await assert.rejects(f.authority.reserveProviderLaunch(retry), refused);
  await f.authority.prepareResourceRetirement(identity, initial.recordId, 'retire-old-session');
  await assert.rejects(f.authority.renew(initialGrant), refused);
  const claim = await f.authority.claimResetDispatch(identity, initial.recordId);
  assert.equal(claim.purpose, 'reset-effect');
  assert.equal(await f.authority.observeResetRecord(identity, initial.recordId), 'unproven');
  f.prove(); await f.authority.observeResetRecord(identity, initial.recordId);
  const replacement = await f.authority.reserveProviderLaunch(retry);
  const replacementGrant = await f.authority.claimDispatch(identity, replacement.recordId); await f.authority.consumeGrant(replacementGrant, replacementGrant.purpose);
  await f.authority.bindSessionId(replacementGrant, 'same-provider-id');
  assert.notEqual(replacement.incarnation, initial.incarnation);
  await assert.rejects(f.authority.reserveProviderLaunch({ ...retry, attemptId: 'another-attempt' }), refused);
  await assert.rejects(f.authority.reserveProviderLaunch({ ...f.reservation(), issuer: retryIssuer }), refused);
  // Global reset must preserve a resource-retirement claim across reconstruction.
  await f.close(); await f.authority.fenceReset(resetIntent);
  await assert.rejects((await f.restart()).claimResetDispatch(identity, initial.recordId), refused);
});

test('permanent predecessor refusal can be independently observed after successor activation', async () => {
  const f = await fixture(); await f.close(); await f.authority.fenceReset(resetIntent); await f.authority.retireReset(identity);
  await f.authority.transferSuccessor(enrollment(successor));
  const next = await createHostedProviderAuthority(enrollment(successor), f.ports);
  assert.equal((await next.observePredecessorRefusal(identity)).state, 'permanently-refused');
  assert.equal((await f.authority.observePredecessorRefusal(identity)).state, 'permanently-refused');
  assert.equal((await next.observePredecessorRefusal(successor)).state, 'unproven');
  await assert.rejects(next.observePredecessorRefusal({ ...identity, tenantId: 'other-tenant' }), refused);
  await assert.rejects(next.fenceReset({ operationId: 'aba', predecessor: successor,
    successor: { ...identity, ownerEpoch: 'owner-3', runtimeGeneration: 'runtime-3' } }), refused);
});

test('issuer closure fences dispatch/issuance while allowing positive finish of an existing lease', async () => {
  const f = await fixture();
  const a = await f.authority.reserveProviderLaunch(f.reservation());
  const b = await f.authority.reserveProviderLaunch(f.reservation());
  const grant = await f.authority.claimDispatch(identity, a.recordId); await f.authority.consumeGrant(grant, grant.purpose);
  await f.authority.closeIssuer(identity, f.enrolled.issuers[0], 2);
  await assert.rejects(f.authority.claimDispatch(identity, b.recordId), refused);
  await assert.rejects(f.authority.commitIssuance(grant), refused);
  await assert.rejects(f.authority.bindSessionId(grant, 'provider-id'), refused);
  await assert.rejects(f.authority.renew(grant), refused);
  await f.authority.finish(grant);
  const other = f.reservation(); other.issuer = f.enrolled.issuers[1]; other.resourceKey = 'codex:session:launch';
  await f.authority.reserveProviderLaunch(other);
  // An exact close retry remains observable after another issuer advances HWM.
  await f.authority.closeIssuer(identity, f.enrolled.issuers[0], 2);
});

for (const point of ['before-read', 'after-read', 'before-cas', 'after-cas'] as const) {
  test(`initial create-only provisioning crash ${point}`, async () => {
    const store = new TestControlRoot(); store.fault = point;
    await assert.rejects(fixture({ store }), refused);
    assert.equal(store.rows.size, point === 'after-cas' ? 1 : 0);
    await fixture({ store });
    assert.equal(store.rows.size, 1);
  });
}

test('foreign handles, forged grant purposes, missing readback and key failures are redacted refusals', async () => {
  const f = await fixture(); const r = await f.authority.reserveProviderLaunch(f.reservation());
  const grant = await f.authority.claimDispatch(identity, r.recordId); await f.authority.consumeGrant(grant, grant.purpose);
  const other = await f.restart();
  await assert.rejects(other.commitIssuance(grant), refused);
  await assert.rejects(f.authority.bindSessionId({ ...grant, purpose: 'credential-writer' } as ProviderGrant, 'private'), refused);
  f.ports.keys.commit = () => { throw new Error('PRIVATE-key-error'); };
  await assert.rejects(f.authority.bindSessionId(grant, 'private'), error => String(error) === 'Error: provider_authority_unavailable');
  await f.close(); await f.authority.fenceReset(resetIntent);
  f.ports.reader.observe = async () => undefined;
  await assert.rejects(f.authority.observeResetRecord(identity, r.recordId), refused);
  f.ports.reader.observe = async () => { throw new Error('PRIVATE-reader-error'); };
  await assert.rejects(f.authority.observeResetRecord(identity, r.recordId), error => String(error) === 'Error: provider_authority_unavailable');
  await assert.rejects(f.authority.retireReset(identity), refused);
});

test('session custody binding is private, immutable and rejects ABA locator substitution', async () => {
  const f = await fixture(); const r = await f.authority.reserveProviderLaunch(f.reservation());
  const grant = await f.authority.claimDispatch(identity, r.recordId); await f.authority.consumeGrant(grant, grant.purpose);
  await f.authority.bindSessionId(grant, 'private-provider-id', { locator: '/PRIVATE/control-root/session-target' });
  await assert.rejects(f.authority.bindSessionId(grant, 'private-provider-id', { locator: '/PRIVATE/replacement-target' }), refused);
  const bytes = [...f.store.rows.values()][0].bytes;
  assert.ok(bytes.includes('/PRIVATE/control-root/session-target')); assert.ok(!bytes.includes('private-provider-id'));
  const inventory = await f.authority.observeInventory(identity);
  assert.ok(!JSON.stringify(inventory).includes('/PRIVATE')); assert.ok(!JSON.stringify(grant).includes('/PRIVATE'));
});

test('retained enrollment refuses observer and creator revision changes within an epoch', async () => {
  const f = await fixture();
  const changedObserver = { ...f.enrolled, observerRevision: 'reader-2' };
  await assert.rejects(createHostedProviderAuthority(changedObserver, f.ports), refused);
  const changedCreator = structuredClone(f.enrolled); changedCreator.issuers[0].implementationRevision = 'implementation-2';
  await assert.rejects(createHostedProviderAuthority(changedCreator, f.ports), refused);
  await f.authority.assertAdmission(identity);
});

test('physical grants redeem only once for the exact purpose and cannot regain effects on renewal', async () => {
  const f = await fixture(); const r = await f.authority.reserveProviderLaunch(f.reservation());
  const grant = await f.authority.claimDispatch(identity, r.recordId);
  await assert.rejects(f.authority.commitIssuance(grant), refused);
  await assert.rejects(f.authority.bindSessionId(grant, 'id'), refused);
  await assert.rejects(f.authority.consumeGrant(grant, 'credential-writer'), refused);
  await assert.rejects(f.authority.consumeGrant(grant, undefined as never), refused);
  await assert.rejects(f.authority.consumeGrant(structuredClone(grant), 'provider-launch'), refused);
  const context = await f.authority.consumeGrant(grant, 'provider-launch');
  assert.equal(context.incarnation, r.incarnation); assert.ok(Object.isFrozen(context.binding.issuer.resources));
  await assert.rejects(f.authority.consumeGrant(grant, 'provider-launch'), refused);
  const renewed = await f.authority.renew(grant);
  await assert.rejects(f.authority.consumeGrant(renewed, 'provider-launch'), refused);
  await f.authority.commitIssuance(renewed);
  await f.close(); await f.authority.fenceReset(resetIntent);
  const reset = await f.authority.claimResetDispatch(identity, r.recordId);
  await assert.rejects(f.authority.consumeGrant(reset, 'provider-launch'), refused);
  const effect = await f.authority.consumeGrant(reset, 'reset-effect');
  assert.ok(effect.effectIntentId);
  await assert.rejects(f.authority.consumeGrant(reset, 'reset-effect'), refused);
  f.setNow(31000);
  await assert.rejects(f.authority.consumeGrant(reset, 'reset-effect'), refused);
});

// Pause exactly one CAS without blocking reads or subsequent authority calls.
function pauseRedemptionCas(store: TestControlRoot, outcome: 'confirmed' | 'false' | 'throw' | 'lost-ack') {
  let entered!: () => void; let release!: () => void;
  const paused = new Promise<void>(resolve => { entered = resolve; });
  const resumed = new Promise<void>(resolve => { release = resolve; });
  const cas = store.compareAndSwap.bind(store);
  store.compareAndSwap = async (key, expected, bytes) => {
    store.compareAndSwap = cas;
    // Lost acknowledgement pauses after durable commit, all others before CAS.
    if (outcome === 'lost-ack') assert.equal(await cas(key, expected, bytes), true);
    entered(); await resumed;
    if (outcome === 'false') return false;
    if (outcome === 'throw' || outcome === 'lost-ack') throw new Error('PRIVATE-ADAPTER-ERROR');
    return cas(key, expected, bytes);
  };
  return { paused, release };
}

for (const purpose of ['provider-launch', 'config-mutation', 'credential-writer', 'credential-use'] as const) {
  for (const outcome of ['false', 'throw', 'lost-ack'] as const) {
    test(`unconfirmed redemption stays closed before/after ${outcome}, including renewal: ${purpose}`, async () => {
      const enrolled = enrollment();
      if (purpose === 'config-mutation') {
        enrolled.issuers.push({ ...structuredClone(enrolled.issuers[0]), issuerId: 'claude-run-creator' });
        enrolled.issuers[0].sourceKind = 'config';
        enrolled.issuers[0].resources = enrolled.issuers[0].resources.filter(key => key.includes(':credential:'));
      }
      const f = await fixture({ enrollment: enrolled });
      const r = await f.authority.reserve(f.reservation(purpose === 'provider-launch' ? 'provider-sessions' : 'provider-credentials'), purpose);
      const grant = await f.authority.claimDispatch(identity, r.recordId);
      const before = structuredClone([...f.store.rows.values()][0]);
      const gate = pauseRedemptionCas(f.store, outcome);
      const redemption = assert.rejects(f.authority.consumeGrant(grant, purpose), refused);
      await gate.paused;
      async function assertClosed() {
        await assert.rejects(f.authority.consumeGrant(grant, purpose), refused);
        await assert.rejects(f.authority.commitIssuance(grant), refused);
        await assert.rejects(f.authority.commitCredentialConfig(grant, 'PRIVATE-value'), refused);
        await assert.rejects(f.authority.bindSessionId(grant, 'PRIVATE-id', { locator: '/PRIVATE/session' }), refused);
        await assert.rejects(f.authority.renew(grant), refused);
      }
      try { await assertClosed(); } finally { gate.release(); }
      await redemption;
      await assertClosed();
      const after = [...f.store.rows.values()][0];
      assert.equal(after.revision, before.revision + (outcome === 'lost-ack' ? 1 : 0));
      const record = JSON.parse(after.bytes).records[0];
      assert.equal(record.phase, 'dispatched');
      assert.equal(record.providerIdCommitment, null);
      assert.equal(record.valueCommitment, null);
      assert.equal(record.privateCustody, null);
      assert.deepEqual(record.lease, JSON.parse(before.bytes).records[0].lease);
      const restarted = await f.restart();
      await assert.rejects(restarted.consumeGrant(grant, purpose), refused);
      await assert.rejects(restarted.commitIssuance(grant), refused);
      await assert.rejects(restarted.bindSessionId(grant, 'PRIVATE-id'), refused);
      await assert.rejects(restarted.renew(grant), refused);
      await assert.rejects(restarted.claimDispatch(identity, r.recordId), refused);
      assert.equal((await restarted.observeInventory(identity)).records[0].phase, 'unknown-after-crash');
    });
  }
}

test('only acknowledged redemption releases exact metadata completion, preserved once across renewal', async () => {
  const f = await fixture();
  const r = await f.authority.reserveProviderLaunch(f.reservation());
  const original = await f.authority.claimDispatch(identity, r.recordId);
  // Renewal before redemption preserves the unattempted state, not authorization.
  const grant = await f.authority.renew(original);
  await assert.rejects(f.authority.consumeGrant(original, original.purpose), refused);
  await assert.rejects(f.authority.commitIssuance(grant), refused);
  await assert.rejects(f.authority.bindSessionId(grant, 'exact-id'), refused);
  const gate = pauseRedemptionCas(f.store, 'confirmed');
  const redemption = f.authority.consumeGrant(grant, grant.purpose);
  await gate.paused;
  try {
    await assert.rejects(f.authority.commitIssuance(grant), refused);
    await assert.rejects(f.authority.bindSessionId(grant, 'exact-id'), refused);
    await assert.rejects(f.authority.renew(grant), refused);
    await assert.rejects(f.authority.consumeGrant(grant, grant.purpose), refused);
  } finally { gate.release(); }
  const effect = await redemption;
  assert.equal(effect.recordId, r.recordId); assert.equal(effect.incarnation, r.incarnation);
  const renewed = await f.authority.renew(grant);
  await assert.rejects(f.authority.commitIssuance(grant), refused);
  await assert.rejects(f.authority.bindSessionId(grant, 'exact-id'), refused);
  await assert.rejects(f.authority.consumeGrant(renewed, renewed.purpose), refused);
  await assert.rejects(f.authority.commitIssuance(structuredClone(renewed)), refused);
  await f.authority.bindSessionId(renewed, 'exact-id');
  await f.authority.bindSessionId(renewed, 'exact-id'); // Exact binding retries remain idempotent.
  await assert.rejects(f.authority.bindSessionId(renewed, 'different-id'), refused);
  await f.authority.commitIssuance(renewed);
  await assert.rejects(f.authority.commitIssuance(renewed), refused);
  const record = JSON.parse([...f.store.rows.values()][0].bytes).records[0];
  assert.equal(record.phase, 'issued'); assert.ok(record.providerIdCommitment);
  const restarted = await f.restart();
  await assert.rejects(restarted.consumeGrant(renewed, renewed.purpose), refused);
  await assert.rejects(restarted.commitIssuance(renewed), refused);
  await assert.rejects(restarted.bindSessionId(renewed, 'exact-id'), refused);
  await assert.rejects(restarted.claimDispatch(identity, r.recordId), refused);
});

test('one run attempt can reserve both credential resources and its distinct provider session', async () => {
  const f = await fixture(); const home = f.reservation('provider-credentials');
  const settings = { ...home, resourceKey: 'claude:credential:claude-settings' };
  const session = { ...home, category: 'provider-sessions' as const, resourceKey: 'claude:session:launch' };
  const a = await f.authority.reserveCredentialWriter(home);
  const b = await f.authority.reserveCredentialWriter(settings);
  const c = await f.authority.reserveProviderLaunch(session);
  assert.equal(new Set([a.incarnation, b.incarnation, c.incarnation]).size, 3);
  await assert.rejects(f.authority.reserveCredentialWriter(home), refused);
  await assert.rejects(f.authority.reserveProviderLaunch(session), refused);
  assert.equal((await f.authority.observeInventory(identity)).highWater, 3);
});

test('purpose-to-source catalog is transitively immutable; runtime mutation cannot admit a forbidden source', async () => {
  const helpers = await import('../src/providerAuthority/authorityHelpers.js');
  const catalog = helpers.PURPOSE_SOURCES;
  const expected = {
    'config-mutation': ['config'], 'credential-writer': ['login', 'run', 'migration'],
    'credential-use': ['login', 'run', 'probe', 'migration'],
    'provider-launch': ['login', 'run', 'probe', 'migration', 'retry', 'callback'],
  };
  assert.deepEqual(structuredClone(catalog), expected);
  assert.ok(Object.isFrozen(catalog));
  for (const sources of Object.values(catalog)) assert.ok(Object.isFrozen(sources));
  const mutable = catalog as unknown as Record<string, string[]>;
  // Strict-mode module code: every write to a frozen target throws rather than silently succeeding.
  assert.throws(() => mutable['credential-writer'].push('probe'), TypeError);
  assert.throws(() => { mutable['credential-writer'][0] = 'probe'; }, TypeError);
  assert.throws(() => { mutable['credential-writer'].length = 0; }, TypeError);
  assert.throws(() => { mutable['credential-writer'] = ['probe']; }, TypeError);
  assert.throws(() => { mutable['new-purpose'] = ['probe']; }, TypeError);
  assert.throws(() => { delete mutable['credential-writer']; }, TypeError);
  assert.equal(Reflect.set(mutable['credential-writer'], 3, 'probe'), false);
  assert.equal(Reflect.defineProperty(mutable, 'credential-writer', { value: ['probe'] }), false);
  assert.deepEqual(structuredClone(catalog), expected);
  // An enrolled probe issuer covering credential resources still cannot reserve a writer.
  const e = enrollment();
  const probe = { ...structuredClone(e.issuers[0]), issuerId: 'claude-probe-creator', sourceKind: 'probe' as const };
  probe.resources = probe.resources.filter(key => key.includes(':credential:'));
  e.issuers.push(probe);
  const f = await fixture({ enrollment: e });
  const asProbe = (): Reservation => ({ ...f.reservation('provider-credentials'), issuer: structuredClone(probe) });
  await assert.rejects(f.authority.reserveCredentialWriter(asProbe()), refused);
  await assert.rejects(f.authority.prepareCredentialConfig(asProbe()), refused);
  assert.equal((await f.authority.observeInventory(identity)).highWater, 0);
  // Valid source-purpose pairs keep working: probe may use, run may write.
  assert.ok(await f.authority.reserveCredentialUse(asProbe()));
  assert.ok(await f.authority.reserveCredentialWriter(f.reservation('provider-credentials', 'claude:credential:claude-settings')));
  await assert.rejects(f.authority.reserveCredentialWriter(asProbe()), refused);
});
