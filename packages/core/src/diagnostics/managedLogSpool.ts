import fs from 'node:fs';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { PinnedDirectory } from './privateDirectory.js';
import { redactRecord, REDACTION_VERSION, type DiagnosticAttribution } from './redaction.js'; import { untilDeadline } from './providerOutputLedger.js';
import type { NativeInventory } from './providerCollector.js';
import type { NativeLogInventory, NativeLogRoot } from './nativeLogPolicy.js'; import type { CredentialRootRefusal } from './providerRoots.js';

interface Statement { run(...args: unknown[]): { lastInsertRowid: number | bigint }; get(...args: unknown[]): unknown; all(...args: unknown[]): unknown[] }
export interface Database { exec(sql: string): void; prepare(sql: string): Statement; close(): void; readonly inTransaction: boolean }
type SqliteConstructor = new (file: string) => Database;
let sqlite: SqliteConstructor | undefined;
/** The native binding loads only when a spool is constructed, so importing the
 * logger never adds a native-module requirement to disabled entry points. */
function loadSqlite(): SqliteConstructor {
    return sqlite ??= createRequire(import.meta.url)('better-sqlite3') as SqliteConstructor;
}
export const MANAGED_LOG_POLICY = Object.freeze({
    version: 1, recordBytes: 64 * 1024, segmentBytes: 256 * 1024,
    sourceBytes: 8 * 1024 * 1024, spoolBytes: 64 * 1024 * 1024,
    segments: 1024, sources: 2048, databaseBytes: 96 * 1024 * 1024,
    retentionMs: 14 * 86400_000, scanBytes: 1024 * 1024, scanFiles: 4096,
    scanMs: 250, protectedBytes: 256 * 1024 * 1024,
});
export type ManagedLogPolicy = { [K in keyof typeof MANAGED_LOG_POLICY]: number };
/** One explicit upgrade step. `previous` is the exact policy bound by the prior
 * release: tuned or unknown bindings never migrate implicitly. Every step seals
 * open segments, so no stored segment is extended under different bounds, and
 * preserves the instance binding, cursors, gaps and unacknowledged segments. */
export interface ManagedLogPolicyMigration {
    from: number;
    to: number;
    previous: ManagedLogPolicy;
    migrate?(db: Database): void;
}
/** Append a step (and bump MANAGED_LOG_POLICY.version) whenever a limit changes. */
export const MANAGED_LOG_POLICY_MIGRATIONS: readonly ManagedLogPolicyMigration[] = Object.freeze([]);
const policyErrorBrand = Symbol.for('@propr/core/diagnostics/DiagnosticPolicyError');
/** Branded so `instanceof` holds across duplicate module instances. */
export class DiagnosticPolicyError extends Error {
    override name = 'DiagnosticPolicyError';
    readonly [policyErrorBrand] = true;
    static [Symbol.hasInstance](value: unknown): boolean {
        return value instanceof Error && (value as unknown as Record<symbol, unknown>)[policyErrorBrand] === true;
    }
}
export type LogIdentity = { provider: string; agent: string; source: string };
export type Cursor = { inode?: string; birth?: string; offset?: number; discard?: boolean; anchor?: string };
export interface AppendOptions {
    credentials: readonly string[];
    now?: number; attribution?: DiagnosticAttribution; // per-record task/run labels, never part of the source identity
    cursor?: { before: Cursor; after: Cursor };
    droppedBytes?: number; continuation?: readonly boolean[]; // per record: a bounded stack/error continuation
}
interface Source { retired: number; id: string; identity: string; cursor: string; next: number; dropped: number; gaps: number; last_success: number | null; reason: string | null; protected_bytes: number; diagnostic_bytes: number; inventory_complete: number; protection: string | null; native_inventory: string | null; native_details: string | null }
interface Segment { id: number; source: string; day: string; first: number; last: number; start: number; end: number; raw: number; digest: string; data: Buffer; sealed: number; ack: number; redaction: number }
export const digest = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');

/** A private transactional outbox. Only this database is pruned, never provider state.
 * DELETE journalling keeps the on-disk bound independent of long-lived readers.
 * Immediate transactions serialize writers, collectors, exporters and pruning. */
