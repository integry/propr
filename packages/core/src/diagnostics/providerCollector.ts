import { rememberDiagnosticCredentials } from './redaction.js';
import { nativeCredentialValues } from './credentialRedaction.js';
import fs from 'node:fs';
import { ManagedLogSpool, digest, type LogIdentity, type Cursor } from './managedLogSpool.js';
import { PinnedDirectory } from './privateDirectory.js';

export type DiagnosticProvider = 'codex' | 'claude' | 'antigravity' | 'opencode' | 'vibe';
// Exact structural allowlists. No glob of an entire home; no repository paths.
const files: Record<DiagnosticProvider, RegExp> = {
    codex: /^(?:log\/codex-tui\.log|(?:sessions|archived_sessions)\/\d{4}\/\d{2}\/\d{2}\/rollout-[\w.-]+\.jsonl)$/,
    claude: /^(?:debug\/[\w.-]+\.txt|projects\/[^/]+\/[\w.-]+\.jsonl|projects\/[^/]+\/[\w.-]+\/subagents\/agent-[\w.-]+\.jsonl)$/,
    opencode: /^log\/[\w.-]+\.log$/,
    vibe: /^logs\/session\/[\w.-]+\/messages\.jsonl$/,
    antigravity: /^antigravity-cli\/(?:log\/[\w.-]+\.log|brain\/[\w.-]+\/\.system_generated\/logs\/transcript\.jsonl)$/,
};
const protectedFiles: Record<DiagnosticProvider, RegExp> = {
    codex: /^(?:state_\d+|logs_\d+)\.sqlite(?:-wal|-shm)?$/,
    claude: /^history\.jsonl$/,
    opencode: /^opencode\.db(?:-wal|-shm)?$/,
    antigravity: /$a/, vibe: /$a/,
};
const directories: Record<DiagnosticProvider, RegExp> = {
    codex: /^(?:log|sessions|archived_sessions|(?:sessions|archived_sessions)\/\d{4}(?:\/\d{2}){0,2})$/,
    claude: /^(?:debug|projects|projects\/[^/]+|projects\/[^/]+\/[\w.-]+(?:\/subagents)?)$/,
    opencode: /^log$/,
    vibe: /^(?:logs|logs\/session|logs\/session\/[\w.-]+)$/,
    antigravity: /^(?:antigravity-cli|antigravity-cli\/log|antigravity-cli\/brain|antigravity-cli\/brain\/[\w.-]+(?:\/\.system_generated(?:\/logs)?)?)$/,
};
/** Classification is independent of export eligibility. Session records can
 * supply diagnostics, but are NEVER disposable diagnostic files. */
export function nativeFileClass(provider: DiagnosticProvider, relative: string): 'diagnostic' | 'session' | 'database' | 'auth-config' | 'unknown' {
    if (/^(?:auth\.json|account\.json|\.credentials\.json|credentials\.json|config\.[\w.-]+|settings\.[\w.-]+|\.env)$/.test(relative)
        || relative === 'antigravity-cli/antigravity-oauth-token') return 'auth-config';
    if (provider === 'claude' && relative === 'history.jsonl') return 'session';
    if (protectedFiles[provider].test(relative)) return 'database';
    if (!files[provider].test(relative)) return 'unknown';
    return /^(?:log\/|debug\/|antigravity-cli\/log\/)/.test(relative) ? 'diagnostic' : 'session';
}
export function nativeDirectoryAllowed(provider: DiagnosticProvider, relative: string): boolean {
    return directories[provider].test(relative);
}
export interface ProviderRoot { provider: DiagnosticProvider; agent: string; root: string; credentials: readonly string[]; credentialContextComplete?: boolean; transient?: boolean }
export interface NativeInventory {
    rootIdentity: string;
    diagnosticBytes: number; sessionBytes: number; databaseBytes: number;
    diagnosticFiles: number; sessionFiles: number; databaseFiles: number;
    excludedEntries: number;
}
/** Snapshot only committed newline-delimited records. Never modifies the writer's
 * descriptor, native filename, DB, resume state, or live UI watcher. */
