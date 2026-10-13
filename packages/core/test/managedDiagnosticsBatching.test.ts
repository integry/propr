import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { spawn, spawnSync } from 'node:child_process';
import { ManagedLogSpool } from '../src/diagnostics/managedLogSpool.js';
import { collectProvider } from '../src/diagnostics/providerCollector.js';
import { redactAttribution } from '../src/diagnostics/redaction.js';

const repository = path.resolve(import.meta.dirname, '../../..');
const prelude = `
    import assert from 'node:assert/strict';
    import { gunzipSync } from 'node:zlib';
    import * as runtime from './packages/core/src/diagnostics/managedLogRuntime.ts';
    const db = runtime.managedDiagnostics();
    const appends = { n: 0 };
    const append = db.append.bind(db);
    db.append = (...args) => { appends.n++; return append(...args); };
    const exported = () => {
        const records = [];
        for (let item; (item = db.exportOne());) {
            records.push(...gunzipSync(item.data).toString().trim().split('\\n').map(line => JSON.parse(line)));
            db.acknowledge(item.id, item.digest);
        }
        return records;
    };
    const sources = () => db.status().sources;
    const tick = ms => new Promise(resolve => setTimeout(resolve, ms));
    /** Waits for an observable outcome instead of guessing retry timing. */
    const until = async (done, ms = 15_000) => { for (const end = Date.now() + ms; !done() && Date.now() < end;) await tick(25); };
    const source = name => sources().find(s => s.source === name);
    const identity = source => ({ provider: 'claude', agent: 'batch', source });`;
function environment(root: string) {
    return { ...process.env, PROPR_MANAGED_LOGS: '1', PROPR_INSTANCE_ID: 'tenant-a', PROPR_DIAGNOSTIC_ROOT: path.join(root, 'spool') };
}
/** Runs `script` against the managed runtime and returns its JSON stdout. */
function run(root: string, script: string) {
    const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', prelude + script],
        { cwd: repository, encoding: 'utf8', timeout: 30000, env: environment(root) });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout.trim().split('\n').at(-1)!);
}
function withRoot(fn: (root: string) => void | Promise<void>) {
    return async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'diagnostic-batch-'));
        try { await fn(root); } finally { fs.rmSync(root, { recursive: true, force: true }); }
    };
}

test('provider output is batched on a short timer instead of one transaction per chunk', withRoot(root => {
    const result = run(root, `
        const capture = runtime.captureProviderOutput(identity('stdout'), ['opaque-run-canary-1'], { task: 'task-42', attempt: 'gen-7' });
        for (let n = 0; n < 2000; n++) { const line = 'INFO chunk ' + n + ' opaque-run-canary-1\\n'; capture.write(line.slice(0, 7)); capture.write(line.slice(7)); }
        const duringWrites = appends.n;
        await tick(runtime.PROVIDER_OUTPUT_FLUSH_MS * 4);
        const afterTimer = appends.n;
        capture.write('INFO partial final');
        capture.close();
        const records = exported();
        console.log(JSON.stringify({ duringWrites, afterTimer, afterClose: appends.n, records, sources: sources().filter(s => s.agent === 'batch') }));
    `);
    assert.equal(result.duringWrites, 0, 'no transaction while chunks arrive');
    assert.equal(result.afterTimer, 1, 'one batched transaction for 4,000 chunks');
    assert.equal(result.afterClose, 2, 'close flushes the partial final line');
    assert.equal(result.records.length, 2001);
    assert.equal(result.records[0].message, 'INFO chunk 0 [REDACTED]');
    assert.equal(result.records.at(-1).message, 'INFO partial final');
    for (const record of result.records) assert.deepEqual(record.attribution, { task: 'task-42', attempt: 'gen-7' });
    assert.ok(!JSON.stringify(result.records).includes('opaque-run-canary-1'));
    // Attribution never enters the source identity.
    assert.deepEqual(result.sources.map((s: { source: string }) => s.source), ['stdout']);
    assert.ok(!JSON.stringify(result.sources).includes('task-42'));
    assert.equal(result.sources[0].gaps, 1, 'only the capture-interrupted boundary');
}));

