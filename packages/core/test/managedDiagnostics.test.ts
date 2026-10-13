import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { execFileSync, spawnSync } from 'node:child_process';
import { ManagedLogSpool, digest } from '../src/diagnostics/managedLogSpool.js';
import { collectProvider } from '../src/diagnostics/providerCollector.js';
import { PinnedDirectory } from '../src/diagnostics/privateDirectory.js';
import { redactRecord } from '../src/diagnostics/redaction.js';

const identity = { provider: 'codex', agent: 'agent-a', source: 'stdout' };
function fixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-diagnostics-'));
    const spool = new ManagedLogSpool(path.join(root, 'spool'), 'tenant-a');
    return { root, spool, close() { spool.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}
function drain(spool: ManagedLogSpool) {
    const result: Array<{ manifest: any; text: string; data: Buffer }> = [];
    for (let item; (item = spool.exportOne());) {
        assert.equal(digest(item.data), item.digest);
        result.push({ manifest: item.manifest, text: gunzipSync(item.data).toString(), data: item.data });
        spool.acknowledge(item.id, item.digest);
    }
    return result;
}
test('UTC midnight, multiple size rolls, stable sealed export, restart and cursor CAS', () => {
    const f = fixture();
    try {
        const lines = Array.from({ length: 20 }, (_, n) => JSON.stringify({ n, message: 'a'.repeat(30_000) }));
        const before = Date.parse('2026-10-11T23:59:59Z');
        f.spool.append(identity, lines.slice(0, 10), 'jsonl', { credentials: [], now: before });
        f.spool.append(identity, lines.slice(10), 'jsonl', { credentials: [], now: before + 2000, cursor: { before: {}, after: { offset: 20 } } });
        assert.equal(f.spool.append(identity, lines, 'jsonl', { credentials: [], now: before, cursor: { before: {}, after: { offset: 20 } } }), false);
        const second = new ManagedLogSpool(path.join(f.root, 'spool'), 'tenant-a');
        assert.deepEqual(second.exportOne(), f.spool.exportOne());
        second.close();
        const exported = drain(f.spool);
        assert.equal(exported.length, 4);
        assert.deepEqual(exported.flatMap(e => e.text.trim().split('\n').map(line => JSON.parse(line).n)), lines.map((_, n) => n));
        assert.deepEqual([...new Set(exported.map(e => e.manifest.utcDay))], ['2026-10-11', '2026-10-12']);
        assert.equal(exported[0].manifest.historyComplete, false);
    } finally { f.close(); }
});
test('actual managed Codex and Claude layouts: active append-only writers, protected resumable state and immutable credentials', () => {
    const f = fixture();
    try {
        for (const provider of ['codex', 'claude'] as const) {
            const home = path.join(f.root, 'agent-credentials', 'agent-a', provider === 'codex' ? '.codex' : '.claude');
            const native = provider === 'codex' ? 'sessions/2026/10/12/rollout-session.jsonl' : 'projects/-workspace/session.jsonl';
            const debug = provider === 'codex' ? 'log/codex-tui.log' : 'debug/session.txt';
            for (const name of [native, debug]) fs.mkdirSync(path.dirname(path.join(home, name)), { recursive: true });
            const auth = provider === 'codex' ? 'auth.json' : '.credentials.json';
            fs.writeFileSync(path.join(home, auth), '{"access_token":"credential-canary"}');
            fs.writeFileSync(path.join(home, 'config.json'), 'UNRELATED-CONFIG-CANARY');
            fs.writeFileSync(path.join(home, debug), 'INFO token=secret-canary ready\n');
            const writer = fs.openSync(path.join(home, native), 'a');
            fs.writeSync(writer, '{"type":"session_meta","authorization":"Bearer credential-canary"}\n{"type":');
            const args = { provider, agent: 'agent-a', root: home, credentials: ['credential-canary', 'secret-canary'] };
            collectProvider(f.spool, { ...args, credentialContextComplete: true });
            fs.writeSync(writer, '"message","text":"customer prompt credential-canary"}\n');
            collectProvider(f.spool, { ...args, credentialContextComplete: true });
            collectProvider(f.spool, { ...args, credentialContextComplete: true });
            fs.closeSync(writer);
            assert.equal(fs.readFileSync(path.join(home, auth), 'utf8'), '{"access_token":"credential-canary"}');
            assert.equal(fs.readFileSync(path.join(home, native), 'utf8').split('\n').length, 3);
        }
        const exported = drain(f.spool).map(e => e.text).join('');
        assert.equal((exported.match(/session_meta/g) ?? []).length, 2);
        assert.equal((exported.match(/customer prompt/g) ?? []).length, 2);
        for (const secret of ['credential-canary', 'secret-canary', 'UNRELATED-CONFIG-CANARY']) assert.ok(!exported.includes(secret));
        assert.ok(JSON.stringify(f.spool.status()).includes('protected-native-state'));
    } finally { f.close(); }
});
test('no acknowledgement preserves old export, bounded outage drops new data and records gaps', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'diagnostic-cap-'));
    const spool = new ManagedLogSpool(path.join(root, 'spool'), 'tenant-a', { segments: 2, segmentBytes: 80 });
    try {
        for (let n = 0; n < 20; n++) spool.append(identity, [JSON.stringify({ n, text: 'a'.repeat(50) })], 'jsonl', { credentials: [] });
        const status = spool.status() as any;
        assert.equal(status.spool.segments, 2);
        assert.equal(status.sources[0].gaps, 18);
        const item = spool.exportOne()!;
        assert.throws(() => spool.acknowledge(item.id, 'wrong'));
        assert.deepEqual(spool.exportOne(), item);
        assert.ok(item.data.length < 100);
        spool.report(identity, 'protected-native-state', spool.limits.protectedBytes);
        assert.throws(() => spool.assertCapacity(), /protected native state/);
        spool.acknowledge(item.id, item.digest);
        assert.equal((spool.status() as any).spool.segments, 1);
    } finally { spool.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
test('hostile symlink, hardlink, FIFO, traversal and ancestor replacement', () => {
    const f = fixture();
    try {
        const home = path.join(f.root, 'home'); fs.mkdirSync(home); fs.mkdirSync(path.join(home, 'debug'));
        const outside = path.join(f.root, 'secret'); fs.writeFileSync(outside, 'OUTSIDE-CANARY\n');
        fs.symlinkSync(outside, path.join(home, 'debug', 'symlink.txt'));
        fs.linkSync(outside, path.join(home, 'debug', 'hardlink.txt'));
        execFileSync('mkfifo', [path.join(home, 'debug', 'fifo.txt')]);
        collectProvider(f.spool, { credentialContextComplete: true, provider: 'claude', agent: 'a', root: home, credentials: [] });
        assert.equal(f.spool.exportOne(), null);
        assert.ok(JSON.stringify(f.spool.status()).includes('unsafe-source'));
        assert.throws(() => PinnedDirectory.open(home + '/../secret'));
        const pin = PinnedDirectory.open(home);
        fs.renameSync(home, home + '-old'); fs.symlinkSync(f.root, home);
        const debug = pin.child('debug');
        assert.equal(fs.fstatSync(debug.fd).ino, fs.statSync(path.join(home + '-old', 'debug')).ino);
        debug.close(); pin.close();
        assert.throws(() => PinnedDirectory.open(home));
    } finally { f.close(); }
});
test('oversized partial records are discarded through newline without tail leakage', () => {
    const f = fixture();
    try {
        const home = path.join(f.root, 'home'); fs.mkdirSync(path.join(home, 'debug'), { recursive: true });
        const file = path.join(home, 'debug', 'active.txt');
        fs.writeFileSync(file, 'x'.repeat(100_000));
        const args = { provider: 'claude' as const, agent: 'a', root: home, credentials: [] };
        collectProvider(f.spool, { ...args, credentialContextComplete: true });
        fs.appendFileSync(file, 'tail-that-must-not-ship\nINFO ready\n'); collectProvider(f.spool, { ...args, credentialContextComplete: true });
        const output = drain(f.spool).map(e => e.text).join('');
        assert.ok(!output.includes('tail-that-must-not-ship'));
        assert.ok(output.includes('ready'));
        assert.ok((f.spool.status() as any).sources.some((s: any) => s.droppedBytes >= 100_000));
    } finally { f.close(); }
});
test('structured and text redaction fail closed', () => {
    assert.equal(redactRecord('{"bad":', 'jsonl', []), null);
    assert.equal(redactRecord('{"bad":', 'text', []), null);
    const value = redactRecord(JSON.stringify({ nested: { refresh_token: 'CANARY', cookies: ['CANARY'] }, text: 'Bearer CANARY password=CANARY sk-1234567890 ghp_abcdefghijk configured-value' }), 'jsonl', ['configured-value'])!;
    assert.ok(!value.includes('CANARY')); assert.ok(!value.includes('configured-value'));
});
test('CLI private export and readback acknowledgement integration', () => {
    const f = fixture();
    try {
        f.spool.append(identity, ['{"msg":"hello"}'], 'jsonl', { credentials: [] });
        const env = { ...process.env, PROPR_MANAGED_LOGS: '1', PROPR_DIAGNOSTIC_ROOT: path.join(f.root, 'spool'), PROPR_INSTANCE_ID: 'tenant-a' };
        const cli = (...args: string[]) => spawnSync(process.execPath, ['--import', 'tsx', 'scripts/managed-diagnostics.ts', ...args], { env, encoding: 'utf8' });
        const result = cli('export'); assert.equal(result.status, 0, result.stderr);
        const item = JSON.parse(result.stdout);
        assert.equal(gunzipSync(Buffer.from(item.gzipBase64, 'base64')).toString(), '{"msg":"hello"}\n');
        assert.equal(cli('ack', String(item.manifest.segment), item.manifest.sha256).status, 1);
        assert.equal(cli('ack', String(item.manifest.segment), item.manifest.sha256, '--encrypted-upload-readback-verified').status, 0);
        assert.equal(cli('export').stdout.trim(), 'null');
    } finally { f.close(); }
});
test('all remaining enabled provider layouts have explicit safe collection and protected stores', () => {
    const f = fixture();
    try {
        const layouts = {
            antigravity: 'antigravity-cli/brain/conversation/.system_generated/logs/transcript.jsonl',
            opencode: 'log/2026-10-12.log',
            vibe: 'logs/session/session-id/messages.jsonl',
        } as const;
        for (const [provider, relative] of Object.entries(layouts)) {
            const root = path.join(f.root, provider);
            fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
            fs.writeFileSync(path.join(root, relative), JSON.stringify({ event: 'diagnostic', token: 'OPAQUE-AUTH', ...(provider === 'vibe' ? { message: 'opaque-vibe-key' } : {}) }) + '\n');
            if (provider === 'vibe') fs.writeFileSync(path.join(root, '.env'), 'MISTRAL_API_KEY=opaque-vibe-key\n');
            fs.writeFileSync(path.join(root, 'settings.json'), 'NEVER-EXPORT-CONFIG');
            if (provider === 'opencode') fs.writeFileSync(path.join(root, 'opencode.db'), 'NATIVE-RESUMABLE-STATE');
            collectProvider(f.spool, { credentialContextComplete: true, provider: provider as keyof typeof layouts, root, agent: 'a', credentials: [] });
        }
        const data = drain(f.spool);
        assert.equal(data.length, 3);
        assert.ok(data.every(e => !/OPAQUE-AUTH|opaque-vibe-key|NEVER-EXPORT|NATIVE-RESUMABLE/.test(e.text)));
        assert.ok((f.spool.status() as any).sources.find((s: any) => s.provider === 'opencode' && s.source === 'native-state').protectedBytes > 20);
    } finally { f.close(); }
});
test('credential canary loaded for redaction only; unsafe auth store refuses all native collection', () => {
    const f = fixture();
    try {
        const home = path.join(f.root, 'codex'); fs.mkdirSync(path.join(home, 'log'), { recursive: true });
        fs.writeFileSync(path.join(home, 'auth.json'), '{"tokens":{"access_token":"opaque-value-without-known-prefix"}}');
        fs.writeFileSync(path.join(home, 'log/codex-tui.log'), 'INFO opaque-value-without-known-prefix\n');
        collectProvider(f.spool, { credentialContextComplete: true, provider: 'codex', root: home, agent: 'a', credentials: [] });
        assert.ok(!drain(f.spool).map(s => s.text).join('').includes('opaque-value'));
        fs.writeFileSync(path.join(home, 'auth.json'), '{malformed');
        fs.appendFileSync(path.join(home, 'log/codex-tui.log'), 'INFO must-not-export\n');
        collectProvider(f.spool, { credentialContextComplete: true, provider: 'codex', root: home, agent: 'a', credentials: [] });
        assert.equal(f.spool.exportOne(), null);
    } finally { f.close(); }
});
test('SQLite full fault rolls back both data and cursor, keeping last acknowledged coverage honest', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'diagnostic-full-'));
    const limits = { databaseBytes: 128 * 1024 };
    const spool = new ManagedLogSpool(path.join(root, 'spool'), 'tenant-a', limits);
    try {
        let failed = false;
        for (let i = 0; i < 50; i++) {
            const cursor = spool.cursor(identity);
            const random = Array.from({ length: 1000 }, (_, n) => digest(`${i}-${n}`)).join('');
            try { spool.append(identity, [JSON.stringify({ message: random })], 'jsonl', { credentials: [], now: Date.now(), cursor: { before: cursor, after: { offset: i + 1 } } }); }
            catch {
                assert.deepEqual(spool.cursor(identity), cursor);
                failed = true; break;
            }
        }
        assert.ok(failed, 'must actually exercise database full');
        assert.equal((spool.status() as any).historyComplete, false);
        const item = spool.exportOne(); assert.ok(item);
        assert.ok(gunzipSync(item.data).length <= spool.limits.segmentBytes);
        assert.ok(fs.statSync(path.join(root, 'spool/spool.sqlite')).size <= limits.databaseBytes);
    } finally { spool.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
test('sparse multi-GB provider log is bounded and warns rather than truncating native state', () => {
    const f = fixture();
    try {
        const home = path.join(f.root, 'large'); fs.mkdirSync(path.join(home, 'log'), { recursive: true });
        const file = path.join(home, 'log/codex-tui.log');
        const fd = fs.openSync(file, 'w'); fs.ftruncateSync(fd, 3 * 1024 ** 3); fs.closeSync(fd);
        const before = process.memoryUsage().rss;
        collectProvider(f.spool, { credentialContextComplete: true, provider: 'codex', root: home, agent: 'large', credentials: [] });
        assert.ok(process.memoryUsage().rss - before < 32 * 1024 ** 2);
        assert.equal(fs.statSync(file).size, 3 * 1024 ** 3);
        assert.throws(() => f.spool.assertCapacity(), /protected native state/);
        assert.equal(f.spool.exportOne(), null);
    } finally { f.close(); }
});
test('injected ENOSPC during commit is atomic and retry preserves committed record identity', () => {
    const f = fixture();
    try {
        f.spool.cursor(identity);
        const db = (f.spool as any).db;
        const execute = db.exec.bind(db);
        let fail = true;
        db.exec = (sql: string) => {
            if (sql === 'COMMIT' && fail) { fail = false; throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); }
            return execute(sql);
        };
        assert.throws(() => f.spool.append(identity, ['{"n":1}'], 'jsonl', { credentials: [], now: 1000, cursor: { before: {}, after: { offset: 8 } } }), /disk full/);
        assert.deepEqual(f.spool.cursor(identity), {});
        assert.equal(f.spool.exportOne(), null);
        f.spool.append(identity, ['{"n":1}'], 'jsonl', { credentials: [], now: 1000, cursor: { before: {}, after: { offset: 8 } } });
        assert.equal(drain(f.spool)[0].text, '{"n":1}\n');
    } finally { f.close(); }
});
test('real application Pino hook exports redacted operational records', () => {
    const f = fixture();
    try {
        const env = { ...process.env, NODE_ENV: 'production', PROPR_MANAGED_LOGS: '1', PROPR_DIAGNOSTIC_ROOT: path.join(f.root, 'spool'), PROPR_INSTANCE_ID: 'tenant-a', DIAGNOSTIC_TEST_SECRET: 'configured-opaque-canary' };
        const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e',
            `import logger from './packages/core/src/utils/logger.ts'; logger.info({ preview: '/tmp/propr-previews/hidden-preview.png', authorization: 'Bearer auth-canary' }, 'configured-opaque-canary');`], { env, encoding: 'utf8' });
        assert.equal(result.status, 0, result.stderr);
        const records = drain(f.spool).map(e => e.text).join('');
        assert.ok(records.includes('REDACTED'));
        assert.ok(!records.includes('hidden-preview.png')); assert.ok(!records.includes('auth-canary')); assert.ok(!records.includes('configured-opaque-canary'));
    } finally { f.close(); }
});
test('concurrent process rotation, export and cursor CAS recover without duplicate committed records', async () => {
    const { spawn } = await import('node:child_process');
    const f = fixture();
    const db = (f.spool as any).db;
    let startupLocked = false, startupRetried = false;
    try {
        const modulePath = new URL('../src/diagnostics/managedLogSpool.ts', import.meta.url).href;
        const script = `import { ManagedLogSpool } from ${JSON.stringify(modulePath)};
            // Initialization also takes a write lock and can race the exporter.
            // Retry only expected contention, with a deadline for each operation.
            async function retryBusy(operation, onBusy = () => {}) {
                const deadline = Date.now() + 10000;
                for (;;) {
                    try { return operation(); }
                    catch(e) {
                        if(e.code !== 'SQLITE_BUSY' || Date.now() >= deadline) throw e;
                        onBusy();
                        await new Promise(resolve => setTimeout(resolve, 10));
                    }
                }
            }
            const spool = await retryBusy(() => new ManagedLogSpool(${JSON.stringify(path.join(f.root, 'spool'))}, 'tenant-a'), () => process.send('initialization-busy'));
            const identity = ${JSON.stringify(identity)};
            try {
                for (let n=0;n<12;n++) await retryBusy(() => spool.append(identity,[JSON.stringify({writer:process.env.WRITER,n})],'jsonl',{credentials:[]}));
            } finally { spool.close(); }`;
        const run = (writer: string) => new Promise<void>((resolve, reject) => {
            const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { env: { ...process.env, WRITER: writer }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
            child.on('message', message => {
                if (message === 'initialization-busy') {
                    startupRetried = true;
                    if (startupLocked) { db.exec('ROLLBACK'); startupLocked = false; }
                }
            });
            let error = ''; child.stderr.on('data', chunk => { error += chunk; });
            child.on('error', reject); child.on('close', code => code === 0 ? resolve() : reject(new Error(error)));
        });
        // Force startup contention, rather than depending on exporter timing.
        db.exec('BEGIN IMMEDIATE'); startupLocked = true;
        const exported: ReturnType<typeof drain> = [];
        const timer = setInterval(() => {
            if (startupLocked) return;
            try {
                const item = f.spool.exportOne();
                if (item) {
                    f.spool.acknowledge(item.id, item.digest);
                    exported.push({ manifest: item.manifest, data: item.data, text: gunzipSync(item.data).toString() });
                }
            } catch (error) { if ((error as { code?: string }).code !== 'SQLITE_BUSY') throw error; }
        }, 30);
        try {
            // Let both processes exit before closing/removing their shared spool.
            const results = await Promise.allSettled([run('a'), run('b')]);
            for (const result of results) if (result.status === 'rejected') throw result.reason;
        }
        finally { clearInterval(timer); }
        assert.equal(startupRetried, true);
        exported.push(...drain(f.spool));
        const output = exported.flatMap(e => e.text.trim().split('\n').map(line => JSON.parse(line)));
        assert.equal(output.length, 24);
        assert.equal(new Set(output.map(r => `${r.writer}:${r.n}`)).size, 24);
    } finally {
        if (startupLocked) db.exec('ROLLBACK');
        f.close();
    }
});
test('file replacement, malicious spool roots and cross-instance access fail safe', () => {
    const f = fixture();
    try {
        assert.throws(() => new ManagedLogSpool(path.join(f.root, 'spool'), 'tenant-b'), /mismatch/);
        const linked = path.join(f.root, 'linked'); fs.symlinkSync(path.join(f.root, 'spool'), linked);
        assert.throws(() => new ManagedLogSpool(linked, 'tenant-a'));
        const home = path.join(f.root, 'home'); fs.mkdirSync(path.join(home, 'debug'), { recursive: true });
        const log = path.join(home, 'debug/session.txt'); fs.writeFileSync(log, 'INFO original-record\n');
        const args = { provider: 'claude' as const, root: home, agent: 'a', credentials: [] };
        collectProvider(f.spool, { ...args, credentialContextComplete: true });
        // Reuse the same inode, regrow past its old offset before the next scan.
        fs.writeFileSync(log, 'INFO replaced-record-with-longer-value\n');
        collectProvider(f.spool, { ...args, credentialContextComplete: true });
        assert.ok(JSON.stringify(f.spool.status()).includes('source-replaced'));
        const output = drain(f.spool).map(e => e.text).join('');
        assert.ok(output.includes('original-record')); assert.ok(output.includes('replaced-record'));
    } finally { f.close(); }
});
test('stream capture stays bounded across chunks and keeps the original live child stream usable', () => {
    const f = fixture();
    try {
        const env = { ...process.env, PROPR_MANAGED_LOGS: '1', PROPR_DIAGNOSTIC_ROOT: path.join(f.root, 'spool'), PROPR_INSTANCE_ID: 'tenant-a' };
        const script = `import { captureProviderOutput } from './packages/core/src/diagnostics/managedLogRuntime.ts';
            const capture=captureProviderOutput({provider:'claude',agent:'live',source:'stdout'},['secret-value']);
            for(let n=0;n<4;n++) { const chunk=JSON.stringify({n,message:'secret-value'})+'\\n'; process.stdout.write(chunk); capture.write(chunk.slice(0,12)); capture.write(chunk.slice(12)); }
            capture.write('x'.repeat(100000)); capture.write('unsafe-tail\\n'); capture.close();`;
        const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { env, encoding: 'utf8' });
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.stdout.trim().split('\n').length, 4);
        const records = drain(f.spool).flatMap(e => e.text.trim().split('\n').map(line => JSON.parse(line)));
        assert.deepEqual(records.map(r => r.n), [0, 1, 2, 3]);
        assert.ok(!JSON.stringify(records).includes('secret-value'));
        assert.ok((f.spool.status() as any).sources.some((s: any) => s.droppedBytes >= 100000));
    } finally { f.close(); }
});

