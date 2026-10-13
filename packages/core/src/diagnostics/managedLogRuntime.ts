import { PinnedDirectory } from './privateDirectory.js';
import { rememberDiagnosticCredentials, diagnosticCredentials, processDiagnosticState, classifyTextLine, redactRecord, type DiagnosticAttribution } from './redaction.js';
import fs from 'node:fs';
import type { ChildProcess } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { collectProvider } from './providerCollector.js';
import { nativeCredentialValues } from './credentialRedaction.js';
import { MANAGED_LOG_POLICY, ManagedLogSpool, type LogIdentity } from './managedLogSpool.js';
import { configuredNativeLogRoots, inspectNativeLogRoots, nativeAdmissionReason, NATIVE_LOG_LIMITS } from './nativeLogPolicy.js';
import { assertProviderOwner, isProviderOwnershipError, providerOwnershipStatus } from './providerOwnership.js';
import { resolveProviderCredentialRoot } from './providerRoots.js';
import { isStorageContention, owe, retryOwed, settle, settleAll, untilDeadline } from './providerOutputLedger.js';

/** Shared by every module instance in the process: one spool, one queue. */
const state = processDiagnosticState('runtime@1', () => ({
    spool: undefined as ManagedLogSpool | undefined, warningAt: 0,
    applicationLostBytes: 0, applicationOverflowBytes: 0,
    applicationLines: [] as string[], applicationBytes: 0,
    applicationTimer: undefined as NodeJS.Timeout | undefined,
}));
export function diagnosticsFailure(): void {
    if (Date.now() - state.warningAt > 60_000) {
        state.warningAt = Date.now();
        // Deliberately no exception text, file names or record contents.
        process.stderr.write('managed diagnostics unavailable; collection coverage is incomplete\n');
    }
}
/** Bound on the synchronous wait for another worker's lock when opening. */
const SPOOL_OPEN_CONTENTION_MS = 5_000;
export function managedDiagnostics(): ManagedLogSpool | null {
    return openDiagnostics(Date.now() + SPOOL_OPEN_CONTENTION_MS);
}
/** Opening takes the write lock for schema and binding checks. `deadline`
 * bounds the wait while another worker holds it; without one, one attempt. */
function openDiagnostics(deadline?: number): ManagedLogSpool | null {
    if (state.spool !== undefined) return state.spool;
    if (process.env.PROPR_MANAGED_LOGS !== '1') return null;
    const root = process.env.PROPR_DIAGNOSTIC_ROOT || '/usr/src/app/data/managed-diagnostics';
    state.spool = new ManagedLogSpool(root, process.env.PROPR_INSTANCE_ID || '', {}, { openDeadline: deadline ?? 0 });
    return state.spool;
}
export function configuredDiagnosticSecrets(env: Record<string, string | undefined> = process.env): string[] {
    return Object.entries(env).filter(([k, v]) => /secret|token|password|key|credential/i.test(k) && v && v.length >= 8).map(([, v]) => v!);
}
const applicationIdentity = { provider: 'application', agent: 'application', source: 'pino' };
export function flushApplicationRecords(): void {
    if (state.applicationTimer) clearTimeout(state.applicationTimer);
    state.applicationTimer = undefined;
    const lines = state.applicationLines;
    try {
        const db = managedDiagnostics();
        if (!db) return;
        if (state.applicationLostBytes) { db.report(applicationIdentity, 'storage-unavailable', state.applicationLostBytes); state.applicationLostBytes = 0; }
        if (state.applicationOverflowBytes) { db.report(applicationIdentity, 'buffer-capacity', state.applicationOverflowBytes); state.applicationOverflowBytes = 0; }
        // Use one bounded, deduplicated context, including current environment values.
        rememberDiagnosticCredentials(configuredDiagnosticSecrets());
        if (lines.length) db.append(applicationIdentity, lines, 'jsonl', { credentials: diagnosticCredentials() });
    } catch { state.applicationLostBytes = Math.min(Number.MAX_SAFE_INTEGER, state.applicationLostBytes + state.applicationBytes); diagnosticsFailure(); }
    finally { state.applicationLines = []; state.applicationBytes = 0; }
}
/** Bounded queue: the synchronous Pino hook never opens a transaction. */
export function captureApplicationRecord(line: string): void {
    if (process.env.PROPR_MANAGED_LOGS !== '1') return;
    const size = Buffer.byteLength(line);
    if (state.applicationBytes + size > 1024 * 1024 || state.applicationLines.length >= 4096) state.applicationOverflowBytes = Math.min(Number.MAX_SAFE_INTEGER, state.applicationOverflowBytes + size);
    else { state.applicationLines.push(line); state.applicationBytes += size; }
    if (!state.applicationTimer) state.applicationTimer = setTimeout(flushApplicationRecords, 25);
}
/** Provider output is buffered in memory and committed on this short timer,
 * not with one immediate transaction (and gzip/fsync) per child-process chunk. */
