import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { ManagedLogSpool, DiagnosticPolicyError, MANAGED_LOG_POLICY, digest, type ManagedLogPolicy } from '../src/diagnostics/managedLogSpool.js';
import { collectProvider } from '../src/diagnostics/providerCollector.js';
import { inspectNativeLogRoot, nativeAdmissionReason, UNSUPPORTED_OWNERSHIP_REASON } from '../src/diagnostics/nativeLogPolicy.js';
import { supportedProviderOwners, AGENT_CONTAINER_UID, containerUidConfigurationError, INVALID_CONTAINER_UID_REASON, isProviderOwnershipError, providerOwnershipStatus } from '../src/diagnostics/providerOwnership.js';
import { nativeCredentialValues } from '../src/diagnostics/credentialRedaction.js';
import Database from 'better-sqlite3';

const repository = path.resolve(import.meta.dirname, '../../..');
function fixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-diagnostics-portability-'));
    const spool = new ManagedLogSpool(path.join(root, 'spool'), 'tenant-a');
    const home = path.join(root, 'agent-a', '.claude');
    fs.mkdirSync(path.join(home, 'debug'), { recursive: true });
    return { root, spool, home, close() { spool.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}
function drain(spool: ManagedLogSpool): string[] {
    const messages: string[] = [];
    for (let item; (item = spool.exportOne());) {
        messages.push(...gunzipSync(item.data).toString().trim().split('\n').map(line => JSON.parse(line).message.trim()));
        spool.acknowledge(item.id, item.digest);
    }
    return messages;
}
function sourceStatus(spool: ManagedLogSpool, relative: string) {
    return (spool.status() as { sources: Array<{ source: string; gaps: number; reason: string | null }> }).sources.find(s => s.source === digest(relative))!;
}
const pause = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
const collect = (f: ReturnType<typeof fixture>) => collectProvider(f.spool, { provider: 'claude', agent: 'agent-a', root: f.home, credentials: [], credentialContextComplete: true });
function run(script: string, env: Record<string, string | undefined>) {
    const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script],
        { cwd: repository, encoding: 'utf8', env: { ...process.env, PROPR_DEMO_MODE: 'true', ...env } });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
}

test('unavailable birth time: ctime substitution appends once without replay or false source-replaced gaps', t => {
    const f = fixture();
    const fstat = fs.fstatSync;
    // Node substitutes ctime when the filesystem/statx path has no birth time.
    t.mock.method(fs, 'fstatSync', (fd: number, options?: fs.StatOptions) => {
        const stat = fstat(fd, options as never) as fs.Stats | fs.BigIntStats;
        if ('birthtimeNs' in stat) { stat.birthtimeNs = stat.ctimeNs; stat.birthtimeMs = stat.ctimeMs; }
        else stat.birthtimeMs = stat.ctimeMs;
        return stat;
    });
    try {
        const file = path.join(f.home, 'debug', 'session.txt');
        const relative = 'debug/session.txt';
        fs.writeFileSync(file, 'INFO one\n');
        collect(f);
        for (const line of ['INFO two\n', 'INFO three\n']) {
            pause(); fs.appendFileSync(file, line);
            collect(f); collect(f);
        }
        assert.deepEqual(drain(f.spool), ['INFO one', 'INFO two', 'INFO three']);
        assert.equal(sourceStatus(f.spool, relative).gaps, 0);
        // A legacy `dev:ino:birthtimeMs` cursor (with substituted ctime) migrates without replay.
        const stat = fs.statSync(file);
        const content = fs.readFileSync(file);
        const identity = { provider: 'claude', agent: 'agent-a', source: digest(relative) };
        assert.ok(f.spool.append(identity, [], 'text', { credentials: [], cursor: { before: f.spool.cursor(identity),
            after: { inode: `${stat.dev}:${stat.ino}:${stat.ctimeMs}`, offset: content.length, discard: false, anchor: digest(content.subarray(content.length - 128 < 0 ? 0 : content.length - 128)) } } }));
        pause(); fs.appendFileSync(file, 'INFO four\n');
        collect(f);
        assert.deepEqual(drain(f.spool), ['INFO four']);
        assert.equal(sourceStatus(f.spool, relative).gaps, 0);

        // Inode replacement still resets safely.
        fs.writeFileSync(`${file}.next`, 'INFO replaced\n');
        fs.renameSync(`${file}.next`, file);
        collect(f);
        assert.deepEqual(drain(f.spool), ['INFO replaced']);
        assert.deepEqual([sourceStatus(f.spool, relative).gaps, sourceStatus(f.spool, relative).reason], [1, 'source-replaced']);
        // Anchor mismatch on the same inode (rewrite in place) also resets.
        const fd = fs.openSync(file, 'r+');
        fs.writeSync(fd, 'INFO rewritten\nINFO after\n', 0);
        fs.closeSync(fd);
        collect(f);
        assert.deepEqual(drain(f.spool), ['INFO rewritten', 'INFO after']);
        assert.deepEqual([sourceStatus(f.spool, relative).gaps, sourceStatus(f.spool, relative).reason], [2, 'source-replaced']);
    } finally { f.close(); }
});

