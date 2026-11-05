import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { ManagedLogSpool } from '../src/diagnostics/managedLogSpool.js';
import { collectProvider, nativeFileClass } from '../src/diagnostics/providerCollector.js';
import { PinnedDirectory } from '../src/diagnostics/privateDirectory.js';

test('native classification separates diagnostics, resume records and SQLite sidecars', () => {
    for (const [provider, filename, kind] of [
        ['codex', 'log/codex-tui.log', 'diagnostic'],
        ['codex', 'sessions/2026/10/12/rollout-resume.jsonl', 'session'],
        ['codex', 'archived_sessions/2026/10/12/rollout-resume.jsonl', 'session'],
        ['codex', 'logs_2.sqlite-wal', 'database'],
        ['claude', 'debug/run.txt', 'diagnostic'],
        ['claude', 'projects/-workspace/resume.jsonl', 'session'],
        ['claude', 'history.jsonl', 'session'],
        ['opencode', 'log/opencode.log', 'diagnostic'],
        ['opencode', 'opencode.db-shm', 'database'],
        ['antigravity', 'antigravity-cli/log/run.log', 'diagnostic'],
        ['antigravity', 'antigravity-cli/brain/resume/.system_generated/logs/transcript.jsonl', 'session'],
        ['vibe', 'logs/session/resume/messages.jsonl', 'session'],
        ['claude', '.credentials.json', 'auth-config'],
        ['codex', 'config.toml', 'auth-config'],
        ['claude', '../other/debug/run.txt', 'unknown'],
    ] as const) assert.equal(nativeFileClass(provider, filename), kind);
});

