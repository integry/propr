import { createHmac, createPrivateKey, createPublicKey, sign, timingSafeEqual } from 'node:crypto';
import {
  canonicalFleetJson, EXTENSION_AUTHORITY_CONTRACT, EXTENSION_AUTHORITY_SCHEMA, EXTENSION_AUTHORITY_LIMITS,
  extensionAuthorityEnvelopeSchema, extensionAuthorityResponseSchema, INSTANCE_PERMISSIONS,
  type ExtensionAuthorityRequest, type ExtensionAuthorityResponse,
} from '@propr/shared';
import type { FleetExtensionPlane } from './extensions.js';
import { digest } from './contract.js';
import { configuredResetFence } from './resetFence.js';

interface AuthorityConnection {
  inTransaction: boolean;
  prepare(sql: string): {
    get(...args: unknown[]): Record<string, unknown> | undefined;
    run(...args: unknown[]): unknown;
  };
  exec(sql: string): unknown;
  pragma(sql: string, options?: { simple: boolean }): unknown;
}

export const extensionAuthorityPin = digest(JSON.parse(EXTENSION_AUTHORITY_SCHEMA));
export class AuthorityProofRefusal extends Error { constructor() { super('extension_authority_unavailable'); } }
const refuse = (): never => { throw new AuthorityProofRefusal(); };
const clock = (r: ExtensionAuthorityRequest) => {
  const now = Date.now();
  if (r.issuedAt * 1000 > now || now >= r.expiresAt * 1000 || r.expiresAt <= r.issuedAt
    || r.expiresAt - r.issuedAt > EXTENSION_AUTHORITY_LIMITS.seconds) refuse();
};
const commitment = (r: ExtensionAuthorityRequest) => digest({ extension: r.extension, extensionInstanceId: r.extensionInstanceId,
  workDigest: r.workDigest, acquisitionOperationId: r.acquisitionOperationId });

/** Independently provisioned Core Ed25519 key. No key is accepted from a request or transport peer.
 * SQLite's synchronous final transaction avoids an await between the final authority decision,
 * native generation observation, signature and socket write. There is no extension dispatch here. */
