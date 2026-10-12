import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { inspectNativeLogRoot } from '../src/diagnostics/nativeLogPolicy.js';

// Explicit opt-in: exercises only a newly-created private localhost process,
// never a customer provider or credentials. No model request is made.
test('installed OpenCode 1.18.31 retains real active native descriptors and serves UI requests during inventory', {
    skip: process.env.PROPR_NATIVE_LOG_LIVE !== '1', timeout: 20_000,
}, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-opencode-live-'));
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: path.join(root, 'home'),
        XDG_CONFIG_HOME: path.join(root, 'config'), XDG_DATA_HOME: path.join(root, 'data'),
        XDG_STATE_HOME: path.join(root, 'state'), XDG_CACHE_HOME: path.join(root, 'cache'),
        OPENCODE_DISABLE_MODELS_FETCH: '1', OPENCODE_DISABLE_AUTOUPDATE: '1', OPENCODE_PURE: '1',
        OPENCODE_SERVER_PASSWORD: 'fixture-private-password' };
    for (const key of ['HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME']) fs.mkdirSync(env[key]!);
    const executable = process.env.PROPR_NATIVE_OPENCODE_BINARY || 'opencode';
    const version = spawnSync(executable, ['--version'], { env, encoding: 'utf8', timeout: 5000 });
    assert.equal(version.status, 0); assert.equal(version.stdout.trim(), '1.18.31');
    const socket = net.createServer();
    await new Promise<void>(resolve => socket.listen(0, '127.0.0.1', resolve));
    const port = (socket.address() as net.AddressInfo).port;
    await new Promise<void>((resolve, reject) => socket.close(error => error ? reject(error) : resolve()));
    const child = spawn(executable, ['serve', '--hostname', '127.0.0.1', '--port', String(port), '--print-logs'], { env, cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', spawnError: Error | undefined;
    child.on('error', error => { spawnError = error; });
    child.stdout.on('data', (data: Buffer) => { stdout = (stdout + data.toString()).slice(-8192); });
    child.stderr.on('data', (data: Buffer) => { stderr = (stderr + data.toString()).slice(-8192); });
    const exited = new Promise<void>(resolve => child.once('close', () => resolve()));
    const home = path.join(env.XDG_DATA_HOME!, 'opencode');
    const original = path.join(home, 'log', 'opencode.log');
    try {
        for (let n = 0; n < 100 && !stdout.includes('server listening'); n++) {
            if (spawnError) throw spawnError;
            if (child.exitCode !== null) throw new Error('isolated provider failed to start');
            await delay(50);
        }
        assert.match(stdout, /server listening/);
        // The native sink buffers writes independently of the listener becoming
        // ready. Wait for its flush rather than equating a zero-byte file with
        // a disabled writer.
        for (let n = 0; n < 100 && (!fs.existsSync(original) || fs.statSync(original).size === 0); n++) await delay(50);
        assert.ok(fs.statSync(original).size > 0, '--print-logs must not be mistaken for native log elimination');
        const stat = fs.statSync(original);
        const descriptors = () => fs.readdirSync(`/proc/${child.pid}/fd`).filter(fd => {
            try { const s = fs.statSync(`/proc/${child.pid}/fd/${fd}`); return s.dev === stat.dev && s.ino === stat.ino; }
            catch { return false; }
        });
        const before = descriptors(); assert.ok(before.length > 0);
        fs.writeFileSync(path.join(home, 'preserved-session.jsonl'), 'RESUME-CANARY');
        for (let n = 0; n < 3; n++) {
            const inventory = inspectNativeLogRoot({ provider: 'opencode', agent: 'isolated-test', root: home });
            assert.ok(inventory.bytes.diagnostic >= stat.size);
            assert.deepEqual(descriptors(), before);
            assert.equal(fs.statSync(original).ino, stat.ino);
            const response = await fetch(`http://127.0.0.1:${port}/global/health`, {
                headers: { authorization: `Basic ${Buffer.from('opencode:fixture-private-password').toString('base64')}` },
                signal: AbortSignal.timeout(2000),
            });
            assert.equal(response.status, 200);
            assert.equal((await response.json() as { version: string }).version, '1.18.31');
        }
        assert.match(stderr, /level=INFO/);
        assert.equal(fs.readFileSync(path.join(home, 'preserved-session.jsonl'), 'utf8'), 'RESUME-CANARY');
        assert.equal(child.exitCode, null);
    } finally {
        // Only the test-owned child is terminated; native production writers
        // are never signalled by the policy under test.
        child.kill('SIGTERM');
        await Promise.race([exited, delay(2000)]);
        if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
        fs.rmSync(root, { recursive: true, force: true });
    }
});
