import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { configuredNativeLogRoots, inspectNativeLogRoot, nativeAdmissionReason, NATIVE_LOG_LIMITS } from '../src/diagnostics/nativeLogPolicy.js';
import { ManagedLogSpool, digest } from '../src/diagnostics/managedLogSpool.js';
import { collectProvider } from '../src/diagnostics/providerCollector.js';

function fixture() {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'native-log-policy-'));
    const root = path.join(base, 'home');
    fs.mkdirSync(root);
    return { base, root, input: { provider: 'codex' as const, agent: 'agent-a', root },
        close() { fs.rmSync(base, { recursive: true, force: true }); } };
}
const limits = { ...NATIVE_LOG_LIMITS, minimumFreeBytes: 0 };
function write(root: string, relative: string, text: string) {
    fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
    fs.writeFileSync(path.join(root, relative), text);
}

test('activation and instance-owned declarations reject inferred homes, traversal, overlap and shared UI ownership', () => {
    const config = { instance: 'tenant-a', instanceOwned: true, roots: [{ provider: 'codex', agent: 'a', root: '/managed/a/.codex' }] };
    const env = { PROPR_MANAGED_LOGS: '1', PROPR_INSTANCE_ID: 'tenant-a', PROPR_NATIVE_LOG_ROOTS: JSON.stringify(config) };
    assert.equal(configuredNativeLogRoots(env).length, 1);
    assert.deepEqual(configuredNativeLogRoots({ ...env, PROPR_MANAGED_LOGS: '0', PROPR_FLEET_CONTROL_SECRET: 'credential' }), []);
    assert.deepEqual(configuredNativeLogRoots({ PROPR_MANAGED_LOGS: '1', HOME: '/personal' }), []);
    for (const changes of [{ instance: 'other' }, { instanceOwned: false }, { roots: Array(129).fill(config.roots[0]) },
        { roots: [config.roots[0], config.roots[0]] }, { roots: [{ ...config.roots[0], root: '/managed/a/../b' }] },
        { roots: [{ ...config.roots[0], root: '/tmp/claude-logs' }] }]) {
        assert.throws(() => configuredNativeLogRoots({ ...env, PROPR_NATIVE_LOG_ROOTS: JSON.stringify({ ...config, ...changes }) }));
    }
});

test('version-matched layouts distinguish disposable diagnostics from protected sessions, DB/WAL/SHM and secrets', () => {
    const f = fixture();
    try {
        // Versions from Dockerfile.agent. Metadata classification is not proof
        // that these providers support rotating an active file.
        const layouts = [
            ['codex', '0.160.0', 'log/codex-tui.log', 'sessions/2026/10/12/rollout-session.jsonl', 'logs_2.sqlite-wal', 'auth.json'],
            ['claude', '2.1.284', 'debug/session.txt', 'projects/-workspace/session.jsonl', null, '.credentials.json'],
            ['antigravity', '1.2.4', 'antigravity-cli/log/runtime.log', 'antigravity-cli/brain/session/.system_generated/logs/transcript.jsonl', null, 'antigravity-cli/antigravity-oauth-token'],
            ['opencode', '1.18.31', 'log/opencode.log', null, 'opencode.db-shm', 'auth.json'],
            ['vibe', '2.25.8', null, 'logs/session/session/messages.jsonl', null, 'credentials.json'],
        ] as const;
        for (const [provider, , diagnostic, session, database, auth] of layouts) {
            const root = path.join(f.root, provider); fs.mkdirSync(root);
            for (const relative of [diagnostic, session, database, auth]) if (relative) write(root, relative, 'CANARY');
            const state = inspectNativeLogRoot({ provider, agent: 'a', root });
            assert.equal(state.inventoryComplete, true, provider);
            assert.equal(state.bytes.diagnostic, diagnostic ? 6 : 0, provider);
            assert.equal(state.bytes.session, session ? 6 : 0, provider);
            assert.equal(state.bytes.database, database ? 6 : 0, provider);
            assert.equal(state.bytes['auth-config'], 6, provider);
            assert.equal(fs.readFileSync(path.join(root, auth), 'utf8'), 'CANARY');
        }
    } finally { f.close(); }
});