export const PROVIDER_OUTPUT_FLUSH_MS = 50;
/** Bounds on a batch that could not be committed. It is kept (within the
 * buffer bound) and retried: while other workers hold the spool lock, until no
 * worker has committed for `contentionMs` (a stalled spool, not contention) or
 * for at most `retainMs` in all; after any other storage error, `attempts`
 * times. A flush that must free a full buffer waits synchronously for at most
 * `fullMs`; if the lock is still held, only the incoming line is shed as an
 * exact `buffer-capacity` gap. The exit drain waits for at most `exitMs`. Past
 * those bounds the batch's exact bytes are owed as a `storage-unavailable`
 * gap, which is retried until the spool records it. */
export const providerOutputRetry = { contentionMs: 30_000, retainMs: 300_000, attempts: 2, fullMs: 250, exitMs: 2_000 };
/** Captures holding buffered records; drained synchronously on process exit. */
const outputState = processDiagnosticState('provider-output@2', () => ({ buffered: new Set<(deadline: number) => unknown>(), exitHook: false, idleUntil: 0, backoff: 1 }));
/** Captures in one process take turns with other workers: after holding (or
 * waiting for) the spool lock for d ms, the next timer flush starts no sooner
 * than `backoff`·d ms (at most 2s) later. Contention doubles `backoff` (up to 16) and each
 * uncontended commit lowers it, so busy workers leave the lock free for the
 * others rather than starving them. Batches grow instead, up to the bound. */
function paced(delay: number): number {
    const wait = Math.max(delay, Math.min(outputState.idleUntil - Date.now(), 2_000));
    return wait + Math.floor(Math.random() * wait / 2);
}
function flushBufferedOutputOnExit(): void {
    if (outputState.exitHook) return;
    outputState.exitHook = true;
    process.once('exit', () => {
        const deadline = Date.now() + providerOutputRetry.exitMs;
        for (const flush of [...outputState.buffered]) flush(deadline);
        if (state.spool) settleAll(state.spool, deadline);
    });
}
/** Line-oriented stdout/stderr capture. Complete lines and a final unterminated
 * line are records; Docker/exception heads open a bounded continuation window
 * for stack frames (see classifyTextLine). Oversized lines become gaps.
 * Records are buffered up to the spool's batch bound (scanBytes, 4096 records)
 * and flushed by timer, when full, on close and on process exit. A hard crash
 * loses at most the buffer, behind the capture-interrupted boundary. */