export function collectProvider(spool: ManagedLogSpool, input: ProviderRoot & { measureOnly?: boolean; pinnedRoot?: PinnedDirectory; rejectUnsafe?: boolean }, now = Date.now()): boolean {
    const summary: LogIdentity = { provider: input.provider, agent: input.agent, source: input.transient ? `native-state:${digest(input.root)}` : 'native-state' };
    const transientRoot = input.transient ? input.root : undefined;
    let root: PinnedDirectory;
    try { root = input.pinnedRoot ?? PinnedDirectory.open(input.root); }
    catch (e) {
        spool.report(summary, (e as NodeJS.ErrnoException).code === 'ENOENT' ? 'ownership-unverified' : 'unsafe-source');
        if (input.rejectUnsafe) throw e;
        return false;
    }
    let credentials: readonly string[];
    try { credentials = input.measureOnly ? [] : [...input.credentials, ...nativeCredentialValues(input.root, input.provider, root)]; }
    catch { if (!input.pinnedRoot) root.close(); spool.report(summary, 'unsafe-source'); return false; }
    rememberDiagnosticCredentials(credentials);
    let count = 0, readBytes = 0, protectedBytes = 0;
    const rootStat = fs.fstatSync(root.fd);
    const inventory: NativeInventory = { rootIdentity: digest(`${rootStat.dev}:${rootStat.ino}`), diagnosticBytes: 0, sessionBytes: 0, databaseBytes: 0,
        diagnosticFiles: 0, sessionFiles: 0, databaseFiles: 0, excludedEntries: 0 };
    const measure = (relative: string, size: number) => {
        protectedBytes += size;
        const kind = nativeFileClass(input.provider, relative);
        if (kind === 'auth-config' || kind === 'unknown') { inventory.excludedEntries++; return; }
        inventory[`${kind}Bytes`] += size;
        inventory[`${kind}Files`]++;
    };
    let deadline = performance.now() + spool.limits.scanMs;
    let limited = false, inventoryIncomplete = false, unsafe = false;
    const measureProtectedFile = (dir: PinnedDirectory, entry: fs.Dirent, relative: string): void => {
        let fd: number | undefined;
        try { fd = dir.file(entry.name); measure(relative, fs.fstatSync(fd).size); }
        catch { unsafe = true; inventoryIncomplete = true; spool.report(summary, 'unsafe-source'); }
        finally { if (fd !== undefined) fs.closeSync(fd); }
    };
    const collectFile = (dir: PinnedDirectory, entry: fs.Dirent, relative: string): void => {
        const identity = { provider: input.provider, agent: input.agent, source: digest(input.transient ? `${input.root}:${relative}` : relative) };
        let fd: number | undefined;
        try {
            if (!input.measureOnly) spool.trackNativeSource(identity, transientRoot);
            fd = dir.file(entry.name);
            const stat = fs.fstatSync(fd);
            measure(relative, stat.size);
            if (input.measureOnly || !input.credentialContextComplete) return;
            if (readBytes >= spool.limits.scanBytes) { limited = true; return; }
            const before = spool.cursor(identity);
            const inode = `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
            let offset = before.offset ?? 0;
            const anchorAt = (position: number) => {
                const bytes = Buffer.alloc(Math.min(128, position));
                const n = fs.readSync(fd!, bytes, 0, bytes.length, position - bytes.length);
                return digest(bytes.subarray(0, n));
            };
            const replaced = sourceWasReplaced(before, { offset, size: stat.size, inode }, anchorAt);
            if (replaced) {
                spool.report(identity, 'source-replaced', Math.max(0, offset - stat.size)); offset = 0;
            }
            if (sourceIsCaughtUp(before, { offset, size: stat.size, inode }, replaced)) return;
            const buffer = Buffer.alloc(Math.min(spool.limits.scanBytes - readBytes, stat.size - offset));
            const length = fs.readSync(fd, buffer, 0, buffer.length, offset);
            readBytes += length;
            const { records, start, dropped, discard, recordBound } = readCommittedRecords(buffer.subarray(0, length),
                spool.limits.recordBytes, replaced ? false : before.discard ?? false);
            if (recordBound) limited = true;
            spool.append(identity, records, relative.endsWith('.jsonl') ? 'jsonl' : 'text', { credentials, now,
                cursor: { before, after: { inode, offset: offset + start, discard, anchor: anchorAt(offset + start) } }, droppedBytes: dropped });
        } catch { unsafe = true; inventoryIncomplete = true; spool.report(summary, 'unsafe-source'); spool.report(identity, 'unsafe-source'); }
        finally { if (fd !== undefined) fs.closeSync(fd); }
    };
    const visitEntry = (dir: PinnedDirectory, entry: fs.Dirent, relative: string): void => {
        // File matches precede directory matches (Claude session basenames).
        if (protectedFiles[input.provider].test(relative)) measureProtectedFile(dir, entry, relative);
        else if (files[input.provider].test(relative)) {
            const started = performance.now();
            collectFile(dir, entry, relative);
            deadline += performance.now() - started;
        }
        else if (directories[input.provider].test(relative)) {
            let child: PinnedDirectory | undefined;
            try { child = dir.child(entry.name); walk(child, relative + '/'); }
            catch { unsafe = true; inventoryIncomplete = true; spool.report(summary, 'unsafe-source'); }
            finally { child?.close(); }
        }
        else {
            inventory.excludedEntries++;
            if (entry.isDirectory()) inventoryIncomplete = true;
        }
    };
    const walk = (dir: PinnedDirectory, prefix: string): void => {
        const listing = fs.opendirSync(`/proc/self/fd/${dir.fd}`);
        try {
            let entry: fs.Dirent | null;
            while ((entry = listing.readSync())) {
                if (++count > spool.limits.scanFiles || performance.now() > deadline) { limited = true; inventoryIncomplete = true; break; }
                visitEntry(dir, entry, prefix + entry.name);
            }
        } finally { listing.closeSync(); }
    };
    try { walk(root, ''); }
    finally { if (!input.pinnedRoot) root.close(); }
    spool.measureNativeState(summary, protectedBytes, !inventoryIncomplete, { inventory, now });
    if (limited || inventoryIncomplete) spool.report(summary, 'scan-limit');
    if (!input.measureOnly && !input.credentialContextComplete) spool.report(summary, 'ownership-unverified');
    // Scan bounds and unknown subtrees remain lower bounds. Admission must
    // distinguish those from verified unsafe entries.
    if (input.rejectUnsafe && unsafe) throw new Error('unsafe native inventory');
    return !inventoryIncomplete;
}

function sourceWasReplaced(before: Cursor, current: { offset: number; size: number; inode: string }, anchorAt: (position: number) => string): boolean {
    const { offset, size, inode } = current;
    return Boolean((before.anchor && offset <= size && before.anchor !== anchorAt(offset)) || (before.inode && before.inode !== inode) || offset > size);
}

function sourceIsCaughtUp(before: Cursor, current: { offset: number; size: number; inode: string }, replaced: boolean): boolean {
    return !replaced && before.inode === current.inode && current.offset === current.size;
}

/** Keep oversized unfinished lines discarded across bounded reads. */
function readCommittedRecords(buffer: Buffer, recordBytes: number, discard: boolean) {
    let start = 0, dropped = 0, recordBound = false;
    const records: string[] = [];
    for (let end = 0; end < buffer.length; end++) if (buffer[end] === 10) {
        if (discard || end - start > recordBytes) dropped += end + 1 - start;
        else records.push(buffer.subarray(start, end).toString('utf8'));
        discard = false; start = end + 1;
        if (records.length >= 4096) { recordBound = true; break; }
    }
    // An oversized unfinished line is consumed in bounded pieces,
    // and its tail can NEVER be reclassified as a safe record.
    if (!recordBound && (discard || buffer.length - start > recordBytes)) {
        dropped += buffer.length - start; start = buffer.length; discard = true;
    }
    return { records, start, dropped, discard, recordBound };
}