test('real active writer survives capacity refusal, daily boundary, collector/export and missing archive acknowledgement', () => {
    const f = fixture();
    const spool = new ManagedLogSpool(path.join(f.base, 'spool'), 'tenant-a');
    write(f.root, 'log/codex-tui.log', 'INFO first\n');
    write(f.root, 'sessions/2026/10/12/rollout-resume.jsonl', '{"session":"RESUME-CANARY"}\n');
    write(f.root, 'auth.json', '{"token":"AUTH-CANARY"}');
    write(f.root, 'config.toml', 'CONFIG-CANARY');
    const writer = fs.openSync(path.join(f.root, 'log/codex-tui.log'), 'a');
    try {
        const now = Date.parse('2026-10-11T23:59:59Z');
        collectProvider(spool, { ...f.input, credentials: [], credentialContextComplete: true }, now);
        const first = spool.exportOne();
        fs.writeSync(writer, 'INFO after midnight\n');
        collectProvider(spool, { ...f.input, credentials: [], credentialContextComplete: true }, now + 2000);
        const inventory = inspectNativeLogRoot(f.input);
        assert.match(nativeAdmissionReason([inventory], { ...limits, rootBytes: 1 })!, /capacity/);
        assert.deepEqual(spool.exportOne(), first); // no acknowledgement, no eviction
        fs.writeSync(writer, 'INFO uninterrupted\n');
        assert.match(fs.readFileSync(path.join(f.root, 'log/codex-tui.log'), 'utf8'), /uninterrupted/);
        assert.equal(fs.readFileSync(path.join(f.root, 'sessions/2026/10/12/rollout-resume.jsonl'), 'utf8'), '{"session":"RESUME-CANARY"}\n');
        assert.equal(fs.readFileSync(path.join(f.root, 'auth.json'), 'utf8'), '{"token":"AUTH-CANARY"}');
        assert.equal(fs.readFileSync(path.join(f.root, 'config.toml'), 'utf8'), 'CONFIG-CANARY');
        spool.recordNativeInventory(f.input, inventory);
        const restarted = new ManagedLogSpool(path.join(f.base, 'spool'), 'tenant-a');
        try {
            const status = restarted.status() as any;
            assert.equal(status.nativeMaintenance.sources[0].bytes.diagnostic, inventory.bytes.diagnostic);
            assert.equal(status.nativeMaintenance.growthBounded, false);
            assert.equal(status.nativeMaintenance.existingWritersCapped, false);
            assert.ok(status.spool.bytes > 0);
            assert.ok(!JSON.stringify(status).includes(f.root));
        } finally { restarted.close(); }
    } finally { fs.closeSync(writer); spool.close(); f.close(); }
});