test('a full buffer flushes synchronously at the spool batch bound', withRoot(root => {
    const result = run(root, `
        const capture = runtime.captureProviderOutput(identity('stdout'), []);
        for (let n = 0; n < 4096 * 2 + 10; n++) capture.write('INFO r' + n + '\\n');
        const whenFull = appends.n;
        capture.close();
        console.log(JSON.stringify({ whenFull, total: appends.n, records: exported().length }));
    `);
    assert.equal(result.whenFull, 2, 'the 4,096 record bound forces deterministic flushes');
    assert.equal(result.total, 3);
    assert.equal(result.records, 4096 * 2 + 10);
}));

test('transient storage errors retry a timer batch; persistent errors become exact durable gaps', withRoot(root => {
    const result = run(root, `
        const busy = () => Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });
        let failures = 3;
        db.append = (...args) => { appends.n++; if (failures-- > 0) throw busy(); return append(...args); };
        const contended = runtime.captureProviderOutput(identity('contended'), []);
        contended.write('INFO survives contention\\n');
        await until(() => source('contended').lastSuccessfulCollection);
        contended.close();
        failures = Infinity;
        db.append = (...args) => { appends.n++; if (failures-- > 0) throw Object.assign(new Error('disk full'), { code: 'SQLITE_FULL' }); return append(...args); };
        const failing = runtime.captureProviderOutput(identity('enospc'), []);
        failing.write('INFO lost-a\\nINFO lost-b\\n');
        await until(() => source('enospc').reason === 'storage-unavailable');
        failures = 0;
        failing.write('INFO after-repair\\n');
        failing.close();
        // Contention past its bound is accounted exactly, too.
        runtime.providerOutputRetry.contentionMs = 100;
        failures = Infinity;
        db.append = (...args) => { appends.n++; if (failures-- > 0) throw busy(); return append(...args); };
        const starved = runtime.captureProviderOutput(identity('starved'), []);
        starved.write('INFO starved\\n');
        await until(() => source('starved').reason === 'storage-unavailable');
        failures = 0;
        starved.close();
        const status = Object.fromEntries(sources().filter(s => s.agent === 'batch').map(s => [s.source, { gaps: s.gaps, dropped: s.droppedBytes, reason: s.reason }]));
        console.log(JSON.stringify({ records: exported().map(r => r.message), status }));
    `);
    assert.deepEqual(result.records, ['INFO survives contention', 'INFO after-repair']);
    assert.deepEqual(result.status.contended, { gaps: 1, dropped: 0, reason: 'capture-interrupted' }, 'a retried batch is not a gap');
    // Two records of 11 bytes plus their newlines, reported before later records.
    assert.deepEqual(result.status.enospc, { gaps: 2, dropped: 24, reason: 'storage-unavailable' });
    assert.deepEqual(result.status.starved, { gaps: 2, dropped: 13, reason: 'storage-unavailable' });
}));

test('a failed close keeps exact loss accounting until the spool records it', withRoot(root => {
    const result = run(root, `
        const report = db.report.bind(db);
        let storage = false;
        db.append = (...args) => { appends.n++; if (!storage) throw Object.assign(new Error('disk full'), { code: 'SQLITE_FULL' }); return append(...args); };
        db.report = (...args) => { if (!storage && args[1] === 'storage-unavailable') throw Object.assign(new Error('disk full'), { code: 'SQLITE_FULL' }); return report(...args); };
        const capture = runtime.captureProviderOutput(identity('closed'), []);
        capture.write('INFO first\\nINFO tail');
        capture.close();
        // Close retries, then owes the exact bytes; the gap report itself keeps
        // failing, so nothing may be forgotten while storage is unavailable.
        await tick(runtime.PROVIDER_OUTPUT_FLUSH_MS * 30);
        const whileFailing = sources().find(s => s.source === 'closed');
        storage = true;
        await until(() => source('closed').gaps === 2);
        const after = sources().find(s => s.source === 'closed');
        console.log(JSON.stringify({ whileFailing: [whileFailing.gaps, whileFailing.droppedBytes], after: [after.gaps, after.droppedBytes, after.reason], records: exported().length }));
    `);
    assert.deepEqual(result.whileFailing, [1, 0], 'only the capture boundary while storage is down');
    // "INFO first\n" (11) + "INFO tail" with its record terminator (10).
    assert.deepEqual(result.after, [2, 21, 'storage-unavailable']);
    assert.equal(result.records, 0);
}));

