import { PinnedDirectory } from './privateDirectory.js';
import { rememberDiagnosticCredentials, diagnosticCredentials, processDiagnosticState, classifyTextLine, redactRecord } from './redaction.js';
import fs from 'node:fs';
import type { ChildProcess } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { collectProvider } from './providerCollector.js';
import { nativeCredentialValues } from './credentialRedaction.js';
import { ManagedLogSpool, type LogIdentity } from './managedLogSpool.js';
import { configuredNativeLogRoots, inspectNativeLogRoots, nativeAdmissionReason, NATIVE_LOG_LIMITS } from './nativeLogPolicy.js';
import { assertProviderOwner, isProviderOwnershipError, providerOwnershipStatus } from './providerOwnership.js';
import { resolveProviderCredentialRoot } from './providerRoots.js';

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
export function managedDiagnostics(): ManagedLogSpool | null {
    if (state.spool !== undefined) return state.spool;
    const enabled = process.env.PROPR_MANAGED_LOGS === '1';
    if (!enabled) return null;
    const root = process.env.PROPR_DIAGNOSTIC_ROOT || '/usr/src/app/data/managed-diagnostics';
    state.spool = new ManagedLogSpool(root, process.env.PROPR_INSTANCE_ID || '');
    return state.spool;
}
function availableDiagnostics(): ManagedLogSpool | null {
    try { return managedDiagnostics(); }
    catch { diagnosticsFailure(); return null; }
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
/** Line-oriented stdout/stderr capture. Complete lines and a final unterminated
 * line are records; Docker/exception heads open a bounded continuation window
 * for stack frames (see classifyTextLine). Oversized lines become gaps. */
export function captureProviderOutput(identity: LogIdentity, secrets: readonly string[]): { write(chunk: string): void; close(): void } {
    let pending = '', discard = false, lostBytes = 0, window = 0;
    const db = availableDiagnostics();
    if (!db) return { write() {}, close() {} };
    // There is no durable stdout offset across process death. Expose the capture
    // boundary rather than claiming continuous history after a restart.
    db.report(identity, 'capture-interrupted');
    const records: string[] = [], continuation: boolean[] = [];
    let dropped = 0, bytes = 0;
    const flush = () => {
        if (records.length || dropped) db.append(identity, records, 'text', { credentials: secrets, droppedBytes: dropped, continuation });
        records.length = 0; continuation.length = 0; dropped = 0; bytes = 0;
    };
    const line = (text: string) => {
        const record = text.endsWith('\r') ? text.slice(0, -1) : text;
        const size = Buffer.byteLength(record);
        if (bytes + size > db.limits.scanBytes || records.length >= 4096) flush();
        const kind = classifyTextLine(record, window);
        // A head the spool will reject as unsafe-record must not license orphan
        // frames: check it with the same adapter and bound the spool applies.
        const rejectedHead = !kind.continuation && kind.window > 0 && (() => {
            const redacted = redactRecord(record, 'text', secrets);
            return !redacted || Buffer.byteLength(redacted) > db.limits.recordBytes;
        })();
        window = rejectedHead ? 0 : kind.window;
        records.push(record); continuation.push(kind.continuation); bytes += size;
    };
    const reset = () => { records.length = 0; continuation.length = 0; dropped = 0; bytes = 0; };
    return {
        write(chunk) {
            try {
                if (lostBytes) { db.report(identity, 'storage-unavailable', lostBytes); lostBytes = 0; }
                let start = 0;
                for (let i = 0; i < chunk.length; i++) {
                    if (chunk[i] !== '\n') continue;
                    const part = chunk.slice(start, i); start = i + 1;
                    const size = Buffer.byteLength(pending) + Buffer.byteLength(part);
                    // A dropped line also ends any continuation window.
                    if (discard || size > db.limits.recordBytes) { dropped += size + 1; window = 0; }
                    else line(pending + part);
                    pending = ''; discard = false;
                }
                const rest = chunk.slice(start);
                if (discard || Buffer.byteLength(pending) + Buffer.byteLength(rest) > db.limits.recordBytes) {
                    dropped += Buffer.byteLength(pending) + Buffer.byteLength(rest);
                    pending = ''; discard = true; window = 0;
                } else pending += rest;
                flush();
            } catch {
                lostBytes = Math.min(Number.MAX_SAFE_INTEGER, lostBytes + Buffer.byteLength(chunk) + Buffer.byteLength(pending));
                pending = ''; discard = true; window = 0; reset(); diagnosticsFailure();
            }
        },
        close() {
            try {
                if (lostBytes) db.report(identity, 'storage-unavailable', lostBytes);
                // A bounded final line without a trailing newline is still a
                // record; only an oversized (discarded) tail becomes a gap.
                if (pending && !discard) line(pending);
                else if (discard) dropped += 1;
                flush();
            } catch { reset(); diagnosticsFailure(); }
            pending = ''; discard = false; window = 0;
        },
    };
}

export interface DiagnosticAgent { provider: string; agent: string; configPath?: string; credentials?: Record<string, string>; nativeRoot?: string; authenticationRoot?: string; nativeCredentialContextComplete?: boolean }
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
    const db = availableDiagnostics();
    if (!db) return null;
    const environment = { ...process.env, ...extraEnv };
    // Final and create arguments are scanned separately: admission replaces the
    // final vector with a start command, and neither may hide the other's secrets.
    const secrets = [...configuredDiagnosticSecrets(), ...configuredDiagnosticSecrets(agent.credentials ?? {}), ...configuredDiagnosticSecrets(extraEnv),
        ...argumentDiagnosticSecrets(createArgs, environment), ...argumentDiagnosticSecrets(args, environment)];
    const capture = { provider: agent.provider, agent: agent.agent, source: 'capture' };
    const resolution = resolveProviderCredentialRoot(agent);
    if (resolution.reason) {
        diagnosticsFailure();
        try { db.report(capture, `credential-root:${resolution.reason}`); } catch { /* failure is already surfaced */ }
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
            if (db && agent.provider === 'vibe' && agent.nativeRoot) {
                try { collectProvider(db, { provider: 'vibe', agent: agent.agent, root: agent.nativeRoot, credentials: unique, credentialContextComplete: agent.nativeCredentialContextComplete === true, transient: true }); }
                catch { diagnosticsFailure(); }
            }
        };
        return {
            snapshot,
            stdout: captureProviderOutput({ provider: agent.provider, agent: agent.agent, source: 'stdout' }, unique),
            stderr: captureProviderOutput({ provider: agent.provider, agent: agent.agent, source: 'stderr' }, unique),
        };
    } catch (error) {
        diagnosticsFailure();
        // Only the root-level check raises the ownership error; foreign entries
        // inside a supported root surface as unsafe, never as a UID remedy.
        try {
            db.report(capture, error instanceof MissingCredentialRoot ? 'credential-root:missing'
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