test('sealed native exports retain metadata across later collections, retries, gaps and restart', () => {
    const f = fixture();
    const spoolRoot = path.join(f.base, 'spool');
    let spool = new ManagedLogSpool(spoolRoot, 'tenant-a');
    const input = { ...f.input, credentials: [], credentialContextComplete: true };
    const identity = { provider: input.provider, agent: input.agent, source: digest('log/codex-tui.log') };
    const now = Date.parse('2026-10-12T12:00:00Z');
    try {
        write(f.root, 'log/codex-tui.log', 'INFO first\n');
        assert.equal(collectProvider(spool, input, now), true);
        const first = spool.exportOne()!;
        assert.equal((first.manifest as any).lastSuccessfulCollection, now);
        assert.equal(digest(first.data), first.digest);
        // Advancing the clock within one day avoids relying on midnight rolls.
        write(f.root, 'log/codex-tui.log', 'INFO first\nINFO later\n');
        assert.equal(collectProvider(spool, input, now + 1000), true);
        assert.equal(collectProvider(spool, input, now + 2000), true); // caught-up retry
        const status = (spool.status() as any).sources.find((s: any) => s.source === identity.source);
        assert.equal(status.lastSuccessfulCollection, now + 1000);
        assert.deepEqual(spool.exportOne(), first);
        spool.report(identity, 'capture-interrupted', 7);
        assert.deepEqual(spool.exportOne(), first);
        const changed = (spool.status() as any).sources.find((s: any) => s.source === identity.source);
        assert.equal(changed.gaps, 1);
        assert.equal(changed.droppedBytes, 7);
        spool.close();
        spool = new ManagedLogSpool(spoolRoot, 'tenant-a');
        assert.deepEqual(spool.exportOne(), first);
        // An independently opened exporter sees the same durable snapshot.
        const second = new ManagedLogSpool(spoolRoot, 'tenant-a');
        try { assert.deepEqual(second.exportOne(), first); } finally { second.close(); }
        spool.acknowledge(first.id, first.digest);
        const later = spool.exportOne()!;
        assert.notEqual(later.id, first.id);
        assert.equal((later.manifest as any).firstSequence, 2);
        assert.equal(digest(later.data), later.digest);
        assert.equal((spool.status() as any).spool.segments, 1);
    } finally { spool.close(); f.close(); }
});

test('daily sealing freezes native metadata before the first export is requested', () => {
    const f = fixture();
    const spool = new ManagedLogSpool(path.join(f.base, 'spool'), 'tenant-a');
    const input = { ...f.input, credentials: [], credentialContextComplete: true };
    const now = Date.parse('2026-10-11T23:59:59Z');
    try {
        write(f.root, 'log/codex-tui.log', 'INFO first\n');
        collectProvider(spool, input, now);
        write(f.root, 'log/codex-tui.log', 'INFO first\nINFO next day\n');
        collectProvider(spool, input, now + 2000);
        const first = spool.exportOne()!;
        assert.equal((first.manifest as any).lastSuccessfulCollection, now);
        assert.equal((first.manifest as any).lastSequence, 1);
        collectProvider(spool, input, now + 3000);
        assert.deepEqual(spool.exportOne(), first);
    } finally { spool.close(); f.close(); }
});

test('legacy sealed native segments acquire a durable manifest snapshot on reopen', () => {
    const f = fixture();
    const spoolRoot = path.join(f.base, 'spool');
    let spool = new ManagedLogSpool(spoolRoot, 'tenant-a');
    const input = { ...f.input, credentials: [], credentialContextComplete: true };
    const now = Date.parse('2026-10-12T12:00:00Z');
    try {
        write(f.root, 'log/codex-tui.log', 'INFO legacy\n');
        collectProvider(spool, input, now);
        const first = spool.exportOne()!;
        // Reproduce the prior on-disk schema, which sealed only the payload.
        (spool as any).db.exec('ALTER TABLE segments DROP COLUMN manifest');
        spool.close();
        spool = new ManagedLogSpool(spoolRoot, 'tenant-a');
        write(f.root, 'log/codex-tui.log', 'INFO legacy\nINFO later\n');
        collectProvider(spool, input, now + 1000);
        assert.deepEqual(spool.exportOne(), first);
        spool.close();
        spool = new ManagedLogSpool(spoolRoot, 'tenant-a');
        assert.deepEqual(spool.exportOne(), first);
    } finally { spool.close(); f.close(); }
});