test('a contended close is retried and drained on exit; owed loss is reported on exit', withRoot(root => {
    const result = run(root, `
        let busy = 2;
        db.append = (...args) => { appends.n++; if (busy-- > 0) throw Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' }); return append(...args); };
        const capture = runtime.captureProviderOutput(identity('retried'), []);
        capture.write('INFO kept\\n');
        capture.close();
        const afterClose = exported().length;
        await until(() => source('retried').lastSuccessfulCollection);
        console.log(JSON.stringify({ afterClose, records: exported().map(r => r.message), gaps: sources().find(s => s.source === 'retried').gaps }));
    `);
    assert.deepEqual(result, { afterClose: 0, records: ['INFO kept'], gaps: 1 });
    // Storage that only recovers at exit: the exit drain records the exact loss.
    const exited = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', prelude + `
        const report = db.report.bind(db);
        let storage = false;
        db.append = () => { throw Object.assign(new Error('disk full'), { code: 'SQLITE_FULL' }); };
        db.report = (...args) => { if (!storage && args[1] === 'storage-unavailable') throw new Error('disk full'); return report(...args); };
        const capture = runtime.captureProviderOutput(identity('exit-owed'), []);
        capture.write('INFO lost\\n');
        capture.close();
        await tick(runtime.PROVIDER_OUTPUT_FLUSH_MS * 20);
        storage = true;
        process.exit(0);
    `], { cwd: repository, encoding: 'utf8', timeout: 30000, env: environment(root) });
    assert.equal(exited.status, 0, exited.stderr);
    const spool = new ManagedLogSpool(path.join(root, 'spool'), 'tenant-a');
    try {
        const owed = (spool.status() as { sources: Array<{ source: string; gaps: number; droppedBytes: number; reason: string }> }).sources.find(s => s.source === 'exit-owed')!;
        assert.deepEqual([owed.gaps, owed.droppedBytes, owed.reason], [2, 10, 'storage-unavailable']);
    } finally { spool.close(); }
}));

test('a contended capture start never throws and records its boundary before any record', withRoot(root => {
    const result = run(root, `
        const report = db.report.bind(db);
        let busy = 3;
        db.report = (...args) => { if (busy-- > 0) throw Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' }); return report(...args); };
        const capture = runtime.captureProviderOutput(identity('started'), []);
        const atStart = source('started') ?? null;
        capture.write('INFO after boundary\\n');
        await until(() => source('started')?.lastSuccessfulCollection);
        capture.close();
        const { gaps, reason } = source('started');
        console.log(JSON.stringify({ atStart, gaps, reason, records: exported().map(r => r.message) }));
    `);
    assert.equal(result.atStart, null);
    assert.deepEqual([result.gaps, result.reason], [1, 'capture-interrupted']);
    assert.deepEqual(result.records, ['INFO after boundary']);
}));

test('buffered records flush on process exit without close', withRoot(root => {
    const spawned = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
        import * as runtime from './packages/core/src/diagnostics/managedLogRuntime.ts';
        const capture = runtime.captureProviderOutput({ provider: 'claude', agent: 'exit', source: 'stderr' }, [], { task: 'task-exit' });
        capture.write('ERROR before exit\\nINFO unterminated');
        process.exit(3);
    `], { cwd: repository, encoding: 'utf8', timeout: 30000, env: environment(root) });
    assert.equal(spawned.status, 3, spawned.stderr);
    const spool = new ManagedLogSpool(path.join(root, 'spool'), 'tenant-a');
    try {
        const item = spool.exportOne()!;
        const records = gunzipSync(item.data).toString().trim().split('\n').map(line => JSON.parse(line));
        // A partial final chunk without close stays an unterminated, uncommitted line.
        assert.deepEqual(records, [{ message: 'ERROR before exit', attribution: { task: 'task-exit' } }]);
    } finally { spool.close(); }
}));