export class ManagedLogSpool {
    private readonly dir: PinnedDirectory;
    private readonly db!: Database;
    readonly limits: ManagedLogPolicy;
    constructor(root: string, readonly instance: string, limits: Partial<ManagedLogPolicy> = {},
        options: { migrations?: readonly ManagedLogPolicyMigration[]; openDeadline?: number } = {}) {
        if (!/^[a-zA-Z0-9._:-]{1,128}$/.test(instance)) throw new DiagnosticPolicyError('invalid diagnostic instance');
        this.limits = validPolicy({ ...MANAGED_LOG_POLICY, ...limits });
        const Sqlite = loadSqlite();
        this.dir = PinnedDirectory.open(root, true);
        try {
            for (const name of ['spool.sqlite', 'spool.sqlite-journal', 'spool.sqlite-wal', 'spool.sqlite-shm']) {
                try {
                    const s = fs.lstatSync(this.dir.path(name));
                    if (!s.isFile() || s.nlink !== 1 || s.uid !== process.getuid?.() || (s.mode & 0o077)) throw new Error('unsafe diagnostic database');
                } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
            }
            try { fs.closeSync(fs.openSync(this.dir.path('spool.sqlite'), 'wx', 0o600)); }
            catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
            this.db = new Sqlite(this.dir.path('spool.sqlite'));
            untilDeadline(() => { try { // other workers may hold the write lock past busy_timeout; a past `openDeadline` means one attempt
                this.db.exec(`PRAGMA busy_timeout=1000; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;
                    PRAGMA max_page_count=${Math.floor(this.limits.databaseBytes / 4096)};
                    BEGIN IMMEDIATE;
                    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
                    CREATE TABLE IF NOT EXISTS sources (id TEXT PRIMARY KEY, identity TEXT NOT NULL, cursor TEXT NOT NULL DEFAULT '{}', next INTEGER NOT NULL DEFAULT 1,
                        dropped INTEGER NOT NULL DEFAULT 0, gaps INTEGER NOT NULL DEFAULT 0, last_success INTEGER, reason TEXT, protection TEXT, protected_bytes INTEGER NOT NULL DEFAULT 0);
                    CREATE TABLE IF NOT EXISTS segments (id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL, day TEXT NOT NULL,
                        first INTEGER NOT NULL, last INTEGER NOT NULL, start INTEGER NOT NULL, end INTEGER NOT NULL, raw INTEGER NOT NULL,
                        digest TEXT NOT NULL, data BLOB NOT NULL, sealed INTEGER NOT NULL DEFAULT 0, ack INTEGER NOT NULL DEFAULT 0);
                    CREATE INDEX IF NOT EXISTS segments_source ON segments(source,id); COMMIT; PRAGMA busy_timeout=100;`);
                this.atomic(() => {
                    for (const [table, name, type] of [['sources', 'inventory_complete', 'INTEGER NOT NULL DEFAULT 0'], ['sources', 'retired', 'INTEGER NOT NULL DEFAULT 0'],
                        ['sources', 'native_root', 'TEXT'], ['sources', 'native_inventory', 'TEXT'], ['sources', 'native_details', 'TEXT'],
                        // Segments stored before the column existed were redacted by adapter v1.
                        ['segments', 'redaction', 'INTEGER NOT NULL DEFAULT 1']]) {
                        if (!(this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some(column => column.name === name)) {
                            this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
                        }
                    }
                    if (!(this.db.prepare('PRAGMA table_info(sources)').all() as Array<{ name: string }>).some(column => column.name === 'diagnostic_bytes')) {
                        this.db.exec('ALTER TABLE sources ADD COLUMN diagnostic_bytes INTEGER NOT NULL DEFAULT 0');
                        // Legacy totals include resumable state. Only classified
                        // diagnostic evidence can seed the new capacity bound.
                        this.db.exec(`UPDATE sources SET diagnostic_bytes=coalesce(json_extract(native_inventory,'$.diagnosticBytes'),0)`);
                    }
                    this.bind(options.migrations ?? MANAGED_LOG_POLICY_MIGRATIONS);
                }); } catch (e) { if (this.db.inTransaction) this.db.exec('ROLLBACK'); throw e; } }, options.openDeadline ?? Date.now() + 10_000);
        } catch (e) { this.db?.close(); this.dir.close(); throw e; }
    }
    /** The instance binding is permanent; the policy binding changes only
     * through declared migrations. Downgrades and unversioned tuning refuse. */
    private bind(migrations: readonly ManagedLogPolicyMigration[]): void {
        validMigrations(migrations);
        const row = this.db.prepare('SELECT value FROM settings WHERE key=?').get('binding') as { value: string } | undefined;
        const write = () => this.db.prepare('INSERT OR REPLACE INTO settings VALUES (?,?)').run('binding', JSON.stringify({ instance: this.instance, policy: this.limits }));
        if (!row) { write(); return; }
        const stored = JSON.parse(row.value) as { instance?: unknown; policy?: ManagedLogPolicy };
        if (stored.instance !== this.instance) throw new DiagnosticPolicyError('diagnostic policy/instance mismatch');
        // A newer release may bind a policy shape this one cannot validate.
        const storedVersion = Number((stored.policy as { version?: unknown } | undefined)?.version);
        if (Number.isSafeInteger(storedVersion) && storedVersion > this.limits.version) throw new DiagnosticPolicyError('diagnostic policy downgrade refused');
        const policy = stored.policy ? validPolicy(stored.policy) : undefined;
        if (policy && samePolicy(policy, this.limits)) return;
        const history = JSON.parse((this.db.prepare('SELECT value FROM settings WHERE key=?').get('policyHistory') as { value: string } | undefined)?.value ?? '[]') as object[];
        const migrated = policy && this.migrate(policy, migrations, history);
        if (!migrated || !samePolicy(migrated, this.limits)) {
            throw new DiagnosticPolicyError(migrated && migrated.version > this.limits.version
                ? 'diagnostic policy downgrade refused' : 'diagnostic policy change requires an explicit versioned migration');
        }
        this.db.prepare('INSERT OR REPLACE INTO settings VALUES (?,?)').run('policyHistory', JSON.stringify(history.slice(-32)));
        write();
    }
    /** Apply consecutive declared steps; stop at the first undeclared one. */
    private migrate(policy: ManagedLogPolicy, migrations: readonly ManagedLogPolicyMigration[], history: object[]): ManagedLogPolicy | undefined {
        let current: ManagedLogPolicy | undefined = policy;
        while (current && current.version < this.limits.version) {
            const from: ManagedLogPolicy = current;
            const step = migrations.find(m => m.from === from.version);
            if (!step || step.to <= step.from || step.to > this.limits.version || !samePolicy(step.previous, from)) return from;
            this.db.prepare('UPDATE segments SET sealed=1 WHERE sealed=0').run();
            step.migrate?.(this.db);
            history.push({ from: step.from, to: step.to, migratedAt: Date.now() });
            current = step.to === this.limits.version ? this.limits : migrations.find(m => m.from === step.to)?.previous;
        }
        return current;
    }
    private atomic<T>(fn: () => T): T {
        this.db.exec('BEGIN IMMEDIATE');
        try { const result = fn(); this.db.exec('COMMIT'); return result; }
        catch (e) { try { this.db.exec('ROLLBACK'); } catch { /* SQLite may have rolled back on SQLITE_FULL. */ } throw e; }
    }
    private source(identity: LogIdentity): Source {
        for (const value of Object.values(identity)) if (!/^[a-zA-Z0-9._:-]{1,160}$/.test(value)) throw new Error('invalid diagnostic identity');
        const json = JSON.stringify(identity), id = digest(json);
        let source = this.db.prepare('SELECT * FROM sources WHERE id=?').get(id) as Source | undefined;
        if (!source || source.retired) {
            // Admission metadata must remain writable when copy cursors fill.
            const admissionMetadata = /^(?:native-state(?::|$)|native-capacity:|unmapped-native-state$)/.test(identity.source);
            if (!admissionMetadata && (this.db.prepare('SELECT count(*) AS n FROM sources WHERE retired=0').get() as { n: number }).n >= this.limits.sources) throw new Error('diagnostic source capacity');
            this.db.prepare('INSERT INTO sources(id,identity) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET retired=0').run(id, json);
            source = this.db.prepare('SELECT * FROM sources WHERE id=?').get(id) as Source;
        }
        return source;
    }
    private gap(source: Source, bytes: number, reason: string): void { this.db.prepare('UPDATE sources SET dropped=dropped+?,gaps=gaps+1,reason=?,inventory_complete=0 WHERE id=?').run(bytes, reason, source.id); }
    /** `standing`: a limitation re-observed on every pass (e.g. the daemon's 30s
     * inventory) records one durable gap when it begins or changes, not per pass. */
    report(identity: LogIdentity, reason: 'buffer-capacity' | 'unsafe-source' | 'ownership-unsupported' | 'scan-limit' | 'source-replaced' | 'capture-interrupted' | 'protected-native-state' | 'ownership-unverified' | 'storage-unavailable' | `credential-root:${CredentialRootRefusal | 'missing'}`, bytes = 0, options: { standing?: boolean } = {}): void {
        this.atomic(() => {
            const source = this.source(identity);
            if (reason === 'protected-native-state') this.db.prepare('UPDATE sources SET protected_bytes=?,diagnostic_bytes=?,protection=? WHERE id=?').run(bytes, bytes, reason, source.id);
            else if (!options.standing || source.reason !== reason) this.gap(source, bytes, reason);
        });
    }
    measureNativeState(identity: LogIdentity, bytes: number, complete: boolean, options: { inventory?: NativeInventory; now?: number } = {}): void {
        const { inventory, now = Date.now() } = options;
        this.atomic(() => {
            const source = this.source(identity);
            // A partial scan can only raise the known lower bound. A complete
            // scan may release capacity, without erasing historical gaps.
            this.db.prepare('UPDATE sources SET protected_bytes=?,diagnostic_bytes=?,protection=?,inventory_complete=?,native_inventory=? WHERE id=?')
                .run(complete ? bytes : Math.max(bytes, source.protected_bytes),
                    complete ? inventory?.diagnosticBytes ?? bytes : Math.max(inventory?.diagnosticBytes ?? bytes, source.diagnostic_bytes),
                    'protected-native-state', Number(complete),
                    inventory ? JSON.stringify({ ...inventory, measuredAt: now, complete }) : null, source.id);
        });
    }
    recordNativeInventory(root: NativeLogRoot, inventory: NativeLogInventory): NativeLogInventory {
        return this.atomic(() => {
            const source = this.source({ provider: root.provider, agent: root.agent, source: `native-capacity:${digest(root.root)}` });
            const previous = source.native_details ? JSON.parse(source.native_details) as NativeLogInventory : undefined;
            const measured: NativeLogInventory = { ...inventory, capacityBasis: 'diagnostic',
                capacityBytesLowerBound: inventory.inventoryComplete ? inventory.bytes.diagnostic
                    : Math.max(inventory.bytes.diagnostic, previous?.capacityBasis === 'diagnostic'
                        ? previous.capacityBytesLowerBound ?? previous.bytes.diagnostic : previous?.bytes.diagnostic ?? 0) };
            this.db.prepare('UPDATE sources SET native_details=? WHERE id=?').run(JSON.stringify(measured), source.id);
            return measured;
        });
    }
    /** Private operator remediation, never evidence of native disposal or backup.
     * Serialize with measurements so the next scan starts a new lower bound.
     * Keep cursors, gaps and unacknowledged segments intact. */
    resetNativeCapacity(id: string): void {
        if (process.env.PROPR_MANAGED_LOGS !== '1') throw new DiagnosticPolicyError('native capacity reset disabled');
        this.atomic(() => {
            const source = this.db.prepare('SELECT * FROM sources WHERE id=? AND retired=0').get(id) as Source | undefined;
            if (!source || !/^(?:native-state(?::[a-f0-9]{64})?|native-capacity:[a-f0-9]{64})$/.test(JSON.parse(source.identity).source)) {
                throw new DiagnosticPolicyError('unknown native capacity source');
            }
            this.db.prepare(`UPDATE sources SET protected_bytes=0,diagnostic_bytes=0,inventory_complete=0,protection=NULL,
                native_inventory=NULL,native_details=NULL WHERE id=?`).run(id);
        });
    }
    /** Persist membership before collection so retirement survives worker restarts. */
    trackNativeSource(identity: LogIdentity, root: string | undefined): void {
        if (!root) return;
        this.atomic(() => {
            const source = this.source(identity);
            this.db.prepare('UPDATE sources SET native_root=? WHERE id=?').run(digest(root), source.id);
        });
    }
    /** Only confirmed absence releases a transient root's measured contribution. */
    retireNativeRoot(identity: Pick<LogIdentity, 'provider' | 'agent'>, root: string): void {
        this.atomic(() => {
            try { fs.lstatSync(root); return; }
            catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
            const summary = digest(JSON.stringify({ ...identity, source: `native-state:${digest(root)}` }));
            this.db.prepare(`UPDATE sources SET retired=1,protected_bytes=0,diagnostic_bytes=0,inventory_complete=1
                WHERE id=? OR (native_root=? AND json_extract(identity,'$.provider')=? AND json_extract(identity,'$.agent')=?)`)
                .run(summary, digest(root), identity.provider, identity.agent);
            this.prune(Date.now());
        });
    }
    /** Changes whenever another connection commits: progress, not a stalled spool. */
    dataVersion(): number { return (this.db.prepare('PRAGMA data_version').get() as { data_version: number }).data_version; }
    cursor(identity: LogIdentity): Cursor {
        const existing = this.db.prepare('SELECT cursor FROM sources WHERE id=?').get(digest(JSON.stringify(identity))) as { cursor: string } | undefined;
        return existing ? JSON.parse(existing.cursor) as Cursor : this.atomic(() => JSON.parse(this.source(identity).cursor) as Cursor);
    }
    /** Cursor CAS + segments commit together. Concurrent/restarted scans cannot duplicate records. */
    append(identity: LogIdentity, records: string[], format: 'jsonl' | 'text', options: AppendOptions): boolean {
        const { credentials, now = Date.now(), cursor, droppedBytes = 0, continuation, attribution } = options;
        if (records.length > 4096 || records.reduce((sum, r) => sum + Buffer.byteLength(r), 0) > this.limits.scanBytes) throw new Error('diagnostic batch exceeds bound');
        return this.atomic(() => {
            const source = this.source(identity);
            if (cursor && source.cursor !== JSON.stringify(cursor.before)) return false;
            this.prune(now);
            let next = source.next;
            const batch: Array<{ text: string; seq: number; size: number }> = [];
            const flush = () => { if (batch.length) this.appendRecords(source, batch.splice(0), now); };
            if (droppedBytes) this.gap(source, droppedBytes, 'oversize-record');
            for (const [index, record] of records.entries()) {
                const size = Buffer.byteLength(record) + (record.endsWith('\n') ? 0 : 1);
                const redacted = size <= this.limits.recordBytes ? redactRecord(record, format, credentials, { continuation: continuation?.[index] === true, attribution }) : null;
                const seq = next++;
                if (!redacted || Buffer.byteLength(redacted) > this.limits.recordBytes) { flush(); this.gap(source, size, 'unsafe-record'); continue; }
                batch.push({ text: redacted, seq, size });
            }
            flush();
            this.db.prepare('UPDATE sources SET next=?,cursor=?,last_success=? WHERE id=?').run(next, cursor ? JSON.stringify(cursor.after) : source.cursor,
                (this.db.prepare('SELECT gaps FROM sources WHERE id=?').get(source.id) as { gaps: number }).gaps === source.gaps ? now : source.last_success, source.id);
            return true;
        });
    }
    private appendRecords(source: Source, records: Array<{ text: string; seq: number; size: number }>, now: number): void {
        const day = new Date(now).toISOString().slice(0, 10);
        let segment = this.db.prepare('SELECT * FROM segments WHERE source=? ORDER BY id DESC LIMIT 1').get(source.id) as Segment | undefined;
        // Rejected inputs consume sequence numbers, but not segment capacity.
        // A segment is never extended by a different redaction adapter.
        if (segment && (segment.sealed || segment.day !== day || segment.last >= records[0].seq || segment.redaction !== REDACTION_VERSION)) segment = undefined;
        let index = 0;
        while (index < records.length) {
            const parts: Buffer[] = segment ? [gunzipSync(segment.data, { maxOutputLength: this.limits.segmentBytes })] : [];
            let bytes = segment?.raw ?? 0;
            const start = index;
            while (index < records.length && bytes + Buffer.byteLength(records[index].text) <= this.limits.segmentBytes) {
                const data = Buffer.from(records[index++].text); parts.push(data); bytes += data.length;
            }
            if (start === index && segment) { segment = undefined; continue; }
            if (start === index) { this.gap(source, records[index++].size, 'oversize-record'); continue; }
            const raw = Buffer.concat(parts);
            this.storeBatch(source, { segment, day, raw, records: records.slice(start, index), now });
            segment = undefined;
        }
    }
    private storeBatch(source: Source, batch: { segment?: Segment; day: string; raw: Buffer; records: Array<{ seq: number; size: number }>; now: number }): void {
        const { segment, day, raw, records, now } = batch;
        const compressed = gzipSync(raw, { level: 6 });
        const total = this.db.prepare('SELECT coalesce(sum(length(data)),0) AS bytes, count(*) AS n FROM segments').get() as { bytes: number; n: number };
        const perSource = this.db.prepare('SELECT coalesce(sum(length(data)),0) AS bytes FROM segments WHERE source=?').get(source.id) as { bytes: number };
        const added = compressed.length - (segment?.data.length ?? 0);
        if (total.bytes + added > this.limits.spoolBytes || perSource.bytes + added > this.limits.sourceBytes || (!segment && total.n >= this.limits.segments)) {
            for (const record of records) this.gap(source, record.size, 'unacknowledged-capacity');
            return;
        }
        const last = records.at(-1)!.seq;
        if (segment) this.db.prepare('UPDATE segments SET last=?,end=?,raw=?,digest=?,data=? WHERE id=?').run(last, now, raw.length, digest(compressed), compressed, segment.id);
        else {
            this.db.prepare('UPDATE segments SET sealed=1 WHERE source=?').run(source.id);
            this.db.prepare('INSERT INTO segments(source,day,first,last,start,end,raw,digest,data,redaction) VALUES (?,?,?,?,?,?,?,?,?,?)')
                .run(source.id, day, records[0].seq, last, now, now, raw.length, digest(compressed), compressed, REDACTION_VERSION);
        }
    }
    private prune(now: number): void {
        // Acknowledgement includes encrypted upload AND verified readback. Unacked
        // data is never evicted; capacity drops NEW diagnostics with durable gaps.
        this.db.prepare('DELETE FROM segments WHERE ack=1').run();
        this.db.prepare('DELETE FROM sources WHERE retired=1 AND NOT EXISTS (SELECT 1 FROM segments WHERE segments.source=sources.id)').run();
        this.db.prepare('UPDATE segments SET sealed=1 WHERE day<>?').run(new Date(now).toISOString().slice(0, 10));
    }
    status(): object {
        const sources = this.db.prepare('SELECT * FROM sources ORDER BY id').all() as Source[];
        // Preserved pre-upgrade segments keep (and export with) the adapter that produced them.
        const segmentRedactionVersions = (this.db.prepare('SELECT DISTINCT redaction FROM segments ORDER BY redaction').all() as Array<{ redaction: number }>).map(r => r.redaction);
        return { policyVersion: this.limits.version, redactionVersion: REDACTION_VERSION, segmentRedactionVersions, instance: this.instance, private: true, historyComplete: false,
            disposalPolicy: process.env.PROPR_DIAGNOSTIC_DISPOSAL === 'local-only' || process.env.PROPR_DIAGNOSTIC_LOCAL_ONLY === '1' ? 'local-only-loss-accepted' : 'verified-remote-acknowledgement',
            offsiteRetentionDays: 14, limits: this.limits, sourceCapacityWarning: sources.filter(s => !s.retired).length >= this.limits.sources,
            sources: sources.map(s => ({ ...JSON.parse(s.identity), id: s.id, retired: Boolean(s.retired), nextSequence: s.next, droppedBytes: s.dropped, gaps: s.gaps,
                inventoryComplete: Boolean(s.inventory_complete), lastSuccessfulCollection: s.last_success, reason: s.reason, protectedReason: s.protection, protectedBytes: s.protection && !s.reason && JSON.parse(s.identity).source.startsWith('native-state') ? s.protected_bytes : null, capacityWarning: s.diagnostic_bytes >= this.limits.protectedBytes })),
            nativeSources: {
                rotation: 'none', growthBounded: false, inventoryComplete: false,
                maintenance: 'unsupported-writer-lifecycle',
                admission: { existingWritersCapped: false },
                unmeasured: ['container-only', 'unowned', 'excluded-or-unrecognized'],
                sources: sources.filter(s => (/^(?:native-state(?::|$)|unmapped-native-state$|shared-tmp-claude-logs$)/).test(JSON.parse(s.identity).source))
                    .map(s => ({ ...JSON.parse(s.identity), protected: true, growthBounded: false,
                        inventory: s.native_inventory ? JSON.parse(s.native_inventory) : null,
                        capacityBytesLowerBound: s.diagnostic_bytes,
                        capacityBasis: 'diagnostic',
                        measurement: s.protection && !s.reason && JSON.parse(s.identity).source.startsWith('native-state') ? 'allowlisted-files-only' : 'unknown',
                        measuredBytes: s.protection && !s.reason && JSON.parse(s.identity).source.startsWith('native-state') ? s.protected_bytes : null })),
            },
            nativeMaintenance: {
                rotation: 'unsupported', growthBounded: false, disposal: 'protected',
                admission: 'new-launches-only', existingWritersCapped: false,
                coverage: 'explicit-instance-owned-roots-only',
                sources: sources.filter(s => s.native_details).map(s => ({ ...JSON.parse(s.identity),
                    ...JSON.parse(s.native_details!), protected: true, growthBounded: false })),
            },
            spool: this.db.prepare('SELECT count(*) AS segments,coalesce(sum(length(data)),0) AS bytes FROM segments').get() };
    }
    assertCapacity(): void {
        const sources = this.db.prepare('SELECT * FROM sources WHERE retired=0').all() as Source[];
        const roots = new Map<string, number>();
        for (const source of sources) {
            const rootIdentity = source.native_inventory ? (JSON.parse(source.native_inventory) as NativeInventory).rootIdentity : source.id;
            roots.set(rootIdentity, Math.max(roots.get(rootIdentity) ?? 0, source.diagnostic_bytes));
        }
        const bytes = [...roots.values()];
        if (bytes.some(value => value >= this.limits.protectedBytes) || bytes.reduce((sum, value) => sum + value, 0) >= 4 * this.limits.protectedBytes) throw new Error('managed diagnostics: protected native state capacity; operator action required; after storage remediation use private CLI reset-native-capacity (docs/operations/managed-diagnostics.md)');
    }
    assertFilesystemCapacity(directory: PinnedDirectory = this.dir): void {
        const stat = fs.statfsSync(`/proc/self/fd/${directory.fd}`, { bigint: true });
        // Dynamic-inode filesystems report files=ffree=0 without exhaustion.
        if (stat.bavail * stat.bsize < BigInt(this.limits.spoolBytes) || (stat.files > 0n && stat.ffree === 0n)) {
            throw new Error('managed diagnostics: filesystem capacity; operator action required');
        }
    }
    exportOne(): { manifest: object; data: Buffer; id: number; digest: string } | null {
        return this.atomic(() => {
            const s = this.db.prepare('SELECT * FROM segments WHERE ack=0 ORDER BY id LIMIT 1').get() as Segment | undefined;
            if (!s) return null;
            this.db.prepare('UPDATE segments SET sealed=1 WHERE id=?').run(s.id);
            const source = this.db.prepare('SELECT * FROM sources WHERE id=?').get(s.source) as Source;
            return { id: s.id, digest: s.digest, data: s.data, manifest: {
                schemaVersion: 1, policyVersion: this.limits.version, redactionVersion: s.redaction, tenantPrivate: true, instance: this.instance,
                ...JSON.parse(source.identity), sourceId: source.id, segment: s.id, utcDay: s.day,
                collectionWindow: { start: s.start, end: s.end }, firstSequence: s.first, lastSequence: s.last,
                compressedBytes: s.data.length, uncompressedBytes: s.raw, sha256: s.digest, encoding: 'gzip-jsonl',
                droppedBytes: source.dropped, gaps: source.gaps, historyComplete: false, lastSuccessfulCollection: source.last_success,
            } };
        });
    }
    acknowledge(id: number, sha256: string): void {
        this.atomic(() => {
            const s = this.db.prepare('SELECT * FROM segments WHERE id=? AND digest=? AND sealed=1').get(id, sha256) as Segment | undefined;
            if (!s) {
                const previous = this.db.prepare('SELECT value FROM settings WHERE key=?').get('lastAck') as { value: string } | undefined;
                if (previous?.value === JSON.stringify({ id, sha256 })) return;
                throw new Error('unknown diagnostic acknowledgement');
            }
            this.db.prepare('INSERT OR REPLACE INTO settings VALUES (?,?)').run('lastAck', JSON.stringify({ id, sha256 }));
            this.db.prepare('UPDATE segments SET ack=1 WHERE id=?').run(id);
            this.prune(Date.now());
        });
    }
    discardLocal(id: number, sha256: string): void {
        if (process.env.PROPR_MANAGED_LOGS !== '1' || process.env.PROPR_DIAGNOSTIC_LOCAL_ONLY !== '1') {
            throw new Error('local-only diagnostic disposal disabled');
        }
        this.atomic(() => {
            const segment = this.db.prepare('SELECT * FROM segments WHERE id=? AND digest=? AND sealed=1 AND ack=0').get(id, sha256) as Segment | undefined;
            if (!segment) throw new Error('unknown diagnostic local disposal');
            const source = this.db.prepare('SELECT * FROM sources WHERE id=?').get(segment.source) as Source;
            this.gap(source, segment.raw, 'local-only-discard');
            this.db.prepare('DELETE FROM segments WHERE id=?').run(segment.id);
            this.prune(Date.now());
        });
    }
    /** Separate OS-admin opt-in: accepting loss is not remote acknowledgement.
     * This disposes ONLY an exact sealed collected copy, never native history. */
    disposeLocal(id: number, sha256: string): void {
        if (process.env.PROPR_MANAGED_LOGS !== '1' || process.env.PROPR_DIAGNOSTIC_DISPOSAL !== 'local-only') {
            throw new Error('local-only diagnostic disposal is not enabled');
        }
        this.atomic(() => {
            const s = this.db.prepare('SELECT * FROM segments WHERE id=? AND digest=? AND sealed=1').get(id, sha256) as Segment | undefined;
            const receipt = JSON.stringify({ id, sha256 });
            if (!s) {
                if ((this.db.prepare('SELECT value FROM settings WHERE key=?').get('lastLocalDisposal') as { value: string } | undefined)?.value === receipt) return;
                throw new Error('unknown local diagnostic disposal');
            }
            const source = this.db.prepare('SELECT * FROM sources WHERE id=?').get(s.source) as Source;
            this.gap(source, s.raw, 'local-only-disposal');
            this.db.prepare('DELETE FROM segments WHERE id=?').run(id);
            this.db.prepare('INSERT OR REPLACE INTO settings VALUES (?,?)').run('lastLocalDisposal', receipt);
        });
    }
    close(): void { this.db.close(); this.dir.close(); }
}

function validPolicy(policy: ManagedLogPolicy): ManagedLogPolicy {
    const keys = Object.keys(MANAGED_LOG_POLICY);
    if (Object.keys(policy).length !== keys.length || keys.some(key => !Number.isSafeInteger(policy[key as keyof ManagedLogPolicy]) || policy[key as keyof ManagedLogPolicy] <= 0)) {
        throw new DiagnosticPolicyError('invalid diagnostic policy');
    }
    return policy;
}
/** Each step starts from exactly its declared version, once, and strictly advances. */
function validMigrations(migrations: readonly ManagedLogPolicyMigration[]): void {
    const from = new Set<number>();
    for (const step of migrations) {
        if (!Number.isSafeInteger(step.from) || !Number.isSafeInteger(step.to) || step.to <= step.from || from.has(step.from) || validPolicy(step.previous).version !== step.from) throw new DiagnosticPolicyError('invalid diagnostic policy migrations');
        from.add(step.from);
    }
}
function samePolicy(a: ManagedLogPolicy, b: ManagedLogPolicy): boolean {
    return Object.keys(MANAGED_LOG_POLICY).every(key => a[key as keyof ManagedLogPolicy] === b[key as keyof ManagedLogPolicy]);
}