export function captureProviderOutput(identity: LogIdentity, secrets: readonly string[], attribution?: DiagnosticAttribution): { write(chunk: string): void; close(): void } {
    let pending = '', discard = false, window = 0, closed = false, db: ManagedLogSpool | null = null;
    if (process.env.PROPR_MANAGED_LOGS !== '1') return { write() {}, close() {} };
    // Starting never waits for or fails on another worker's lock: a contended
    // spool is opened, like any contended commit, by this capture's flushes.
    try { db = openDiagnostics(); }
    catch (error) { if (!isStorageContention(error)) { diagnosticsFailure(); return { write() {}, close() {} }; } }
    const limits = db?.limits ?? MANAGED_LOG_POLICY;
    const records: string[] = [], continuation: boolean[] = [];
    let dropped = 0, bytes = 0, failures = 0, failingSince = 0, progressAt = 0, version = NaN, timer: NodeJS.Timeout | undefined;
    const reset = () => { records.length = 0; continuation.length = 0; dropped = 0; bytes = 0; failures = 0; failingSince = 0; };
    /** Whether a failed batch is kept for another attempt (see providerOutputRetry). */
    const retainable = (error: unknown, mode: 'timer' | 'full' | 'exit'): boolean => {
        const now = Date.now();
        if (!failingSince) failingSince = progressAt = now;
        failures++;
        if (mode === 'exit') return false;
        if (!isStorageContention(error)) return mode === 'timer' && failures <= providerOutputRetry.attempts;
        outputState.backoff = Math.min(outputState.backoff * 2, 16);
        // Another connection's commit since the last attempt means the spool is
        // progressing; an unreadable version (or no spool yet) means it is held.
        let current = NaN;
        try { current = db ? db.dataVersion() : NaN; } catch { /* held: progressing */ }
        if (current !== version) { version = current; progressAt = now; }
        return now - progressAt < providerOutputRetry.contentionMs && now - failingSince < providerOutputRetry.retainMs;
    };
    /** Owed markers are retried by the ledger, or by this capture's flush until it has a spool. */
    const retry = () => { if (db) retryOwed(db, diagnosticsFailure); else schedule(failures ? 1_000 : PROVIDER_OUTPUT_FLUSH_MS); };
    const schedule = (delay = PROVIDER_OUTPUT_FLUSH_MS) => {
        outputState.buffered.add(final);
        if (timer) return;
        timer = setTimeout(() => flush('timer'), paced(delay));
        // Only a closed capture's retained batch, for its bounded retries, may
        // keep the process alive; the exit drain covers everything else.
        if (!closed || !failures || !(records.length || dropped)) timer.unref();
    };
    /** `timer` (and close) makes one attempt; `full` and `exit` wait for the
     * lock until `deadline`. True when nothing remains buffered. */
    const flush = (mode: 'timer' | 'full' | 'exit', deadline?: number): boolean => {
        if (timer) clearTimeout(timer);
        timer = undefined;
        const started = Date.now();
        try {
            db ??= openDiagnostics(deadline);
            if (db) settle(db, identity, deadline);
            if (db && (records.length || dropped)) untilDeadline(() => db!.append(identity, records, 'text', { credentials: secrets, droppedBytes: dropped, continuation, attribution }), deadline);
            reset();
            outputState.backoff = Math.max(1, outputState.backoff - 1);
        } catch (error) {
            if (retainable(error, mode)) {
                // Contention is polled at the paced timer cadence (the lock frees
                // between other workers' commits); other errors back off.
                schedule(isStorageContention(error) ? PROVIDER_OUTPUT_FLUSH_MS : Math.min(PROVIDER_OUTPUT_FLUSH_MS * 2 ** failures, 1_000));
                return false;
            }
            // Exact fail-closed accounting: every byte and newline of the batch.
            diagnosticsFailure();
            if (records.length || dropped) owe(identity, { bytes: bytes + records.length + dropped });
            reset();
            if (mode !== 'exit') retry();
        } finally { outputState.idleUntil = Math.max(outputState.idleUntil, Date.now() + outputState.backoff * (Date.now() - started)); }
        if (!timer && !pending) outputState.buffered.delete(final);
        return true;
    };
    const final = (deadline: number) => {
        finishLine('exit', deadline);
        return flush('exit', deadline);
    };
    const line = (text: string, mode: 'full' | 'exit' = 'full', deadline = Date.now() + providerOutputRetry.fullMs) => {
        const record = text.endsWith('\r') ? text.slice(0, -1) : text;
        const size = Buffer.byteLength(record);
        if ((bytes + size > limits.scanBytes || records.length >= 4096) && !flush(mode, deadline)) {
            // Still contended: keep the retained batch, shed this line exactly.
            owe(identity, { overflow: size + 1 }); window = 0; retry();
            return;
        }
        const kind = classifyTextLine(record, window);
        // A head the spool will reject as unsafe-record must not license orphan
        // frames: check it with the same adapter and bound the spool applies.
        const rejectedHead = !kind.continuation && kind.window > 0 && (() => {
            const redacted = redactRecord(record, 'text', secrets, { attribution });
            return !redacted || Buffer.byteLength(redacted) > limits.recordBytes;
        })();
        window = rejectedHead ? 0 : kind.window;
        records.push(record); continuation.push(kind.continuation); bytes += size;
    };
    /** Detach once, before a capacity flush, so close/exit cannot replay a tail.
     * Discarded tail bytes are already in `dropped`; no newline was received. */
    const finishLine = (mode: 'full' | 'exit' = 'full', deadline?: number) => {
        const tail = pending;
        pending = ''; discard = false;
        if (tail) line(tail, mode, deadline);
        window = 0;
    };
    // There is no durable stdout offset across process death. Expose the capture
    // boundary rather than claiming continuous history after a restart. Under
    // contention it stays owed and is recorded before any of this capture's records.
    owe(identity, { interrupted: true });
    flushBufferedOutputOnExit();
    if (!db) retry();
    else try { settle(db, identity); } catch (error) { if (!isStorageContention(error)) diagnosticsFailure(); retry(); }
    return {
        write(chunk) {
            if (!chunk) return;
            try {
                let start = 0;
                for (let i = 0; i < chunk.length; i++) {
                    if (chunk[i] !== '\n') continue;
                    const part = chunk.slice(start, i); start = i + 1;
                    const size = Buffer.byteLength(pending) + Buffer.byteLength(part);
                    // A dropped line also ends any continuation window.
                    if (discard || size > limits.recordBytes) { dropped += size + 1; window = 0; }
                    else line(pending + part);
                    pending = ''; discard = false;
                }
                const rest = chunk.slice(start);
                if (discard || Buffer.byteLength(pending) + Buffer.byteLength(rest) > limits.recordBytes) {
                    dropped += Buffer.byteLength(pending) + Buffer.byteLength(rest);
                    pending = ''; discard = true; window = 0;
                } else pending += rest;
            } catch {
                owe(identity, { bytes: Buffer.byteLength(chunk) + Buffer.byteLength(pending) });
                pending = ''; discard = true; window = 0; diagnosticsFailure();
                retry();
            }
            // Register partial-only captures for exit without starting a timer
            // that would prematurely turn an incomplete line into a record.
            if (pending) outputState.buffered.add(final);
            if (records.length || dropped) schedule();
        },
        close() {
            try {
                // A bounded final line without a trailing newline is still a
                // record; only an oversized (discarded) tail becomes a gap.
                finishLine();
            } catch { diagnosticsFailure(); }
            pending = ''; discard = false; window = 0; closed = true;
            // A failed close keeps the batch, and anything owed, for the bounded
            // retries above; it never discards loss it could not record.
            flush('timer');
        },
    };
}

