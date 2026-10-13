import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { FLEET_DATA_CONTRACT, FLEET_DATA_SCOPE, type FleetDataAssertion, type FleetDataBinding, type FleetDataEnvelope, type FleetDataResult, type FleetDataState, type DatabaseExportStatus } from '@propr/shared';
import { InstanceStorageService } from '../storage/service.js';
import { FleetFiles } from './files.js';
import { contractPin, digest, exact, FleetRefusal, identifier, parseEnvelope, verifyAssertion } from './contract.js';

interface Authority { hostedInstanceId: string; placementGeneration: string; scope: typeof FLEET_DATA_SCOPE; secretSha256: string }
interface Operation extends FleetDataResult {
  binding: FleetDataBinding;
  secretHash: string;
  action: FleetDataAssertion['action'];
  requestDigest: string;
  grantDigest: string;
  nativeExport?: DatabaseExportStatus;
  nativeConfirmation?: string;
  previewOperationId?: string;
}
const secretHash = (secret: string) => createHash('sha256').update(secret).digest('hex');
const binding = (a: FleetDataBinding): FleetDataBinding => ({ hostedInstanceId: a.hostedInstanceId, storageInstanceId: a.storageInstanceId, runtimeGeneration: a.runtimeGeneration, placementGeneration: a.placementGeneration, scope: a.scope });
const irreversible = new Set(['database.export', 'repositories.cleanup.execute', 'artifact.stream']);
const terminal = new Set<FleetDataState>(['completed', 'failed', 'fenced', 'cancelled', 'consumed']);
const publicResult = (op: Operation): FleetDataResult => ({ contract: FLEET_DATA_CONTRACT, operationId: op.operationId, actor: 'fleet', state: op.state, expiresAt: op.expiresAt, ...(op.result === undefined ? {} : { result: op.result }) });

