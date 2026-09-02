import { promises as fs } from 'node:fs';
import path from 'node:path';
import type {
    NativeGoalEvent,
    NativeGoalEventAppendResult,
    NativeGoalEventSink,
    NativeGoalSessionRecord,
    NativeGoalSessionStore,
} from './nativeGoalTypes.js';

function clone<T>(value: T): T {
    return structuredClone(value);
}

function pathsOverlap(left: string, right: string): boolean {
    const relative = path.relative(left, right);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export class NativeGoalConflictError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'NativeGoalConflictError';
    }
}

/** Useful for contract tests and for embedding in a caller-owned durable layer. */
export class InMemoryNativeGoalSessionStore implements NativeGoalSessionStore {
    private readonly records = new Map<string, NativeGoalSessionRecord>();

    async get(goalId: string): Promise<NativeGoalSessionRecord | null> {
        const record = this.records.get(goalId);
        return record ? clone(record) : null;
    }

    async findByProviderSession(provider: string, providerSessionId: string): Promise<NativeGoalSessionRecord | null> {
        for (const record of this.records.values()) {
            if (record.provider === provider && record.providerSessionId === providerSessionId) return clone(record);
        }
        return null;
    }

    async findByWritableMount(hostPath: string): Promise<NativeGoalSessionRecord | null> {
        for (const record of this.records.values()) {
            if (record.writableMounts.some(mount => pathsOverlap(mount.hostPath, hostPath) || pathsOverlap(hostPath, mount.hostPath))) return clone(record);
        }
        return null;
    }

    async findByWorktree(hostPath: string): Promise<NativeGoalSessionRecord | null> {
        for (const record of this.records.values()) {
            if (pathsOverlap(record.worktree.hostPath, hostPath) || pathsOverlap(hostPath, record.worktree.hostPath)) return clone(record);
        }
        return null;
    }

    async create(record: NativeGoalSessionRecord): Promise<void> {
        if (this.records.has(record.goalId)) throw new NativeGoalConflictError(`Goal '${record.goalId}' already has a session`);
        await this.assertResourcesAvailable(record);
        if (record.providerSessionId) await this.assertSessionAvailable(record);
        this.records.set(record.goalId, clone(record));
    }

    async save(record: NativeGoalSessionRecord, expectedRevision: number): Promise<NativeGoalSessionRecord> {
        const current = this.records.get(record.goalId);
        if (!current) throw new NativeGoalConflictError(`Goal '${record.goalId}' has no session`);
        if (current.revision !== expectedRevision) {
            throw new NativeGoalConflictError(`Goal '${record.goalId}' revision changed from ${expectedRevision} to ${current.revision}`);
        }
        await this.assertResourcesAvailable(record);
        if (record.providerSessionId) await this.assertSessionAvailable(record);
        const saved = { ...clone(record), revision: expectedRevision + 1 };
        this.records.set(record.goalId, saved);
        return clone(saved);
    }

    private async assertSessionAvailable(candidate: NativeGoalSessionRecord): Promise<void> {
        const owner = await this.findByProviderSession(candidate.provider, candidate.providerSessionId!);
        if (owner && owner.goalId !== candidate.goalId) {
            throw new NativeGoalConflictError(
                `Provider session '${candidate.providerSessionId}' belongs to goal '${owner.goalId}', not '${candidate.goalId}'`,
            );
        }
    }

    private async assertResourcesAvailable(candidate: NativeGoalSessionRecord): Promise<void> {
        for (const record of this.records.values()) {
            if (record.goalId === candidate.goalId) continue;
            if (pathsOverlap(record.worktree.hostPath, candidate.worktree.hostPath)
                || pathsOverlap(candidate.worktree.hostPath, record.worktree.hostPath)) {
                throw new NativeGoalConflictError(`Worktree belongs to goal '${record.goalId}'`);
            }
            if (record.writableMounts.some(existing => candidate.writableMounts.some(mount =>
                pathsOverlap(existing.hostPath, mount.hostPath) || pathsOverlap(mount.hostPath, existing.hostPath),
            ))) throw new NativeGoalConflictError(`Writable state belongs to goal '${record.goalId}'`);
        }
    }
}