test('multi-GB metadata scans are bounded; unknown directories retain byte and reserve admission checks', () => {
    const f = fixture();
    try {
        write(f.root, 'log/codex-tui.log', '');
        const fd = fs.openSync(path.join(f.root, 'log/codex-tui.log'), 'r+');
        fs.ftruncateSync(fd, 3 * 1024 ** 3); fs.closeSync(fd);
        const before = process.memoryUsage().rss;
        const inventory = inspectNativeLogRoot(f.input);
        assert.equal(inventory.bytes.diagnostic, 3 * 1024 ** 3);
        assert.ok(inventory.allocatedBytes < inventory.observedBytes);
        assert.ok(process.memoryUsage().rss - before < 32 * 1024 ** 2);
        assert.match(nativeAdmissionReason([inventory], limits)!, /capacity/);
        assert.match(nativeAdmissionReason([{ ...inventory, availableBytes: 0 }])!, /reserve/);
        fs.mkdirSync(path.join(f.root, 'unknown-state'));
        assert.equal(inspectNativeLogRoot(f.input).inventoryComplete, false);
        assert.equal(inspectNativeLogRoot(f.input, { ...limits, entries: 1 }).reason, 'scan-limit');
        assert.match(nativeAdmissionReason([inspectNativeLogRoot(f.input)], limits)!, /capacity/);
    } finally { f.close(); }
});

test('symlink, hardlink, FIFO and ancestor replacement cannot escape pinned roots or modify another tenant', () => {
    const f = fixture();
    try {
        const foreign = path.join(f.base, 'foreign'); fs.mkdirSync(foreign);
        write(foreign, 'canary', 'FOREIGN-CANARY');
        fs.symlinkSync(path.join(foreign, 'canary'), path.join(f.root, 'auth.json'));
        fs.linkSync(path.join(foreign, 'canary'), path.join(f.root, 'config.toml'));
        execFileSync('mkfifo', [path.join(f.root, 'pipe')]);
        assert.equal(inspectNativeLogRoot(f.input).inventoryComplete, false);
        write(f.root, 'log/codex-tui.log', 'ORIGINAL');
        const statfs = fs.statfsSync;
        // Swap the ancestor after opening the root descriptor. Enumeration and
        // all subsequent opens must still address the original directory.
        fs.statfsSync = ((...args: Parameters<typeof statfs>) => {
            fs.renameSync(f.root, f.root + '-old'); fs.symlinkSync(foreign, f.root);
            return statfs(...args);
        }) as typeof statfs;
        try { assert.equal(inspectNativeLogRoot(f.input).bytes.diagnostic, 8); }
        finally { fs.statfsSync = statfs; }
        assert.equal(inspectNativeLogRoot(f.input).inventoryComplete, false);
        assert.equal(fs.readFileSync(path.join(foreign, 'canary'), 'utf8'), 'FOREIGN-CANARY');
    } finally { f.close(); }
});

test('local-only disposal requires explicit policy, exact sealed digest and loss acceptance; it never acknowledges remote backup', () => {
    const f = fixture();
    const spool = new ManagedLogSpool(path.join(f.base, 'spool'), 'tenant-a');
    const saved = { enabled: process.env.PROPR_MANAGED_LOGS, disposal: process.env.PROPR_DIAGNOSTIC_DISPOSAL };
    const identity = { provider: 'codex', agent: 'a', source: 'stderr' };
    try {
        spool.append(identity, ['INFO diagnostic'], 'text', { credentials: [] });
        const item = spool.exportOne()!;
        delete process.env.PROPR_DIAGNOSTIC_DISPOSAL;
        assert.throws(() => spool.disposeLocal(item.id, item.digest));
        assert.deepEqual(spool.exportOne(), item);
        process.env.PROPR_MANAGED_LOGS = '1'; process.env.PROPR_DIAGNOSTIC_DISPOSAL = 'local-only';
        assert.throws(() => spool.disposeLocal(item.id, 'wrong'));
        spool.disposeLocal(item.id, item.digest);
        spool.disposeLocal(item.id, item.digest); // idempotent loss accounting
        assert.equal(spool.exportOne(), null);
        assert.equal((spool.status() as any).sources[0].reason, 'local-only-disposal');
        assert.equal((spool.status() as any).sources[0].gaps, 1);
        assert.throws(() => spool.acknowledge(item.id, item.digest));
    } finally {
        if (saved.enabled === undefined) delete process.env.PROPR_MANAGED_LOGS; else process.env.PROPR_MANAGED_LOGS = saved.enabled;
        if (saved.disposal === undefined) delete process.env.PROPR_DIAGNOSTIC_DISPOSAL; else process.env.PROPR_DIAGNOSTIC_DISPOSAL = saved.disposal;
        spool.close(); f.close();
    }
});

