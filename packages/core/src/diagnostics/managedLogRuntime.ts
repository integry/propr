import { PinnedDirectory } from './privateDirectory.js';
import { rememberDiagnosticCredentials, diagnosticCredentials } from './redaction.js';
import path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { getManagedAgentConfigRelativePath } from '@propr/shared';
import { collectProvider } from './providerCollector.js';
import { nativeCredentialValues, antigravityCredentialRoot } from './credentialRedaction.js';
import { ManagedLogSpool, type LogIdentity } from './managedLogSpool.js';
import { configuredNativeLogRoots, inspectNativeLogRoots, nativeAdmissionReason, NATIVE_LOG_LIMITS } from './nativeLogPolicy.js';

let spool: ManagedLogSpool | undefined;
let warningAt = 0;
let applicationLostBytes = 0, applicationOverflowBytes = 0;
export function diagnosticsFailure(): void {
    if (Date.now() - warningAt > 60_000) {
        warningAt = Date.now();
        // Deliberately no exception text, file names or record contents.
        process.stderr.write('managed diagnostics unavailable; collection coverage is incomplete\n');
    }
}
export function managedDiagnostics(): ManagedLogSpool | null {
    if (spool !== undefined) return spool;
    const enabled = process.env.PROPR_MANAGED_LOGS === '1';
    if (!enabled) return null;
    const root = process.env.PROPR_DIAGNOSTIC_ROOT || '/usr/src/app/data/managed-diagnostics';
    spool = new ManagedLogSpool(root, process.env.PROPR_INSTANCE_ID || '');
    return spool;
}
function availableDiagnostics(): ManagedLogSpool | null {
    try { return managedDiagnostics(); }
    catch { diagnosticsFailure(); return null; }
}
export function configuredDiagnosticSecrets(env: Record<string, string | undefined> = process.env): string[] {
    return Object.entries(env).filter(([k, v]) => /secret|token|password|key|credential/i.test(k) && v && v.length >= 8).map(([, v]) => v!);
}
const applicationIdentity = { provider: 'application', agent: 'application', source: 'pino' };
let applicationLines: string[] = [], applicationBytes = 0;
let applicationTimer: NodeJS.Timeout | undefined;
export function flushApplicationRecords(): void {
    if (applicationTimer) clearTimeout(applicationTimer);
    applicationTimer = undefined;
    const lines = applicationLines;
    try {
        const db = managedDiagnostics();
        if (!db) return;
        if (applicationLostBytes) { db.report(applicationIdentity, 'storage-unavailable', applicationLostBytes); applicationLostBytes = 0; }
        if (applicationOverflowBytes) { db.report(applicationIdentity, 'buffer-capacity', applicationOverflowBytes); applicationOverflowBytes = 0; }
        // Use one bounded, deduplicated context, including current environment values.
        rememberDiagnosticCredentials(configuredDiagnosticSecrets());
        if (lines.length) db.append(applicationIdentity, lines, 'jsonl', { credentials: diagnosticCredentials() });
    } catch { applicationLostBytes = Math.min(Number.MAX_SAFE_INTEGER, applicationLostBytes + applicationBytes); diagnosticsFailure(); }
    finally { applicationLines = []; applicationBytes = 0; }
}
/** Bounded queue: the synchronous Pino hook never opens a transaction. */
export function captureApplicationRecord(line: string): void {
    if (process.env.PROPR_MANAGED_LOGS !== '1') return;
    const size = Buffer.byteLength(line);
    if (applicationBytes + size > 1024 * 1024 || applicationLines.length >= 4096) applicationOverflowBytes = Math.min(Number.MAX_SAFE_INTEGER, applicationOverflowBytes + size);
    else { applicationLines.push(line); applicationBytes += size; }
    if (!applicationTimer) applicationTimer = setTimeout(flushApplicationRecords, 25);
}
export function captureProviderOutput(identity: LogIdentity, secrets: readonly string[]): { write(chunk: string): void; close(): void } {
    let pending = '', discard = false, lostBytes = 0;
    const db = availableDiagnostics();
    if (!db) return { write() {}, close() {} };
    // There is no durable stdout offset across process death. Expose the capture
    // boundary rather than claiming continuous history after a restart.
    db.report(identity, 'capture-interrupted');
    return {
        write(chunk) {
            try {
                if (lostBytes) { db.report(identity, 'storage-unavailable', lostBytes); lostBytes = 0; }
                const records: string[] = [];
                let dropped = 0, start = 0, bytes = 0;
                const flush = () => {
                    if (records.length || dropped) db.append(identity, records, 'text', { credentials: secrets, droppedBytes: dropped });
                    records.length = 0; dropped = 0; bytes = 0;
                };
                for (let i = 0; i < chunk.length; i++) {
                    if (chunk[i] !== '\n') continue;
                    const part = chunk.slice(start, i); start = i + 1;
                    const size = Buffer.byteLength(pending) + Buffer.byteLength(part);
                    if (discard || size > db.limits.recordBytes) dropped += size + 1;
                    else {
                        if (bytes + size > db.limits.scanBytes || records.length >= 4096) flush();
                        records.push(pending + part); bytes += size;
                    }
                    pending = ''; discard = false;
                }
                const rest = chunk.slice(start);
                if (discard || Buffer.byteLength(pending) + Buffer.byteLength(rest) > db.limits.recordBytes) {
                    dropped += Buffer.byteLength(pending) + Buffer.byteLength(rest);
                    pending = ''; discard = true;
                } else pending += rest;
                flush();
            } catch { lostBytes = Math.min(Number.MAX_SAFE_INTEGER, lostBytes + Buffer.byteLength(chunk) + Buffer.byteLength(pending)); pending = ''; discard = true; diagnosticsFailure(); }
        },
        close() {
            try { if (lostBytes) db.report(identity, 'storage-unavailable', lostBytes); if (pending || discard) db.append(identity, [], 'text', { credentials: secrets, droppedBytes: Buffer.byteLength(pending) || 1 }); }
            catch { diagnosticsFailure(); }
            pending = '';
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
    return { ...db.status(), nativeAdmission: { configuredRoots: roots.length, limits: NATIVE_LOG_LIMITS,
        status: roots.length ? nativeAdmissionReason(inventories) ? 'refused' : 'available' : 'unconfigured',
        reason: nativeAdmissionReason(inventories), newLaunchesOnly: true, existingWritersCapped: false,
        inventoryComplete: roots.length > 0 && inventories.every(i => i.inventoryComplete),
        observedBytes: inventories.reduce((sum, i) => sum + i.observedBytes, 0) } };
}
export function providerCredentialRoot(agent: DiagnosticAgent, resolve?: (value: string) => string): string | undefined {
    if (agent.authenticationRoot) return agent.authenticationRoot;
    if (agent.provider === 'vibe' && agent.nativeRoot) return agent.nativeRoot;
    if (agent.provider === 'antigravity' && agent.configPath && resolve) return antigravityCredentialRoot(agent.configPath, resolve);
    const relative = getManagedAgentConfigRelativePath(agent.configPath ?? '');
    const mounts: Record<string, string | undefined> = {
        codex: process.env.CODEX_CONFIG_PATH || process.env.HOST_CODEX_DIR,
        claude: process.env.CLAUDE_CONFIG_PATH || process.env.HOST_CLAUDE_DIR,
        antigravity: process.env.ANTIGRAVITY_CONFIG_PATH || process.env.HOST_ANTIGRAVITY_DIR,
        opencode: process.env.HOST_OPENCODE_DATA_DIR,
        vibe: process.env.VIBE_CONFIG_PATH || process.env.HOST_VIBE_DIR,
    };
    let root: string | undefined;
    if (relative && process.env.PROPR_MANAGED_CREDENTIALS_DIR) {
        root = path.join(process.env.PROPR_MANAGED_CREDENTIALS_DIR, relative);
        if (agent.provider === 'opencode') root = root.replace(/\/\.config\/opencode$/, '/.local/share/opencode');
    } else if (!relative && (agent.configPath?.startsWith('~/') || agent.configPath === mounts[agent.provider])) {
        root = mounts[agent.provider];
    }
    return root;
}
function argumentDiagnosticSecrets(args: readonly string[]): string[] {
    const secrets: string[] = [];
    for (let i = 0; i < args.length - 1; i++) if (args[i] === '-e' || args[i] === '--env') {
        const separator = args[i + 1].indexOf('=');
        if (separator > 0) secrets.push(...configuredDiagnosticSecrets({ [args[i + 1].slice(0, separator)]: args[i + 1].slice(separator + 1) }));
    }
    return secrets;
}
/** Establish redaction context immediately before spawning with final arguments.
 * Create-time arguments are separate because admission may replace them with a
 * container start command; credentials from both vectors must remain redacted.
 */
export function prepareProviderCapture(agent: DiagnosticAgent, args: string[] = [], extraEnv: Record<string, string | undefined> = {}, createArgs: readonly string[] = []) {
    const db = availableDiagnostics();
    if (!db) return null;
    const secrets = [...configuredDiagnosticSecrets(), ...configuredDiagnosticSecrets(agent.credentials ?? {}), ...configuredDiagnosticSecrets(extraEnv),
        ...argumentDiagnosticSecrets(createArgs), ...argumentDiagnosticSecrets(args)];
    try {
        const root = providerCredentialRoot(agent);
        if (!root) throw new Error('credential root unavailable');
        // Missing roots cannot establish native authentication context.
        const pinned = PinnedDirectory.open(root);
        try { secrets.push(...nativeCredentialValues(root, agent.provider, pinned)); }
        finally { pinned.close(); }
        rememberDiagnosticCredentials(secrets);
        const snapshot = () => {
            if (db && agent.provider === 'vibe' && agent.nativeRoot) {
                try { collectProvider(db, { provider: 'vibe', agent: agent.agent, root: agent.nativeRoot, credentials: secrets, credentialContextComplete: agent.nativeCredentialContextComplete === true, transient: true }); }
                catch { diagnosticsFailure(); }
            }
        };
        return {
            snapshot,
            stdout: captureProviderOutput({ provider: agent.provider, agent: agent.agent, source: 'stdout' }, secrets),
            stderr: captureProviderOutput({ provider: agent.provider, agent: agent.agent, source: 'stderr' }, secrets),
        };
    } catch {
        diagnosticsFailure();
        try { db?.report({ provider: agent.provider, agent: agent.agent, source: 'capture' }, 'unsafe-source'); } catch { /* failure is already surfaced */ }
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