interface StoredNativeGoals { records: NativeGoalSessionRecord[] }

/**
 * Small atomic JSON store for deployments that do not yet project goal state
 * into a database. The containing directory is expected to be goal-runtime
 * state, not provider-writable state inside a container.
 */
export class JsonFileNativeGoalSessionStore implements NativeGoalSessionStore {
    private tail: Promise<unknown> = Promise.resolve();

    constructor(private readonly filePath: string) {
        if (!path.isAbsolute(filePath)) throw new Error('Native goal state path must be absolute');
    }

    async get(goalId: string): Promise<NativeGoalSessionRecord | null> {
        return this.lock(async () => clone((await this.read()).records.find(record => record.goalId === goalId) ?? null));
    }

    async findByProviderSession(provider: string, providerSessionId: string): Promise<NativeGoalSessionRecord | null> {
        return this.lock(async () => clone((await this.read()).records.find(record =>
            record.provider === provider && record.providerSessionId === providerSessionId,
        ) ?? null));
    }

    async findByWritableMount(hostPath: string): Promise<NativeGoalSessionRecord | null> {
        return this.lock(async () => clone((await this.read()).records.find(record =>
            record.writableMounts.some(mount => pathsOverlap(mount.hostPath, hostPath) || pathsOverlap(hostPath, mount.hostPath)),
        ) ?? null));
    }

    async findByWorktree(hostPath: string): Promise<NativeGoalSessionRecord | null> {
        return this.lock(async () => clone((await this.read()).records.find(record =>
            pathsOverlap(record.worktree.hostPath, hostPath) || pathsOverlap(hostPath, record.worktree.hostPath),
        ) ?? null));
    }

    async create(record: NativeGoalSessionRecord): Promise<void> {
        await this.lock(async () => {
            const state = await this.read();
            if (state.records.some(item => item.goalId === record.goalId)) {
                throw new NativeGoalConflictError(`Goal '${record.goalId}' already has a session`);
            }
            this.assertUnique(state, record);
            state.records.push(clone(record));
            await this.write(state);
        });
    }

    async save(record: NativeGoalSessionRecord, expectedRevision: number): Promise<NativeGoalSessionRecord> {
        return this.lock(async () => {
            const state = await this.read();
            const index = state.records.findIndex(item => item.goalId === record.goalId);
            if (index < 0) throw new NativeGoalConflictError(`Goal '${record.goalId}' has no session`);
            if (state.records[index].revision !== expectedRevision) {
                throw new NativeGoalConflictError(`Goal '${record.goalId}' revision changed`);
            }
            this.assertUnique(state, record);
            const saved = { ...clone(record), revision: expectedRevision + 1 };
            state.records[index] = saved;
            await this.write(state);
            return clone(saved);
        });
    }

    private assertUnique(state: StoredNativeGoals, candidate: NativeGoalSessionRecord): void {
        const worktreeOwner = state.records.find(record => record.goalId !== candidate.goalId
            && (pathsOverlap(record.worktree.hostPath, candidate.worktree.hostPath)
                || pathsOverlap(candidate.worktree.hostPath, record.worktree.hostPath)));
        if (worktreeOwner) throw new NativeGoalConflictError(`Worktree belongs to goal '${worktreeOwner.goalId}'`);
        const stateOwner = state.records.find(record => record.goalId !== candidate.goalId
            && record.writableMounts.some(existing => candidate.writableMounts.some(mount =>
                pathsOverlap(existing.hostPath, mount.hostPath) || pathsOverlap(mount.hostPath, existing.hostPath),
            )));
        if (stateOwner) throw new NativeGoalConflictError(`Writable state belongs to goal '${stateOwner.goalId}'`);
        if (candidate.providerSessionId) {
            const owner = state.records.find(record => record.provider === candidate.provider
                && record.providerSessionId === candidate.providerSessionId
                && record.goalId !== candidate.goalId);
            if (owner) throw new NativeGoalConflictError(`Provider session is already bound to goal '${owner.goalId}'`);
        }
    }