test('launch preflight refuses a configured oversized root and ENOSPC reporting failures before any provider starts', () => {
    const f = fixture();
    try {
        write(f.root, 'log/codex-tui.log', '');
        const fd = fs.openSync(path.join(f.root, 'log/codex-tui.log'), 'r+');
        fs.ftruncateSync(fd, NATIVE_LOG_LIMITS.rootBytes); fs.closeSync(fd);
        const runtime = new URL('../src/diagnostics/managedLogRuntime.ts', import.meta.url).href;
        const module = new URL('../src/diagnostics/managedLogSpool.ts', import.meta.url).href;
        const env = { ...process.env, PROPR_MANAGED_LOGS: '1', PROPR_INSTANCE_ID: 'tenant-a', PROPR_DIAGNOSTIC_ROOT: path.join(f.base, 'spool'),
            PROPR_NATIVE_LOG_ROOTS: JSON.stringify({ instance: 'tenant-a', instanceOwned: true, roots: [f.input] }) };
        // Pass module URLs as data so filesystem paths never become JavaScript source.
        const code = "const {assertNativeLogAdmission}=await import(process.argv[1]); assertNativeLogAdmission({provider:'codex',agent:'agent-a'}); process.stdout.write('STARTED');";
        const run = spawnSync(process.execPath, ['--import', 'tsx', '-e', code, runtime], { env, encoding: 'utf8' });
        assert.equal(run.status, 1); assert.match(run.stderr, /capacity|reserve/); assert.equal(run.stdout, '');
        const full = spawnSync(process.execPath, ['--import', 'tsx', '-e',
            "const {ManagedLogSpool}=await import(process.argv[2]); ManagedLogSpool.prototype.recordNativeInventory=()=>{throw Object.assign(new Error('ENOSPC'),{code:'ENOSPC'})}; " + code,
            runtime, module], { env, encoding: 'utf8' });
        assert.equal(full.status, 1); assert.match(full.stderr, /ENOSPC/); assert.equal(full.stdout, '');
        assert.equal(fs.statSync(path.join(f.root, 'log/codex-tui.log')).size, NATIVE_LOG_LIMITS.rootBytes);
    } finally { f.close(); }
});