test('runtime diagnostics require explicit activation and reject missing, invalid and cross-instance bindings', () => {
    const f = fixture();
    try {
        for (const secret of ['', 'test-fleet-auth']) {
            for (const flag of ['', '0', 'true', '1']) {
                for (const instance of ['tenant-a', '', '../tenant-b', 'tenant-b']) {
                    const env: NodeJS.ProcessEnv = { ...process.env, PROPR_MANAGED_LOGS: flag, PROPR_FLEET_CONTROL_SECRET: secret,
                        PROPR_INSTANCE_ID: instance, PROPR_DIAGNOSTIC_ROOT: path.join(f.root, 'spool'), HOME: f.root };
                    // The resolved default root (HOME/.codex, or an unmapped container default) is absent.
                    delete env.CODEX_CONFIG_PATH; delete env.HOST_CODEX_DIR;
                    if (!flag) delete env.PROPR_MANAGED_LOGS;
                    if (!secret) delete env.PROPR_FLEET_CONTROL_SECRET;
                    if (!instance) delete env.PROPR_INSTANCE_ID;
                    const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
                        import assert from 'node:assert/strict';
                        import { managedDiagnostics, captureApplicationRecord, prepareProviderCapture } from './packages/core/src/diagnostics/managedLogRuntime.ts';
                        const enabled = process.env.PROPR_MANAGED_LOGS === '1';
                        const valid = process.env.PROPR_INSTANCE_ID === 'tenant-a';
                        if (enabled && !valid) {
                            assert.throws(() => managedDiagnostics(), /invalid diagnostic instance|instance mismatch/);
                            assert.equal(prepareProviderCapture({ provider: 'codex', agent: 'agent-a' }), null);
                            captureApplicationRecord('{"message":"must not cross instance"}');
                        } else {
                            const db = managedDiagnostics();
                            assert.equal(Boolean(db), enabled);
                            const capture = prepareProviderCapture({ provider: 'codex', agent: 'agent-a' });
                            assert.equal(capture, null); // No established native authentication root.
                            captureApplicationRecord('{"message":"explicit policy"}');
                            capture?.stdout.write('INFO explicit provider policy\\n');
                            capture?.stdout.close();
                        }
                    `], { env, encoding: 'utf8' });
                    assert.equal(result.status, 0, result.stderr);
                    const records = drain(f.spool);
                    assert.equal(records.length > 0, flag === '1' && instance === 'tenant-a');
                    assert.ok(!records.some(r => r.text.includes('must not cross instance')));
                }
            }
        }
    } finally { f.close(); }
});

test('native source uncertainty is separate from bounded collected spool bytes', () => {
    const f = fixture();
    try {
        const native = { provider: 'codex', agent: 'agent-a', source: 'native-state' };
        f.spool.report(native, 'protected-native-state', 123);
        let status = f.spool.status() as any;
        assert.equal(status.nativeSources.sources[0].measuredBytes, 123);
        assert.equal(status.nativeSources.growthBounded, false);
        assert.equal(status.nativeSources.inventoryComplete, false);
        f.spool.report(native, 'scan-limit');
        f.spool.report(native, 'protected-native-state', f.spool.limits.protectedBytes);
        f.spool.report({ provider: 'claude', agent: 'unknown', source: 'shared-tmp-claude-logs' }, 'ownership-unverified');
        status = f.spool.status() as any;
        assert.ok(status.nativeSources.sources.every((s: any) => s.measuredBytes === null && s.measurement === 'unknown'));
        assert.ok(status.sources.every((s: any) => s.protectedBytes === null));
        assert.deepEqual(status.spool, { segments: 0, bytes: 0 });
        assert.ok(status.nativeSources.unmeasured.includes('container-only'));
        assert.throws(() => f.spool.assertCapacity(), /protected native state/);
    } finally { f.close(); }
});

test('mature segments accept a 2,000 record batch without CPU deadline losses', () => {
    const f = fixture();
    try {
        f.spool.append(identity, Array.from({ length: 4 }, () => JSON.stringify({ message: 'x'.repeat(50_000) })), 'jsonl', { credentials: [] });
        const started = performance.now();
        f.spool.append(identity, Array.from({ length: 2000 }, (_, n) => JSON.stringify({ n, message: 'ordinary output' })), 'jsonl', { credentials: [] });
        assert.ok(performance.now() - started < 1000, 'batch should finish comfortably without per-record recompression');
        assert.equal(drain(f.spool).flatMap(e => e.text.trim().split('\n')).length, 2004);
        assert.equal((f.spool.status() as any).sources[0].gaps, 0);
    } finally { f.close(); }
});

test('ordinary homes and incomplete inventories never fabricate capacity', () => {
    const f = fixture();
    try {
        const home = path.join(f.root, 'home');
        fs.mkdirSync(path.join(home, 'projects/project'), { recursive: true });
        for (let n = 0; n < 40; n++) fs.writeFileSync(path.join(home, `projects/project/session-${n}.jsonl`), '{"message":"hello"}\n');
        for (let n = 0; n < 2; n++) collectProvider(f.spool, { provider: 'claude', agent: 'a', root: home, credentials: [], credentialContextComplete: true });
        assert.doesNotThrow(() => f.spool.assertCapacity());
        assert.equal((f.spool.status() as any).sources.find((s: any) => s.source === 'native-state').inventoryComplete, true);
        fs.renameSync(home, home + '-moved');
        collectProvider(f.spool, { provider: 'claude', agent: 'a', root: home, credentials: [], credentialContextComplete: true });
        assert.equal((f.spool.status() as any).sources.find((s: any) => s.source === 'native-state').inventoryComplete, false);
        fs.renameSync(home + '-moved', home);
        const limited = new ManagedLogSpool(path.join(f.root, 'limited'), 'tenant-a', { scanFiles: 1 });
        try {
            collectProvider(limited, { provider: 'claude', agent: 'a', root: home, credentials: [] });
            assert.doesNotThrow(() => limited.assertCapacity());
            const state = (limited.status() as any).sources[0];
            assert.equal(state.inventoryComplete, false);
            assert.equal(state.capacityWarning, false);
        } finally { limited.close(); }
    } finally { f.close(); }
});

test('short configuration values survive substring redaction', () => {
    const output = redactRecord('{"message":"run 123 production !propr opaque-secret-canary"}', 'jsonl', ['1', '!propr', 'opaque-secret-canary'])!;
    assert.ok(output.includes('123 production !propr'));
    assert.ok(!output.includes('opaque-secret-canary'));
});

test('unknown native run context refuses content while complete context redacts both copies', () => {
    const f = fixture();
    try {
        const home = path.join(f.root, 'vibe');
        fs.mkdirSync(path.join(home, 'logs/session/run'), { recursive: true });
        fs.writeFileSync(path.join(home, 'logs/session/run/messages.jsonl'), '{"message":"opaque-run-canary"}\n');
        collectProvider(f.spool, { provider: 'vibe', agent: 'a', root: home, credentials: [] });
        assert.equal(f.spool.exportOne(), null);
        const env = { ...process.env, PROPR_MANAGED_LOGS: '1', PROPR_DIAGNOSTIC_ROOT: path.join(f.root, 'spool'), PROPR_INSTANCE_ID: 'tenant-a' };
        const script = `import assert from 'node:assert/strict';
            import { prepareProviderCapture, captureApplicationRecord, flushApplicationRecords, configuredDiagnosticSecrets, managedDiagnostics } from './packages/core/src/diagnostics/managedLogRuntime.ts';
            assert.deepEqual(configuredDiagnosticSecrets({DEBUG:'1', NODE_ENV:'production', PR_FOLLOWUP_TRIGGER_KEYWORDS:'!propr', MISTRAL_API_KEY:'opaque-run-canary'}), ['opaque-run-canary']);
            managedDiagnostics().report({provider:'vibe',agent:'other',source:'native-state'}, 'protected-native-state', 999999999);
            const capture = prepareProviderCapture({provider:'vibe', agent:'a', nativeCredentialContextComplete:true, nativeRoot:${JSON.stringify(home)}, credentials:{DEBUG:'1', NODE_ENV:'production'}}, ['-e','MISTRAL_API_KEY=opaque-run-canary']);
            assert.ok(capture);
            capture.stdout.write('INFO 123 production opaque-run-canary\\n'); capture.stdout.close(); capture.snapshot();
            const db = managedDiagnostics(); const append = db.append.bind(db); let calls = 0;
            db.append = (...args) => { calls++; return append(...args); };
            for (let n=0;n<100;n++) captureApplicationRecord(JSON.stringify({message:'123 production opaque-run-canary',n}));
            assert.equal(calls,0); flushApplicationRecords(); assert.equal(calls,1);`;
        const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { env, encoding: 'utf8', timeout: 10000 });
        assert.equal(result.status, 0, result.stderr);
        const output = drain(f.spool).map(e => e.text).join('');
        assert.ok(output.includes('123 production'));
        assert.ok(!output.includes('opaque-run-canary'));
        assert.equal(output.trim().split('\n').length, 102);
    } finally { f.close(); }
});

test('transient roots retire only on confirmed absence and preserve concurrent roots after restart', () => {
    const f = fixture();
    try {
        const roots = ['run-a', 'run-b'].map(name => path.join(f.root, name));
        for (const root of roots) {
            fs.mkdirSync(path.join(root, 'logs/session/run'), { recursive: true });
            fs.writeFileSync(path.join(root, 'logs/session/run/messages.jsonl'), '{"message":"hello"}\n');
            collectProvider(f.spool, { provider: 'vibe', agent: 'a', root, credentials: [], credentialContextComplete: true, transient: true });
        }
        const who = { provider: 'vibe', agent: 'a' };
        f.spool.retireNativeRoot(who, roots[0]);
        let native = (f.spool.status() as any).sources.filter((s: any) => s.source.startsWith('native-state:'));
        assert.ok(native.every((s: any) => s.protectedBytes > 0));
        fs.rmSync(roots[0], { recursive: true });
        f.spool.retireNativeRoot(who, roots[0]);
        const restarted = new ManagedLogSpool(path.join(f.root, 'spool'), 'tenant-a');
        try {
            native = (restarted.status() as any).sources.filter((s: any) => s.source.startsWith('native-state:'));
            assert.deepEqual(native.map((s: any) => s.protectedBytes).sort((a: number, b: number) => a-b), [20]);
        } finally { restarted.close(); }
        assert.equal(drain(f.spool).length, 2);
    } finally { f.close(); }
});

test('Antigravity capture uses the effective override and refuses unavailable authentication', () => {
    const f = fixture();
    try {
        const actual = path.join(f.root, '.gemini'); fs.mkdirSync(actual);
        fs.writeFileSync(path.join(actual, 'oauth_creds.json'), '{"access_token":"opaque-actual-root-canary"}');
        const env = { ...process.env, PROPR_MANAGED_LOGS: '1', PROPR_DIAGNOSTIC_ROOT: path.join(f.root, 'spool'), PROPR_INSTANCE_ID: 'tenant-a', ANTIGRAVITY_CONFIG_PATH: actual };
        const script = `import assert from 'node:assert/strict';
            import fs from 'node:fs';
            import { antigravityCredentialRoot } from './packages/core/src/diagnostics/credentialRedaction.ts';
            import { prepareProviderCapture, providerCredentialRoot } from './packages/core/src/diagnostics/managedLogRuntime.ts';
            const saved = '/saved/absolute/root';
            const effective = antigravityCredentialRoot(saved, value => value);
            assert.equal(effective, process.env.ANTIGRAVITY_CONFIG_PATH);
            const agent = {provider:'antigravity',agent:'a',configPath:saved};
            assert.equal(providerCredentialRoot(agent, value => value), effective);
            const capture = prepareProviderCapture({...agent, authenticationRoot:effective});
            assert.ok(capture); capture.stdout.write('INFO opaque-actual-root-canary\\n'); capture.stdout.close();
            fs.writeFileSync(effective + '/oauth_creds.json', '{invalid');
            assert.equal(prepareProviderCapture({...agent, authenticationRoot:effective}), null);
            assert.equal(prepareProviderCapture({...agent, authenticationRoot:effective + '/missing'}), null);
            assert.equal(prepareProviderCapture(agent), null);`;
        const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { env, encoding: 'utf8', timeout: 10000 });
        assert.equal(result.status, 0, result.stderr);
        const output = drain(f.spool).map(e => e.text).join('');
        assert.ok(output.includes('REDACTED')); assert.ok(!output.includes('opaque-actual-root-canary'));
        const source = fs.readFileSync('packages/core/src/agents/impl/AntigravityAgent.ts', 'utf8');
        assert.equal((source.match(/authenticationRoot: this.getHostConfigPath\(\)/g) ?? []).length, 3);
    } finally { f.close(); }
});

test('retired transient sources release capacity while pending exports survive restart', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'diagnostic-retirement-'));
    let spool = new ManagedLogSpool(path.join(root, 'spool'), 'tenant-a', { sources: 4 });
    try {
        for (let n = 0; n < 3; n++) {
            const home = path.join(root, `run-${n}`);
            fs.mkdirSync(path.join(home, 'logs/session/run'), { recursive: true });
            fs.writeFileSync(path.join(home, 'logs/session/run/messages.jsonl'), JSON.stringify({ message: `run-${n}` }) + '\n');
            collectProvider(spool, { provider: 'vibe', agent: 'a', root: home, credentials: [], credentialContextComplete: true, transient: true });
            fs.rmSync(home, { recursive: true });
            spool.close();
            spool = new ManagedLogSpool(path.join(root, 'spool'), 'tenant-a', { sources: 4 });
            spool.retireNativeRoot({ provider: 'vibe', agent: 'other' }, home);
            assert.ok((spool.status() as any).sources.some((s: any) => !s.retired));
            spool.retireNativeRoot({ provider: 'vibe', agent: 'a' }, home);
            spool.retireNativeRoot({ provider: 'vibe', agent: 'a' }, path.join(root, 'never-collected'));
            assert.equal((spool.status() as any).sourceCapacityWarning, false);
            spool.assertCapacity();
        }
        assert.equal((spool.status() as any).sources.length, 3);
        assert.ok((spool.status() as any).sources.every((s: any) => s.retired));
        spool.append(identity, ['INFO new agent'], 'text', { credentials: [] });
        assert.deepEqual(drain(spool).map(item => item.text.trim()), [
            '{"message":"run-0"}', '{"message":"run-1"}', '{"message":"run-2"}', '{"message":"INFO new agent"}',
        ]);
        assert.equal((spool.status() as any).sources.length, 1);
    } finally { spool.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('new agent capture remains available after transient root churn at a four-source cap', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'diagnostic-churn-'));
    try {
        const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
            import assert from 'node:assert/strict';
            import fs from 'node:fs';
            import { managedDiagnostics, prepareProviderCapture } from './packages/core/src/diagnostics/managedLogRuntime.ts';
            import { collectProvider } from './packages/core/src/diagnostics/providerCollector.ts';
            const db = managedDiagnostics(); db.limits.sources = 4;
            for (let n = 0; n < 3; n++) {
                const root = ${JSON.stringify(root)} + '/run-' + n;
                fs.mkdirSync(root + '/logs/session/run', {recursive:true});
                fs.writeFileSync(root + '/logs/session/run/messages.jsonl', '{"message":"hello"}\\n');
                collectProvider(db, {provider:'vibe', agent:'old', root, credentials:[], credentialContextComplete:true, transient:true});
                fs.rmSync(root, {recursive:true});
                db.retireNativeRoot({provider:'vibe',agent:'old'}, root);
            }
            const capture = prepareProviderCapture({provider:'vibe',agent:'new',authenticationRoot:${JSON.stringify(root)}});
            assert.ok(capture); capture.stdout.write('INFO working\\n'); capture.stdout.close(); capture.stderr.close();
        `], { encoding: 'utf8', env: { ...process.env, PROPR_MANAGED_LOGS: '1', PROPR_INSTANCE_ID: 'tenant-a', PROPR_DIAGNOSTIC_ROOT: path.join(root, 'spool') } });
        assert.equal(result.status, 0, result.stderr);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('unavailable spool does not block executor or daemon and capture retries after storage repair', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'diagnostic-unavailable-'));
    try {
        for (const failure of ['missing-parent', 'public-root']) {
            const spoolRoot = path.join(root, failure, 'spool');
            if (failure === 'public-root') fs.mkdirSync(spoolRoot, { recursive: true, mode: 0o755 });
            const result = spawnSync(process.execPath, ['--experimental-test-module-mocks', '--import', 'tsx', '-e', `
                import assert from 'node:assert/strict';
                import fs from 'node:fs';
                import path from 'node:path';
                import { mock } from 'node:test';
                class Redis { on(){return this} async quit(){} disconnect(){} }
                mock.module('ioredis', {namedExports:{Redis,default:Redis}});
                const { executeDockerCommand } = await import('./packages/core/src/claude/docker/dockerExecutor.ts');
                const { prepareProviderCapture, captureProviderOutput } = await import('./packages/core/src/diagnostics/managedLogRuntime.ts');
                const { scheduleManagedDiagnostics } = await import('./src/daemon/managedDiagnostics.ts');
                const diagnostics = {provider:'vibe',agent:'new',authenticationRoot:${JSON.stringify(root)}};
                assert.equal(prepareProviderCapture(diagnostics), null);
                captureProviderOutput({...diagnostics, source:'stdout'}, []).close();
                const stop = scheduleManagedDiagnostics(); stop();
                const result = await executeDockerCommand(process.execPath, ['-e','process.stdout.write("working")'], {diagnostics,timeout:10000});
                assert.equal(result.exitCode, 0); assert.equal(result.stdout, 'working');
                fs.mkdirSync(path.dirname(process.env.PROPR_DIAGNOSTIC_ROOT), {recursive:true});
                if (fs.existsSync(process.env.PROPR_DIAGNOSTIC_ROOT)) fs.chmodSync(process.env.PROPR_DIAGNOSTIC_ROOT, 0o700);
                const capture = prepareProviderCapture(diagnostics);
                assert.ok(capture); capture.stdout.close(); capture.stderr.close();
                const { closeConnection } = await import('./packages/core/src/db/connection.ts'); await closeConnection();
            `], { encoding: 'utf8', timeout: 30000, env: { ...process.env, NODE_ENV: 'test', PROPR_MANAGED_LOGS: '1', PROPR_INSTANCE_ID: 'tenant-a', PROPR_DIAGNOSTIC_ROOT: spoolRoot } });
            assert.equal(result.status, 0, result.stderr);
            assert.equal(result.stderr.split('managed diagnostics unavailable').length - 1, 1);
        }
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('executor and native goal admission retain create and final argument secrets', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'diagnostic-admitted-'));
    try {
        for (const entry of ['executor', 'claude', 'antigravity', 'codex']) {
            const result = spawnSync(process.execPath, ['--experimental-test-module-mocks', '--import', 'tsx', '-e', `
                import assert from 'node:assert/strict';
                import { mock } from 'node:test';
                import { gunzipSync } from 'node:zlib';
                class Redis { on(){return this} async quit(){} disconnect(){} }
                mock.module('ioredis', {namedExports:{Redis,default:Redis}});
                const runtime = await import('./packages/core/src/diagnostics/managedLogRuntime.ts');
                const create = ['run','-e','GITHUB_TOKEN=opaque-create-canary','image'];
                const final = ['start','--attach','--interactive','container','--env','RUN_SECRET=opaque-final-canary'];
                let captures = 0;
                const capture = (agent, args, env, createArgs) => {
                    captures++;
                    assert.ok(createArgs.includes('GITHUB_TOKEN=opaque-create-canary'));
                    assert.ok(!createArgs.includes('RUN_SECRET=opaque-final-canary'));
                    assert.deepEqual(args, final);
                    const result = runtime.prepareProviderCapture({...agent,authenticationRoot:${JSON.stringify(root)}}, args, env, createArgs);
                    assert.ok(result);
                    result.stdout.write('INFO opaque-create-canary opaque-final-canary\\n'); result.stdout.close(); result.stderr.close();
                    throw new Error('capture-verified');
                };
                mock.module('./packages/core/src/diagnostics/managedLogRuntime.ts', {namedExports:{...runtime,
                    prepareProviderCapture:capture, prepareCommandCapture:capture}});
                mock.module('./packages/core/src/claude/docker/dockerNetworkPolicy.ts', {namedExports:{
                    startWithNetworkPolicy:async (_command,args,_options,start) => start(args),
                    spawnWithNetworkPolicy:async (_args,start) => {await Promise.resolve(); return start(final)},
                }});
                mock.module('./packages/core/src/agents/agentRunAdmission.ts', {namedExports:{
                    prepareAdmittedAgent:async () => ({args:final,finish:async()=>{}}),
                }});
                const options = {nativeGoalObjective:'test',taskId:'diagnostic-test',goalControl:{
                    setActiveTurn:async()=>{},appendOutput:async()=>{},load:async()=>({desiredState:'running',pendingInputs:[]})},issueRef:{number:1}};
                const diagnostics = {provider:'vibe',agent:'admitted'};
                const launch = {diagnostics,buildDockerArgs:async()=>create,sessionId:'s',model:'test',timeoutMs:1000};
                let failure;
                try {
                    if (${JSON.stringify(entry)} === 'executor') {
                        const {executeDockerCommand} = await import('./packages/core/src/claude/docker/dockerExecutor.ts');
                        await executeDockerCommand('docker',create,{diagnostics,timeout:1000});
                    } else if (${JSON.stringify(entry)} === 'claude') {
                        const {executeClaudeNativeGoal} = await import('./packages/core/src/agents/impl/claudeNativeGoal.ts');
                        await executeClaudeNativeGoal(options,launch);
                    } else if (${JSON.stringify(entry)} === 'antigravity') {
                        const {executeAntigravityNativeGoal} = await import('./packages/core/src/agents/impl/antigravityNativeGoal.ts');
                        await executeAntigravityNativeGoal(options,launch);
                    } else {
                        mock.module('./packages/core/src/agents/agentGitAccess.ts',{namedExports:{prepareAgentGitAccess:async()=>({gitMountArgs:[]})}});
                        mock.module('./packages/core/src/agents/impl/utils/codexDockerArgsBuilder.ts',{namedExports:{buildCodexAppServerDockerArgs:()=>create}});
                        const {executeCodexAppServerGoal} = await import('./packages/core/src/agents/impl/codexAppServer.ts');
                        await executeCodexAppServerGoal({id:'admitted',type:'codex',defaultModel:'test'},options,1000);
                    }
                } catch (error) { failure = error; }
                assert.equal(captures,1,failure?.stack);
                const item = runtime.managedDiagnostics().exportOne(); assert.ok(item, failure?.stack);
                const text = gunzipSync(item.data).toString();
                assert.ok(!text.includes('opaque-create-canary')); assert.ok(!text.includes('opaque-final-canary'));
                const {closeConnection} = await import('./packages/core/src/db/connection.ts'); await closeConnection();
            `], { encoding: 'utf8', timeout: 30000, env: { ...process.env, NODE_ENV: 'test', PROPR_MANAGED_LOGS: '1', PROPR_INSTANCE_ID: 'tenant-a', PROPR_DIAGNOSTIC_ROOT: path.join(root, entry) } });
            assert.equal(result.status, 0, `${entry}: ${result.stderr}`);
        }
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('credential cache evicts at count and byte bounds without disabling application capture', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'diagnostic-credential-eviction-'));
    try {
        const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
            import assert from 'node:assert/strict';
            import { gunzipSync } from 'node:zlib';
            import { rememberDiagnosticCredentials, diagnosticCredentials } from './packages/core/src/diagnostics/redaction.ts';
            import { captureApplicationRecord, flushApplicationRecords, managedDiagnostics } from './packages/core/src/diagnostics/managedLogRuntime.ts';
            const values = Array.from({length:600}, (_, n) => 'opaque-' + String(n).padStart(9, '0'));
            rememberDiagnosticCredentials(values);
            assert.deepEqual(diagnosticCredentials(), values.slice(88));
            rememberDiagnosticCredentials([values[599]]);
            assert.equal(diagnosticCredentials().length, 512);
            const checkCapture = (message) => {
                captureApplicationRecord(JSON.stringify({message})); flushApplicationRecords();
                const db = managedDiagnostics(), item = db.exportOne(); assert.ok(item);
                assert.equal(JSON.parse(gunzipSync(item.data).toString()).message, 'x [REDACTED] [REDACTED]');
                assert.equal(db.status().sources.find(s => s.source === 'pino').gaps, 0);
                db.acknowledge(item.id, item.digest);
            };
            checkCapture('x ' + values[599] + ' environment-canary');
            const large = Array.from({length:6}, (_, n) => String(n) + 'z'.repeat(100 * 1024 - 1));
            rememberDiagnosticCredentials(large);
            assert.deepEqual(diagnosticCredentials(), large.slice(1));
            rememberDiagnosticCredentials(['q'.repeat(512 * 1024 + 1), 'newest-opaque-canary']);
            assert.ok(diagnosticCredentials().includes('newest-opaque-canary'));
            assert.ok(diagnosticCredentials().reduce((n, v) => n + v.length, 0) <= 512 * 1024);
            checkCapture('x newest-opaque-canary environment-canary');
            managedDiagnostics().close();
        `], { encoding: 'utf8', timeout: 10000, env: { ...process.env, PROPR_MANAGED_LOGS: '1', PROPR_INSTANCE_ID: 'tenant-a', PROPR_DIAGNOSTIC_ROOT: path.join(root, 'spool'), TEST_DIAGNOSTIC_SECRET: 'environment-canary' } });
        assert.equal(result.status, 0, result.stderr);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

for (const format of ['text', 'jsonl'] as const) test(`${format} rejected records leave sequence holes without fragmenting segments`, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'diagnostic-sequence-holes-'));
    const spool = new ManagedLogSpool(path.join(root, 'spool'), 'tenant-a', { segments: 4 });
    const accepted = (n: number) => format === 'text' ? `INFO ok-${n}` : JSON.stringify({ message: `INFO ok-${n}` });
    try {
        // Exercise holes both inside a batch and across separate collection calls.
        spool.append(identity, Array.from({ length: 10 }, (_, n) => [accepted(n), 'plain']).flat(), format, { credentials: [] });
        for (let n = 10; n < 20; n++) {
            spool.append(identity, [accepted(n)], format, { credentials: [] });
            spool.append(identity, ['plain'], format, { credentials: [] });
        }
        const status = spool.status() as any;
        assert.equal(status.spool.segments, 1);
        assert.ok(status.spool.bytes < spool.limits.spoolBytes / 100);
        assert.equal(status.sources[0].gaps, 20);
        assert.equal(status.sources[0].droppedBytes, 20 * 6);
        assert.equal(status.sources[0].reason, 'unsafe-record');
        assert.equal(status.sources[0].nextSequence, 41);
        const exported = spool.exportOne()!;
        assert.equal((exported.manifest as any).firstSequence, 1);
        assert.equal((exported.manifest as any).lastSequence, 39);
        assert.deepEqual(gunzipSync(exported.data).toString().trim().split('\n').map(line => JSON.parse(line).message),
            Array.from({ length: 20 }, (_, n) => `INFO ok-${n}`));
        // Export seals the segment: later holes must not let a writer mutate it.
        spool.append(identity, ['plain', accepted(20)], format, { credentials: [] });
        const repeated = spool.exportOne()!;
        assert.equal(repeated.id, exported.id);
        assert.equal(repeated.digest, exported.digest);
        assert.deepEqual(repeated.data, exported.data);
        assert.equal((repeated.manifest as any).lastSequence, 39);
        assert.throws(() => spool.acknowledge(exported.id, 'wrong'));
        spool.acknowledge(exported.id, exported.digest);
        const remaining = drain(spool);
        assert.equal(remaining.length, 1);
        assert.equal(JSON.parse(remaining[0].text).message, 'INFO ok-20');
        assert.equal(remaining[0].manifest.firstSequence, 42);
    } finally { spool.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
