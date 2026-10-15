import { createHmac, createPrivateKey, createPublicKey, sign, timingSafeEqual, verify } from 'node:crypto';
import type { Knex } from 'knex';
import {
  canonicalFleetJson as canonical, INSTANCE_PERMISSIONS, EXTENSION_AUTHORITY_V2, EXTENSION_AUTHORITY_V2_SCHEMA,
  EXTENSION_AUTHORITY_V2_LIMITS as limits, authorityV2EnvelopeSchema, authorityV2ResponseSchema,
  routingTrustSchema, type AuthorityV2Request, type AuthorityV2Response, type FleetExtensionRequest,
} from '@propr/shared';
import { digest } from './contract.js';
import { AuthorityProofRefusal } from './extensionAuthorityProof.js';
import type { FleetExtensionPlane } from './extensions.js';
import { configuredResetFence } from './resetFence.js';

export const extensionAuthorityV2Pin = digest(JSON.parse(EXTENSION_AUTHORITY_V2_SCHEMA));
const refuse = (): never => { throw new AuthorityProofRefusal(); };
function nativeIntent(native: FleetExtensionRequest) {
  return native.action === 'recipient.issue' ? native.intent
    : native.action === 'profile.create' ? { action: native.action, input: native.input }
      : native.action === 'profile.update' ? { action: native.action, input: native.input, selection: native.selection } : undefined;
}
interface Connection {
  inTransaction: boolean;
  prepare(sql: string): { get(...args: unknown[]): Record<string, unknown> | undefined; run(...args: unknown[]): unknown };
  exec(sql: string): unknown;
  pragma(sql: string, options?: { simple: boolean }): unknown;
}
interface ObservationContext {
  envelope: ReturnType<typeof authorityV2EnvelopeSchema.parse>;
  trust: ReturnType<typeof routingTrustSchema.parse>;
  nativePin: string;
  secret: string;
}
/** Bind every query and nested store transaction to the manually owned connection.
 * A nested transaction is a scope, not a commit: the outer owner rolls everything
 * back on any error. No pooled query or independent save can escape this boundary. */
function transactionDatabase(database: Knex, connection: Connection): Knex {
  const scoped: Knex = new Proxy(database, {
    apply(target, receiver, args) { return Reflect.apply(target, receiver, args).connection(connection); },
    get(target, property) {
      if (property === 'transaction') return async (fn: (trx: Knex) => Promise<unknown>) => fn(scoped);
      if (property === 'raw') return (...args: unknown[]) => Reflect.apply(target.raw, target, args).connection(connection);
      return Reflect.get(target, property);
    },
  });
  return scoped;
}