test('concurrent chatty providers across worker processes avoid self-inflicted storage gaps', withRoot(async root => {
    const worker = (n: number) => new Promise<{ status: number | null; stdout: string; stderr: string }>(resolve => {
        // Like a real worker, the spool is first opened by the captures themselves.
        const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
            import { ManagedLogSpool } from './packages/core/src/diagnostics/managedLogSpool.ts';
            import * as runtime from './packages/core/src/diagnostics/managedLogRuntime.ts';
            const appends = { n: 0 }, append = ManagedLogSpool.prototype.append;
            ManagedLogSpool.prototype.append = function (...args) { appends.n++; return append.apply(this, args); };
            const tick = ms => new Promise(resolve => setTimeout(resolve, ms));
            const captures = ['stdout', 'stderr'].map(source => runtime.captureProviderOutput({ provider: 'claude', agent: 'worker-${n}', source }, [], { task: 'task-${n}' }));
            for (let i = 0; i < 3000; i++) { captures[i % 2].write('INFO worker ${n} line ' + i + '\\n'); if (i % 100 === 0) await tick(1); }
            for (const capture of captures) capture.close();
            console.log(JSON.stringify({ appends: appends.n }));
        `], { cwd: repository, env: environment(root) });
        let stdout = '', stderr = '';
        child.stdout.on('data', chunk => { stdout += chunk; });
        child.stderr.on('data', chunk => { stderr += chunk; });
        child.on('close', status => resolve({ status, stdout, stderr }));
    });
    // Create the spool once so workers do not race on schema creation.
    new ManagedLogSpool(path.join(root, 'spool'), 'tenant-a').close();
    const results = await Promise.all([0, 1, 2, 3].map(worker));
    for (const result of results) {
        assert.equal(result.status, 0, result.stderr);
        assert.ok(JSON.parse(result.stdout.trim()).appends < 3000 / 10, 'batches, not per-chunk transactions');
    }
    const spool = new ManagedLogSpool(path.join(root, 'spool'), 'tenant-a');
    try {
        const sources = (spool.status() as { sources: Array<{ agent: string; reason: string | null; gaps: number }> }).sources.filter(s => s.agent.startsWith('worker-'));
        assert.equal(sources.length, 8);
        for (const source of sources) assert.deepEqual([source.reason, source.gaps], ['capture-interrupted', 1]);
        // Contention is absorbed, not converted into loss: every line is durable.
        let records = 0;
        for (let item; (item = spool.exportOne());) {
            records += gunzipSync(item.data).toString().trim().split('\n').length;
            spool.acknowledge(item.id, item.digest);
        }
        assert.equal(records, 4 * 3000);
    } finally { spool.close(); }
}));

test('capture start neither blocks on nor fails under another worker\'s write lock', withRoot(root => {
    new ManagedLogSpool(path.join(root, 'spool'), 'tenant-a').close();
    const spawned = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
        import { createRequire } from 'node:module';
        import * as runtime from './packages/core/src/diagnostics/managedLogRuntime.ts';
        const holder = new (createRequire(import.meta.url)('better-sqlite3'))(process.env.PROPR_DIAGNOSTIC_ROOT + '/spool.sqlite');
        holder.exec('BEGIN IMMEDIATE');
        const started = Date.now();
        const capture = runtime.captureProviderOutput({ provider: 'claude', agent: 'batch', source: 'locked' }, [], { task: 'task-locked' });
        capture.write('INFO while locked\\n');
        const startMs = Date.now() - started;
        await new Promise(resolve => setTimeout(resolve, 1_500));
        holder.exec('COMMIT'); holder.close();
        capture.close();
        console.log(JSON.stringify({ startMs }));
    `], { cwd: repository, encoding: 'utf8', timeout: 30000, env: environment(root) });
    assert.equal(spawned.status, 0, spawned.stderr);
    assert.ok(JSON.parse(spawned.stdout).startMs < 1_500, 'bounded by one lock attempt');
    const spool = new ManagedLogSpool(path.join(root, 'spool'), 'tenant-a');
    try {
        const source = (spool.status() as { sources: Array<{ source: string; gaps: number; reason: string }> }).sources.find(s => s.source === 'locked')!;
        assert.deepEqual([source.gaps, source.reason], [1, 'capture-interrupted']);
        const item = spool.exportOne()!;
        assert.deepEqual(gunzipSync(item.data).toString().trim().split('\n').map(line => JSON.parse(line)),
            [{ message: 'INFO while locked', attribution: { task: 'task-locked' } }]);
    } finally { spool.close(); }
}));