    private async read(): Promise<StoredNativeGoals> {
        try {
            return JSON.parse(await fs.readFile(this.filePath, 'utf8')) as StoredNativeGoals;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { records: [] };
            throw error;
        }
    }

    private async write(state: StoredNativeGoals): Promise<void> {
        await fs.mkdir(path.dirname(this.filePath), { recursive: true });
        const temporary = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
        await fs.writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
        await fs.rename(temporary, this.filePath);
    }

    private lock<T>(operation: () => Promise<T>): Promise<T> {
        const result = this.tail.then(operation, operation);
        this.tail = result.then(() => undefined, () => undefined);
        return result;
    }
}

export class InMemoryNativeGoalEventSink implements NativeGoalEventSink {
    private readonly eventsByGoal = new Map<string, NativeGoalEvent[]>();
    private readonly idsByGoal = new Map<string, Set<string>>();

    async append(candidate: Omit<NativeGoalEvent, 'sequence' | 'recordedAt'>): Promise<NativeGoalEventAppendResult> {
        const ids = this.idsByGoal.get(candidate.goalId) ?? new Set<string>();
        if (ids.has(candidate.providerEventId)) return { accepted: false, reason: 'duplicate' };
        const events = this.eventsByGoal.get(candidate.goalId) ?? [];
        const event: NativeGoalEvent = {
            ...clone(candidate), sequence: events.length + 1, recordedAt: new Date().toISOString(),
        };
        ids.add(candidate.providerEventId);
        events.push(event);
        this.idsByGoal.set(candidate.goalId, ids);
        this.eventsByGoal.set(candidate.goalId, events);
        return { accepted: true, event: clone(event) };
    }

    events(goalId: string): NativeGoalEvent[] {
        return clone(this.eventsByGoal.get(goalId) ?? []);
    }
}

/** Append-only JSONL sink with durable per-goal ordering and event-id deduplication. */
export class JsonlNativeGoalEventSink implements NativeGoalEventSink {
    private tail: Promise<unknown> = Promise.resolve();
    private loaded = false;
    private readonly seen = new Map<string, Set<string>>();
    private readonly sequences = new Map<string, number>();

    constructor(private readonly filePath: string) {
        if (!path.isAbsolute(filePath)) throw new Error('Native goal event path must be absolute');
    }

    append(candidate: Omit<NativeGoalEvent, 'sequence' | 'recordedAt'>): Promise<NativeGoalEventAppendResult> {
        return this.lock(async () => {
            await this.load();
            const ids = this.seen.get(candidate.goalId) ?? new Set<string>();
            if (ids.has(candidate.providerEventId)) return { accepted: false, reason: 'duplicate' };
            const event: NativeGoalEvent = {
                ...clone(candidate),
                sequence: (this.sequences.get(candidate.goalId) ?? 0) + 1,
                recordedAt: new Date().toISOString(),
            };
            await fs.mkdir(path.dirname(this.filePath), { recursive: true });
            const handle = await fs.open(this.filePath, 'a', 0o600);
            try {
                await handle.write(`${JSON.stringify(event)}\n`);
                await handle.sync();
            } finally {
                await handle.close();
            }
            ids.add(candidate.providerEventId);
            this.seen.set(candidate.goalId, ids);
            this.sequences.set(candidate.goalId, event.sequence);
            return { accepted: true, event };
        });
    }

    private async load(): Promise<void> {
        if (this.loaded) return;
        this.loaded = true;
        let contents: string;
        try { contents = await fs.readFile(this.filePath, 'utf8'); }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
            throw error;
        }
        for (const line of contents.split('\n')) {
            if (!line.trim()) continue;
            const event = JSON.parse(line) as NativeGoalEvent;
            const ids = this.seen.get(event.goalId) ?? new Set<string>();
            ids.add(event.providerEventId);
            this.seen.set(event.goalId, ids);
            this.sequences.set(event.goalId, Math.max(this.sequences.get(event.goalId) ?? 0, event.sequence));
        }
    }

    private lock<T>(operation: () => Promise<T>): Promise<T> {
        const result = this.tail.then(operation, operation);
        this.tail = result.then(() => undefined, () => undefined);
        return result;
    }
}