export class ExtensionAuthorityV2Plane {
  private stopped = false;
  constructor(readonly extensions: FleetExtensionPlane) {}
  shutdown() { this.stopped = true; }
  private key() {
    const key = createPrivateKey(this.extensions.fleet.files.readSync('native-authority-key.pem'));
    if (key.asymmetricKeyType !== 'ed25519') return refuse();
    return key;
  }
  verificationKey() { return createPublicKey(this.key()).export({ type: 'spki', format: 'der' }).toString('base64url'); }
  private trust() {
    const raw = this.extensions.fleet.files.readSync('routing-extension-authority-v2.json');
    if (Buffer.byteLength(raw) > 2048) return refuse();
    const trust = routingTrustSchema.parse(JSON.parse(raw));
    if (canonical(trust) !== raw) return refuse();
    const key = createPublicKey({ key: Buffer.from(trust.publicKey, 'base64url'), type: 'spki', format: 'der' });
    if (key.asymmetricKeyType !== 'ed25519' || key.export({ type: 'spki', format: 'der' }).toString('base64url') !== trust.publicKey) return refuse();
    return { trust, key };
  }
  private async authenticate(raw: string) {
    if (this.stopped || Buffer.byteLength(raw) > limits.requestBytes) return refuse();
    const parsed = JSON.parse(raw);
    if (canonical(parsed) !== raw) return refuse();
    const envelope = authorityV2EnvelopeSchema.parse(parsed);
    // Refuse schema normalization: all signatures and commitments name wire bytes.
    if (canonical(envelope) !== raw) return refuse();
    const { request: r, routing, native } = envelope;
    if (r.contractPin !== extensionAuthorityV2Pin || Buffer.byteLength(canonical({ request: r, routing })) > limits.metadataBytes
      || (r.phase === 'dispatch') !== (native !== undefined)) return refuse();
    if (native && (native.action !== r.work.extension.action || digest(native) !== r.work.extension.requestDigest)) return refuse();
    const { trust, key } = this.trust();
    const s = routing.statement;
    if (canonical(s.request) !== canonical(r) || s.expiresAt !== r.expiresAt) return refuse();
    for (const field of ['keyId', 'keyEpoch', 'authorityEpoch', 'producerRevision', 'producerEpoch'] as const) if (s[field] !== trust[field]) return refuse();
    const signature = Buffer.from(routing.signature, 'base64url');
    if (signature.toString('base64url') !== routing.signature || !verify(null, Buffer.from(canonical(s)), key, signature)) return refuse();
    const nativePin = this.verificationKey();
    const secret = await this.extensions.fleet.extensionAuthority({ ...r.work.extension, expiresAt: r.expiresAt });
    if (!timingSafeEqual(createHmac('sha256', secret).update(canonical({ request: r, routing })).digest(), Buffer.from(envelope.mac, 'hex'))) return refuse();
    return { envelope, trust, nativePin, secret };
  }
  async invoke(raw: string, deliver?: (response: AuthorityV2Response) => void): Promise<AuthorityV2Response> {
    let connection: Connection | undefined;
    let synchronous: number | undefined;
    let discard: (() => void) | undefined;
    try {
      const { envelope, trust, nativePin, secret } = await this.authenticate(raw);
      const { request: r, routing, native } = envelope;
      connection = await this.extensions.store.database.client.acquireConnection();
      const c = connection!;
      synchronous = this.synchronousPolicy(c);
      c.pragma('synchronous = FULL');
      const get = (sql: string, ...args: unknown[]) => c.prepare(sql).get(...args);
      const run = (sql: string, ...args: unknown[]) => c.prepare(sql).run(...args);
      const observe = this.observer(c, { envelope, trust, nativePin, secret });
      const commit = () => {
        const finish = () => { const now = observe(); run('UPDATE extension_authority_v2_clock SET checked_ms=? WHERE id=1', now); c.exec('COMMIT'); };
        const managed = configuredResetFence();
        if (managed) managed.fence.write(managed.identity, finish); else finish();
      };
      const id = r.work.extension.operationId;
      const envelopeDigest = digest(envelope);
      c.exec('BEGIN IMMEDIATE');
      observe();
      const prior = get('SELECT * FROM extension_authority_v2_intents WHERE challenge=?', r.challenge);
      if (prior) {
        const response = this.replay(c, r, envelopeDigest, prior);
        commit(); deliver?.(response); return response;
      }
      if (Number(get('SELECT count(*) AS n FROM extension_authority_v2_intents')!.n) >= limits.challenges) return refuse();
      const operation = get('SELECT * FROM extension_authority_v2_operations WHERE operation_id=?', id);
      this.admitOperation(c, { envelope, trust, nativePin, secret }, operation);
      const receiptFor = (phase: string) => this.receiptFor(c, { envelope, trust, nativePin, secret }, phase);
      if (r.phase !== 'request' && r.phase !== 'status' && !receiptFor('request')) return refuse();
      const dispatch = receiptFor('dispatch');
      if (r.phase === 'completion' && !dispatch) return refuse();
      this.checkAcquisition(c, r, native);
      run('INSERT INTO extension_authority_v2_intents VALUES (?, ?, ?, ?)', r.challenge, id, r.phase, envelopeDigest);
      commit(); // Create-only intent survives every subsequent ambiguity.
      if (native) {
        await this.fenceNative(r);
      }
      c.exec('BEGIN IMMEDIATE');
      const checkedAt = Math.floor(observe() / 1000);
      // Status observes the result inside its admission transaction, not the earlier intent transaction.
      const committedDispatch = receiptFor('dispatch');
      const coreDecision = { requestDigest: digest(r), workDigest: digest(r.work), authorityEpoch: r.work.coreAuthorityEpoch,
        actorId: r.work.extension.githubActorId, role: 'admin' as const, source: 'local' as const,
        permission: 'instance.manage_settings' as const, checkedAt };
      const routingDigest = digest(routing), trustDigest = digest(trust);
      const combinedDecisionDigest = digest({ coreDecision, routingDigest, trustDigest });
      let nativeResultDigest: string | null = committedDispatch?.statement.result.nativeResultDigest ?? null;
      if (native) {
        const rawIntent = nativeIntent(native);
        const outcome = await this.extensions.dispatchAtomic(r.work.extension, native, rawIntent,
          { database: transactionDatabase(this.extensions.store.database, c), guard: assertion => {
            if (assertion && assertion.operationId !== id && assertion.operationId !== r.work.acquisitionOperationId) return refuse();
            observe();
          }, secret });
        discard = outcome.discard;
        nativeResultDigest = digest(outcome.result);
      }
      const buildResult = () => {
        const recipientCommitment = native?.action === 'recipient.issue'
          ? { operationId: native.mutationOperationId, intentDigest: digest(native.intent) }
          : committedDispatch?.statement.result.recipientCommitment ?? null;
        const result = { recipientCommitment, state: r.phase === 'request' ? 'admitted' as const : native || committedDispatch ? 'completed' as const : 'incomplete' as const,
          nativeResultDigest, dispatchDecisionDigest: native ? combinedDecisionDigest : committedDispatch?.statement.combinedDecisionDigest ?? null };
        return result;
      };
      const result = buildResult();
      const statement = { contract: EXTENSION_AUTHORITY_V2, contractPin: extensionAuthorityV2Pin, request: r,
        coreDecision, routingDigest, trustDigest, combinedDecisionDigest, result, resultDigest: digest(result),
        committedAt: Math.floor(observe() / 1000), expiresAt: r.expiresAt };
      const response = authorityV2ResponseSchema.parse({ statement, signature: sign(null, Buffer.from(canonical(statement)), this.key()).toString('base64url') });
      if (Buffer.byteLength(canonical(response)) > limits.responseBytes) return refuse();
      run('INSERT INTO extension_authority_v2_receipts VALUES (?, ?, ?)', r.challenge, canonical(response), digest(response));
      commit();
      discard = undefined;
      deliver?.(response);
      return response;
    } catch { discard?.(); return refuse(); }
    finally { await this.releaseConnection(connection, synchronous); }
  }
  private checkTime(context: ObservationContext, latestObservation: number, now: number, high: Record<string, unknown> | undefined) {
    const { envelope: { request: r, routing: { statement: s } } } = context;
    if (!Number.isSafeInteger(now) || now < latestObservation || !high || now < Number(high.checked_ms) || r.issuedAt * 1000 > now || now >= r.expiresAt * 1000
      || r.expiresAt <= r.issuedAt || r.expiresAt - r.issuedAt > limits.seconds
      || s.checkedAt < r.issuedAt || s.checkedAt * 1000 > now || s.checkedAt >= s.expiresAt) return refuse();
    const a = r.work.extension;
    if (r.phase === 'dispatch' && (a.issuedAt * 1000 > now || now >= a.expiresAt * 1000
      || a.expiresAt <= a.issuedAt || a.expiresAt - a.issuedAt > 60)) return refuse();
  }