/** `attribution` labels records only; it never becomes part of a source identity. */
export interface DiagnosticAgent { provider: string; agent: string; attribution?: DiagnosticAttribution; configPath?: string; credentials?: Record<string, string>; nativeRoot?: string; authenticationRoot?: string; nativeCredentialContextComplete?: boolean }
/** Before Docker admission/creation, outside the best-effort capture catch.
 * Fresh metadata checks refuse new launches only; they never stop a writer. */
export function assertNativeLogAdmission(agent: DiagnosticAgent | undefined): void {
    if (!agent || process.env.PROPR_MANAGED_LOGS !== '1') return;
    const roots = configuredNativeLogRoots();
    if (!roots.some(root => root.provider === agent.provider && root.agent === agent.agent)) return;
    const db = managedDiagnostics();
    if (!db) throw new Error('native log admission unavailable; operator action required');
    const inventories = inspectNativeLogRoots(roots).map((inventory, index) => db.recordNativeInventory(roots[index], inventory));
    const reason = nativeAdmissionReason(inventories);
    if (reason) throw new Error(`managed diagnostics: ${reason}`);
}
export function nativeDiagnosticStatus(): object {
    const db = managedDiagnostics();
    if (!db) throw new Error('disabled');
    const roots = configuredNativeLogRoots();
    const inventories = inspectNativeLogRoots(roots).map((inventory, index) => db.recordNativeInventory(roots[index], inventory));
    return { ...db.status(), providerOwnership: providerOwnershipStatus(), nativeAdmission: { configuredRoots: roots.length, limits: NATIVE_LOG_LIMITS,
        status: roots.length ? nativeAdmissionReason(inventories) ? 'refused' : 'available' : 'unconfigured',
        reason: nativeAdmissionReason(inventories), newLaunchesOnly: true, existingWritersCapped: false,
        inventoryComplete: roots.length > 0 && inventories.every(i => i.inventoryComplete),
        observedBytes: inventories.reduce((sum, i) => sum + i.observedBytes, 0) } };
}
/** Root-only view of resolveProviderCredentialRoot, for inventory callers. */
export function providerCredentialRoot(agent: DiagnosticAgent, resolve?: (value: string) => string): string | undefined {
    return resolveProviderCredentialRoot(agent, { resolve }).root;
}
const secretName = /secret|token|password|passwd|key|credential|auth|cookie/i;
/** `user[:password]` of every `scheme://user[:password]@` in a value, scanned
 * linearly (a backtracking pattern is polynomial on long scheme-like runs). */
