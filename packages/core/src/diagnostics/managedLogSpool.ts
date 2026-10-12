import fs from 'node:fs';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { PinnedDirectory } from './privateDirectory.js';
import { redactRecord, REDACTION_VERSION } from './redaction.js';
import type { NativeInventory } from './providerCollector.js';

interface Statement { run(...args: unknown[]): { lastInsertRowid: number | bigint }; get(...args: unknown[]): unknown; all(...args: unknown[]): unknown[] }
interface Database { exec(sql: string): void; prepare(sql: string): Statement; close(): void }
const Sqlite = createRequire(import.meta.url)('better-sqlite3') as new (file: string) => Database;
export const MANAGED_LOG_POLICY = Object.freeze({
    version: 1, recordBytes: 64 * 1024, segmentBytes: 256 * 1024,
    sourceBytes: 8 * 1024 * 1024, spoolBytes: 64 * 1024 * 1024,
    segments: 1024, sources: 2048, databaseBytes: 96 * 1024 * 1024,
    retentionMs: 14 * 86400_000, scanBytes: 1024 * 1024, scanFiles: 4096,
    scanMs: 250, protectedBytes: 256 * 1024 * 1024,
});
export class DiagnosticPolicyError extends Error {}
export type LogIdentity = { provider: string; agent: string; source: string };
export type Cursor = { inode?: string; offset?: number; discard?: boolean; anchor?: string };
export interface AppendOptions {
    credentials: readonly string[];
    now?: number;
    cursor?: { before: Cursor; after: Cursor };
    droppedBytes?: number;
}
interface Source { retired: number; id: string; identity: string; cursor: string; next: number; dropped: number; gaps: number; last_success: number | null; reason: string | null; protected_bytes: number; inventory_complete: number; protection: string | null; native_inventory: string | null }
interface Segment { id: number; source: string; day: string; first: number; last: number; start: number; end: number; raw: number; digest: string; data: Buffer; sealed: number; ack: number }
export const digest = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');

/** A private transactional outbox. Only this database is pruned, never provider state.
 * DELETE journalling keeps the on-disk bound independent of long-lived readers.
 * Immediate transactions serialize writers, collectors, exporters and pruning. */
export class ManagedLogSpool {
    private readonly dir: PinnedDirectory;
    private readonly db!: Database;
    readonly limits: typeof MANAGED_LOG_POLICY;
    constructor(root: string, readonly instance: string, limits: Partial<typeof MANAGED_LOG_POLICY> = {}) {
        if (!/^[a-zA-Z0-9._:-]{1,128}$/.test(instance)) throw new DiagnosticPolicyError('invalid diagnostic instance');
        this.limits = { ...MANAGED_LOG_POLICY, ...limits };
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
            this.db.exec(`PRAGMA busy_timeout=1000; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;
                PRAGMA max_page_count=${Math.floor(this.limits.databaseBytes / 4096)};
                BEGIN IMMEDIATE;
                CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS sources (id TEXT PRIMARY KEY, identity TEXT NOT NULL, cursor TEXT NOT NULL DEFAULT '{}', next INTEGER NOT NULL DEFAULT 1,
                    dropped INTEGER NOT NULL DEFAULT 0, gaps INTEGER NOT NULL D