import { randomUUID } from 'node:crypto';
import {
  PROVIDER_AUTHORITY_CONTRACT, PROVIDER_CATALOG_REVISION, PROVIDER_CATALOG, PROVIDER_AUTHORITY_MAX_LEASE_MS as MAX_LEASE_MS,
  authorityIdentitySchema, canonicalAuthority as canonical, immutableAuthority as immutable,
  parseProviderAuthority as parse, refuseAuthority as refuse, reservationSchema, issuerSchema,
  resetIntentSchema, readbackSchema, validateEnrollment,
  type AuthorityReadonly, type AuthorityIdentity, type Enrollment, type Issuer, type Purpose, type Reservation,
} from './contracts.js';
import {
  authorityStateSchema, validateAuthorityState, type AuthorityState, type AuthorityRecord,
} from './state.js';
import type { HostedAuthorityPorts, ProviderGrant, LocalProviderCapability as Capability } from './ports.js';
import { same, hash, copy, custodySchema, commitmentSchema, PURPOSE_SOURCES } from './authorityHelpers.js';

/** No filesystem, provider, config, process or Fleet dependencies. The only
 * persistence path is the explicitly injected permissioned control-root port. */
class HostedProviderAuthority {
  readonly mode = 'hosted' as const;
  #caps = new WeakMap<ProviderGrant, Capability>();
  #key: string;
  #ports: HostedAuthorityPorts;
  #identity: AuthorityIdentity;
  #readerRevision: string;
  constructor(ports: HostedAuthorityPorts, enrollment: Enrollment) {
    this.#ports = Object.freeze({ ...ports });
    this.#identity = copy(enrollment.identity);
    this.#key = `provider-authority:${hash({ tenantId: enrollment.identity.tenantId, instanceId: enrollment.identity.instanceId })}`;
    this.#readerRevision = parse(issuerSchema.shape.implementationRevision, ports.reader.implementationRevision);
    if (enrollment.observerRevision !== this.#readerRevision) return refuse();
  }
  static async open(ports: HostedAuthorityPorts, enrollment: Enrollment) {
    const authority = new HostedProviderAuthority(ports, enrollment);
    await authority.#initialize(enrollment);
    return authority;
  }
  async #safe<T>(fn: () => Promise<T>): Promise<T> {
    try { return await fn(); } catch { return refuse(); }
  }
  async #load() {
    const row = await this.#ports.store.read(this.#key);
    if (!row || !Number.isSafeInteger(row.revision) || row.revision < 0) return refuse();
    const state = parse(authorityStateSchema, JSON.parse(row.bytes));
    if (canonical(state) !== row.bytes || state.schemaPin !== PROVIDER_CATALOG_REVISION) return refuse();
    validateEnrollment(state.enrollment);
    validateAuthorityState(state);
    return { row, state };
  }
  #now(state: AuthorityState) {
    const now = this.#ports.clock.now();
    if (!Number.isSafeInteger(now) || now < state.lastNow) return refuse();
    state.lastNow = now;
    return now;
  }
  /** One CAS, no hidden retry: ambiguous persistence consumes the caller's attempt. */
  async #change<T>(fn: (state: AuthorityState, now: number) => T): Promise<AuthorityReadonly<T>> {
    return this.#safe(async () => {
      const { row, state } = await this.#load();
      const result = fn(state, this.#now(state));
      validateAuthorityState(state);
      const bytes = canonical(parse(authorityStateSchema, state));
      if (!await this.#ports.store.compareAndSwap(this.#key, row.revision, bytes)) return refuse();
      return immutable(result);
    });
  }
  #exact(state: AuthorityState, identity: AuthorityIdentity, admission = false) {
    parse(authorityIdentitySchema, identity);
    if (!same(identity, this.#identity) || !same(identity, state.enrollment.identity)) return refuse();
    if (admission && state.tombstones.some(t => same(t.identity, identity))) return refuse();
  }
  #issuer(state: AuthorityState, issuer: Issuer, admission = false) {
    parse(issuerSchema, issuer);
    if (!state.enrollment.issuers.some(i => same(i, issuer))) return refuse();
    if (admission && state.closures.some(c => c.issuer.issuerId === issuer.issuerId)) return refuse();
  }
  #record(state: AuthorityState, id: string) {
    this.#exact(state, this.#identity);
    const record = state.records.find(r => r.id === id && same(r.binding.identity, this.#identity));
    return record ?? refuse();
  }
  #deadline(now: number, duration: number) {
    if (!Number.isSafeInteger(duration) || duration <= 0 || duration > MAX_LEASE_MS || !Number.isSafeInteger(now + duration)) return refuse();
    return now + duration;
  }
  #grant(record: AuthorityReadonly<AuthorityRecord>, purpose: Purpose | 'reset-effect', expiresAt = record.lease.expiresAt): ProviderGrant {
    const grant = immutable({ recordId: record.id, incarnation: record.incarnation,
      identity: copy(record.binding.identity), binding: copy(record.binding), purpose, expiresAt,
      effectIntentId: purpose === 'reset-effect' ? record.resetEffect?.intentId ?? null : null }) as ProviderGrant;
    this.#caps.set(grant, { recordId: record.id, leaseId: record.lease.id, purpose, consumed: false, effectAttempted: false, effectConsumed: false });
    return grant;
  }
  #capability(state: AuthorityState, grant: ProviderGrant, now: number, purpose?: Purpose | 'reset-effect') {
    const cap = this.#caps.get(grant);
    if (!cap || cap.consumed || (purpose && cap.purpose !== purpose)) return refuse();
    const record = this.#record(state, cap.recordId);
    if (record.incarnation !== grant.incarnation || cap.leaseId !== record.lease.id || now >= grant.expiresAt) return refuse();
    return { cap, record };
  }
  async #initialize(enrollment: Enrollment) {
    return this.#safe(async () => {
      const row = await this.#ports.store.read(this.#key);
      if (!row) {
        const state: AuthorityState = { contract: PROVIDER_AUTHORITY_CONTRACT, schemaPin: PROVIDER_CATALOG_REVISION,
          enrollment: copy(enrollment), highWater: 0, lastNow: 0, records: [], closures: [], reset: null, tombstones: [], transfers: [] };
        this.#now(state);
        if (!await this.#ports.store.compareAndSwap(this.#key, null, canonical(state))) return refuse();
      }
      const { state } = await this.#load();
      if (!same(state.enrollment, enrollment)) return refuse();
    });
  }
  /** Append before config/login/provider launch. No physical action is permitted
   * until claimDispatch returns a capability after a durable exclusive claim. */
  async reserve(input: Reservation, purpose: Purpose, leaseMs = MAX_LEASE_MS,
    privateCustody?: { locator: string }): Promise<Readonly<{ recordId: string; incarnation: string }>> {
    return this.#change((state, now) => {
      const binding = parse(reservationSchema, input);
      this.#exact(state, binding.identity, true); this.#issuer(state, binding.issuer, true);
      const resource = PROVIDER_CATALOG.find(r => r.key === binding.resourceKey && r.provider === binding.issuer.provider && r.category === binding.category);
      if (!resource || !binding.issuer.resources.includes(resource.key)) return refuse();
      if (binding.category === 'provider-sessions' ? purpose !== 'provider-launch'
        : !['config-mutation', 'credential-writer', 'credential-use'].includes(purpose)) return refuse();
      if (!PURPOSE_SOURCES[purpose]?.includes(binding.issuer.sourceKind)
        || (binding.issuer.sourceKind === 'retry' && !binding.replacementOf)) return refuse();
      if (state.records.some(r => same(r.binding.identity, binding.identity) && r.binding.issuer.issuerId === binding.issuer.issuerId
        && r.binding.category === binding.category && r.binding.resourceKey === binding.resourceKey
        && r.binding.operationId === binding.operationId && r.binding.attemptId === binding.attemptId)) return refuse();
      if (binding.replacementOf) this.#replacement(state, binding);
      // Expiry never releases a possibly live writer. Only positive finish or
      // independent revoked-and-quiescent readback closes it.
      if (binding.category === 'provider-credentials' && state.records.some(r => same(r.binding.identity, binding.identity)
        && r.binding.resourceKey === binding.resourceKey && r.lease.status === 'open'
        && (purpose !== 'credential-use' || r.purpose !== 'credential-use'))) return refuse();
      const record: AuthorityRecord = { id: randomUUID(), incarnation: randomUUID(), sequence: ++state.highWater,
        binding, purpose, phase: 'reserved', lease: { id: randomUUID(), expiresAt: this.#deadline(now, leaseMs), status: 'open' },
        providerIdCommitment: null, valueCommitment: null,
        privateCustody: privateCustody === undefined ? null : parse(custodySchema, privateCustody), resetEffect: null };
      state.records.push(record);
      return { recordId: record.id, incarnation: record.incarnation };
    });
  }
  #replacement(state: AuthorityState, binding: Reservation) {
    const previous = this.#record(state, binding.replacementOf!);
    if (previous.binding.resourceKey !== binding.resourceKey
      || previous.binding.issuer.provider !== binding.issuer.provider
      || previous.binding.issuer.agentKind !== binding.issuer.agentKind
      || previous.binding.issuer.implementationRevision !== binding.issuer.implementationRevision
      || previous.binding.issuer.catalogRevision !== binding.issuer.catalogRevision
      || state.records.some(r => r.binding.replacementOf === previous.id)
      || previous.resetEffect?.readback !== 'revoked-and-quiescent') return refuse();
  }
  prepareCredentialConfig(input: Reservation, custody?: { locator: string }) { return this.reserve(input, 'config-mutation', MAX_LEASE_MS, custody); }
  reserveCredentialWriter(input: Reservation, custody?: { locator: string }) { return this.reserve(input, 'credential-writer', MAX_LEASE_MS, custody); }
  reserveCredentialUse(input: Reservation, custody?: { locator: string }) { return this.reserve(input, 'credential-use', MAX_LEASE_MS, custody); }
  reserveProviderLaunch(input: Reservation, custody?: { locator: string }) { return this.reserve(input, 'provider-launch', MAX_LEASE_MS, custody); }
  async claimDispatch(identity: AuthorityIdentity, recordId: string): Promise<ProviderGrant> {
    // Grant creation occurs AFTER persistence; a lost CAS acknowledgement yields
    // no grant and leaves a burned dispatch, reconstructed as unknown on restart.
    const record = await this.#change((state, now) => {
      this.#exact(state, identity, true);
      const r = this.#record(state, recordId);
      this.#issuer(state, r.binding.issuer, true);
      if (r.resetEffect || r.phase !== 'reserved' || r.lease.status !== 'open' || now >= r.lease.expiresAt) return refuse();
      r.phase = 'dispatched'; return copy(r);
    });
    return this.#grant(record, record.purpose);
  }
  /** Physical adapters redeem the local grant immediately before their one
   * external effect. Metadata/lease completion uses the same grant afterward. */
  async consumeGrant(grant: ProviderGrant, purpose: Purpose | 'reset-effect') {
    const result = await this.#change((state, now) => {
      const { cap, record } = this.#capability(state, grant, now, purpose);
      if (cap.effectAttempted || cap.purpose !== purpose) return refuse();
      if (purpose === 'reset-effect') {
        if (record.resetEffect?.dispatch !== 'claimed' || record.resetEffect.intentId !== grant.effectIntentId
          || record.resetEffect.readback !== 'unproven') return refuse();
      } else {
        this.#exact(state, grant.identity, true); this.#issuer(state, record.binding.issuer, true);
        if (record.resetEffect || record.phase !== 'dispatched' || record.lease.status !== 'open') return refuse();
      }
      // Burn before persistence, but never treat an ambiguous attempt as proof
      // that redemption succeeded. Concurrent metadata/renewal must stay closed.
      cap.effectAttempted = true;
      return { recordId: record.id, incarnation: record.incarnation, binding: copy(record.binding), purpose,
        effectIntentId: grant.effectIntentId, expiresAt: grant.expiresAt };
    });
    this.#caps.get(grant)!.effectConsumed = true;
    return result;
  }
  async commitIssuance(grant: ProviderGrant, value?: string) {
    return this.#change((state, now) => {
      this.#exact(state, grant.identity, true);
      const { cap, record } = this.#capability(state, grant, now);
      this.#issuer(state, record.binding.issuer, true);
      if (!cap.effectConsumed || record.resetEffect || cap.purpose === 'reset-effect' || record.phase !== 'dispatched' || record.lease.status !== 'open') return refuse();
      if (value !== undefined) {
        if (typeof value !== 'string' || record.binding.category !== 'provider-credentials' || record.purpose === 'credential-use') return refuse();
        record.valueCommitment = parse(commitmentSchema, this.#ports.keys.commit('credential-value', canonical({ binding: record.binding, incarnation: record.incarnation }), value));
      }
      record.phase = 'issued';
    });
  }
  commitCredentialConfig(grant: ProviderGrant, value?: string) {
    if (this.#caps.get(grant)?.purpose !== 'config-mutation') return Promise.reject(new Error('provider_authority_unavailable'));
    return this.commitIssuance(grant, value);
  }
  async bindSessionId(grant: ProviderGrant, providerId: string, privateCustody?: { locator: string }) {
    return this.#change((state, now) => {
      this.#exact(state, grant.identity, true);
      const { cap, record } = this.#capability(state, grant, now, 'provider-launch');
      this.#issuer(state, record.binding.issuer, true);
      if (!cap.effectConsumed || record.resetEffect || !['dispatched', 'issued'].includes(record.phase) || typeof providerId !== 'string' || !providerId.length) return refuse();
      const commitment = parse(commitmentSchema, this.#ports.keys.commit('provider-id', canonical({ binding: record.binding, incarnation: record.incarnation }), providerId));
      if (record.providerIdCommitment && !same(record.providerIdCommitment, commitment)) return refuse();
      if (privateCustody !== undefined) {
        const custody = parse(custodySchema, privateCustody);
        if (record.privateCustody && !same(record.privateCustody, custody)) return refuse();
        record.privateCustody = custody;
      }
      record.providerIdCommitment = commitment;
    });
  }
  async renew(grant: ProviderGrant, leaseMs = MAX_LEASE_MS): Promise<ProviderGrant> {
    const record = await this.#change((state, now) => {
      this.#exact(state, grant.identity, true);
      const { cap, record } = this.#capability(state, grant, now);
      this.#issuer(state, record.binding.issuer, true);
      if ((cap.effectAttempted && !cap.effectConsumed) || record.resetEffect || cap.purpose === 'reset-effect'
        || record.lease.status !== 'open' || !['dispatched', 'issued'].includes(record.phase)) return refuse();
      record.lease.expiresAt = this.#deadline(now, leaseMs); record.lease.id = randomUUID();
      return copy(record);
    });
    this.#caps.get(grant)!.consumed = true;
    const renewed = this.#grant(record, record.purpose);
    this.#caps.get(renewed)!.effectAttempted = this.#caps.get(grant)!.effectAttempted;
    this.#caps.get(renewed)!.effectConsumed = this.#caps.get(grant)!.effectConsumed;
    return renewed;
  }
  /** Finish proves only that this writer/use operation returned. It is NOT
   * credential or session revocation and cannot retire inventory. */
  async finish(grant: ProviderGrant) {
    return this.#change((state, now) => {
      const { cap, record } = this.#capability(state, grant, now);
      if (cap.purpose === 'reset-effect' || !['dispatched', 'issued'].includes(record.phase) || record.lease.status !== 'open') return refuse();
      record.phase = 'finished'; record.lease.status = 'closed'; cap.consumed = true;
    });
  }
  async unknownAfterCrash(identity: AuthorityIdentity, recordId: string) {
    return this.#change(state => {
      this.#exact(state, identity);
      const record = this.#record(state, recordId);
      if (record.phase === 'finished' || record.resetEffect?.readback === 'revoked-and-quiescent') return refuse();
      record.phase = 'unknown-after-crash';
    });
  }
  async closeIssuer(identity: AuthorityIdentity, issuer: Issuer, expectedHighWater: number) {
    return this.#change(state => {
      this.#exact(state, identity); this.#issuer(state, issuer);
      const prior = state.closures.find(c => c.issuer.issuerId === issuer.issuerId);
      if (prior) { if (prior.highWater !== expectedHighWater || !same(prior.issuer, issuer)) return refuse(); return; }
      if (expectedHighWater !== state.highWater) return refuse();
      state.closures.push({ issuer: copy(issuer), highWater: state.highWater });
    });
  }
  #sealed(state: AuthorityState) {
    return state.enrollment.issuers.every(i => state.closures.some(c => same(c.issuer, i)));
  }
  async observeInventory(identity: AuthorityIdentity) {
    return this.#safe(async () => {
      const { state } = await this.#load(); this.#exact(state, identity);
      const now = this.#now(state);
      return immutable({ identity: copy(identity), catalogRevision: state.enrollment.catalogRevision,
        highWater: state.highWater, exhaustive: this.#sealed(state),
        seal: this.#sealed(state) ? { identity: copy(identity), catalogRevision: state.enrollment.catalogRevision,
          highWater: state.highWater, commitment: hash({ enrollment: state.enrollment, closures: state.closures, highWater: state.highWater }) } : null,
        closures: copy(state.closures),
        records: state.records.filter(r => same(r.binding.identity, identity)).map(r => ({
          recordId: r.id, incarnation: r.incarnation, sequence: r.sequence, binding: copy(r.binding), purpose: r.purpose,
          phase: r.lease.status === 'open' && (now >= r.lease.expiresAt || r.phase === 'dispatched') ? 'unknown-after-crash' as const : r.phase,
          lease: copy(r.lease), hasProviderId: r.providerIdCommitment !== null,
          resetEffect: copy(r.resetEffect),
        })),
      });
    });
  }
  async fenceReset(input: unknown) {
    return this.#change(state => {
      const intent = parse(resetIntentSchema, input);
      this.#exact(state, intent.predecessor);
      if (intent.successor.tenantId !== intent.predecessor.tenantId || intent.successor.instanceId !== intent.predecessor.instanceId
        || intent.successor.predecessorGeneration === intent.predecessor.predecessorGeneration
        || intent.successor.runtimeGeneration === intent.predecessor.runtimeGeneration
        || intent.successor.ownerEpoch === intent.predecessor.ownerEpoch
        || state.tombstones.some(t => same(t.identity, intent.successor)
          || t.identity.predecessorGeneration === intent.successor.predecessorGeneration
          || t.identity.runtimeGeneration === intent.successor.runtimeGeneration)) return refuse();
      if (state.reset) { if (!same(state.reset.intent, intent)) return refuse(); return state.reset.intentId; }
      const intentId = hash(intent);
      state.reset = { intent, intentId, retired: false };
      state.tombstones.push({ identity: copy(intent.predecessor), intentId });
      for (const record of state.records.filter(r => same(r.binding.identity, intent.predecessor))) {
        if (record.resetEffect) continue;
        record.resetEffect = { kind: 'reset', operationId: intent.operationId, intentId: hash({ intentId, recordId: record.id, incarnation: record.incarnation }),
          dispatch: 'unclaimed', readback: 'unproven', evidenceCommitment: null, observerRevision: null };
      }
      return intentId;
    });
  }
  /** A retry/replacement must retire the exact old incarnation first. Its
   * durable claim remains authoritative if a whole-generation reset follows. */
  async prepareResourceRetirement(identity: AuthorityIdentity, recordId: string, operationId: string) {
    return this.#change(state => {
      this.#exact(state, identity, true);
      parse(issuerSchema.shape.issuerId, operationId);
      const record = this.#record(state, recordId);
      const intentId = hash({ kind: 'resource-retirement', identity, recordId, incarnation: record.incarnation, operationId });
      if (record.resetEffect) {
        if (record.resetEffect.intentId !== intentId) return refuse();
        return intentId;
      }
      record.resetEffect = { kind: 'resource-retirement', operationId, intentId, dispatch: 'unclaimed',
        readback: 'unproven', evidenceCommitment: null, observerRevision: null };
      return intentId;
    });
  }
  async claimResetDispatch(identity: AuthorityIdentity, recordId: string, leaseMs = MAX_LEASE_MS): Promise<ProviderGrant> {
    const result = await this.#change((state, now) => {
      this.#exact(state, identity);
      const r = this.#record(state, recordId);
      if (!r.resetEffect || (r.resetEffect.kind === 'reset' && (!state.reset || !this.#sealed(state))) || r.resetEffect.dispatch !== 'unclaimed'
        || r.resetEffect.readback !== 'unproven') return refuse();
      r.resetEffect.dispatch = 'claimed';
      return { record: copy(r), expiresAt: this.#deadline(now, leaseMs) };
    });
    return this.#grant(result.record, 'reset-effect', result.expiresAt);
  }
  /** Readback is available after a lost claim/reply, with no redispatch. Caller
   * cannot submit proof; only the separately injected trusted reader can do so. */
  async observeResetRecord(identity: AuthorityIdentity, recordId: string) {
    return this.#safe(async () => {
      const { state } = await this.#load(); this.#exact(state, identity);
      const record = this.#record(state, recordId);
      if (!record.resetEffect) return refuse();
      const request = immutable({ identity: copy(identity), binding: copy(record.binding), recordId, incarnation: record.incarnation, intentId: record.resetEffect.intentId });
      const observation = parse(readbackSchema, await this.#ports.reader.observe(request));
      if (observation.observerRevision !== this.#readerRevision
        || !same(observation.identity, request.identity) || !same(observation.binding, request.binding) || observation.recordId !== request.recordId
        || observation.incarnation !== request.incarnation || observation.intentId !== request.intentId) return refuse();
      return this.#change(current => {
        const r = this.#record(current, recordId);
        if (!r.resetEffect || r.resetEffect.intentId !== observation.intentId) return refuse();
        if (observation.result.state === 'revoked-and-quiescent') {
          if (r.resetEffect.readback === 'revoked-and-quiescent'
            && (r.resetEffect.evidenceCommitment !== observation.result.evidenceCommitment || r.resetEffect.observerRevision !== observation.observerRevision)) return refuse();
          r.resetEffect.readback = 'revoked-and-quiescent'; r.resetEffect.evidenceCommitment = observation.result.evidenceCommitment;
          r.resetEffect.observerRevision = observation.observerRevision; r.lease.status = 'closed';
        }
        return r.resetEffect.readback;
      });
    });
  }
  async retireReset(identity: AuthorityIdentity) {
    return this.#change(state => {
      this.#exact(state, identity);
      if (!state.reset || !this.#sealed(state) || state.records.some(r => same(r.binding.identity, identity)
        && (r.resetEffect?.readback !== 'revoked-and-quiescent' || r.lease.status !== 'closed'))) return refuse();
      state.reset.retired = true;
      return { state: 'retired' as const, intentId: state.reset.intentId, highWater: state.highWater };
    });
  }
  async observeReset(identity: AuthorityIdentity) {
    return this.#safe(async () => {
      const { state } = await this.#load(); this.#exact(state, identity);
      return immutable({ predecessorRefused: state.tombstones.some(t => same(t.identity, identity)),
        state: state.reset?.retired ? 'retired' as const : state.reset ? 'fenced' as const : 'active' as const,
        intent: copy(state.reset?.intent ?? null), exhaustive: this.#sealed(state) });
    });
  }
  async transferSuccessor(input: Enrollment) {
    return this.#change(state => {
      const enrollment = validateEnrollment(input);
      this.#exact(state, this.#identity);
      if (!state.reset?.retired || !same(state.reset.intent.successor, enrollment.identity)) return refuse();
      state.transfers.push(copy(state.reset.intent)); state.enrollment = enrollment;
      state.closures = []; state.reset = null;
      return { successor: copy(enrollment.identity) };
    });
  }
  async observePredecessorRefusal(identity: AuthorityIdentity) {
    return this.#safe(async () => {
      parse(authorityIdentitySchema, identity);
      if (identity.tenantId !== this.#identity.tenantId || identity.instanceId !== this.#identity.instanceId) return refuse();
      const { state } = await this.#load();
      const tombstone = state.tombstones.find(t => same(t.identity, identity));
      return immutable(tombstone ? { state: 'permanently-refused' as const, identity: copy(identity), intentId: tombstone.intentId }
        : { state: 'unproven' as const, identity: copy(identity) });
    });
  }
  async assertAdmission(identity: AuthorityIdentity) {
    return this.#safe(async () => { const { state } = await this.#load(); this.#exact(state, identity, true); });
  }
}

export type HostedProviderAuthorityHandle = HostedProviderAuthority;
export async function createHostedProviderAuthority(enrollment: Enrollment, ports: HostedAuthorityPorts): Promise<HostedProviderAuthorityHandle> {
  try {
    if (!ports || ports.store?.custody !== 'durable-permissioned-control-root'
      || ![ports.store.read, ports.store.compareAndSwap, ports.clock?.now, ports.keys?.commit, ports.reader?.observe]
        .every(method => typeof method === 'function')) return refuse();
    const validated = validateEnrollment(enrollment);
    return await HostedProviderAuthority.open(ports, validated);
  } catch { return refuse(); }
}
/** Explicitly separate mode with no hosted-compatible grants or methods. */
export function createSelfHostedProviderAuthority() {
  return Object.freeze({ mode: 'self-hosted-unqualified' as const, hostedResetQualified: false as const });
}