function urlUserinfo(value: string): Array<[string, string | undefined]> {
    const found: Array<[string, string | undefined]> = [];
    const schemeChar = /[a-z0-9+.-]/i;
    const stop = (c: string, colon: boolean) => /\s/.test(c) || c === '/' || c === '@' || (colon && c === ':');
    for (let at = value.indexOf('://'); at !== -1; at = value.indexOf('://', at + 3)) {
        let start = at;
        while (start > 0 && schemeChar.test(value[start - 1])) start--;
        if (!/[a-z]/i.test(value.slice(start, at))) continue;
        let i = at + 3;
        const userStart = i;
        while (i < value.length && !stop(value[i], true)) i++;
        const user = value.slice(userStart, i);
        let password: string | undefined;
        if (value[i] === ':') {
            const passwordStart = ++i;
            while (i < value.length && !stop(value[i], false)) i++;
            // `user:@host` still names `user`; only the empty password is absent.
            password = value.slice(passwordStart, i) || undefined;
        }
        if (user && value[i] === '@') found.push([user, password]);
    }
    return found;
}
/** Secret-shaped parts of values under innocuous names, e.g. a proxy URL with
 * userinfo, an injected authorization header or an MCP JSON configuration. */
function secretShapedValues(value: string): string[] {
    const parts: string[] = [];
    for (const [user, password] of urlUserinfo(value)) parts.push(user, ...(password ? [password, `${user}:${password}`] : []));
    for (const match of value.matchAll(/\b(?:Bearer|Basic|token)\s+([^\s"',;]+)/gi)) parts.push(match[1]);
    if (/^\s*[{[]/.test(value)) {
        const walk = (node: unknown, key = '', depth = 0): void => {
            if (depth > 16 || parts.length > 64) return;
            if (typeof node === 'string') parts.push(...(secretName.test(key) ? [node] : []), ...secretShapedValues(node));
            else if (node && typeof node === 'object') for (const [k, v] of Object.entries(node)) walk(v, Array.isArray(node) ? key : k, depth + 1);
        };
        try { walk(JSON.parse(value)); } catch { /* opaque text: only the shapes above */ }
    }
    return parts.filter(part => part.length >= 8);
}
/** Every Docker env option form (`-e K=V`, `--env K=V`, `--env=K=V`, `-eK=V`
 * and inherited `-e K`), including those a network/admission policy appended. */
function argumentDiagnosticSecrets(args: readonly string[], env: Record<string, string | undefined>): string[] {
    const secrets: string[] = [];
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        const separate = arg === '-e' || arg === '--env';
        const entry = separate ? args[++i]
            : arg.startsWith('--env=') ? arg.slice('--env='.length)
            : /^-e[^-]/.test(arg) ? arg.slice(arg.startsWith('-e=') ? 3 : 2) : undefined;
        if (!entry) continue;
        const separator = entry.indexOf('=');
        const key = separator < 0 ? entry : entry.slice(0, separator);
        const value = separator < 0 ? env[key] ?? process.env[key] : entry.slice(separator + 1);
        if (!key || !value) continue;
        if (value.length >= 8 && secretName.test(key)) secrets.push(value);
        secrets.push(...secretShapedValues(value));
    }
    return secrets;
}
class MissingCredentialRoot extends Error {}
/** Establish redaction context immediately before spawning with final arguments.
 * Create-time arguments are separate because admission may replace them with a
 * container start command; credentials from both vectors must remain redacted.
 */
export function prepareProviderCapture(agent: DiagnosticAgent, args: string[] = [], extraEnv: Record<string, string | undefined> = {}, createArgs: readonly string[] = []) {
    if (process.env.PROPR_MANAGED_LOGS !== '1') return null;
    // A contended spool must not block or skip the launch; captures open it lazily.
    let db: ManagedLogSpool | null = null;
    try { db = openDiagnostics(); }
    catch (error) { if (!isStorageContention(error)) { diagnosticsFailure(); return null; } }
    const environment = { ...process.env, ...extraEnv };
    // Final and create arguments are scanned separately: admission replaces the
    // final vector with a start command, and neither may hide the other's secrets.
    const secrets = [...configuredDiagnosticSecrets(), ...configuredDiagnosticSecrets(agent.credentials ?? {}), ...configuredDiagnosticSecrets(extraEnv),
        ...argumentDiagnosticSecrets(createArgs, environment), ...argumentDiagnosticSecrets(args, environment)];
    const capture = { provider: agent.provider, agent: agent.agent, source: 'capture' };
    const resolution = resolveProviderCredentialRoot(agent);
    if (resolution.reason) {
        diagnosticsFailure();
        try { (db ?? managedDiagnostics())?.report(capture, `credential-root:${resolution.reason}`); } catch { /* failure is already surfaced */ }
        return null;
    }
    const root = resolution.root;
    try {
        let pinned: PinnedDirectory;
        // Missing roots cannot establish native authentication context.
        try { pinned = PinnedDirectory.open(root); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new MissingCredentialRoot(); throw error; }
        try {
            // Unsupported worker/container UID mappings fail closed before any
            // credential read; entries are then checked against this pinned root.
            assertProviderOwner(fs.fstatSync(pinned.fd).uid);
            secrets.push(...nativeCredentialValues(root, agent.provider, pinned));
        }
        finally { pinned.close(); }
        const unique = [...new Set(secrets.filter(secret => secret.length >= 8))];
        rememberDiagnosticCredentials(unique);
        const snapshot = () => {
            const spool = db ?? state.spool;
            if (spool && agent.provider === 'vibe' && agent.nativeRoot) {
                try { collectProvider(spool, { provider: 'vibe', agent: agent.agent, root: agent.nativeRoot, credentials: unique, credentialContextComplete: agent.nativeCredentialContextComplete === true, transient: true }); }
                catch { diagnosticsFailure(); }
            }
        };
        return {
            snapshot,
            stdout: captureProviderOutput({ provider: agent.provider, agent: agent.agent, source: 'stdout' }, unique, agent.attribution),
            stderr: captureProviderOutput({ provider: agent.provider, agent: agent.agent, source: 'stderr' }, unique, agent.attribution),
        };
    } catch (error) {
        diagnosticsFailure();
        // Only the root-level check raises the ownership error; foreign entries
        // inside a supported root surface as unsafe, never as a UID remedy.
        try {
            (db ?? managedDiagnostics())?.report(capture, error instanceof MissingCredentialRoot ? 'credential-root:missing'
                : isProviderOwnershipError(error) ? 'ownership-unsupported' : 'unsafe-source');
        } catch { /* failure is already surfaced */ }
        return null;
    }
}
export function attachProviderCapture(child: ChildProcess, capture: ReturnType<typeof prepareProviderCapture>): void {
    if (!capture) return;
    const timer = setInterval(capture.snapshot, 30_000); timer.unref();
    const stdout = new StringDecoder('utf8'), stderr = new StringDecoder('utf8');
    child.stdout?.on('data', (chunk: Buffer) => capture.stdout.write(stdout.write(chunk)));
    child.stderr?.on('data', (chunk: Buffer) => capture.stderr.write(stderr.write(chunk)));
    child.once('close', () => {
        clearInterval(timer); capture.snapshot();
        capture.stdout.write(stdout.end()); capture.stdout.close();
        capture.stderr.write(stderr.end()); capture.stderr.close();
    });
}

export function prepareCommandCapture(agent: DiagnosticAgent | undefined, args: string[], extraEnv?: Record<string, string | undefined>, createArgs?: readonly string[]) {
    const capture = agent ? prepareProviderCapture(agent, args, extraEnv, createArgs) : null;
    return {
        capture,
        stdout: capture?.stdout,
        stderr: capture?.stderr,
    };
}

export function finishDiagnosticOutput(output: ReturnType<typeof prepareProviderCapture>, stdout: string, stderr: string): void {
    output?.stdout.write(stdout);
    output?.stdout.close();
    output?.stderr.write(stderr);
    output?.stderr.close();
}

export function scheduleProviderCapture(capture: ReturnType<typeof prepareProviderCapture>) {
    const timer = capture ? setInterval(capture.snapshot, 30_000) : undefined;
    timer?.unref();
    return timer;
}

export function retireProviderRuntime(agent: string, root: string | undefined): void {
    if (!root) return;
    try { managedDiagnostics()?.retireNativeRoot({ provider: 'vibe', agent }, root); }
    catch { diagnosticsFailure(); }
}