export class ExtensionAuthorityProofPlane {
  private stopped = false;
  constructor(readonly extensions: FleetExtensionPlane) {}
  shutdown() { this.stopped = true; }
  private key() {
    const key = createPrivateKey(this.extensions.fleet.files.readSync('native-authority-key.pem'));
    if (key.asymmetricKeyType !== 'ed25519') return refuse();
    return key;
  }
  /** Native/operator provisioning accessor only; never exposed on either listener. */
  verificationKey() { return createPublicKey(this.key()).export({ format: 'der', type: 'spki' }).toString('base64url'); }
  async invoke(raw: string, deliver?: (response: ExtensionAuthorityResponse) => void): Promise<ExtensionAuthorityResponse> {
    let acquired: AuthorityConnection | undefined;
    let response: ExtensionAuthorityResponse | undefined;
    let failed = false;
    const { fleet, store } = this.extensions;
    try {
      if (this.stopped || Buffer.byteLength(raw) > EXTENSION_AUTHORITY_LIMITS.requestBytes) return refuse();
      const parsed = JSON.parse(raw);
      if (canonicalFleetJson(parsed) !== raw) return refuse();
      const { request: r, mac } = extensionAuthorityEnvelopeSchema.parse(parsed);
      if (r.contractPin !== extensionAuthorityPin) return refuse();
      clock(r);
      const keyPin = this.verificationKey();
      // Read epoch and actor together, outside cached/session/Connect authorization.
      const initial = await store.database('native_authority_epoch as e').crossJoin(store.database.raw('instance_members as m'))
        .where({ 'e.id': 1, 'm.github_user_id': String(r.extension.githubActorId), 'm.role': 'admin', 'm.source': 'local' }).first('e.epoch');
      if (!initial) return refuse();
      clock(r);
      const secret = await fleet.extensionAuthority({ ...r.extension, expiresAt: r.expiresAt });
      clock(r);
      if (!timingSafeEqual(createHmac('sha256', secret).update(canonicalFleetJson(r)).digest(), Buffer.from(mac, 'hex'))) return refuse();
      const connection: AuthorityConnection = await store.database.client.acquireConnection();
      acquired = connection;
      // This contract is intentionally unavailable on other database drivers.
      if (typeof connection.prepare !== 'function' || connection.inTransaction) return refuse();
      const finish = () => this.finish(connection, r, { initialEpoch: initial.epoch, secret, keyPin }, deliver);
      response = this.withDurability(connection, finish);
    } catch { failed = true; }
    if (acquired) {
      try { await this.releaseConnection(acquired); }
      catch { failed = true; }
    }
    if (failed || !response) return refuse();
    return response;
  }
  private withDurability(connection: AuthorityConnection, finish: () => ExtensionAuthorityResponse): ExtensionAuthorityResponse {
    const synchronous = connection.pragma('synchronous', { simple: true });
    if (typeof synchronous !== 'number' || ![0, 1, 2, 3].includes(synchronous)) return refuse();
    // Flush replay/phase admission and the authority epoch even when the normal
    // application pool uses WAL synchronous=NORMAL. Restore its policy afterwards.
    connection.pragma('synchronous = FULL');
    let response: ExtensionAuthorityResponse | undefined;
    let failed = false;
    try {
      const managed = configuredResetFence();
      response = managed ? managed.fence.write(managed.identity, finish) : finish();
    } catch { failed = true; }
    connection.pragma(`synchronous = ${synchronous}`);
    if (failed || !response) return refuse();
    return response;
  }
  private async releaseConnection(connection: AuthorityConnection): Promise<void> {
    try { await this.extensions.store.database.client.releaseConnection(connection); }
    catch { throw new AuthorityProofRefusal(); }
  }
  private finish(connection: AuthorityConnection, r: ExtensionAuthorityRequest,
    initial: { initialEpoch: unknown; secret: string; keyPin: string }, deliver?: (response: ExtensionAuthorityResponse) => void): ExtensionAuthorityResponse {
    const { initialEpoch, secret, keyPin } = initial;
    const { fleet } = this.extensions;
    const get = (sql: string, ...args: unknown[]) => connection.prepare(sql).get(...args);
    const run = (sql: string, ...args: unknown[]) => connection.prepare(sql).run(...args);
    const observe = () => {
      if (this.stopped) return refuse();
      clock(r);
      const row = get(`SELECT e.epoch, m.role, m.source, i.instance_id FROM native_authority_epoch e
        CROSS JOIN instance_members m CROSS JOIN extension_instance_identity i WHERE e.id=1 AND i.id=1 AND m.github_user_id=?`, String(r.extension.githubActorId));
      if (!row || row.role !== 'admin' || row.source !== 'local' || !INSTANCE_PERMISSIONS.includes('instance.manage_settings')
        || typeof row.epoch !== 'number' || !Number.isSafeInteger(row.epoch) || row.epoch < 1 || String(row.epoch) !== String(initialEpoch)
        || row.instance_id !== r.extensionInstanceId || (r.authorityEpoch !== null && r.authorityEpoch !== String(row.epoch))) return refuse();
      const native = fleet.extensionProofObservationSync();
      for (const field of ['hostedInstanceId', 'storageInstanceId', 'runtimeGeneration', 'storageGeneration', 'placementGeneration'] as const) {
        if (native.binding[field] !== r.extension[field]) return refuse();
      }
      if (native.secret !== secret || this.verificationKey() !== keyPin) return refuse();
      clock(r);
      return String(row.epoch);
    };
    // Persist replay tombstone independently of the proof transaction. An ambiguous
    // failure burns the challenge; neither this nor the operation ledger is recycled.
    connection.exec('BEGIN IMMEDIATE');
    try {
      observe();
      if ((get('SELECT count(*) AS n FROM extension_authority_challenges')!.n as number) >= EXTENSION_AUTHORITY_LIMITS.challenges) return refuse();
      run('INSERT INTO extension_authority_challenges(challenge) VALUES (?)', r.challenge);
      connection.exec('COMMIT');
    } catch (error) { if (connection.inTransaction) connection.exec('ROLLBACK'); throw error; }
    connection.exec('BEGIN IMMEDIATE');
    try {
      const epoch = observe();
      this.admitPhase(connection, r, epoch);
      this.checkAcquisition(r);
      observe();
      // Commit phase admission before a reply can escape. A lost reply is never retryable.
      connection.exec('COMMIT');
      connection.exec('BEGIN IMMEDIATE');
      const authorityEpoch = observe();
      const statement = { contract: EXTENSION_AUTHORITY_CONTRACT, contractPin: extensionAuthorityPin, request: r,
        requestCommitment: digest(r), authorityEpoch, role: 'admin' as const, source: 'local' as const,
        permission: 'instance.manage_settings' as const, observedAt: Math.floor(Date.now() / 1000), expiresAt: r.expiresAt, connectAuthorityVerified: false as const };
      const response = extensionAuthorityResponseSchema.parse({ statement, signature: sign(null, Buffer.from(canonicalFleetJson(statement)), this.key()).toString('base64url') });
      if (Buffer.byteLength(JSON.stringify(response)) > EXTENSION_AUTHORITY_LIMITS.responseBytes) return refuse();
      observe();
      deliver?.(response);
      connection.exec('ROLLBACK'); // Read-only final decision; release the writer barrier.
      return response;
    } catch (error) { if (connection.inTransaction) connection.exec('ROLLBACK'); throw error; }
  }
  private admitPhase(connection: AuthorityConnection, r: ExtensionAuthorityRequest, epoch: string): void {
    const { fleet } = this.extensions;
    const get = (sql: string, ...args: unknown[]) => connection.prepare(sql).get(...args);
    const run = (sql: string, ...args: unknown[]) => connection.prepare(sql).run(...args);
    const id = r.extension.operationId;
    const prior = get('SELECT * FROM extension_authority_operations WHERE operation_id=?', id);
    if (r.phase === 'request') {
      if (prior || r.authorityEpoch !== null || (get('SELECT count(*) AS n FROM extension_authority_operations')!.n as number) >= EXTENSION_AUTHORITY_LIMITS.operations) return refuse();
      run('INSERT INTO extension_authority_operations(operation_id, commitment, epoch) VALUES (?, ?, ?)', id, commitment(r), epoch);
    } else {
      if (!prior || prior.commitment !== commitment(r) || prior.epoch !== epoch || r.authorityEpoch !== epoch) return refuse();
      if (r.phase === 'dispatch') {
        if (prior.dispatched || prior.completed) return refuse();
        // Any existing native tombstone, even torn/ambiguous, prohibits redispatch.
        try { fleet.files.readSync(`extension-operation-${id}.json`); return refuse(); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        run('UPDATE extension_authority_operations SET dispatched=1 WHERE operation_id=?', id);
      } else {
        if (!prior.dispatched) return refuse();
        const record = this.operation(id);
        for (const field of Object.keys(r.extension) as Array<keyof typeof r.extension>) {
          if (record.assertion[field] !== r.extension[field]) return refuse();
        }
        if (r.phase === 'completion') {
          if (prior.completed || record.state !== 'completed') return refuse();
          run('UPDATE extension_authority_operations SET completed=1 WHERE operation_id=?', id);
        }
      }
    }
  }
  private checkAcquisition(r: ExtensionAuthorityRequest): void {
    const id = r.extension.operationId;
    if (r.acquisitionOperationId !== null) {
      if (r.acquisitionOperationId === id) return refuse();
      const acquisition = this.operation(r.acquisitionOperationId);
      if (acquisition.state !== 'completed' || acquisition.assertion.action !== 'recipient.issue') return refuse();
      for (const field of ['githubActorId', 'hostedInstanceId', 'storageInstanceId', 'runtimeGeneration', 'storageGeneration', 'placementGeneration'] as const) {
        if (acquisition.assertion[field] !== r.extension[field]) return refuse();
      }
    }
  }
  private operation(id: string) {
    const raw = this.extensions.fleet.files.readSync(`extension-operation-${id}.json`);
    if (!raw.endsWith('\n')) return refuse();
    const { recordDigest, ...record } = JSON.parse(raw.trimEnd().split('\n').at(-1)!);
    if (recordDigest !== digest(record) || record.operationId !== id || !['fenced', 'completed'].includes(record.state)) return refuse();
    return record;
  }
}
