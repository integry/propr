import { removeRegisteredCache } from './cacheRemoval.js';
import { GeneratedPayloadStorage } from './generatedPayloads.js';
import { StorageContractError, confirmationInvalid, instanceSelectionChanged, validatePreviewSelection, type CleanupPreviewArgs, type CleanupPreviewRequest, type CandidateExecution, type SavedPreview } from './cleanupRequest.js';
import fs from 'node:fs/promises';
import { DatabaseExports, type StorageAuthority } from './databaseExport.js';
import { constants } from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { DEFAULT_STORAGE_POLICY, STORAGE_INSTANCE_CHANGED_CODE, type RepositoryStorageInventory, type StoragePolicy, type StorageObservation, type StorageCleanupPreview, type StorageCleanupResult, type StorageCandidate, type StorageProtection } from '@propr/shared';
import { StorageLifecycle, StorageBusyError, assertRealDirectory } from './lifecycle.js';
import { observeStorage, type StorageRoot } from './observation.js';
import { auditRepository } from './repositorySafety.js';
import type { CacheRecord } from './registry.js';
import { resolveRepositoryClonePath } from '../git/repositoryPaths.js';

export { StorageContractError, instanceSelectionChanged } from './cleanupRequest.js';
interface StorageServices {
  databaseFile?: string;
  lifecycle: StorageLifecycle;
  clonesRoot: string;
  storageRoot?: string;
  roots: StorageRoot[];
  /** Called under the lifecycle barrier. Any unavailable authority must return true or throw. */
  hasPendingTasks: () => Promise<boolean>;
  remoteToken?: () => Promise<string>;
  repositoryInventory?: () => Promise<string[]>;
  auditRepository?: typeof auditRepository;
  taskHistory?: {
    inspect(ids: string[]): Promise<Array<{ candidate: StorageCandidate; fingerprint: string | null }>>;
    erase(id: string, expected: string): Promise<boolean>;
  };
}

/** A single instance, with no caller-controlled roots, remote URLs or filesystem operations. */
export class InstanceStorageService {
  private initialized?: Promise<string>;
  private identityRoot?: { dev: number; ino: number };
  private observation?: StorageObservation;
  private scan?: Promise<void>;
  private sweeping = false;
  private inspecting = false;
  private inventoryScan?: Promise<RepositoryStorageInventory>;
  private inventoryAt = 0;
  readonly exports?: DatabaseExports;
  readonly generation = randomUUID();
  constructor(private readonly services: StorageServices) {
    if (services.databaseFile) this.exports = new DatabaseExports(path.resolve(services.databaseFile), path.join(this.root, 'exports'));
  }
  private payloads(): GeneratedPayloadStorage | undefined {
    const root = this.services.roots.find(root => root.category === 'worktrees');
    return root ? new GeneratedPayloadStorage(root.path, this.root, this.services.lifecycle) : undefined;
  }
  async capabilities() {
    return { version: 1 as const, instanceId: await this.initialize(), generation: this.exports?.generation ?? this.generation,
      features: ['repository_inventory', 'repository_cleanup', ...(this.exports ? ['database_export'] : [])] };
  }
  /** Internal authority must re-read durable identity, never trust the initialization cache. */
  async revalidateIdentity(expected: string): Promise<void> {
    await this.initialize();
    const root = await fs.lstat(this.root);
    if (!root.isDirectory() || root.isSymbolicLink() || root.dev !== this.identityRoot?.dev || root.ino !== this.identityRoot?.ino || await this.read<string>('instance.json') !== expected) throw instanceSelectionChanged();
  }
  async inventory(): Promise<RepositoryStorageInventory> {
    if (!this.inventoryScan || Date.now() - this.inventoryAt > 60_000) {
      this.inventoryAt = Date.now();
      this.inventoryScan = this.scanInventory().catch(error => { this.inventoryScan = undefined; throw error; });
    }
    return this.inventoryScan;
  }
  private async scanInventory(): Promise<RepositoryStorageInventory> {
    const instanceId = await this.initialize();
    return this.cleanup(async admissionSignal => {
      const signal = AbortSignal.any([admissionSignal, AbortSignal.timeout(60_000)]);
      const records = await this.records();
      const busy = await this.busy();
      const lastUse = await this.services.lifecycle.lastUse();
      const repositories: RepositoryStorageInventory['repositories'] = [];
      for (const record of records) {
        const evaluated = await this.evaluate(record, busy, signal);
        repositories.push({ ...evaluated.candidate, name: `${record.owner}/${record.name}` });
      }
      const known = new Set(records.map(record => record.id));
      for (const name of (await this.services.repositoryInventory?.() ?? []).slice(0, 100)) {
        const [owner, repository, extra] = name.split('/');
        if (!owner || !repository || extra) continue;
        const directory = resolveRepositoryClonePath(this.services.clonesRoot, owner, repository);
        const id = createHash('sha256').update(name).digest('hex');
        if (known.has(id)) continue;
        const exists = await fs.lstat(directory).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
        if (exists) repositories.push({ id, name, category: 'repository_caches', estimatedBytes: null, protectedReasons: ['unknown_ownership'] });
      }
      const worktreesRoot = this.services.roots.find(root => root.category === 'worktrees');
      for (const record of records) {
        if (!worktreesRoot || signal.aborted) break;
        const observation = await observeStorage(instanceId, [{ category: 'worktrees', path: resolveRepositoryClonePath(worktreesRoot.path, record.owner, record.name) }], { maxEntries: 10_000, maxMs: 250 });
        const category = observation.categories.find(category => category.category === 'worktrees')!;
        repositories.push({ id: record.id, name: `${record.owner}/${record.name}`, category: 'worktrees', estimatedBytes: category.bytes, protectedReasons: ['worktrees'] });
      }
      // Registry reads are rotating, bounded batches. Never claim a batch is a full inventory.
      return { version: 1, instanceId, state: 'partial', observedAt: new Date().toISOString(),
        lastUseAt: lastUse ? new Date(lastUse).toISOString() : null, repositories };
    });
  }
  private get root(): string { return this.services.storageRoot ?? this.services.lifecycle.root; }

