/**
 * The idle exit contract on a Fly Machine (#3770), against a real process: an
 * app exit 0 does not stop a multi-container Machine (Redis keeps it started),
 * so the idle stop must have the Machines API stop the whole Machine first,
 * and must exit 1 (the restart policy starts the app again) whenever that
 * stop was not accepted. A local HTTP server plays `_api.internal:4280`.
 */
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { FLY_MACHINE_STOP_TOKEN_SECRET } from '../packages/cli/src/commands/deploy/flyMachineConfig.js';
import { FLY_MACHINE_STOP_TOKEN_ENV, resolveFlyMachineStop } from '../src/flyMachineStop.js';

interface StopRequest { method?: string; url?: string; authorization?: string; body: string }

async function machinesApi(respond: (res: ServerResponse, child: () => ChildProcess) => void): Promise<{ url: string; requests: StopRequest[]; setChild(child: ChildProcess): void; close(): Promise<void> }> {
    const requests: StopRequest[] = [];
    let child: ChildProcess | undefined;
    const server = createServer((req: IncomingMessage, res) => {
        let body = '';
        req.on('data', chunk => { body += String(chunk); });
        req.on('end', () => {
            requests.push({ method: req.method, url: req.url, authorization: req.headers.authorization, body });
            respond(res, () => child!);
        });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    return {
        url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        requests,
        setChild: value => { child = value; },
        close: () => new Promise(resolve => { server.closeAllConnections(); server.close(() => resolve()); }),
    };
}

async function runIdleStop(env: NodeJS.ProcessEnv, api?: Awaited<ReturnType<typeof machinesApi>>): Promise<{ code: number | null; output: string; elapsed: number }> {
    const tsx = createRequire(import.meta.url).resolve('tsx/cli');
    const fixture = fileURLToPath(new URL('./fixtures/allInOneIdleHostStop.ts', import.meta.url));
    const cleanEnv = { ...process.env };
    for (const key of ['FLY_APP_NAME', 'FLY_MACHINE_ID', FLY_MACHINE_STOP_TOKEN_ENV]) delete cleanEnv[key];
    const child = spawn(process.execPath, [tsx, fixture], { env: { ...cleanEnv, ...env, FLY_STOP_TEST_API_URL: api?.url }, stdio: ['pipe', 'pipe', 'pipe'] });
    api?.setChild(child);
    let output = '';
    child.stderr!.on('data', chunk => { output += String(chunk); });
    const exited = new Promise<number | null>(resolve => child.on('exit', code => resolve(code)));
    await new Promise<void>((resolve, reject) => {
        child.stdout!.on('data', chunk => { output += String(chunk); if (output.includes('ready')) resolve(); });
        child.on('exit', () => reject(new Error(`fixture exited before it was ready:\n${output}`)));
    });
    const startedAt = Date.now();
    child.stdin!.write('idle\n');
    const kill = setTimeout(() => child.kill('SIGKILL'), 15_000);
    const code = await exited;
    clearTimeout(kill);
    return { code, output, elapsed: Date.now() - startedAt };
}

const FLY_ENV = { FLY_APP_NAME: 'propr-test', FLY_MACHINE_ID: '148e21ef5d6e89', [FLY_MACHINE_STOP_TOKEN_ENV]: 'FlyV1 fm2_test' };

test('on a Fly Machine the idle exit stops the whole Machine, then exits 0', { timeout: 30_000 }, async () => {
    const api = await machinesApi(res => { res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ok":true}'); });
    try {
        const { code, output } = await runIdleStop(FLY_ENV, api);
        assert.equal(code, 0, output);
        assert.deepEqual(api.requests, [{ method: 'POST', url: '/v1/apps/propr-test/machines/148e21ef5d6e89/stop', authorization: 'FlyV1 fm2_test', body: '{}' }]);
        assert.match(output, /the host accepted the idle stop; exiting with code 0/);
    } finally {
        await api.close();
    }
});

test('the SIGTERM Fly sends while it stops the Machine counts as the stop accepted: exit 0', { timeout: 30_000 }, async () => {
    // Fly may signal the app before it answers the stop request.
    const api = await machinesApi((_res, child) => { child().kill('SIGTERM'); });
    try {
        const { code, output } = await runIdleStop(FLY_ENV, api);
        assert.equal(code, 0, output);
        assert.equal(api.requests.length, 1);
        assert.match(output, /SIGTERM received while the host was asked to stop; exiting with code 0/);
    } finally {
        await api.close();
    }
});

test('a stop the Machines API refuses exits 1, so the app restarts instead of leaving the Machine started and unreachable', { timeout: 30_000 }, async () => {
    const api = await machinesApi(res => { res.writeHead(401).end('unauthorized'); });
    try {
        const { code, output } = await runIdleStop(FLY_ENV, api);
        assert.equal(code, 1, output);
        assert.match(output, /the host did not accept the idle stop; exiting with code 1.*HTTP 401: unauthorized/);
        assert.doesNotMatch(output, /fm2_test/, 'the token is never logged');
    } finally {
        await api.close();
    }
});

test('a stop the Machines API never answers exits 1 after the host stop timeout', { timeout: 30_000 }, async () => {
    const api = await machinesApi(() => undefined);
    try {
        const { code, output, elapsed } = await runIdleStop({ ...FLY_ENV, HOST_STOP_TEST_TIMEOUT_MS: '500' }, api);
        assert.equal(code, 1, output);
        assert.ok(elapsed < 10_000, `exited ${elapsed} ms after the idle stop`);
        assert.match(output, /the host did not accept the idle stop/);
    } finally {
        await api.close();
    }
});

test('off Fly the idle exit is the stop: no Machines API call, exit 0', { timeout: 30_000 }, async () => {
    const { code, output } = await runIdleStop({});
    assert.equal(code, 0, output);
    assert.match(output, /idle stop \(not_fly\)/);
});

test('a Fly Machine without the stop token cannot stop itself, and says so', () => {
    assert.equal(FLY_MACHINE_STOP_TOKEN_ENV, FLY_MACHINE_STOP_TOKEN_SECRET, 'the app reads the secret propr deploy fly sets');
    assert.deepEqual(resolveFlyMachineStop({}), { kind: 'not_fly' });
    const missing = resolveFlyMachineStop({ FLY_APP_NAME: 'propr-test', FLY_MACHINE_ID: 'm1' });
    assert.equal(missing.kind, 'unavailable');
    assert.match((missing as { problem: string }).problem, /PROPR_FLY_MACHINE_STOP_TOKEN not set; an exit would leave Redis and the other containers running/);
    const ready = resolveFlyMachineStop({ FLY_APP_NAME: 'propr-test', FLY_MACHINE_ID: 'm1', [FLY_MACHINE_STOP_TOKEN_ENV]: ' raw-token ' });
    assert.equal(ready.kind, 'ready');
});