/** No user/session authority enters this service. Requests are fixed, signed Fleet grants. */
export class FleetDataPlane {
  readonly files: FleetFiles;
  private count = 3; // Reserve startup runtime/temp/socket entries as well.
  private active = new Set<string>();
  private busyTargets = new Set<string>();
  constructor(readonly storage: InstanceStorageService, root: string, private readonly secret: () => string | undefined = () => process.env.PROPR_FLEET_CONTROL_SECRET) {
    this.files = new FleetFiles(root);
  }
  async initialize() {
    await this.files.initialize();
    await this.authority();
    // A bounded namespace; tombstones are never recycled automatically.
    const oldOperations: string[] = [];
    const directory = await fs.opendir(this.files.root);
    for await (const entry of directory) {
      if (++this.count > 16384) throw new FleetRefusal();
      if (!entry.isFile() && !entry.isSocket()) throw new FleetRefusal();
      if (/^operation-[0-9a-f-]{36}\.jsonl$/.test(entry.name)) oldOperations.push(entry.name.slice(10, -6));
    }
    const runtime = await this.runtime();
    await this.files.replaceRuntime(runtime);
    for (const id of oldOperations) {
      const op = await this.read(id);
      if (op.binding.runtimeGeneration !== runtime.runtimeGeneration && !terminal.has(op.state)) {
        await this.save(op, op.state === 'accepted' || !irreversible.has(op.action) ? 'failed' : 'fenced');
      }
    }
  }
  private async authority(): Promise<{ authority: Authority; secret: string }> {
    const value: unknown = JSON.parse(await this.files.read('authority.json'));
    exact(value, ['hostedInstanceId', 'placementGeneration', 'scope', 'secretSha256']);
    const secret = this.secret();
    if (!secret || secret.length < 32 || secret.trim() !== secret || !identifier(value.hostedInstanceId) || !identifier(value.placementGeneration) || value.scope !== FLEET_DATA_SCOPE || value.secretSha256 !== secretHash(secret)) throw new FleetRefusal();
    return { authority: value as unknown as Authority, secret };
  }
  async runtime() {
    const { authority } = await this.authority();
    const capabilities = await this.storage.capabilities();
    await this.storage.revalidateIdentity(capabilities.instanceId);
    return { contract: FLEET_DATA_CONTRACT, contractPin, hostedInstanceId: authority.hostedInstanceId, placementGeneration: authority.placementGeneration,
      scope: authority.scope, storageInstanceId: capabilities.instanceId, runtimeGeneration: capabilities.generation };
  }
  private async validate(op: Pick<Operation, 'binding' | 'secretHash' | 'expiresAt'>) {
    const current = await this.runtime();
    const published = JSON.parse(await this.files.read('runtime.json'));
    if (digest(published) !== digest(current)) throw new FleetRefusal();
    const { secret } = await this.authority();
    if (digest(binding(current)) !== digest(op.binding) || secretHash(secret) !== op.secretHash || Date.now() >= op.expiresAt) throw new FleetRefusal();
  }
  private name(id: string) { return `operation-${id}.jsonl`; }
  private async save(op: Operation, state: FleetDataState, result?: FleetDataResult['result']) {
    const candidate = { ...op, state, ...(result === undefined ? {} : { result }) };
    if (Buffer.byteLength(JSON.stringify(candidate)) > 24000) throw new FleetRefusal();
    await this.files.append(this.name(op.operationId), { ...candidate, recordDigest: digest(candidate) });
    Object.assign(op, candidate);
  }
  private async read(id: string): Promise<Operation> {
    const raw = await this.files.read(this.name(id));
    if (!raw.endsWith('\n')) throw new FleetRefusal(); // Torn write: never infer permission.
    const records = raw.trimEnd().split('\n').map(line => {
      const { recordDigest, ...record } = JSON.parse(line);
      if (recordDigest !== digest(record)) throw new FleetRefusal();
      return record as Operation;
    });
    const op = records.at(-1)!;
    if (!op || op.operationId !== id || op.actor !== 'fleet' || op.contract !== FLEET_DATA_CONTRACT || !op.binding || !op.secretHash || !op.action || !Number.isSafeInteger(op.expiresAt)) throw new FleetRefusal();
    return op;
  }
  private async target(envelope: FleetDataEnvelope, id: string) {
    const op = await this.read(id);
    const { secret } = await this.authority();
    if (digest(op.binding) !== digest(binding(envelope.assertion)) || op.secretHash !== secretHash(secret)) throw new FleetRefusal();
    await this.validate(op);
    if (!this.active.has(id) && !terminal.has(op.state)) {
      // accepted proves dispatch was impossible. Anything beyond the durable
      // dispatch decision is ambiguous after a crash; no automatic retry.
      const recoverableExport = op.state === 'running' && op.nativeExport && op.binding.runtimeGeneration === (await this.runtime()).runtimeGeneration;
      if (!recoverableExport) await this.save(op, op.state === 'accepted' || !irreversible.has(op.action) ? 'failed' : 'fenced');
    }
    return op;
  }
  private async admit(raw: string) {
    const envelope = parseEnvelope(raw);
    const { secret } = await this.authority();
    verifyAssertion(envelope, secret);
    const a = envelope.assertion;
    const op: Operation = { contract: FLEET_DATA_CONTRACT, operationId: a.operationId, actor: 'fleet', state: 'accepted', expiresAt: Date.now() + 300_000,
      action: a.action, binding: binding(a), secretHash: secretHash(secret), requestDigest: a.requestDigest, grantDigest: digest(a) };
    await this.validate(op);
    if (this.count + 2 > 16384) throw new FleetRefusal();
    this.count += 2; // Reserve capacity synchronously, before filesystem awaits.
    // A lost reply cannot turn the same assertion or operation into a new dispatch.
    await this.files.create(`nonce-${a.nonce}`, { operationId: a.operationId, expiresAt: a.expiresAt });
    if (this.active.has(a.operationId)) throw new FleetRefusal();
    // Publish in-process admission before the durable record becomes observable
    // to a simultaneous status request; only a restart may recover this claim.
    this.active.add(a.operationId);
    try { await this.files.create(this.name(a.operationId), { ...op, recordDigest: digest(op) }); }
    catch (error) { this.active.delete(a.operationId); throw error; }
    return { envelope, op };
  }
  /** Persist export completion even if Fleet loses the start reply or never polls. */
  private async watchExport(id: string) {
    for (;;) {
      await delay(50, undefined, { ref: false });
      if (this.busyTargets.has(id)) continue;
      this.busyTargets.add(id);
      let op: Operation | undefined;
      try {
        op = await this.read(id);
        if (op.state !== 'running' || !op.nativeExport) return;
        await this.validate(op);
        const selected = op;
        const status = await this.storage.exports!.status(op.binding.storageInstanceId, op.nativeExport.generation, op.nativeExport.operationId, 'fleet', () => this.validate(selected));
        if (status.state !== 'running') {
          op.nativeExport = status;
          await this.validate(op);
          await this.save(op, status.state === 'ready' ? 'completed' : 'failed', status);
          return;
        }
      } catch {
        if (op) await this.save(op, 'fenced').catch(() => undefined);
        return;
      } finally { this.busyTargets.delete(id); }
    }
  }
  private async pollOperation(envelope: FleetDataEnvelope, op: Operation, targetOperationId: string) {
    const target = await this.target(envelope, targetOperationId);
    if (target.state === 'running' && target.nativeExport) {
      const status = await this.storage.exports!.status(target.binding.storageInstanceId, target.nativeExport.generation, target.nativeExport.operationId, 'fleet', () => this.validate(target));
      if (status.state !== 'running') {
        target.nativeExport = status;
        await this.save(target, status.state === 'ready' ? 'completed' : 'failed', status);
      }
    }
    await this.validate(op); await this.save(op, 'completed', publicResult(target));
  }
  private async cancelOperation(envelope: FleetDataEnvelope, op: Operation, targetOperationId: string) {
    const target = await this.target(envelope, targetOperationId);
    if (this.active.has(target.operationId) || ['streaming', 'fenced', 'failed', 'consumed', 'cancelled'].includes(target.state) || !['database.export', 'repositories.cleanup.preview'].includes(target.action)) throw new FleetRefusal();
    if (target.nativeExport && !['consumed', 'cancelled', 'failed'].includes(target.state)) {
      await this.storage.exports!.cancel(target.binding.storageInstanceId, target.nativeExport.generation, target.nativeExport.operationId, 'fleet', () => this.validate(target));
    }
    await this.save(target, 'cancelled'); await this.save(op, 'completed', { cancelled: true });
  }
  private async dispatch(envelope: FleetDataEnvelope, op: Operation) {
    const r = envelope.request;
    const authorize = () => this.validate(op);
    switch (r.action) {
      case 'repositories.list': {
        const inventory = await this.storage.inventory();
        await authorize(); await this.save(op, 'completed', inventory); break;
      }
      case 'repositories.cleanup.preview': {
        const preview = await this.storage.preview(op.binding.storageInstanceId, ['repository_caches'], 'fleet', [], authorize);
        await authorize(); op.nativeConfirmation = preview.confirmation;
        await this.save(op, 'completed', { ...preview, impact: 'Only proven refetchable repository caches can be removed. Private work and all other storage are retained.' }); break;
      }
      case 'repositories.cleanup.execute': {
        const preview = await this.target(envelope, r.previewOperationId);
        if (preview.action !== 'repositories.cleanup.preview' || preview.state !== 'completed' || preview.nativeConfirmation !== r.confirmation) throw new FleetRefusal();
        // Durable Fleet binding supplements native actor, generation and exact fingerprint.
        if (++this.count > 16384) throw new FleetRefusal();
        await this.files.create(`confirmation-${r.previewOperationId}`, { operationId: op.operationId, grantDigest: op.grantDigest });
        op.previewOperationId = r.previewOperationId;
        const result = await this.storage.execute(op.binding.storageInstanceId, r.confirmation, 'fleet', authorize);
        await authorize(); await this.save(op, result.state === 'completed' ? 'completed' : 'fenced', result); break;
      }
      case 'database.export': {
        if (!this.storage.exports) throw new FleetRefusal();
        op.nativeExport = await this.storage.exports.start(op.binding.storageInstanceId, 'fleet', authorize);
        await authorize(); await this.save(op, 'running', op.nativeExport); break;
      }
      case 'operation.status': await this.pollOperation(envelope, op, r.targetOperationId); break;
      case 'operation.cancel': await this.cancelOperation(envelope, op, r.targetOperationId); break;
    }
  }
  private async acquireTarget(targetId: string, action: FleetDataAssertion['action']) {
    // Briefly serialize metadata polling with the completion outbox writer.
    if (action === 'operation.status' || action === 'operation.cancel') {
      for (let attempt = 0; attempt < 100 && this.busyTargets.has(targetId); attempt++) await delay(10);
    }
    if (this.busyTargets.has(targetId)) throw new FleetRefusal();
    this.busyTargets.add(targetId);
  }
  async invoke(raw: string): Promise<FleetDataResult> {
    const { envelope, op } = await this.admit(raw);
    let dispatched = false;
    let targetId: string | undefined;
    let ownsTarget = false;
    try {
      const r = envelope.request;
      if (r.action === 'artifact.stream') throw new FleetRefusal();
      if ('targetOperationId' in r || 'previewOperationId' in r) {
        targetId = 'targetOperationId' in r ? r.targetOperationId : r.previewOperationId;
        await this.acquireTarget(targetId, r.action); ownsTarget = true;
      }
      // Definite refusals happen before the durable dispatch decision.
      if (r.action === 'database.export' && !this.storage.exports) throw new FleetRefusal();
      if (r.action === 'repositories.cleanup.execute') {
        const preview = await this.target(envelope, r.previewOperationId);
        if (preview.action !== 'repositories.cleanup.preview' || preview.state !== 'completed' || preview.nativeConfirmation !== r.confirmation) throw new FleetRefusal();
      }
      await this.validate(op);
      // Commit the irreversible-dispatch decision before entering any native primitive.
      await this.save(op, 'dispatched'); dispatched = true;
      await this.dispatch(envelope, op);
      await this.validate(op);
      if (op.action === 'database.export' && op.state === 'running') void this.watchExport(op.operationId).catch(() => undefined);
      return publicResult(op);
    } catch {
      await this.save(op, dispatched && irreversible.has(op.action) ? 'fenced' : 'failed').catch(() => undefined);
      throw new FleetRefusal();
    } finally {
      this.active.delete(op.operationId);
      if (ownsTarget && targetId) this.busyTargets.delete(targetId);
    }
  }
  /** The transport supplies a bounded streaming consumer; never a path or URL. */
  async stream(raw: string, consume: (download: Awaited<ReturnType<NonNullable<InstanceStorageService['exports']>['redeem']>>, authorize: () => Promise<void>) => Promise<void>) {
    const { envelope, op } = await this.admit(raw);
    let target: Operation | undefined;
    let download: Awaited<ReturnType<NonNullable<InstanceStorageService['exports']>['redeem']>> | undefined;
    let owned = false;
    try {
      const r = envelope.request;
      if (r.action !== 'artifact.stream' || this.busyTargets.has(r.targetOperationId)) throw new FleetRefusal();
      this.busyTargets.add(r.targetOperationId); owned = true;
      target = await this.target(envelope, r.targetOperationId);
      if (target.action !== 'database.export' || target.state !== 'completed' || target.nativeExport?.state !== 'ready' || !this.storage.exports) throw new FleetRefusal();
      const selected = target;
      const authorize = async () => { await this.validate(op); await this.validate(selected); };
      await authorize();
      await this.save(op, 'dispatched');
      await this.save(target, 'streaming'); // Consume before opening/releasing bytes.
      download = await this.storage.exports.redeem(target.binding.storageInstanceId, target.nativeExport.generation, target.nativeExport.operationId, 'fleet', authorize);
      if (!download.status.sizeBytes || download.status.sizeBytes > 512 * 1024 ** 2) throw new FleetRefusal();
      await authorize();
      await consume(download, authorize);
      await authorize();
      await this.save(target, 'consumed'); await this.save(op, 'completed', { delivered: true });
    } catch {
      if (target?.state === 'streaming') await this.save(target, 'fenced').catch(() => undefined);
      await this.save(op, op.state === 'accepted' || !irreversible.has(op.action) ? 'failed' : 'fenced').catch(() => undefined);
      throw new FleetRefusal();
    } finally {
      // Consumer completion/disconnection is known; lost outcomes remain fenced.
      // If this process dies, the native export lease reaps staging only after TTL.
      if (download) { await download.file.close().catch(() => undefined); await download.dispose().catch(() => undefined); }
      this.active.delete(op.operationId);
      if (owned && envelope.request.action === 'artifact.stream') this.busyTargets.delete(envelope.request.targetOperationId);
    }
  }
}