test('entry and deadline bounds and unknown directories admit small homes while retaining persisted capacity', () => {
    const f = fixture();
    let spool = new ManagedLogSpool(path.join(f.base, 'spool'), 'tenant-a');
    try {
        write(f.root, 'log/codex-tui.log', 'INFO small');
        const complete = inspectNativeLogRoot(f.input, { ...limits, scanMs: 10000 });
        spool.recordNativeInventory(f.input, complete);
        write(f.root, 'todos/retained', 'SESSION-CANARY');
        for (const bounds of [{}, { entries: 1 }, { scanMs: -1 }]) {
            const inventory = inspectNativeLogRoot(f.input, { ...limits, ...bounds });
            assert.equal(inventory.inventoryComplete, false);
            const measured = spool.recordNativeInventory(f.input, inventory);
            assert.equal(nativeAdmissionReason([measured], limits), null);
            assert.equal(measured.capacityBytesLowerBound, complete.observedBytes);
            assert.match(nativeAdmissionReason([measured], { ...limits, rootBytes: 1 })!, /capacity/);
            assert.match(nativeAdmissionReason([measured, measured], { ...limits, totalBytes: 1 })!, /capacity/);
        }
        spool.close();
        spool = new ManagedLogSpool(path.join(f.base, 'spool'), 'tenant-a');
        const partial = spool.recordNativeInventory(f.input, inspectNativeLogRoot(f.input, { ...limits, entries: 0 }));
        assert.equal(partial.capacityBytesLowerBound, complete.observedBytes);
        assert.match(nativeAdmissionReason([partial], { ...limits, rootBytes: 1 })!, /capacity/);
        fs.rmSync(path.join(f.root, 'todos'), { recursive: true });
        fs.writeFileSync(path.join(f.root, 'log/codex-tui.log'), '');
        const refreshed = spool.recordNativeInventory(f.input, inspectNativeLogRoot(f.input, { ...limits, scanMs: 10000 }));
        assert.equal(refreshed.capacityBytesLowerBound, 0);
        assert.equal(nativeAdmissionReason([refreshed], { ...limits, rootBytes: 1 }), null);
    } finally { spool.close(); f.close(); }
});

test('scan limits and unknown directories cannot mask an unsafe entry', () => {
    const f = fixture();
    try {
        write(f.root, 'log/codex-tui.log', 'safe');
        const original = inspectNativeLogRoot(f.input);
        for (const reason of ['unsafe-entry', 'unsafe-root'] as const) {
            assert.match(nativeAdmissionReason([{ ...original, inventoryComplete: false, reason }], limits)!, /incomplete/);
        }
        fs.symlinkSync('/unowned', path.join(f.root, 'log/escape'));
        write(f.root, 'unknown/canary', 'RESUME-CANARY');
        const inventory = inspectNativeLogRoot(f.input);
        assert.equal(inventory.reason, 'unsafe-entry');
        assert.match(nativeAdmissionReason([inventory], limits)!, /incomplete/);
    } finally { f.close(); }
});


test('declared capacity excludes session, database, auth and unknown bytes, including legacy high-water totals', () => {
    const f = fixture();
    const spool = new ManagedLogSpool(path.join(f.base, 'spool'), 'tenant-a');
    try {
        write(f.root, 'log/codex-tui.log', 'INFO');
        for (const relative of ['sessions/2026/10/12/rollout-resume.jsonl', 'state_2.sqlite', 'auth.json', 'unknown-file']) {
            write(f.root, relative, ''); fs.truncateSync(path.join(f.root, relative), 300 * 1024 ** 2);
        }
        const inventory = inspectNativeLogRoot(f.input, { ...limits, scanMs: 10000 });
        assert.ok(inventory.observedBytes > limits.totalBytes);
        const legacy = { ...inventory, capacityBytesLowerBound: inventory.observedBytes };
        assert.equal(nativeAdmissionReason([legacy], limits), null);
        // Seed the legacy persisted JSON to verify an incomplete new scan
        // cannot import its all-class high-water mark into diagnostic capacity.
        const internal = (spool as any).db;
        spool.recordNativeInventory(f.input, inventory);
        internal.prepare('UPDATE sources SET native_details=?').run(JSON.stringify(legacy));
        const partial = spool.recordNativeInventory(f.input, inspectNativeLogRoot(f.input, { ...limits, entries: 0 }));
        assert.equal(partial.capacityBytesLowerBound, 4);
        assert.equal(nativeAdmissionReason([partial], limits), null);
        assert.match(nativeAdmissionReason([partial], { ...limits, rootBytes: 4 })!, /capacity/);
        assert.match(nativeAdmissionReason([partial, partial], { ...limits, totalBytes: 8 })!, /capacity/);
        assert.match(nativeAdmissionReason([{ ...partial, availableBytes: 0 }], { ...limits, minimumFreeBytes: 1 })!, /reserve/);
    } finally { spool.close(); f.close(); }
});