test('descriptor-pinned measurement keeps original writers and canaries; partial scans retain capacity across restart', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-log-inventory-'));
    let db = new ManagedLogSpool(path.join(root, 'spool'), 'tenant-a');
    const home = path.join(root, 'home');
    fs.mkdirSync(path.join(home, 'debug'), { recursive: true });
    fs.mkdirSync(path.join(home, 'projects/-workspace'), { recursive: true });
    const diagnostic = path.join(home, 'debug/run.txt');
    const resume = path.join(home, 'projects/-workspace/resume.jsonl');
    fs.writeFileSync(diagnostic, 'INFO first\n');
    fs.writeFileSync(resume, '{"type":"resume","message":"unpublished work"}\n');
    // A malformed credential file proves measurement does not require reading auth.
    fs.writeFileSync(path.join(home, '.credentials.json'), 'SECRET-AUTH-CANARY');
    fs.writeFileSync(path.join(home, 'settings.json'), 'CONFIG-CANARY');
    const fd = fs.openSync(diagnostic, 'a');
    const pin = PinnedDirectory.open(home);
    try {
        fs.renameSync(home, home + '-owned');
        fs.symlinkSync(root, home);
        const input = { provider: 'claude' as const, agent: 'a', root: home, credentials: [], measureOnly: true, pinnedRoot: pin };
        assert.equal(collectProvider(db, input), true);
        fs.writeSync(fd, 'INFO after midnight\n');
        assert.equal(collectProvider(db, input, Date.parse('2026-10-13T00:00:01Z')), true);
        const status = db.status() as any;
        const inventory = status.nativeSources.sources[0].inventory;
        assert.equal(inventory.diagnosticBytes, fs.fstatSync(fd).size);
        assert.equal(inventory.sessionBytes, fs.statSync(home + '-owned/projects/-workspace/resume.jsonl').size);
        assert.equal(inventory.excludedEntries, 2);
        assert.equal(status.nativeSources.maintenance, 'unsupported-writer-lifecycle');
        assert.equal(status.nativeSources.growthBounded, false);
        assert.equal(status.nativeSources.admission.existingWritersCapped, false);
        assert.equal(db.exportOne(), null);
        const bytes = status.nativeSources.sources[0].capacityBytesLowerBound;
        db.limits.scanFiles = 1;
        assert.equal(collectProvider(db, input), false);
        assert.equal((db.status() as any).nativeSources.sources[0].capacityBytesLowerBound, bytes);
        db.close();
        db = new ManagedLogSpool(path.join(root, 'spool'), 'tenant-a');
        assert.equal((db.status() as any).nativeSources.sources[0].capacityBytesLowerBound, bytes);
        assert.equal(fs.readFileSync(home + '-owned/.credentials.json', 'utf8'), 'SECRET-AUTH-CANARY');
        assert.equal(fs.readFileSync(home + '-owned/settings.json', 'utf8'), 'CONFIG-CANARY');
        fs.writeSync(fd, 'INFO still running\n');
        assert.ok(fs.readFileSync(home + '-owned/debug/run.txt', 'utf8').endsWith('INFO still running\n'));
    } finally { pin.close(); fs.closeSync(fd); db.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('filesystem admission refuses free-byte/inode exhaustion without touching native files', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-log-space-'));
    const db = new ManagedLogSpool(path.join(root, 'spool'), 'tenant-a');
    try {
        const statfs = mock.method(fs, 'statfsSync', () => ({ bavail: 1n, bsize: 4096n, files: 1000n, ffree: 100n }));
        assert.throws(() => db.assertFilesystemCapacity(), /filesystem capacity/);
        statfs.mock.mockImplementation(() => ({ bavail: 100000n, bsize: 4096n, files: 1000n, ffree: 0n }));
        assert.throws(() => db.assertFilesystemCapacity(), /filesystem capacity/);
        statfs.mock.mockImplementation(() => ({ bavail: 100000n, bsize: 4096n, files: 0n, ffree: 0n }));
        assert.doesNotThrow(() => db.assertFilesystemCapacity());
        statfs.mock.mockImplementation(() => ({ bavail: 1n, bsize: 4096n, files: 0n, ffree: 0n }));
        assert.throws(() => db.assertFilesystemCapacity(), /filesystem capacity/);
        statfs.mock.mockImplementation(() => { throw Object.assign(new Error('full'), { code: 'ENOSPC' }); });
        assert.throws(() => db.assertFilesystemCapacity(), /full/);
        statfs.mock.restore();
    } finally { mock.restoreAll(); db.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('launch admission accepts unaccounted inodes on spool and native mounts, including after acquisition', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-log-dynamic-inodes-'));
    try {
        const result = spawnSync(process.execPath, ['--import', 'tsx', '-e', `
            import assert from 'node:assert/strict';
            import fs from 'node:fs';
            import { mock } from 'node:test';
            import { prepareAdmittedAgent } from './packages/core/src/agents/agentRunAdmission.ts';
            import { managedDiagnostics } from './packages/core/src/diagnostics/managedLogRuntime.ts';
            const base = ${JSON.stringify(root)};
            delete process.env.PROPR_AGENT_RUN_LIMIT;
            process.env.PROPR_MANAGED_CREDENTIALS_DIR = base + '/managed';
            const home = base + '/managed/agent-a/.claude';
            fs.mkdirSync(home + '/debug', {recursive:true});
            fs.writeFileSync(home + '/debug/run.txt', 'INFO running');
            const args = ['run','-v',home + ':/home/node/.claude:rw','image'];
            const accounted = {bavail:100000n,bsize:4096n,files:1000n,ffree:100n};
            const unaccounted = {...accounted,files:0n,ffree:0n};
            const exhausted = {...accounted,ffree:0n};
            let spoolStat = unaccounted, nativeStat = accounted;
            let spoolChecks = 0, nativeChecks = 0;
            mock.method(fs, 'statfsSync', filename => {
                if (fs.readlinkSync(filename) === home) { nativeChecks++; return nativeStat; }
                spoolChecks++; return spoolStat;
            });
            assert.equal(await prepareAdmittedAgent(args), null);
            spoolStat = accounted; nativeStat = unaccounted;
            assert.equal(await prepareAdmittedAgent(args), null);
            assert.ok(spoolChecks > 0 && nativeChecks > 0);
            nativeStat = exhausted;
            await assert.rejects(prepareAdmittedAgent(args), /native capacity unavailable/);
            nativeStat = unaccounted; spoolStat = exhausted;
            await assert.rejects(prepareAdmittedAgent(args), /filesystem capacity/);
            spoolStat = accounted; nativeStat = accounted;
            let created = 0, removed = 0, released = 0;
            const admission = await prepareAdmittedAgent(args, {
                config:{instance:'tenant-a',limit:1},
                client:{zadd:async()=>0,zrem:async()=>0,zremrangebyscore:async()=>0,zcard:async()=>0,hgetall:async()=>({}),
                    eval:async(_sql,_keys,_holders,_config,op)=> {
                        if (op === 'expired') return [];
                        if (op === 'release') released++;
                        if (op === 'acquire') {
                            spoolStat = unaccounted; nativeStat = unaccounted;
                            spoolChecks = 0; nativeChecks = 0;
                        }
                        return 1;
                    }},
                docker:{daemon:async()=> 'test-daemon',create:async()=>{
                    assert.ok(spoolChecks > 0 && nativeChecks > 0);
                    created++; return 'new';
                },remove:async()=>{removed++;}},
            });
            assert.equal(created, 1);
            await admission.finish();
            assert.equal(removed, 1); assert.equal(released, 1);
            assert.equal(fs.readFileSync(home + '/debug/run.txt', 'utf8'), 'INFO running');
            managedDiagnostics().close();
        `], { encoding: 'utf8', timeout: 30000, env: { ...process.env, PROPR_MANAGED_LOGS: '1', PROPR_INSTANCE_ID: 'tenant-a',
            PROPR_DIAGNOSTIC_ROOT: path.join(root, 'spool'), PROPR_NATIVE_LOG_ROOTS: '', PROPR_FLEET_CONTROL_SECRET: '', PROPR_AGENT_RUN_LIMIT: '' } });
        assert.equal(result.status, 0, result.stderr);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('self-managed launch gate refreshes multi-GB originals, refuses unsafe roots and never caps active descriptors', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-log-launch-'));
    try {
        // Node 22 detects the eval's module syntax. Avoid --input-type, which
        // imported dependencies can inherit when starting file-based workers.
        const result = spawnSync(process.execPath, ['--import', 'tsx', '-e', `
            import assert from 'node:assert/strict';
            import fs from 'node:fs';
            import { mock } from 'node:test';
            import { assertNativeLogAdmission } from './packages/core/src/diagnostics/nativeLogAdmission.ts';
            import { managedDiagnostics } from './packages/core/src/diagnostics/managedLogRuntime.ts';
            import { prepareAdmittedAgent } from './packages/core/src/agents/agentRunAdmission.ts';
            mock.method(fs, 'statfsSync', () => ({bavail:100000n,bsize:4096n,files:1000n,ffree:100n}));
            const base = ${JSON.stringify(root)};
            delete process.env.PROPR_AGENT_RUN_LIMIT;
            process.env.PROPR_MANAGED_CREDENTIALS_DIR = base + '/managed';
            const home = base + '/managed/agent-a/.claude';
            fs.mkdirSync(home + '/debug', {recursive:true});
            fs.writeFileSync(home + '/.credentials.json', 'AUTH-CANARY');
            const original = home + '/debug/run.txt';
            const fd = fs.openSync(original, 'a+');
            fs.writeSync(fd, 'INFO running\\n');
            const args = ['run','-v',home + ':/home/node/.claude:rw','image'];
            assert.equal(await prepareAdmittedAgent(args), null);
            const db = managedDiagnostics();
            assert.equal(db.status().nativeSources.sources[0].inventory.diagnosticFiles,1);
            const outside = base + '/other-tenant.txt';
            fs.writeFileSync(outside, 'OTHER-TENANT-CANARY');
            fs.symlinkSync(outside, home + '/debug/escape.txt');
            assert.throws(() => assertNativeLogAdmission(args), /capacity unavailable/);
            fs.unlinkSync(home + '/debug/escape.txt');
            fs.linkSync(outside, home + '/debug/hardlink.txt');
            assert.throws(() => assertNativeLogAdmission(args), /capacity unavailable/);
            fs.unlinkSync(home + '/debug/hardlink.txt');
            // Unconfigured provider-looking roots are never opened or scanned.
            assertNativeLogAdmission(['run','-v',base + '/personal:/home/node/.claude:rw','image']);
            assert.ok(db.status().nativeSources.sources.some(s=>s.source==='unmapped-native-state'));
            assert.equal(fs.readFileSync(outside,'utf8'),'OTHER-TENANT-CANARY');
            let created = 0, removed = 0;
            // The writer grows while entitlement admission is waiting. Capacity
            // is rechecked after acquisition, before Docker create/start.
            await assert.rejects(prepareAdmittedAgent(args, {
                config:{instance:'tenant-a',limit:1},
                client:{zadd:async()=>0,zrem:async()=>0,
                    eval:async(_sql,_keys,_holders,_config,op)=> {
                        if (op === 'expired') return [];
                        if (op === 'acquire') fs.ftruncateSync(fd, 3 * 1024 ** 3);
                        return 1;
                    }},
                docker:{daemon:async()=> 'test-daemon',create:async()=>{created++;return 'new';},remove:async()=>{removed++;}},
            }), /protected native state capacity/);
            assert.equal(created,0); assert.equal(removed,0);
            assert.throws(() => assertNativeLogAdmission(args), /protected native state capacity/);
            await assert.rejects(prepareAdmittedAgent(args), /protected native state capacity/);
            assert.equal(fs.fstatSync(fd).size, 3 * 1024 ** 3);
            fs.writeSync(fd, 'INFO uninterrupted\\n');
            assert.equal(fs.readFileSync(home + '/.credentials.json', 'utf8'), 'AUTH-CANARY');
            assert.equal(db.exportOne(), null);
            process.env.PROPR_MANAGED_LOGS = '0'; assertNativeLogAdmission(args);
            fs.closeSync(fd); db.close();
        `], { encoding: 'utf8', timeout: 30000, env: { ...process.env, PROPR_MANAGED_LOGS: '1', PROPR_INSTANCE_ID: 'tenant-a',
            PROPR_DIAGNOSTIC_ROOT: path.join(root, 'spool'), PROPR_FLEET_CONTROL_SECRET: '', PROPR_AGENT_RUN_LIMIT: '' } });
        assert.equal(result.status, 0, result.stderr);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('local-only disposal requires explicit admin policy and reports loss without offsite acknowledgement', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-local-only-'));
    const db = new ManagedLogSpool(path.join(root, 'spool'), 'tenant-a');
    const before = { enabled: process.env.PROPR_MANAGED_LOGS, local: process.env.PROPR_DIAGNOSTIC_LOCAL_ONLY };
    try {
        db.append({ provider: 'claude', agent: 'a', source: 'stdout' }, ['INFO diagnostic'], 'text', { credentials: [] });
        const item = db.exportOne()!;
        process.env.PROPR_MANAGED_LOGS = '1';
        delete process.env.PROPR_DIAGNOSTIC_LOCAL_ONLY;
        assert.throws(() => db.discardLocal(item.id, item.digest), /disabled/);
        assert.deepEqual(db.exportOne(), item);
        process.env.PROPR_DIAGNOSTIC_LOCAL_ONLY = '1';
        assert.throws(() => db.discardLocal(item.id, 'wrong'), /unknown/);
        db.discardLocal(item.id, item.digest);
        assert.equal(db.exportOne(), null);
        const status = db.status() as any;
        assert.equal(status.sources[0].reason, 'local-only-discard');
        assert.equal(status.sources[0].gaps, 1);
        assert.ok(status.sources[0].droppedBytes > 0);
        assert.equal(status.historyComplete, false);
        assert.throws(() => db.acknowledge(item.id, item.digest), /unknown/);
    } finally {
        for (const [key, value] of [['PROPR_MANAGED_LOGS', before.enabled], ['PROPR_DIAGNOSTIC_LOCAL_ONLY', before.local]] as const) {
            if (value === undefined) delete process.env[key]; else process.env[key] = value;
        }
        db.close(); fs.rmSync(root, { recursive: true, force: true });
    }
});

test('bounded homes and saturated copy cursors preserve task, goal and declared-root admission', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-log-partial-launch-'));
    try {
        const result = spawnSync(process.execPath, ['--import', 'tsx', '-e', `
            import assert from 'node:assert/strict';
            import fs from 'node:fs';
            import { mock } from 'node:test';
            import { assertNativeLogAdmission } from './packages/core/src/diagnostics/nativeLogAdmission.ts';
            import { managedDiagnostics, assertNativeLogAdmission as assertDeclared, nativeDiagnosticStatus } from './packages/core/src/diagnostics/managedLogRuntime.ts';
            import { prepareAdmittedAgent, spawnAdmittedAgent } from './packages/core/src/agents/agentRunAdmission.ts';
            mock.method(fs, 'statfsSync', (_path, options) => options?.bigint
                ? {bavail:1000000n,bsize:4096n,files:1000n,ffree:100n} : {bavail:1000000,bsize:4096,files:1000,ffree:100});
            const base = ${JSON.stringify(root)};
            delete process.env.PROPR_AGENT_RUN_LIMIT;
            process.env.PROPR_MANAGED_CREDENTIALS_DIR = base + '/managed';
            const home = base + '/managed/agent-a/.claude';
            fs.mkdirSync(home + '/projects/-workspace', {recursive:true});
            fs.mkdirSync(home + '/todos', {recursive:true});
            fs.writeFileSync(home + '/todos/canary', 'RESUME-CANARY');
            for (let n = 0; n < 4100; n++) fs.writeFileSync(home + '/projects/-workspace/session-' + n + '.jsonl', '{}');
            const args = ['run','-v',home + ':/home/node/.claude:rw','image'];
            assert.equal(await prepareAdmittedAgent(args), null);
            const db = managedDiagnostics();
            assert.equal(db.status().sources.find(s=>s.source==='native-state').inventoryComplete, false);
            db.limits.scanFiles = 1;
            assert.equal(await prepareAdmittedAgent(args), null);
            db.limits.scanFiles = 4096;
            db.limits.scanMs = -1;
            assertNativeLogAdmission(args);
            db.limits.scanMs = 10000;
            // Cursor saturation arrives at an awaited admission boundary. The
            // second native check must still succeed before physical creation.
            let created = 0, removed = 0, released = 0;
            const admission = await prepareAdmittedAgent(args, {
                config:{instance:'tenant-a',limit:1},
                client:{zadd:async()=>0,zrem:async()=>0,zremrangebyscore:async()=>0,zcard:async()=>0,hgetall:async()=>({}),
                    eval:async(_sql,_keys,_holders,_config,op)=> {
                        if (op === 'expired') return [];
                        if (op === 'release') released++;
                        if (op === 'acquire') {
                            db.limits.sources = db.status().sources.length + 1;
                            db.append({provider:'codex',agent:'old',source:'cursor'}, ['INFO retained'], 'text', {credentials:[]});
                        }
                        return 1;
                    }},
                docker:{daemon:async()=> 'test-daemon',create:async()=>{created++;return 'new';},remove:async()=>{removed++;}},
            });
            assert.equal(created,1);
            assert.equal(db.status().sourceCapacityWarning,true);
            assert.throws(()=>db.cursor({provider:'codex',agent:'old',source:'another-cursor'}), /source capacity/);
            await admission.finish();
            assert.equal(removed,1); assert.equal(released,1);
            const codex = base + '/managed/agent-b/.codex';
            fs.mkdirSync(codex + '/sessions/2026/10/12', {recursive:true});
            fs.writeFileSync(codex + '/sessions/2026/10/12/rollout-resume.jsonl', '{}');
            // A different agent needs a new admission row after saturation.
            const codexArgs = ['run','-v',codex + ':/home/node/.codex:rw','image'];
            assert.equal(await prepareAdmittedAgent(codexArgs),null);
            let spawned = 0;
            const child = {};
            assert.equal(await spawnAdmittedAgent(codexArgs, ()=>{spawned++;return child;}),child);
            assert.equal(spawned,1);
            process.env.PROPR_NATIVE_LOG_ROOTS = JSON.stringify({instance:'tenant-a',instanceOwned:true,roots:[
                {provider:'claude',agent:'agent-a',root:home},{provider:'codex',agent:'agent-b',root:codex}]});
            assertDeclared({provider:'claude',agent:'agent-a'});
            assertDeclared({provider:'codex',agent:'agent-b'});
            const status = nativeDiagnosticStatus();
            assert.equal(status.nativeAdmission.status,'available');
            assert.equal(status.nativeAdmission.inventoryComplete,false);
            // Diagnostic byte refusal remains active even when another
            // inventory is partial and the spool's source warning is set.
            fs.mkdirSync(codex + '/log');
            fs.writeFileSync(codex + '/log/codex-tui.log', 'INFO retained');
            assertNativeLogAdmission(codexArgs);
            db.limits.protectedBytes = 1;
            assert.throws(()=>assertNativeLogAdmission(args), /protected native state capacity/);
            assert.equal(fs.readFileSync(home + '/todos/canary','utf8'),'RESUME-CANARY');
            assert.equal(fs.readFileSync(codex + '/sessions/2026/10/12/rollout-resume.jsonl','utf8'),'{}');
            assert.ok(db.exportOne());
            db.close();
        `], { encoding: 'utf8', timeout: 30000, env: { ...process.env, PROPR_MANAGED_LOGS: '1', PROPR_INSTANCE_ID: 'tenant-a',
            PROPR_DIAGNOSTIC_ROOT: path.join(root, 'spool'), PROPR_NATIVE_LOG_ROOTS: '', PROPR_FLEET_CONTROL_SECRET: '', PROPR_AGENT_RUN_LIMIT: '' } });
        assert.equal(result.status, 0, result.stderr);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('confirmed private capacity reset releases removed and perpetually incomplete roots across both admission paths', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-capacity-reset-'));
    try {
        const result = spawnSync(process.execPath, ['--import', 'tsx', '-e', `
            import assert from 'node:assert/strict';
            import fs from 'node:fs';
            import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
            import { mock } from 'node:test';
            import { assertNativeLogAdmission } from './packages/core/src/diagnostics/nativeLogAdmission.ts';
            import { managedDiagnostics, assertNativeLogAdmission as assertDeclared } from './packages/core/src/diagnostics/managedLogRuntime.ts';
            import { prepareAdmittedAgent } from './packages/core/src/agents/agentRunAdmission.ts';
            mock.method(fs, 'statfsSync', (_path, options) => options?.bigint
                ? {bavail:1000000n,bsize:4096n,files:1000n,ffree:100n} : {bavail:1000000,bsize:4096,files:1000,ffree:100});
            const base = ${JSON.stringify(root)};
            delete process.env.PROPR_AGENT_RUN_LIMIT;
            delete process.env.PROPR_NATIVE_LOG_ROOTS;
            process.env.PROPR_MANAGED_CREDENTIALS_DIR = base + '/managed';
            const a = base + '/managed/agent-a/.claude', b = base + '/managed/agent-b/.claude';
            fs.mkdirSync(a + '/debug', {recursive:true});
            fs.mkdirSync(b, {recursive:true});
            const original = a + '/debug/run.txt';
            fs.writeFileSync(original, '');
            const size = 300 * 1024 ** 2;
            fs.truncateSync(original, size);
            const args = home => ['run','-v',home + ':/home/node/.claude:rw','image'];
            assert.throws(() => assertNativeLogAdmission(args(a)), /protected native state capacity/);
            const db = managedDiagnostics();
            const nativeId = () => db.status().sources.find(s=>s.agent==='agent-a' && s.source==='native-state').id;
            const cli = (args, env = {}) => spawnSync(process.execPath,
                ['--import','tsx','scripts/managed-diagnostics.ts',...args],
                {encoding:'utf8',env:{...process.env,...env}});
            const resetArgs = id => ['reset-native-capacity',id,'--operator-storage-remediation-verified'];
            const reset = id => {
                const r = cli(resetArgs(id));
                assert.equal(r.status,0,r.stderr);
                assert.deepEqual(JSON.parse(r.stdout), {nativeCapacityReset:true,offsiteAcknowledged:false});
            };
            const id = nativeId();
            assert.equal(cli(['reset-native-capacity',id]).status,1);
            assert.equal(cli(resetArgs(id),{PROPR_MANAGED_LOGS:'0'}).status,1);
            assert.equal(cli(resetArgs(id),{PROPR_INSTANCE_ID:'other'}).status,1);
            assert.equal(cli(resetArgs('0'.repeat(64))).status,1);
            // Reset is no bypass for a root that is still oversized.
            reset(id);
            assert.throws(() => assertNativeLogAdmission(args(a)), /protected native state capacity/);
            // Removing/disablement leaves a stale row that used to block every agent.
            fs.rmSync(a,{recursive:true});
            await assert.rejects(prepareAdmittedAgent(args(b)), /protected native state capacity/);
            reset(id);
            assert.equal(await prepareAdmittedAgent(args(b)),null);
            assert.throws(() => assertNativeLogAdmission(args(a)), /capacity unavailable/);
            // Rebuild an oversized root, then make its inventory permanently incomplete.
            fs.mkdirSync(a + '/debug',{recursive:true});
            fs.writeFileSync(original,''); fs.truncateSync(original,size);
            process.env.PROPR_NATIVE_LOG_ROOTS = JSON.stringify({instance:'tenant-a',instanceOwned:true,
                roots:[{provider:'claude',agent:'agent-a',root:a}]});
            const agent = {provider:'claude',agent:'agent-a'};
            assert.throws(() => assertDeclared(agent), /protected native state capacity/);
            assert.throws(() => assertNativeLogAdmission(args(a)), /protected native state capacity/);
            fs.mkdirSync(a + '/unknown-directory');
            db.limits.scanFiles = 1; // Physical entry-bound scans cannot lower the old mark.
            fs.truncateSync(original,8);
            assert.throws(() => assertDeclared(agent), /protected native state capacity/);
            assert.throws(() => assertNativeLogAdmission(args(a)), /protected native state capacity/);
            // An unacknowledged copy remains an obligation throughout remediation.
            db.append({provider:'claude',agent:'agent-a',source:'stdout'},['INFO diagnostic'],'text',{credentials:[]});
            const exported = db.exportOne();
            const copyId = db.status().sources.find(s=>s.source==='stdout').id;
            assert.equal(cli(resetArgs(copyId)).status,1);
            db.report({provider:'claude',agent:'agent-a',source:'native-state'},'scan-limit');
            const gaps = db.status().sources.find(s=>s.id===id).gaps;
            const capacityId = db.status().sources.find(s=>s.source.startsWith('native-capacity:')).id;
            reset(id); reset(capacityId);
            const cleared = db.status().sources.find(s=>s.id===id);
            assert.equal(cleared.inventoryComplete,false);
            assert.equal(cleared.protectedBytes,null);
            assert.equal(cleared.gaps,gaps);
            assert.equal(cleared.reason,'scan-limit');
            // Reopen the database to verify that the CLI reset is durable.
            const { ManagedLogSpool } = await import('./packages/core/src/diagnostics/managedLogSpool.ts');
            const reopened = new ManagedLogSpool(process.env.PROPR_DIAGNOSTIC_ROOT,'tenant-a');
            reopened.assertCapacity(); reopened.close();
            assertDeclared(agent);
            assertNativeLogAdmission(args(a));
            assert.equal(await prepareAdmittedAgent(args(b)),null);
            assert.deepEqual(db.exportOne(),exported);
            // Fresh oversized lower bounds and unsafe entries still refuse after reset.
            db.limits.scanFiles = 4096;
            fs.truncateSync(original,size);
            assert.throws(() => assertDeclared(agent), /protected native state capacity/);
            assert.throws(() => assertNativeLogAdmission(args(a)), /protected native state capacity/);
            reset(id); reset(capacityId);
            fs.truncateSync(original,8);
            fs.symlinkSync(base,a + '/debug/unsafe.txt');
            assert.throws(() => assertDeclared(agent), /inventory incomplete/);
            assert.throws(() => assertNativeLogAdmission(args(a)), /capacity unavailable/);
            assert.deepEqual(db.exportOne(),exported);
            db.close();
        `], { encoding: 'utf8', timeout: 30000, env: { ...process.env, PROPR_MANAGED_LOGS: '1', PROPR_INSTANCE_ID: 'tenant-a',
            PROPR_DIAGNOSTIC_ROOT: path.join(root, 'spool'), PROPR_FLEET_CONTROL_SECRET: '', PROPR_AGENT_RUN_LIMIT: '' } });
        assert.equal(result.status, 0, result.stderr);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});


test('session-dominated homes admit another agent through declared and physical launch gates', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-log-resume-capacity-'));
    try {
        const result = spawnSync(process.execPath, ['--import', 'tsx', '-e', `
            import assert from 'node:assert/strict';
            import fs from 'node:fs';
            import path from 'node:path';
            import { prepareAdmittedAgent } from './packages/core/src/agents/agentRunAdmission.ts';
            import { assertNativeLogAdmission as declared, managedDiagnostics, nativeDiagnosticStatus } from './packages/core/src/diagnostics/managedLogRuntime.ts';
            const base = process.argv[1];
            delete process.env.PROPR_AGENT_RUN_LIMIT;
            process.env.PROPR_MANAGED_CREDENTIALS_DIR = base + '/managed';
            const layouts = [
                ['claude', '.claude', 'projects/-workspace/resume.jsonl', 'session'],
                ['codex', '.codex', 'sessions/2026/10/12/rollout-resume.jsonl', 'session'],
                ['codex', '.codex', 'logs_2.sqlite-wal', 'database'],
                ['codex', '.codex', 'state_2.sqlite', 'database'],
                ['opencode', '.local/share/opencode', 'opencode.db', 'database'],
                ['antigravity', '.gemini', 'antigravity-cli/brain/run/.system_generated/logs/transcript.jsonl', 'session'],
                ['vibe', '.vibe', 'logs/session/run/messages.jsonl', 'session'],
            ];
            const bytes = 300 * 1024 ** 2;
            const roots = layouts.map(([provider, suffix, relative], n) => {
                const root = base + '/managed/agent-' + n + '/' + suffix;
                const file = path.join(root, relative);
                fs.mkdirSync(path.dirname(file), {recursive:true});
                fs.writeFileSync(file, 'RESUME-CANARY');
                fs.truncateSync(file, bytes);
                return {provider, agent:'agent-' + n, root};
            });
            fs.mkdirSync(roots[0].root + '/debug');
            const other = {provider:'claude', agent:'other', root:base + '/managed/other/.claude'};
            fs.mkdirSync(other.root + '/debug', {recursive:true});
            process.env.PROPR_NATIVE_LOG_ROOTS = JSON.stringify({instance:'tenant-a',instanceOwned:true,roots:[...roots,other]});
            const args = r => ['run','-v',r.root + ':/home/node/' + layouts.find(l=>l[0]===r.provider)[1] + ':rw','image'];
            // Warm all persisted contributions, then launch a different agent.
            for (const r of roots) assert.equal(await prepareAdmittedAgent(args(r)), null);
            declared(other);
            assert.equal(await prepareAdmittedAgent(args(other)), null);
            let created = 0, released = 0;
            const admission = await prepareAdmittedAgent(args(other), {
                config:{instance:'tenant-a',limit:1},
                client:{zadd:async()=>0,zrem:async()=>0,zremrangebyscore:async()=>0,zcard:async()=>0,hgetall:async()=>({}),
                    eval:async(_sql,_keys,_holders,_config,op)=> {
                        if (op === 'expired') return [];
                        if (op === 'release') released++;
                        if (op === 'acquire') {
                            const session = other.root + '/projects/-workspace/resume.jsonl';
                            fs.mkdirSync(path.dirname(session),{recursive:true});
                            fs.writeFileSync(session,''); fs.truncateSync(session,bytes);
                        }
                        return 1;
                    }},
                docker:{daemon:async()=> 'test-daemon',create:async()=>{created++;return 'new';},remove:async()=>{}},
            });
            assert.equal(created,1);
            await admission.finish(); assert.equal(released,1);
            const status = nativeDiagnosticStatus();
            assert.equal(status.nativeAdmission.status, 'available');
            assert.ok(status.nativeAdmission.observedBytes > 1024 ** 3);
            for (const [n, r] of roots.entries()) {
                const state = status.nativeSources.sources.find(s=>s.agent===r.agent);
                assert.equal(state.inventory[layouts[n][3] + 'Bytes'], bytes);
                assert.equal(state.capacityBytesLowerBound, 0);
                assert.equal(status.sources.find(s=>s.agent===r.agent && s.source==='native-state').capacityWarning, false);
                const file = path.join(r.root, layouts[n][2]);
                assert.equal(fs.statSync(file).size, bytes);
                const fd = fs.openSync(file,'r');
                const canary = Buffer.alloc(13); fs.readSync(fd,canary,0,13,0); fs.closeSync(fd);
                assert.equal(canary.toString(), 'RESUME-CANARY');
            }
            managedDiagnostics().close();
        `, root], { encoding: 'utf8', timeout: 30000, env: { ...process.env, PROPR_MANAGED_LOGS: '1', PROPR_INSTANCE_ID: 'tenant-a',
            PROPR_DIAGNOSTIC_ROOT: path.join(root, 'spool'), PROPR_NATIVE_LOG_ROOTS: '', PROPR_FLEET_CONTROL_SECRET: '', PROPR_AGENT_RUN_LIMIT: '' } });
        assert.equal(result.status, 0, result.stderr);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('legacy session totals migrate to classified diagnostic capacity and partial scans retain that evidence', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-log-capacity-migration-'));
    const spoolRoot = path.join(root, 'spool');
    let spool = new ManagedLogSpool(spoolRoot, 'tenant-a');
    try {
        const home = path.join(root, 'home');
        fs.mkdirSync(path.join(home, 'debug'), { recursive: true });
        fs.mkdirSync(path.join(home, 'projects/-workspace'), { recursive: true });
        fs.writeFileSync(path.join(home, 'debug/run.txt'), 'INFO old');
        const session = path.join(home, 'projects/-workspace/resume.jsonl');
        fs.writeFileSync(session, ''); fs.truncateSync(session, 300 * 1024 ** 2);
        const input = { provider: 'claude' as const, agent: 'a', root: home, credentials: [], measureOnly: true };
        collectProvider(spool, input);
        const output = { provider: 'claude', agent: 'a', source: 'stdout' };
        spool.append(output, ['INFO pending'], 'text', { credentials: [], cursor: { before: {}, after: { offset: 13 } } });
        const pending = spool.exportOne();
        spool.close();
        const Sqlite = createRequire(import.meta.url)('better-sqlite3');
        const legacy = new Sqlite(path.join(spoolRoot, 'spool.sqlite'));
        try { legacy.exec('ALTER TABLE sources DROP COLUMN diagnostic_bytes'); }
        finally { legacy.close(); }
        spool = new ManagedLogSpool(spoolRoot, 'tenant-a');
        assert.doesNotThrow(() => spool.assertCapacity());
        assert.deepEqual(spool.exportOne(), pending);
        assert.deepEqual(spool.cursor(output), { offset: 13 });
        const status = spool.status() as any;
        assert.equal(status.nativeSources.sources[0].capacityBytesLowerBound, 8);
        assert.ok(status.nativeSources.sources[0].measuredBytes > 300 * 1024 ** 2);
        spool.limits.scanFiles = 0;
        collectProvider(spool, input);
        assert.equal((spool.status() as any).nativeSources.sources[0].capacityBytesLowerBound, 8);
        spool.limits.protectedBytes = 8;
        assert.throws(() => spool.assertCapacity(), /protected native state capacity/);
    } finally { spool.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