  private observer(c: Connection, context: ObservationContext) {
    const { envelope: { request: r }, trust, nativePin, secret } = context;
    const get = (sql: string, ...args: unknown[]) => c.prepare(sql).get(...args);
    let latestObservation = 0;
    return () => {
      if (this.stopped) return refuse();
      const now = Date.now();
      const high = get('SELECT checked_ms FROM extension_authority_v2_clock WHERE id=1');
      this.checkTime(context, latestObservation, now, high);
      const a = r.work.extension;
      const row = get(`SELECT e.epoch, m.role, m.source, i.instance_id FROM native_authority_epoch e
        CROSS JOIN instance_members m CROSS JOIN extension_instance_identity i WHERE e.id=1 AND i.id=1 AND m.github_user_id=?`, String(a.githubActorId));
      if (!INSTANCE_PERMISSIONS.includes('instance.manage_settings') || !row || row.role !== 'admin' || row.source !== 'local' || !Number.isSafeInteger(row.epoch) || String(row.epoch) !== r.work.coreAuthorityEpoch
        || row.instance_id !== r.work.extensionInstanceId) return refuse();
      const current = this.extensions.fleet.extensionProofObservationSync();
      for (const field of ['hostedInstanceId', 'storageInstanceId', 'runtimeGeneration', 'storageGeneration', 'placementGeneration'] as const) {
        if (current.binding[field] !== a[field]) return refuse();
      }
      if (current.secret !== secret || this.verificationKey() !== nativePin || digest(this.trust().trust) !== digest(trust)) return refuse();
      latestObservation = now;
      return now;
    };
  }
  private replay(c: Connection, r: AuthorityV2Request, envelopeDigest: string, prior: Record<string, unknown>) {
    const get = (sql: string, ...args: unknown[]) => c.prepare(sql).get(...args);
    if (r.phase === 'status' || prior.envelope_digest !== envelopeDigest) return refuse();
    const retained = get('SELECT * FROM extension_authority_v2_receipts WHERE challenge=?', r.challenge);
    if (!retained) return refuse(); // Intent without receipt is terminally incomplete; never redispatch.
    const response = authorityV2ResponseSchema.parse(JSON.parse(String(retained.response)));
    if (digest(response) !== retained.response_digest || canonical(response) !== retained.response
      || canonical(response.statement.request) !== canonical(r)
      || !verify(null, Buffer.from(canonical(response.statement)), createPublicKey(this.key()), Buffer.from(response.signature, 'base64url'))) return refuse();
    return response;
  }