test('task attribution is bounded, allowlisted and redacted', () => {
    assert.deepEqual(redactAttribution({ task: 'integry/propr#3022', attempt: 'g-1' }, []), { task: 'integry/propr#3022', attempt: 'g-1' });
    assert.deepEqual(redactAttribution({ task: 'task opaque-run-canary-1' }, []), { task: '[INVALID]' });
    assert.deepEqual(redactAttribution({ task: 'x'.repeat(129) }, []), { task: '[INVALID]' });
    assert.deepEqual(redactAttribution({ task: 'opaque-run-canary-1' }, ['opaque-run-canary-1']), { task: '[REDACTED]' });
    assert.deepEqual(redactAttribution({ task: 'ghp_abcdefghijklmnop' }, []), { task: '[REDACTED]' });
    assert.equal(redactAttribution({ task: '', attempt: undefined }, []), undefined);
    assert.deepEqual(redactAttribution({ task: 't', extra: 'ignored' } as never, []), { task: 't' });
});

test('captured output cannot spoof attribution and identities stay shared across tasks', withRoot(root => {
    const result = run(root, `
        for (const task of ['task-a', 'task-b', 'task-c']) {
            const capture = runtime.captureProviderOutput(identity('stdout'), [], { task });
            capture.write('{"attribution":{"task":"forged"},"msg":"' + task + '"}\\n');
            capture.close();
        }
        console.log(JSON.stringify({ records: exported(), sources: sources().filter(s => s.agent === 'batch').length }));
    `);
    assert.deepEqual(result.records.map((r: { msg: string; attribution: { task: string } }) => [r.msg, r.attribution.task]),
        [['task-a', 'task-a'], ['task-b', 'task-b'], ['task-c', 'task-c']]);
    assert.equal(result.sources, 1, 'one source for every task');
}));

test('repeated daemon limitation reports record one gap until the limitation changes', withRoot(root => {
    const spool = new ManagedLogSpool(path.join(root, 'spool'), 'tenant-a');
    try {
        const shared = { provider: 'claude', agent: 'unknown', source: 'shared-tmp-claude-logs' };
        for (let pass = 0; pass < 10; pass++) spool.report(shared, 'ownership-unverified', 0, { standing: true });
        const gaps = () => (spool.status() as { sources: Array<{ source: string; gaps: number; agent: string }> }).sources;
        assert.equal(gaps().find(s => s.source === 'shared-tmp-claude-logs')!.gaps, 1);
        spool.report(shared, 'scan-limit', 0, { standing: true });
        spool.report(shared, 'scan-limit', 0, { standing: true });
        assert.equal(gaps().find(s => s.source === 'shared-tmp-claude-logs')!.gaps, 2, 'a changed limitation is recorded');
        // Daemon measure-only passes over a missing root.
        for (let pass = 0; pass < 10; pass++) collectProvider(spool, { provider: 'codex', agent: 'missing', root: path.join(root, 'absent'), credentials: [], measureOnly: true });
        assert.equal(gaps().find(s => s.agent === 'missing')!.gaps, 1);
    } finally { spool.close(); }
}));