  private async cleanup<T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.inspecting) throw new StorageBusyError();
    this.inspecting = true;
    try { return await this.services.lifecycle.cleanup(run); }
    finally { this.inspecting = false; }
  }
  private async read<T>(name: string): Promise<T> {
    await assertRealDirectory(path.dirname(path.join(this.root, name)));
    const file = await fs.open(path.join(this.root, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > 1024 * 1024) throw new Error('Storage record too large');
      return JSON.parse(await file.readFile('utf8')) as T;
    } finally { await file.close(); }
  }
  private async write(name: string, value: unknown): Promise<void> {
    await assertRealDirectory(this.root);
    const temp = path.join(this.root, randomUUID());
    await fs.writeFile(temp, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
    await fs.rename(temp, path.join(this.root, name));
  }
  async initialize(): Promise<string> {
    this.initialized ??= this.services.lifecycle.use(async () => this.services.lifecycle.exclusive(async () => {
      await fs.mkdir(this.root, { recursive: true });
      await assertRealDirectory(this.root);
      const identityRoot = await fs.lstat(this.root);
      this.identityRoot = { dev: identityRoot.dev, ino: identityRoot.ino };
      let id: string;
      try { id = await this.read<string>('instance.json'); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        id = randomUUID(); await this.write('instance.json', id);
      }
      if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error('Invalid storage instance identity');
      try { await this.read('policy.json'); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        await this.write('policy.json', DEFAULT_STORAGE_POLICY);
      }
      return id;
    }));
    return this.initialized;
  }
  async policy(): Promise<StoragePolicy> {
    await this.initialize();
    const value = await this.read<StoragePolicy>('policy.json');
    if (!value || typeof value.enabled !== 'boolean' || !Number.isInteger(value.idleHours) || value.idleHours < 1 || value.idleHours > 8760) throw new Error('Invalid storage policy');
    return value;
  }
  async updatePolicy(instanceId: string, policy: StoragePolicy, actor: string, authorize?: StorageAuthority): Promise<StoragePolicy> {
    await this.assertInstance(instanceId);
    if (typeof policy.enabled !== 'boolean' || !Number.isInteger(policy.idleHours) || policy.idleHours < 1 || policy.idleHours > 8760) throw new StorageContractError(400, 'Invalid cleanup policy');
    return this.services.lifecycle.exclusive(async () => {
      await authorize?.();
      await this.audit(actor, 'policy', { enabled: policy.enabled, idleHours: policy.idleHours });
      await this.write('policy.json', { enabled: policy.enabled, idleHours: policy.idleHours });
      return policy;
    });
  }
  private async assertInstance(id: string): Promise<void> {
    if (id !== await this.initialize()) throw instanceSelectionChanged();
  }
  async usage(): Promise<StorageObservation> {
    const instanceId = await this.initialize();
    if (!this.scan && (!this.observation?.observedAt || Date.now() - Date.parse(this.observation.observedAt) > 60_000)) {
      this.scan = observeStorage(instanceId, this.services.roots).then(value => { this.observation = value; }).catch(() => {
        this.observation = { version: 1, instanceId, observedAt: new Date().toISOString(), state: 'unknown', ownedBytes: null, categories: [], filesystems: [], scanning: false };
      }).finally(() => { this.scan = undefined; });
    }
    const generatedPayloads = await this.read<Record<string, unknown>>('generated-status.json').catch(error => { if (error.code === 'ENOENT') return { observedAt: null, reclaimableBytes: null, coverage: 'unknown: generated payloads have not been inspected; unregistered worktrees are protected' }; throw error; });
    const lastGeneratedCleanup = await this.read<StorageCleanupResult>('last-generated-cleanup.json').catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    return { generatedPayloads: { ...generatedPayloads, lastCleanup: lastGeneratedCleanup }, ...(this.observation ?? { version: 1, instanceId, observedAt: null, state: 'unknown', ownedBytes: null, categories: [], filesystems: [] }), scanning: Boolean(this.scan) };
  }
  private async records(selectedIds?: string[]): Promise<CacheRecord[]> {
    const root = path.join(this.root, 'repositories');
    try { await assertRealDirectory(root); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    let names: string[];
    if (selectedIds) {
      names = selectedIds.filter(id => /^[0-9a-f]{64}$/.test(id)).map(id => `${id}.json`);
    } else {
      names = [];
      const directory = await fs.opendir(root);
      for await (const entry of directory) {
        if (names.length >= 10_000) break;
        if (/^[0-9a-f]{64}\.json$/.test(entry.name) && entry.isFile()) names.push(entry.name);
      }
      names.sort();
      const cursor = await this.read<string>('repository-cursor.json').catch(error => { if (error.code === 'ENOENT') return ''; throw error; });
      names = [...names.filter(name => name > cursor), ...names.filter(name => name <= cursor)].slice(0, 10);
      if (names.length) await this.write('repository-cursor.json', names.at(-1));
    }
    const records: CacheRecord[] = [];
    for (const name of names) {
      const record = await this.read<CacheRecord>(`repositories/${name}`).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      if (!record) continue;
      if (record.id !== name.slice(0, -5) || !record.identity || !Number.isSafeInteger(record.identity.inode) || !Number.isSafeInteger(record.identity.device)) throw new Error('Invalid repository registration');
      if (createHash('sha256').update(`${record.owner}/${record.name}`).digest('hex') !== record.id) throw new Error('Invalid repository registration');
      resolveRepositoryClonePath(this.services.clonesRoot, record.owner, record.name);
      records.push(record);
    }
    return records;
  }
  private async busy(): Promise<boolean> { return await this.services.lifecycle.busy() || await this.services.hasPendingTasks(); }
  private async audit(actor: string, action: string, detail: unknown): Promise<void> {
    const handle = await fs.open(path.join(this.root, 'audit.jsonl'), constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(JSON.stringify({ at: new Date().toISOString(), actor, action, detail }) + '\n'); }
    finally { await handle.close(); }
  }
  private async evaluate(record: CacheRecord, busy: boolean, signal?: AbortSignal): Promise<{ candidate: StorageCandidate; fingerprint: string | null }> {
    if (!record.metadataFingerprint) return { candidate: { id: record.id, name: `${record.owner}/${record.name}`, category: 'repository_caches', estimatedBytes: null, protectedReasons: ['unknown_ownership'] }, fingerprint: null };
    if (busy || signal?.aborted) return { candidate: { id: record.id, name: `${record.owner}/${record.name}`, category: 'repository_caches', estimatedBytes: null, protectedReasons: ['busy'] }, fingerprint: null };
    const result = await this.auditCache(resolveRepositoryClonePath(this.services.clonesRoot, record.owner, record.name), record, signal);
    return { candidate: { id: record.id, name: `${record.owner}/${record.name}`, category: 'repository_caches', estimatedBytes: result.bytes, protectedReasons: result.reasons }, fingerprint: result.fingerprint };
  }
  private async auditCache(directory: string, record: CacheRecord, signal?: AbortSignal) {
    if (signal?.aborted) return { reasons: ['busy'] as StorageProtection[], bytes: null, fingerprint: null };
    return (this.services.auditRepository ?? auditRepository)(directory, record.identity, `https://github.com/${record.owner}/${record.name}.git`, { signal, token: await this.services.remoteToken?.().catch(() => undefined), metadataFingerprint: record.metadataFingerprint });
  }
  private async unregisteredCandidates(registered: CacheRecord[]): Promise<StorageCandidate[]> {
    const candidates: StorageCandidate[] = [];
    const registeredIds = new Set(registered.map(record => record.id));
    for (const repository of (await this.services.repositoryInventory?.() ?? []).slice(0, 100)) {
      const [owner, name, extra] = repository.split('/');
      if (!owner || !name || extra) continue;
      const id = createHash('sha256').update(`${owner}/${name}`).digest('hex');
      if (registeredIds.has(id)) continue;
      const directory = resolveRepositoryClonePath(this.services.clonesRoot, owner, name);
      const exists = await fs.lstat(directory).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
      if (exists) candidates.push({ id, name: repository, category: 'repository_caches', estimatedBytes: null, protectedReasons: ['unknown_ownership'] });
      registeredIds.add(id);
    }
    return candidates;
  }
  async preview(...args: CleanupPreviewArgs): Promise<StorageCleanupPreview> {
    const [instanceId, categories, actor, taskIds = [], authorize] = args;
    return this.previewRequest({ instanceId, categories, actor, taskIds, authorize });
  }
  private async previewRequest(request: CleanupPreviewRequest): Promise<StorageCleanupPreview> {
    const { instanceId, categories, actor, taskIds, authorize } = request;
    await this.assertInstance(instanceId);
    validatePreviewSelection(request);
    return this.cleanup(async admissionSignal => {
      const signal = AbortSignal.any([admissionSignal, AbortSignal.timeout(60_000)]);
      const candidates: StorageCandidate[] = [];
      const fingerprints: Record<string, string> = {};
      const busy = await this.busy() || !await this.services.lifecycle.lastUse();
      for (const category of categories) {
        if (category === 'task_history' && this.services.taskHistory && taskIds.length) {
          const evaluated = await this.previewTaskHistory(taskIds, busy);
          candidates.push(...evaluated.candidates);
          Object.assign(fingerprints, evaluated.fingerprints);
          continue;
        }
        if (category === 'worktrees' && this.payloads()) {
          const policy = await this.policy();
          const payloads = await this.payloads()!.preview(busy, policy.idleHours, signal, policy.enabled);
          await this.write('generated-status.json', { observedAt: new Date().toISOString(), reclaimableBytes: payloads.reduce((sum, candidate) => sum + (candidate.protectedReasons.length ? 0 : candidate.estimatedBytes ?? 0), 0), candidates: payloads, coverage: 'partial: rotating batch; unregistered payloads and whole Git worktrees are protected; task byte budgets are admission estimates, not filesystem quotas' });
          candidates.push(...payloads, { id: 'worktrees-coverage', category: 'worktrees', estimatedBytes: null, protectedReasons: ['unknown_ownership'] });
          for (const candidate of payloads) if (!candidate.protectedReasons.length) fingerprints[candidate.id] = 'generated-v1';
          continue;
        }
        if (category !== 'repository_caches') {
          candidates.push({ id: category, category, estimatedBytes: null, protectedReasons: ['unsupported'] });
          continue;
        }
        const registered = await this.records();
        candidates.push(...await this.unregisteredCandidates(registered));
        for (const record of registered) {
          const evaluated = await this.evaluate(record, busy, signal);
          candidates.push(evaluated.candidate);
          if (evaluated.fingerprint) fingerprints[record.id] = evaluated.fingerprint;
        }
      }
      await authorize?.();
      const confirmation = randomUUID();
      const preview: StorageCleanupPreview = {
        version: 1, instanceId, confirmation, expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(), categories, candidates,
        impact: 'Repository caches are refetched on next use. Explicitly selected terminal task records and their database logs/history are permanently removed locally. '
          + (categories.includes('worktrees')
            ? 'Only proven generated worktree payloads can be reclaimed. Git checkouts, registrations, private files and unregistered payloads are preserved. Empty generated roots remain. Interrupted payload removal can be partial; remaining data stays protected. '
            : 'Worktrees, ')
          + 'filesystem logs, provider credentials, retained backups (60 days) and external services are unaffected. SQLite file size may not shrink.',
      };
      await this.write(`preview-${confirmation}.json`, { actor, preview, fingerprints, useClock: await this.services.lifecycle.lastUse(), generation: this.generation } satisfies SavedPreview);
      await this.audit(actor, 'preview', { confirmation, categories, candidates });
      return preview;
    });
  }
  private async previewTaskHistory(taskIds: string[], busy: boolean) {
    const candidates: StorageCandidate[] = [];
    const fingerprints: Record<string, string> = {};
    for (const evaluated of await this.services.taskHistory!.inspect(taskIds)) {
      if (busy) evaluated.candidate.protectedReasons = ['busy'];
      candidates.push(evaluated.candidate);
      if (evaluated.fingerprint) fingerprints[evaluated.candidate.id] = evaluated.fingerprint;
    }
    return { candidates, fingerprints };
  }
  private async executeCandidate(candidate: StorageCandidate, execution: CandidateExecution): Promise<StorageProtection[]> {
    const { record, fingerprint, signal, authorize } = execution;
    if (candidate.category === 'task_history' && this.services.taskHistory) {
      await authorize?.();
      return await this.services.taskHistory.erase(candidate.id, fingerprint) ? [] : ['changed'];
    }
    if (candidate.category === 'worktrees' && this.payloads()) {
      const policy = await this.policy();
      const clock = await this.services.lifecycle.lastUse();
      if (!policy.enabled) return ['unsupported'];
      if (!clock || Date.now() - clock < Math.max(24, policy.idleHours) * 3_600_000) return ['recent_use'];
      if (await this.busy()) return ['busy'];
      return this.payloads()!.remove(candidate.id, signal);
    }
    if (!record) return ['unknown_ownership'];
    const current = await this.evaluate(record, false, signal);
    if (current.candidate.protectedReasons.length) return current.candidate.protectedReasons;
    if (current.fingerprint !== fingerprint) return ['changed'];
    // The same cross-process barrier covers remote proof, final identity and removal.
    // No unchecked force/remove fallback exists elsewhere in the cache lifecycle.
    return removeRegisteredCache(record, fingerprint, signal, {
      clonesRoot: this.services.clonesRoot, root: this.root, authorize,
      auditCache: (directory, cache, abortSignal) => this.auditCache(directory, cache, abortSignal),
    });
  }
  private validateConfirmation(saved: SavedPreview, instanceId: string, actor: string): void {
    if (saved.generation !== this.generation) throw new StorageContractError(409, 'Instance generation changed', STORAGE_INSTANCE_CHANGED_CODE);
    if (saved.actor !== actor || saved.preview.instanceId !== instanceId) throw new StorageContractError(403, 'Confirmation belongs to another principal');
    if (!Number.isFinite(Date.parse(saved.preview.expiresAt)) || Date.parse(saved.preview.expiresAt) <= Date.now()) throw confirmationInvalid('Confirmation expired');
  }
  private async validateAutomaticExecution(): Promise<void> {
    const policy = await this.policy();
    const clock = await this.services.lifecycle.lastUse();
    if (!policy.enabled || !clock || Date.now() - clock < policy.idleHours * 3_600_000) throw new StorageContractError(409, 'Automatic policy or idle interval changed');
  }
  async execute(instanceId: string, confirmation: string, actor: string, authorize?: StorageAuthority): Promise<StorageCleanupResult> {
    await this.assertInstance(instanceId);
    if (!/^[0-9a-f-]{36}$/.test(confirmation)) throw new StorageContractError(400, 'Invalid confirmation');
    return this.cleanup(async admissionSignal => {
      const signal = AbortSignal.any([admissionSignal, AbortSignal.timeout(60_000)]);
      await authorize?.();
      let saved: SavedPreview;
      try { saved = await this.read<SavedPreview>(`preview-${confirmation}.json`); }
      catch { throw confirmationInvalid('Confirmation unavailable or consumed'); }
      this.validateConfirmation(saved, instanceId, actor);
      const result: StorageCleanupResult = { version: 1, instanceId, operationId: confirmation, state: 'interrupted', deleted: [], retained: [] };
      // Consume before any side effects; never automatically replay an interrupted operation.
      // Results outlive confirmations and process generations for durable recovery.
      await fs.rename(path.join(this.root, `preview-${confirmation}.json`), path.join(this.root, `consumed-${confirmation}.json`));
      await this.write(`result-${confirmation}.json`, { actor, result });
      if (saved.preview.categories.includes('worktrees')) await this.write('last-generated-cleanup.json', { ...result, at: new Date().toISOString() });
      await this.audit(actor, 'execute_started', { operationId: confirmation });
      if (actor === 'automatic') await this.validateAutomaticExecution();
      const busy = await this.busy();
      const clockChanged = saved.useClock !== await this.services.lifecycle.lastUse();
      const records = new Map((await this.records(saved.preview.candidates.filter(candidate => candidate.category === 'repository_caches').map(candidate => candidate.id))).map(record => [record.id, record]));
      for (const candidate of saved.preview.candidates) {
        let reasons: StorageProtection[] = [...candidate.protectedReasons];
        const record = records.get(candidate.id);
        if (!reasons.length && (busy || signal.aborted || clockChanged)) reasons = [busy || signal.aborted ? 'busy' : 'changed'];
        if (!reasons.length) {
          await authorize?.();
          reasons = await this.executeCandidate(candidate, { record, fingerprint: saved.fingerprints[candidate.id], signal, authorize });
          if (!reasons.length) result.deleted.push(candidate.id);
        }
        if (reasons.length) result.retained.push({ id: candidate.id, reasons });
        await this.write(`result-${confirmation}.json`, { actor, result });
        if (saved.preview.categories.includes('worktrees')) await this.write('last-generated-cleanup.json', { ...result, at: new Date().toISOString() });
      }
      result.state = signal.aborted ? 'interrupted' : 'completed';
      await this.audit(actor, 'execute_completed', result);
      await this.write(`result-${confirmation}.json`, { actor, result });
      if (saved.preview.categories.includes('worktrees')) await this.write('last-generated-cleanup.json', { ...result, at: new Date().toISOString() });
      this.observation = undefined; this.inventoryScan = undefined;
      return result;
    });
  }
  async result(instanceId: string, operationId: string, actor: string): Promise<StorageCleanupResult> {
    await this.assertInstance(instanceId);
    if (!/^[0-9a-f-]{36}$/.test(operationId)) throw new StorageContractError(400, 'Invalid operation');
    const saved = await this.read<{ actor: string; result: StorageCleanupResult }>(`result-${operationId}.json`).catch(() => null);
    if (!saved || saved.actor !== actor || saved.result.instanceId !== instanceId || saved.result.operationId !== operationId) throw new StorageContractError(404, 'Operation unavailable');
    return saved.result;
  }
  /** Automatic execution uses exactly the manual proof and revalidation, never age alone. */
  async sweep(): Promise<void> {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      const policy = await this.policy();
      if (!policy.enabled) return;
      const lastUse = await this.services.lifecycle.lastUse();
      if (!lastUse || Date.now() - lastUse < policy.idleHours * 3_600_000) return;
      const due = await this.services.lifecycle.exclusive(async () => {
        const previous = await this.read<number>('last-sweep.json').catch(error => { if (error.code === 'ENOENT') return 0; throw error; });
        if (Date.now() - previous < 3_600_000) return false;
        await this.write('last-sweep.json', Date.now());
        return true;
      });
      if (!due) return;
      const instanceId = await this.initialize();
      const preview = await this.preview(instanceId, ['repository_caches', 'worktrees'], 'automatic');
      // Policy may have changed during the remote observation. Recheck at execution too.
      const current = await this.policy();
      if (!current.enabled || Date.now() - (await this.services.lifecycle.lastUse() ?? Date.now()) < current.idleHours * 3_600_000) return;
      await this.execute(instanceId, preview.confirmation, 'automatic');
    } finally { this.sweeping = false; }
  }
}