  private admitOperation(c: Connection, context: ObservationContext, operation: Record<string, unknown> | undefined) {
    const { envelope: { request: r }, trust, nativePin } = context;
    const id = r.work.extension.operationId;
    const get = (sql: string, ...args: unknown[]) => c.prepare(sql).get(...args);
    const run = (sql: string, ...args: unknown[]) => c.prepare(sql).run(...args);
    if (r.phase === 'request') {
      if (operation || Number(get('SELECT count(*) AS n FROM extension_authority_v2_operations')!.n) >= limits.operations) return refuse();
      // Reject a v1 operation, including an incomplete tombstone.
      this.absentNative(id);
      run('INSERT INTO extension_authority_v2_operations VALUES (?, ?, ?, ?, ?)', id, digest(r.work), r.work.extension.nonce, digest(trust), digest(nativePin));
    } else if (!operation || operation.work_digest !== digest(r.work) || operation.trust_digest !== digest(trust)
      || operation.core_key_digest !== digest(nativePin)) return refuse();
  }

  private receiptFor(c: Connection, context: ObservationContext, phase: string) {
    const { envelope: { request: r }, trust } = context;
    const id = r.work.extension.operationId;
    const get = (sql: string, ...args: unknown[]) => c.prepare(sql).get(...args);
    const row = get(`SELECT r.response, r.response_digest FROM extension_authority_v2_receipts r JOIN extension_authority_v2_intents i USING(challenge) WHERE i.operation_id=? AND i.phase=?`, id, phase);
    if (!row) return undefined;
    const value = authorityV2ResponseSchema.parse(JSON.parse(String(row.response)));
    if (digest(value) !== row.response_digest || canonical(value) !== row.response
      || value.statement.request.phase !== phase || digest(value.statement.request.work) !== digest(r.work)
      || value.statement.trustDigest !== digest(trust) || !verify(null, Buffer.from(canonical(value.statement)), createPublicKey(this.key()), Buffer.from(value.signature, 'base64url'))) return refuse();
    return value;
  }