test('diagnostics-disabled logger and diagnostics entry imports never load the SQLite binding', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-diagnostics-lazy-'));
    try {
        const script = `
            import assert from 'node:assert/strict';
            import { registerHooks, createRequire } from 'node:module';
            const blocked = process.env.BLOCK_SQLITE === '1';
            if (blocked) registerHooks({ resolve(specifier, context, next) {
                if (specifier === 'better-sqlite3') throw new Error('sqlite binding unavailable');
                return next(specifier, context);
            } });
            const loaded = () => Object.keys(createRequire(import.meta.url).cache).some(key => key.includes('better-sqlite3'));
            const { default: logger } = await import('./packages/core/src/utils/logger.ts');
            const diagnostics = await import('@propr/core/diagnostics');
            await import('./packages/core/src/agents/agentRunAdmission.ts');
            logger.info('diagnostics disabled');
            assert.equal(diagnostics.managedDiagnostics(), null);
            assert.equal(loaded(), false);
            process.env.PROPR_MANAGED_LOGS = '1';
            if (blocked) assert.throws(() => diagnostics.managedDiagnostics(), /sqlite binding unavailable/);
            else { diagnostics.managedDiagnostics().close(); assert.equal(loaded(), true); }
            process.exit(0);
        `;
        for (const block of ['1', '0']) run(script, { BLOCK_SQLITE: block, PROPR_MANAGED_LOGS: undefined, PROPR_INSTANCE_ID: 'tenant-a', PROPR_DIAGNOSTIC_ROOT: path.join(root, `spool-${block}`) });
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('one diagnostics singleton, credential cache and policy error identity regardless of import path', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-diagnostics-singleton-'));
    try {
        run(`
            import assert from 'node:assert/strict';
            const runtime = await import('./packages/core/src/diagnostics/managedLogRuntime.ts');
            const duplicate = await import('./packages/core/src/diagnostics/managedLogRuntime.ts?duplicate=1');
            const entry = await import('@propr/core/diagnostics');
            assert.notEqual(runtime, duplicate);
            const spool = runtime.managedDiagnostics();
            assert.ok(spool);
            assert.equal(duplicate.managedDiagnostics(), spool);
            assert.equal(entry.managedDiagnostics(), spool);
            const redaction = await import('./packages/core/src/diagnostics/redaction.ts');
            const otherRedaction = await import('./packages/core/src/diagnostics/redaction.ts?duplicate=1');
            redaction.rememberDiagnosticCredentials(['credential-canary-value']);
            assert.ok(otherRedaction.diagnosticCredentials().includes('credential-canary-value'));
            const spoolModule = await import('./packages/core/src/diagnostics/managedLogSpool.ts?duplicate=1');
            assert.ok(new spoolModule.DiagnosticPolicyError('x') instanceof entry.DiagnosticPolicyError);
            assert.ok(!(new Error('x') instanceof entry.DiagnosticPolicyError));
            spool.close();
            process.exit(0);
        `, { PROPR_MANAGED_LOGS: '1', PROPR_INSTANCE_ID: 'tenant-a', PROPR_DIAGNOSTIC_ROOT: path.join(root, 'spool') });
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('policy-limit upgrade migrates explicitly, preserving instance, unacknowledged exports and cursors', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-diagnostics-policy-'));
    const dir = path.join(root, 'spool');
    const identity = { provider: 'codex', agent: 'agent-a', source: 'stdout' };
    const v1: ManagedLogPolicy = { ...MANAGED_LOG_POLICY };
    const v2: ManagedLogPolicy = { ...v1, version: 2, segmentBytes: 128 * 1024, sourceBytes: 16 * 1024 * 1024 };
    const migrations = [{ from: 1, to: 2, previous: v1 }];
    try {
        const old = new ManagedLogSpool(dir, 'tenant-a');
        old.append(identity, [JSON.stringify({ n: 1 })], 'jsonl', { credentials: [], cursor: { before: {}, after: { inode: '1:2', offset: 10 } } });
        const pending = old.exportOne()!;
        old.append(identity, [JSON.stringify({ n: 2 })], 'jsonl', { credentials: [], cursor: { before: { inode: '1:2', offset: 10 }, after: { inode: '1:2', offset: 20 } } });
        old.close();

        // Tuning without a declared migration refuses explicitly; nothing changes.
        assert.throws(() => new ManagedLogSpool(dir, 'tenant-a', v2), (e: unknown) => e instanceof DiagnosticPolicyError && /explicit versioned migration/.test((e as Error).message));
        assert.throws(() => new ManagedLogSpool(dir, 'tenant-a', { sourceBytes: 1024 }), /explicit versioned migration/);
        assert.throws(() => new ManagedLogSpool(dir, 'tenant-a', v2, { migrations: [{ from: 1, to: 2, previous: { ...v1, scanMs: 1 } }] }), /explicit versioned migration/);

        const upgraded = new ManagedLogSpool(dir, 'tenant-a', v2, { migrations });
        assert.deepEqual(upgraded.cursor(identity), { inode: '1:2', offset: 20 });
        const first = upgraded.exportOne()!;
        assert.deepEqual([first.id, first.digest], [pending.id, pending.digest]);
        assert.equal((first.manifest as { policyVersion: number }).policyVersion, 2);
        assert.equal((upgraded.status() as { instance: string; policyVersion: number }).policyVersion, 2);
        assert.equal((upgraded.status() as { instance: string }).instance, 'tenant-a');
        // Open segments are sealed: new records never extend a segment bound by v1.
        upgraded.append(identity, [JSON.stringify({ n: 3 })], 'jsonl', { credentials: [] });
        const segments: number[][] = [];
        for (let item; (item = upgraded.exportOne());) {
            segments.push(gunzipSync(item.data).toString().trim().split('\n').map(line => JSON.parse(line).n));
            upgraded.acknowledge(item.id, item.digest);
        }
        assert.deepEqual(segments, [[1], [2], [3]]);
        upgraded.close();

        // Idempotent restart at v2; downgrade and instance rebinding still refuse.
        new ManagedLogSpool(dir, 'tenant-a', v2).close();
        assert.throws(() => new ManagedLogSpool(dir, 'tenant-a'), /downgrade refused/);
        assert.throws(() => new ManagedLogSpool(dir, 'tenant-b', v2, { migrations }), /instance mismatch/);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('hosted and native UID mappings: supported owners collect, unsupported mappings fail closed explicitly', t => {
    assert.deepEqual(supportedProviderOwners({}, 0), [0, AGENT_CONTAINER_UID]);
    assert.deepEqual(supportedProviderOwners({}, 1000), [1000]);
    assert.deepEqual(supportedProviderOwners({}, 1001), [1001]);
    assert.deepEqual(supportedProviderOwners({ PROPR_AGENT_CONTAINER_UID: '2000' }, 0), [0, 2000]);
    assert.deepEqual(supportedProviderOwners({ PROPR_AGENT_CONTAINER_UID: '2000' }, 1001), [1001]);
    assert.deepEqual(supportedProviderOwners({ PROPR_AGENT_CONTAINER_UID: '-1' }, 0), [0]);
    assert.deepEqual(supportedProviderOwners({}, null), []);

    const uid = process.getuid!();
    const previousContainer = process.env.PROPR_AGENT_CONTAINER_UID;
    const scenarios = [
        { name: 'native aligned', processUid: uid, container: undefined, supported: true },
        { name: 'hosted root worker, container-owned home', processUid: 0, container: String(uid), supported: true },
        { name: 'native misaligned worker', processUid: uid + 1, container: undefined, supported: false },
        { name: 'hosted root worker, foreign container UID', processUid: 0, container: String(uid + 1), supported: uid === 0 },
    ];
    for (const scenario of scenarios) {
        const f = fixture();
        const getuid = t.mock.method(process, 'getuid', () => scenario.processUid);
        if (scenario.container === undefined) delete process.env.PROPR_AGENT_CONTAINER_UID;
        else process.env.PROPR_AGENT_CONTAINER_UID = scenario.container;
        try {
            fs.writeFileSync(path.join(f.home, 'debug', 'session.txt'), 'INFO owned record\n');
            const input = { provider: 'claude' as const, agent: 'agent-a', root: f.home, credentials: [], credentialContextComplete: true };
            collectProvider(f.spool, input);
            const summary = (f.spool.status() as { sources: Array<{ source: string; reason: string | null }> }).sources.find(s => s.source === 'native-state')!;
            const inventory = inspectNativeLogRoot({ provider: 'claude', agent: 'agent-a', root: f.home });
            if (scenario.supported) {
                assert.deepEqual(drain(f.spool), ['INFO owned record'], scenario.name);
                assert.notEqual(summary.reason, 'ownership-unsupported', scenario.name);
                assert.equal(inventory.reason, 'protected-unbounded', scenario.name);
                assert.equal(nativeAdmissionReason([inventory]), null, scenario.name);
            } else {
                assert.deepEqual(drain(f.spool), [], scenario.name);
                assert.equal(summary.reason, 'ownership-unsupported', scenario.name);
                assert.throws(() => collectProvider(f.spool, { ...input, measureOnly: true, rejectUnsafe: true }), /ownership unsupported/, scenario.name);
                assert.equal(inventory.reason, 'unsupported-ownership', scenario.name);
                assert.equal(nativeAdmissionReason([inventory]), UNSUPPORTED_OWNERSHIP_REASON, scenario.name);
            }
        } finally {
            getuid.mock.restore();
            if (previousContainer === undefined) delete process.env.PROPR_AGENT_CONTAINER_UID;
            else process.env.PROPR_AGENT_CONTAINER_UID = previousContainer;
            f.close();
        }
    }
});

// A foreign-owned entry inside a supported root may be planted rather than a
// missed chown; it must not suggest aligning the container UID to its owner.
function assertUnsafeEntryFraming(f: ReturnType<typeof fixture>, input: Parameters<typeof collectProvider>[1], source?: string): void {
    assert.equal(collectProvider(f.spool, input), false);
    assert.deepEqual(drain(f.spool), ['INFO owned']);
    if (source) assert.equal(sourceStatus(f.spool, source).reason, 'unsafe-source');
    assert.notEqual((f.spool.status() as { sources: Array<{ source: string; reason: string | null }> }).sources.find(s => s.source === 'native-state')!.reason, 'ownership-unsupported');
    assert.throws(() => collectProvider(f.spool, { ...input, measureOnly: true, rejectUnsafe: true }),
        (e: unknown) => !isProviderOwnershipError(e) && /unsafe native inventory/.test((e as Error).message));
    const inventory = inspectNativeLogRoot({ provider: 'claude', agent: 'agent-a', root: f.home });
    assert.equal(inventory.reason, 'unsafe-entry');
    assert.equal(inventory.inventoryComplete, false);
    const reason = nativeAdmissionReason([inventory])!;
    assert.match(reason, /operator action required/);
    assert.doesNotMatch(reason, /align worker|container UID/);
}

test('a foreign-owned file inside a supported root is an unsafe entry, not a UID-alignment refusal', t => {
    const f = fixture();
    const fstat = fs.fstatSync;
    try {
        fs.writeFileSync(path.join(f.home, 'debug', 'owned.txt'), 'INFO owned\n');
        fs.writeFileSync(path.join(f.home, 'debug', 'foreign.txt'), 'INFO foreign\n');
        t.mock.method(fs, 'fstatSync', (fd: number, options?: fs.StatOptions) => {
            const stat = fstat(fd, options as never) as fs.Stats;
            if (fs.readlinkSync(`/proc/self/fd/${fd}`).endsWith('/foreign.txt')) (stat as { uid: number }).uid = stat.uid + 1;
            return stat;
        });
        assertUnsafeEntryFraming(f, { provider: 'claude', agent: 'agent-a', root: f.home, credentials: [], credentialContextComplete: true }, 'debug/foreign.txt');
    } finally { f.close(); }
});

test('a foreign-owned directory inside a supported root is an unsafe entry, not a UID-alignment refusal', t => {
    const f = fixture();
    const fstat = fs.fstatSync, lstat = fs.lstatSync;
    try {
        fs.writeFileSync(path.join(f.home, 'debug', 'owned.txt'), 'INFO owned\n');
        fs.mkdirSync(path.join(f.home, 'projects', 'planted'), { recursive: true });
        fs.writeFileSync(path.join(f.home, 'projects', 'planted', 'session.jsonl'), '{"n":1}\n');
        const foreign = (stat: fs.Stats) => { (stat as { uid: number }).uid = stat.uid + 1; return stat; };
        t.mock.method(fs, 'fstatSync', (fd: number, options?: fs.StatOptions) => {
            const stat = fstat(fd, options as never) as fs.Stats;
            return fs.readlinkSync(`/proc/self/fd/${fd}`).endsWith('/projects') ? foreign(stat) : stat;
        });
        t.mock.method(fs, 'lstatSync', (target: fs.PathLike, options?: fs.StatOptions) => {
            const stat = lstat(target, options as never) as fs.Stats;
            return stat.isDirectory() && fs.realpathSync(target).endsWith('/projects') ? foreign(stat) : stat;
        });
        assertUnsafeEntryFraming(f, { provider: 'claude', agent: 'agent-a', root: f.home, credentials: [], credentialContextComplete: true });
    } finally { f.close(); }
});

test('foreign-owned credential stores inside a root refuse collection and capture as unsafe, without a UID remedy', t => {
    const f = fixture();
    const fstat = fs.fstatSync;
    try {
        fs.writeFileSync(path.join(f.home, 'debug', 'owned.txt'), 'INFO owned\n');
        fs.writeFileSync(path.join(f.home, '.credentials.json'), '{"token":"credential-canary-value"}');
        // A credential file that missed the entrypoint chown.
        t.mock.method(fs, 'fstatSync', (fd: number, options?: fs.StatOptions) => {
            const stat = fstat(fd, options as never) as fs.Stats;
            if (fs.readlinkSync(`/proc/self/fd/${fd}`).endsWith('/.credentials.json')) (stat as { uid: number }).uid = stat.uid + 1;
            return stat;
        });
        assert.throws(() => nativeCredentialValues(f.home, 'claude'), (e: unknown) => !isProviderOwnershipError(e) && /credential redaction unavailable/.test((e as Error).message));
        assert.equal(collectProvider(f.spool, { provider: 'claude', agent: 'agent-a', root: f.home, credentials: [] }), false);
        assert.deepEqual(drain(f.spool), []);
        assert.equal((f.spool.status() as { sources: Array<{ source: string; reason: string | null }> }).sources.find(s => s.source === 'native-state')!.reason, 'unsafe-source');
    } finally { f.close(); }

    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-diagnostics-capture-owner-'));
    try {
        const home = path.join(root, '.claude');
        fs.mkdirSync(home);
        fs.writeFileSync(path.join(home, '.credentials.json'), '{"token":"credential-canary-value"}');
        const output = run(`
            import assert from 'node:assert/strict';
            import fs from 'node:fs';
            const fstat = fs.fstatSync;
            fs.fstatSync = (fd, options) => {
                const stat = fstat(fd, options);
                if (fs.readlinkSync('/proc/self/fd/' + fd).endsWith('/.credentials.json')) stat.uid += 1;
                return stat;
            };
            const runtime = await import('./packages/core/src/diagnostics/managedLogRuntime.ts');
            assert.equal(runtime.prepareProviderCapture({ provider: 'claude', agent: 'agent-a', authenticationRoot: ${JSON.stringify(home)} }), null);
            const spool = runtime.managedDiagnostics();
            console.log(spool.status().sources.find(s => s.source === 'capture').reason);
            spool.close();
            process.exit(0);
        `, { PROPR_MANAGED_LOGS: '1', PROPR_INSTANCE_ID: 'tenant-a', PROPR_DIAGNOSTIC_ROOT: path.join(root, 'spool') });
        assert.equal(output.trim(), 'unsafe-source');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('misdeclared policy migration chains refuse before any step is applied', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-diagnostics-chain-'));
    const dir = path.join(root, 'spool');
    const v1: ManagedLogPolicy = { ...MANAGED_LOG_POLICY };
    const v2: ManagedLogPolicy = { ...v1, version: 2, segmentBytes: 128 * 1024 };
    const v3: ManagedLogPolicy = { ...v2, version: 3, sourceBytes: 16 * 1024 * 1024 };
    try {
        new ManagedLogSpool(dir, 'tenant-a').close();
        const invalid = [
            // Copy-pasted `previous` shared by two steps.
            [{ from: 1, to: 2, previous: v1 }, { from: 2, to: 3, previous: v1 }],
            // Duplicate `from` values.
            [{ from: 1, to: 2, previous: v1 }, { from: 1, to: 3, previous: v1 }, { from: 2, to: 3, previous: v2 }],
            // Non-advancing step.
            [{ from: 1, to: 1, previous: v1 }],
        ];
        for (const migrations of invalid) {
            assert.throws(() => new ManagedLogSpool(dir, 'tenant-a', v3, { migrations }),
                (e: unknown) => e instanceof DiagnosticPolicyError && /invalid diagnostic policy migrations/.test((e as Error).message));
        }
        // The refused attempts left the v1 binding intact; a valid chain still upgrades.
        new ManagedLogSpool(dir, 'tenant-a').close();
        new ManagedLogSpool(dir, 'tenant-a', v3, { migrations: [{ from: 1, to: 2, previous: v1 }, { from: 2, to: 3, previous: v2 }] }).close();
        new ManagedLogSpool(dir, 'tenant-a', v3).close();
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a newer stored policy with keys this release does not know refuses as a downgrade', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-diagnostics-future-'));
    const dir = path.join(root, 'spool');
    try {
        new ManagedLogSpool(dir, 'tenant-a').close();
        const db = new Database(path.join(dir, 'spool.sqlite'));
        db.prepare('UPDATE settings SET value=? WHERE key=?').run(JSON.stringify({ instance: 'tenant-a',
            policy: { ...MANAGED_LOG_POLICY, version: MANAGED_LOG_POLICY.version + 1, futureLimit: 1 } }), 'binding');
        db.close();
        assert.throws(() => new ManagedLogSpool(dir, 'tenant-a'), /diagnostic policy downgrade refused/);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a malformed container UID is surfaced as a configuration error, not an alignment refusal', () => {
    for (const value of ['-1', 'node', '4294967295']) {
        const env = { PROPR_AGENT_CONTAINER_UID: value };
        assert.deepEqual(supportedProviderOwners(env, 0), [0]);
        assert.equal(containerUidConfigurationError(env, 0), INVALID_CONTAINER_UID_REASON);
        assert.deepEqual(providerOwnershipStatus(env, 0), { processUid: 0, supportedOwners: [0], agentContainerUid: null,
            configurationError: INVALID_CONTAINER_UID_REASON, mapping: 'hosted-root-worker' });
        // Non-root workers never consult the container UID.
        assert.equal(containerUidConfigurationError(env, 1000), null);
    }
    assert.equal(containerUidConfigurationError({ PROPR_AGENT_CONTAINER_UID: '2000' }, 0), null);
    assert.equal((providerOwnershipStatus({ PROPR_AGENT_CONTAINER_UID: '2000' }, 0) as { agentContainerUid: number }).agentContainerUid, 2000);

    const previous = process.env.PROPR_AGENT_CONTAINER_UID;
    const getuid = process.getuid;
    process.env.PROPR_AGENT_CONTAINER_UID = '-1';
    process.getuid = () => 0;
    try {
        assert.equal(nativeAdmissionReason([{ reason: 'unsupported-ownership' } as never]), INVALID_CONTAINER_UID_REASON);
    } finally {
        process.getuid = getuid;
        if (previous === undefined) delete process.env.PROPR_AGENT_CONTAINER_UID;
        else process.env.PROPR_AGENT_CONTAINER_UID = previous;
    }
    assert.equal(nativeAdmissionReason([{ reason: 'unsupported-ownership' } as never]), UNSUPPORTED_OWNERSHIP_REASON);
});

test('pre-spawn capture validates the credential root owner before reading any credential content', () => {
    const uid = process.getuid!();
    const scenarios = [
        { name: 'hosted root worker, container-owned home', processUid: 0, container: String(uid), supported: true },
        { name: 'native aligned worker', processUid: uid, container: undefined, supported: true },
        { name: 'native misaligned worker', processUid: uid + 1, container: undefined, supported: false },
        { name: 'hosted root worker, foreign container UID', processUid: 0, container: String(uid + 1), supported: uid === 0 },
    ];
    for (const scenario of scenarios) {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-diagnostics-capture-root-'));
        try {
            const home = path.join(root, '.claude');
            fs.mkdirSync(home);
            fs.writeFileSync(path.join(home, '.credentials.json'), '{"token":"credential-canary-value"}');
            const output = run(`
                import assert from 'node:assert/strict';
                import fs from 'node:fs';
                import { gunzipSync } from 'node:zlib';
                const runtime = await import('./packages/core/src/diagnostics/managedLogRuntime.ts');
                // The worker's own spool is opened before the mapping under test applies.
                const spool = runtime.managedDiagnostics();
                process.getuid = () => ${scenario.processUid};
                const opened = [], open = fs.openSync;
                fs.openSync = (target, ...rest) => { opened.push(String(target)); return open(target, ...rest); };
                const capture = runtime.prepareProviderCapture({ provider: 'claude', agent: 'agent-a', authenticationRoot: ${JSON.stringify(home)} });
                fs.openSync = open;
                const credentialReads = opened.filter(target => target.endsWith('/.credentials.json')).length;
                if (capture) { capture.stdout.write('INFO token credential-canary-value\\n'); capture.stdout.close(); capture.stderr.close(); }
                const messages = [];
                for (let item; (item = spool.exportOne());) {
                    messages.push(...gunzipSync(item.data).toString().trim().split('\\n').map(line => JSON.parse(line).message));
                    spool.acknowledge(item.id, item.digest);
                }
                const reason = spool.status().sources.find(s => s.source === 'capture')?.reason ?? null;
                console.log(JSON.stringify({ captured: capture !== null, credentialReads, reason, messages }));
                spool.close();
                process.exit(0);
            `, { PROPR_MANAGED_LOGS: '1', PROPR_INSTANCE_ID: 'tenant-a', PROPR_DIAGNOSTIC_ROOT: path.join(root, 'spool'), PROPR_AGENT_CONTAINER_UID: scenario.container });
            const result = JSON.parse(output.trim()) as { captured: boolean; credentialReads: number; reason: string | null; messages: string[] };
            if (scenario.supported) {
                assert.equal(result.captured, true, scenario.name);
                assert.equal(result.credentialReads, 1, scenario.name);
                assert.equal(result.reason, null, scenario.name);
                assert.equal(result.messages.length, 1, scenario.name);
                assert.match(result.messages[0], /^INFO token /, scenario.name);
                assert.doesNotMatch(result.messages[0], /credential-canary-value/, scenario.name);
            } else {
                assert.equal(result.captured, false, scenario.name);
                assert.equal(result.credentialReads, 0, scenario.name);
                assert.equal(result.reason, 'ownership-unsupported', scenario.name);
                assert.deepEqual(result.messages, [], scenario.name);
            }
        } finally { fs.rmSync(root, { recursive: true, force: true }); }
    }
});
