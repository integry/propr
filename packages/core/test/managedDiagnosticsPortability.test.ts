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
import { supportedProviderOwners, AGENT_CONTAINER_UID } from '../src/diagnostics/providerOwnership.js';

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

test('mixed ownership inside a supported root is reported per file and refuses admission', t => {
    const f = fixture();
    const fstat = fs.fstatSync;
    try {
        fs.writeFileSync(path.join(f.home, 'debug', 'owned.txt'), 'INFO owned\n');
        fs.writeFileSync(path.join(f.home, 'debug', 'foreign.txt'), 'INFO foreign\n');
        // Simulate an entrypoint chown that missed one provider file.
        t.mock.method(fs, 'fstatSync', (fd: number, options?: fs.StatOptions) => {
            const stat = fstat(fd, options as never) as fs.Stats;
            if (fs.readlinkSync(`/proc/self/fd/${fd}`).endsWith('/foreign.txt')) (stat as { uid: number }).uid = stat.uid + 1;
            return stat;
        });
        const input = { provider: 'claude' as const, agent: 'agent-a', root: f.home, credentials: [], credentialContextComplete: true };
        assert.equal(collectProvider(f.spool, input), false);
        assert.deepEqual(drain(f.spool), ['INFO owned']);
        assert.equal(sourceStatus(f.spool, 'debug/foreign.txt').reason, 'ownership-unsupported');
        assert.throws(() => collectProvider(f.spool, { ...input, measureOnly: true, rejectUnsafe: true }), /ownership unsupported/);
        assert.equal(inspectNativeLogRoot({ provider: 'claude', agent: 'agent-a', root: f.home }).reason, 'unsupported-ownership');
    } finally { f.close(); }
});