  private synchronousPolicy(c: Connection) {
    if (typeof c.prepare !== 'function' || c.inTransaction) return refuse();
    const priorPolicy = c.pragma('synchronous', { simple: true });
    if (typeof priorPolicy !== 'number' || ![0, 1, 2, 3].includes(priorPolicy)) return refuse();
    return priorPolicy;
  }
  private async releaseConnection(connection: Connection | undefined, synchronous: number | undefined) {
    if (connection) {
      try {
        if (connection.inTransaction) connection.exec('ROLLBACK');
        if (synchronous !== undefined) connection.pragma(`synchronous = ${synchronous}`);
      } catch { refuse(); }
      finally {
        try { await this.extensions.store.database.client.releaseConnection(connection); } catch { refuse(); }
      }
    }
  }
  private async fenceNative(r: AuthorityV2Request) {
    const id = r.work.extension.operationId;
    // Same exclusive namespace as v1. These fences never assert completion.
    const a = r.work.extension;
    const release = this.extensions.fleet.reserveExtensionEntries(2);
    let unattempted = 2;
    try {
      unattempted--;
      await this.extensions.fleet.files.create(`extension-nonce-${a.nonce}`, { operationId: id });
      const record = { assertion: a, operationId: id, state: 'fenced' };
      unattempted--;
      await this.extensions.fleet.files.create(`extension-operation-${id}.json`, { ...record, recordDigest: digest(record) });
    } finally { release(unattempted); }
  }
  private absentNative(id: string) {
    try { this.extensions.fleet.files.readSync(`extension-operation-${id}.json`); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    return refuse();
  }
  private checkAcquisitionIntent(native: FleetExtensionRequest | undefined, intentDigest: string) {
    if (!native) return;
    if (native.action !== 'profile.create' && native.action !== 'profile.update') return refuse();
    if (digest(nativeIntent(native)) !== intentDigest) return refuse();
  }
  private acquisitionId(r: AuthorityV2Request, native?: FleetExtensionRequest) {
    const id = r.work.acquisitionOperationId;
    if (id === null) {
      if (native && (native.action === 'profile.create' || native.action === 'profile.update') && native.sealed.length) return refuse();
      return null;
    }
    if (!['profile.create', 'profile.update'].includes(r.work.extension.action)) return refuse();
    if (id === r.work.extension.operationId) return refuse();
    return id;
  }
  private checkAcquisition(c: Connection, r: AuthorityV2Request, native?: FleetExtensionRequest) {
    const id = this.acquisitionId(r, native);
    if (id === null) return;
    const row = c.prepare(`SELECT r.response, r.response_digest FROM extension_authority_v2_receipts r JOIN extension_authority_v2_intents i USING(challenge)
      WHERE i.operation_id=? AND i.phase='dispatch'`).get(id);
    if (!row) return refuse();
    const response = authorityV2ResponseSchema.parse(JSON.parse(String(row.response)));
    const a = response.statement.request.work;
    const recipient = response.statement.result.recipientCommitment;
    if (!recipient || recipient.operationId !== r.work.extension.operationId) return refuse();
    this.checkAcquisitionIntent(native, recipient.intentDigest);
    if (canonical(response) !== row.response || digest(response) !== row.response_digest
      || response.statement.request.phase !== 'dispatch' || a.extension.operationId !== id
      || !verify(null, Buffer.from(canonical(response.statement)), createPublicKey(this.key()), Buffer.from(response.signature, 'base64url'))
      || response.statement.trustDigest !== digest(this.trust().trust) || a.extension.action !== 'recipient.issue' || response.statement.result.state !== 'completed') return refuse();
    this.checkAcquisitionWork(a, r);
  }
  private checkAcquisitionWork(a: AuthorityV2Request['work'], r: AuthorityV2Request) {
    if (canonical(a.scope) !== canonical(r.work.scope) || a.coreAuthorityEpoch !== r.work.coreAuthorityEpoch
      || a.extensionInstanceId !== r.work.extensionInstanceId) return refuse();
    for (const field of ['githubActorId', 'hostedInstanceId', 'storageInstanceId', 'runtimeGeneration', 'storageGeneration', 'placementGeneration'] as const) {
      if (a.extension[field] !== r.work.extension[field]) return refuse();
    }
  }
}
