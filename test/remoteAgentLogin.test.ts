import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, test } from 'node:test';
import { FLY_LOGIN_DIR, flyLoginRelayScript, parseFlyLoginPoll, startFlyLogin } from '../packages/core/src/agents/runtime/fly/flyLogin.js';
import { MachinesHttpError, type MachineLaunch, type MachinesApi } from '../packages/core/src/agents/runtime/fly/api.js';
import type { FlyConfig } from '../packages/core/src/agents/runtime/fly/config.js';
import { startSpriteLogin } from '../packages/core/src/agents/runtime/sprites/spritesLogin.js';
import { SpritePoolCapacityError } from '../packages/core/src/agents/runtime/sprites/spritesProvisioning.js';
import { RemoteLoginCapacityError, parseRemoteFileReply } from '../packages/core/src/agents/runtime/remoteLogin.js';
import { checkRemoteRuntimeReadiness } from '../packages/core/src/agents/runtime/remoteRuntimeReadiness.js';
import { FlyImageResolutionError, parseImageReference, resolveFlyImage } from '../packages/core/src/agents/runtime/fly/imageResolution.js';
import {
    applyPastedCredential, describePastedCredentials, PastedCredentialError, removePastedCredential, storedLoginPresent,
} from '../packages/core/src/agents/credentials/pastedCredentials.js';
import { readCredentialStoreFile, writeCredentialStoreFiles } from '../packages/core/src/agents/credentials/credentialStoreWriter.js';
import { withCredentialStoreLock } from '../packages/core/src/agents/credentials/credentialStoreLock.js';
import type { AgentConfig } from '../packages/core/src/agents/types.js';

const request = (overrides: Partial<Parameters<typeof startFlyLogin>[2]> = {}) => ({
    agentType: 'claude' as const,
    command: ['claude', 'auth', 'login'],
    directories: ['/home/node/.claude'],
    signal: new AbortController().signal,
    ...overrides,
});

const flyConfig = (overrides: Partial<FlyConfig> = {}): FlyConfig => ({
    token: 'fly-token-value', app: 'agents', image: 'registry.fly.io/agents:bundle', bootTimeout: 2000, credentialRetention: 1,
    maxMachines: undefined, region: undefined, guest: { cpu_kind: 'shared', cpus: 1, memory_mb: 1024 }, ...overrides,
});

const b64 = (value: string) => Buffer.from(value).toString('base64');

/** A Machines API whose login Machine plays back a transcript, then exits with `exitCode`. */
function fakeMachines({ transcript = ['Open https://claude.ai/oauth?code=1\r\n', 'Paste code: '], exitCode = 0, files = {} as Record<string, string>,
    live = 0 } = {}) {
    const calls = { created: [] as MachineLaunch[], destroyed: [] as string[], inputs: [] as string[], polls: 0 };
    let served = 0;
    let exited = false;
    const api: MachinesApi = {
        async create(launch) { calls.created.push(launch); return 'm-1'; },
        async exec(_id, args) {
            const script = args.includes('-c') ? args[args.indexOf('-c') + 1] : '';
            if (script.includes('tail -c')) {
                calls.polls++;
                const chunk = served < transcript.length ? transcript[served++] : '';
                const status = exited && !chunk ? String(exitCode) : '-';
                return { stdout: `${status}\n${b64(chunk)}`, exit_code: 0 };
            }
            if (script.includes('/in"')) {
                calls.inputs.push(args[args.length - 1]);
                exited = true;
                return { stdout: '', exit_code: 0 };
            }
            if (script.includes('base64 -w0 "$1"')) {
                const file = args[args.length - 1];
                return { stdout: file in files ? `F:${b64(files[file])}` : 'M', exit_code: 0 };
            }
            return { stdout: '', exit_code: 0 };
        },
        async signal() {},
        async destroy(id) { calls.destroyed.push(id); },
        async gone() { return true; },
        async find() { return undefined; },
        async list() { return Array.from({ length: live }, (_, index) => ({ id: `x${index}`, name: `propr-${index}`, state: 'started' })); },
        async logs() {},
    };
    return { api, calls };
}

describe('Fly Machines interactive login', () => {
    test('the relay runs the CLI under a PTY as node, keeps the input FIFO open and records the exit status', () => {
        const script = flyLoginRelayScript({ command: ['claude', 'auth', 'login'], environment: { A: "it's" }, directories: ['/home/node/.claude'] });
        assert.match(script, new RegExp(`mkfifo ${FLY_LOGIN_DIR}/in`));
        assert.match(script, /script -qfec '.*su-exec.*node.*env.*-i.*HOME=\/home\/node.*claude.*auth.*login.*'/);
        assert.match(script, /exec 3> \/run\/propr-login\/in/);
        assert.match(script, /mv \/run\/propr-login\/exit.tmp \/run\/propr-login\/exit/);
        assert.match(script, /su-exec node mkdir -p -m 700 '\/home\/node\/.claude'/);
        assert.throws(() => flyLoginRelayScript({ command: ['x'], directories: ['/etc'] }), /Invalid remote login path/);
        assert.throws(() => flyLoginRelayScript({ command: ['x'], directories: ['/home/node/../../etc'] }), /Invalid remote login path/);
    });

    test('poll replies carry the exit status and a base64 transcript chunk', () => {
        assert.deepEqual(parseFlyLoginPoll(`-\n${b64('hi')}`), { chunk: Buffer.from('hi') });
        assert.deepEqual(parseFlyLoginPoll('0\n'), { exitCode: 0, chunk: Buffer.alloc(0) });
        assert.throws(() => parseFlyLoginPoll('boom\n'), /exit status/);
        assert.equal(parseRemoteFileReply('M'), undefined);
        assert.equal(parseRemoteFileReply(`F:${b64('{"a":1}')}`)?.toString(), '{"a":1}');
        assert.throws(() => parseRemoteFileReply('oops'), /Invalid/);
    });

    test('streams the transcript, forwards input, reads the login file back and destroys the Machine', async () => {
        const { api, calls } = fakeMachines({ files: { '/home/node/.claude/.credentials.json': '{"claudeAiOauth":{}}' } });
        const login = await startFlyLogin(api, flyConfig(), request(), { pollMs: 1 });
        const output: string[] = [];
        login.onOutput(chunk => output.push(chunk));
        const [launch] = calls.created;
        assert.match(launch.name, /^propr-login-/);
        assert.equal(launch.config.image, 'registry.fly.io/agents:bundle');
        assert.equal(launch.config.auto_destroy, true);
        assert.deepEqual(launch.config.processes[0].entrypoint, ['/bin/sh', '-c']);
        while (!output.join('').includes('Paste code')) await new Promise(resolve => setTimeout(resolve, 2));
        await login.write('abc\r');
        assert.deepEqual(calls.inputs, ['abc\r']);
        assert.equal(await login.exited, 0);
        assert.match(output.join(''), /Open https:\/\/claude.ai/);
        assert.equal((await login.readFile('/home/node/.claude/.credentials.json'))?.toString(), '{"claudeAiOauth":{}}');
        assert.equal(await login.readFile('/home/node/.claude/missing.json'), undefined);
        await login.close();
        await login.close();
        assert.deepEqual(calls.destroyed, ['m-1']);
    });

    test('fails clearly, without creating a Machine, when PROPR_FLY_MACHINES_MAX Machines already exist', async () => {
        const { api, calls } = fakeMachines({ live: 3 });
        await assert.rejects(startFlyLogin(api, flyConfig({ maxMachines: 3, app: `full-${Date.now()}` }), request(), { pollMs: 1 }),
            (error: Error) => error instanceof RemoteLoginCapacityError && /3 of 3 Machines \(PROPR_FLY_MACHINES_MAX\)/.test(error.message));
        assert.equal(calls.created.length, 0);
    });

    test('reports the organization machine limit (Free Plan) as a capacity error', async () => {
        const { api } = fakeMachines();
        api.create = async () => { throw new MachinesHttpError('POST', 422, 'machine limit reached'); };
        await assert.rejects(startFlyLogin(api, flyConfig({ app: `limit-${Date.now()}` }), request()),
            (error: Error) => error instanceof RemoteLoginCapacityError && /Free Plan allows 3 Machines/.test(error.message));
    });
});

function fakeSprite(files: Record<string, string> = {}) {
    const calls = { exec: [] as string[][], spawned: [] as string[][], stdin: [] as string[] };
    const command = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), kill() {} });
    command.stdin.on('data', chunk => calls.stdin.push(chunk.toString()));
    const sprite = {
        name: 'propr-abc-1',
        async execFile(file: string, args: string[]) {
            calls.exec.push([file, ...args]);
            const target = args[args.length - 1];
            if (args.includes('/bin/sh')) return { stdout: target in files ? `F:${b64(files[target])}` : 'M', stderr: '', exitCode: 0 };
            return { stdout: '', stderr: '', exitCode: 0 };
        },
        spawn(file: string, args: string[]) { calls.spawned.push([file, ...args]); return command; },
    };
    return { sprite, command, calls };
}

describe('Sprites interactive login', () => {
    test('runs the login with a TTY as node on a pooled Sprite and deletes the Sprite afterwards', async () => {
        const { sprite, command, calls } = fakeSprite({ '/home/node/.codex/auth.json': '{"tokens":{}}' });
        const discarded: string[] = [];
        let acquireOptions: unknown;
        const pool = {
            acquire: async (_signal: AbortSignal, _onWaiting?: () => void, _servers?: unknown, options?: unknown) => {
                acquireOptions = options;
                return { sprite } as never;
            },
            discard: async (value: { name: string }) => { discarded.push(value.name); },
        };
        const login = await startSpriteLogin(pool, request({ agentType: 'codex', command: ['codex', 'login', '--device-auth'], directories: ['/home/node/.codex'] }),
            { slotWaitMs: 5000 });
        assert.deepEqual(acquireOptions, { maxQueueMs: 5000 });
        assert.deepEqual(calls.exec[0], ['sudo', '-n', '/usr/local/bin/su-exec', 'node', 'mkdir', '-p', '-m', '700', '/home/node/.codex']);
        const spawned = calls.spawned[0];
        assert.deepEqual(spawned.slice(0, 6), ['sudo', '-n', '/usr/local/bin/su-exec', 'node', 'env', '-i']);
        assert.ok(spawned.includes('HOME=/home/node'));
        assert.deepEqual(spawned.slice(-3), ['codex', 'login', '--device-auth']);
        const output: string[] = [];
        command.stdout.write('Enter code ABCD-1234\n');
        login.onOutput(chunk => output.push(chunk));
        assert.deepEqual(output, ['Enter code ABCD-1234\n']);
        await login.write('\r');
        assert.deepEqual(calls.stdin, ['\r']);
        command.emit('exit', 0);
        assert.equal(await login.exited, 0);
        assert.equal((await login.readFile('/home/node/.codex/auth.json'))?.toString(), '{"tokens":{}}');
        await assert.rejects(login.readFile('/etc/shadow'), /Invalid remote login path/);
        await login.close();
        assert.deepEqual(discarded, ['propr-abc-1']);
    });

    test('a full pool fails with the cap and PROPR_SPRITES_MAX in the message', async () => {
        const pool = {
            acquire: async () => { throw new SpritePoolCapacityError('No Sprite available: cap 3 reached after 30s', 3); },
            discard: async () => {},
        };
        await assert.rejects(startSpriteLogin(pool, request()),
            (error: Error) => error instanceof RemoteLoginCapacityError && /all 3 Sprite slots \(PROPR_SPRITES_MAX\)/.test(error.message));
    });
});

describe('pasted credentials', () => {
    test('Claude keys go into settings.json env, one method at a time, keeping other settings', () => {
        const current = Buffer.from(JSON.stringify({ model: 'opus', env: { FOO: '1', CLAUDE_CODE_OAUTH_TOKEN: 'old-token-value' } }));
        const next = JSON.parse(applyPastedCredential('anthropic-api-key', '  sk-ant-api03-abcdefgh1234  ', current).toString());
        assert.deepEqual(next, { model: 'opus', env: { FOO: '1', ANTHROPIC_API_KEY: 'sk-ant-api03-abcdefgh1234' } });
        const removed = JSON.parse(removePastedCredential('anthropic-api-key', Buffer.from(JSON.stringify(next)))!.toString());
        assert.deepEqual(removed, { model: 'opus', env: { FOO: '1' } });
        assert.throws(() => applyPastedCredential('claude-oauth-token', 'two words', undefined), PastedCredentialError);
        assert.throws(() => applyPastedCredential('claude-oauth-token', 'token-value-1234', Buffer.from('{not json')), /existing settings.json/);
    });

    test('Codex API keys and auth.json documents are validated and written as auth.json', () => {
        assert.deepEqual(JSON.parse(applyPastedCredential('openai-api-key', 'sk-proj-abcdefghijklmnop', undefined).toString()),
            { OPENAI_API_KEY: 'sk-proj-abcdefghijklmnop', tokens: null, last_refresh: null });
        const auth = { tokens: { access_token: 'access-abcdefgh', refresh_token: 'refresh-abcdefgh9876' }, last_refresh: '2026-11-27T00:00:00Z' };
        assert.deepEqual(JSON.parse(applyPastedCredential('codex-auth-json', JSON.stringify(auth), undefined).toString()), auth);
        assert.throws(() => applyPastedCredential('codex-auth-json', '{"tokens":null}', undefined), /neither an OPENAI_API_KEY nor ChatGPT login tokens/);
        assert.throws(() => applyPastedCredential('codex-auth-json', '[]', undefined), /JSON object/);
        assert.equal(removePastedCredential('codex-auth-json', Buffer.from(JSON.stringify(auth))), null);
        assert.throws(() => applyPastedCredential('opencode-auth-json', '{"anthropic":{}}', undefined), /has no "type"/);
    });

    test('status reports set and the last four characters, never the value', () => {
        const files: Record<string, Buffer> = {
            'config:settings.json': applyPastedCredential('claude-oauth-token', 'sk-ant-oat01-secretvalue9z8y', undefined),
            'config:.credentials.json': Buffer.from('{"claudeAiOauth":{}}'),
        };
        const read = (store: string, file: string) => files[`${store}:${file}`];
        const status = describePastedCredentials('claude', read);
        assert.deepEqual(status, [{ kind: 'anthropic-api-key', set: false }, { kind: 'claude-oauth-token', set: true, last4: '9z8y' }]);
        assert.ok(!JSON.stringify(status).includes('secretvalue'));
        assert.equal(storedLoginPresent('claude', read), true);
        assert.equal(storedLoginPresent('codex', () => undefined), false);
    });
});

describe('credential store writer', () => {
    test('replaces files atomically with mode 0600 under the store lock and refuses symlinks', async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'propr-store-'));
        const lock = { lockRoot: path.join(root, '..', `${path.basename(root)}-locks`) };
        try {
            await writeCredentialStoreFiles(root, [{ path: 'settings.json', content: Buffer.from('{"env":{}}\n') }, { path: 'sub/auth.json', content: Buffer.from('{}') }], { lock });
            assert.equal(readCredentialStoreFile(root, 'settings.json')?.toString(), '{"env":{}}\n');
            assert.equal(fs.statSync(path.join(root, 'settings.json')).mode & 0o777, 0o600);
            await writeCredentialStoreFiles(root, [{ path: 'sub/auth.json', content: null }], { lock });
            assert.equal(readCredentialStoreFile(root, 'sub/auth.json'), undefined);
            fs.symlinkSync('/etc/passwd', path.join(root, 'link.json'));
            await assert.rejects(writeCredentialStoreFiles(root, [{ path: 'link.json', content: Buffer.from('x') }], { lock }), /symlink/);
            assert.deepEqual(fs.readdirSync(root).filter(name => name.startsWith('.propr-writeback-')), []);
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
            fs.rmSync(lock.lockRoot, { recursive: true, force: true });
        }
    });

    test('computed writes read the store under the lock, so overlapping merges keep each other\'s result', async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'propr-store-'));
        const lock = { lockRoot: path.join(root, '..', `${path.basename(root)}-locks`) };
        const merge = (key: string, value: string | undefined) => () => {
            const current = JSON.parse(readCredentialStoreFile(root, 'settings.json')?.toString() ?? '{"env":{}}');
            if (value === undefined) delete current.env[key];
            else current.env[key] = value;
            return [{ path: 'settings.json', content: Buffer.from(JSON.stringify(current)) }];
        };
        try {
            await writeCredentialStoreFiles(root, merge('ANTHROPIC_API_KEY', 'old'), { lock });
            // Both start before either holds the lock: each must merge into the other's result.
            await Promise.all([
                writeCredentialStoreFiles(root, merge('CLAUDE_CODE_OAUTH_TOKEN', 'new'), { lock }),
                writeCredentialStoreFiles(root, merge('ANTHROPIC_API_KEY', undefined), { lock }),
            ]);
            assert.deepEqual(JSON.parse(readCredentialStoreFile(root, 'settings.json')!.toString()).env, { CLAUDE_CODE_OAUTH_TOKEN: 'new' });
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
            fs.rmSync(lock.lockRoot, { recursive: true, force: true });
        }
    });

    test('a write aborted while it waits for the lock publishes nothing', async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'propr-store-'));
        const lock = { lockRoot: path.join(root, '..', `${path.basename(root)}-locks`) };
        try {
            const abort = new AbortController();
            let release!: () => void;
            const held = new Promise<void>(resolve => { release = resolve; });
            let entered!: () => void;
            const inside = new Promise<void>(resolve => { entered = resolve; });
            const blocking = withCredentialStoreLock(path.resolve(root), lock, () => { entered(); return held; });
            await inside;
            const waiting = writeCredentialStoreFiles(root, [{ path: '.credentials.json', content: Buffer.from('{}') }], { lock, signal: abort.signal });
            abort.abort();
            release();
            await blocking;
            await assert.rejects(waiting, { name: 'AbortError' });
            assert.equal(readCredentialStoreFile(root, '.credentials.json'), undefined);
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
            fs.rmSync(lock.lockRoot, { recursive: true, force: true });
        }
    });
});

describe('remote runtime readiness', () => {
    const agent: AgentConfig = { id: 'c', type: 'claude', alias: 'claude', enabled: true, configPath: '~/.claude', dockerImage: 'x', supportedModels: ['m'] };

    test('Sprites: token accepted and the pinned CLI version resolves', async () => {
        const ready = await checkRemoteRuntimeReadiness(agent, 'sprites', { PROPR_SPRITES_TOKEN: 't' }, { listSprites: async () => ({}) });
        assert.equal(ready?.ready, true);
        assert.match(ready?.detail ?? '', /^Sprites, claude CLI \d/);
        const missing = await checkRemoteRuntimeReadiness(agent, 'sprites', {}, { listSprites: async () => ({}) });
        assert.match(missing?.error ?? '', /PROPR_SPRITES_TOKEN/);
        const refused = await checkRemoteRuntimeReadiness(agent, 'sprites', { PROPR_SPRITES_TOKEN: 't' },
            { listSprites: async () => { throw Object.assign(new Error('unauthorized'), { statusCode: 401 }); } });
        assert.match(refused?.error ?? '', /refused PROPR_SPRITES_TOKEN \(HTTP 401\)/);
        const pinned = await checkRemoteRuntimeReadiness({ ...agent, cliVersionType: 'specific', cliVersion: '0.0.1', cliVersionResolved: '0.0.1' },
            'sprites', { PROPR_SPRITES_TOKEN: 't' }, { listSprites: async () => ({}) });
        assert.match(pinned?.error ?? '', /runs only claude CLI/);
    });

    test('Fly Machines: configuration resolves and the token lists Machines; Docker is not judged', async () => {
        const env = { PROPR_FLY_API_TOKEN: 'tok', PROPR_FLY_APP: 'agents', PROPR_FLY_IMAGE: 'registry.fly.io/agents:1' };
        const resolved: string[] = [];
        const ready = await checkRemoteRuntimeReadiness(agent, 'fly-machines', env,
            { machines: () => ({ list: async () => [] }), resolveFlyImage: async fly => { resolved.push(fly.image); } });
        assert.deepEqual(ready, { runtime: 'fly-machines', ready: true, detail: 'Fly Machines, image registry.fly.io/agents:1' });
        assert.deepEqual(resolved, ['registry.fly.io/agents:1']);
        const unconfigured = await checkRemoteRuntimeReadiness(agent, 'fly-machines', {}, {});
        assert.match(unconfigured?.error ?? '', /PROPR_FLY_API_TOKEN/);
        const refused = await checkRemoteRuntimeReadiness(agent, 'fly-machines', env,
            { machines: () => ({ list: async () => { throw new MachinesHttpError('GET', 401); } }) });
        assert.match(refused?.error ?? '', /HTTP 401/);
        assert.equal(await checkRemoteRuntimeReadiness(agent, 'docker', env), undefined);
    });

    test('Fly Machines: an image that does not resolve is not ready', async () => {
        const env = { PROPR_FLY_API_TOKEN: 'tok', PROPR_FLY_APP: 'agents', PROPR_FLY_IMAGE: 'registry.fly.io/agents:missing' };
        const machines = () => ({ list: async () => [] });
        const missing = await checkRemoteRuntimeReadiness(agent, 'fly-machines', env,
            { machines, resolveFlyImage: async () => { throw new FlyImageResolutionError('HTTP 404', 404); } });
        assert.equal(missing?.ready, false);
        assert.match(missing?.error ?? '', /PROPR_FLY_IMAGE registry\.fly\.io\/agents:missing does not resolve/);
        const refused = await checkRemoteRuntimeReadiness(agent, 'fly-machines', env,
            { machines, resolveFlyImage: async () => { throw new FlyImageResolutionError('HTTP 403', 403); } });
        assert.match(refused?.error ?? '', /refused access to PROPR_FLY_IMAGE .*HTTP 403/);
    });

    test('Fly image resolution: registry.fly.io with the Fly token, other registries anonymously', async () => {
        assert.deepEqual(parseImageReference('registry.fly.io/agents:1'), { host: 'registry.fly.io', repository: 'agents', reference: '1' });
        assert.deepEqual(parseImageReference('node'), { host: 'registry-1.docker.io', repository: 'library/node', reference: 'latest' });
        assert.deepEqual(parseImageReference('ghcr.io/o/agent:2'), { host: 'ghcr.io', repository: 'o/agent', reference: '2' });
        const calls: { url: string; method: string; authorization?: string }[] = [];
        const registry = (status: Record<string, number>) => (async (input: string | URL | Request, init?: RequestInit) => {
            const url = String(input);
            const headers = new Headers(init?.headers);
            calls.push({ url, method: init?.method ?? 'GET', authorization: headers.get('authorization') ?? undefined });
            if (url.startsWith('https://auth.')) return Response.json({ token: 'anon' });
            if (!headers.get('authorization')) {
                return new Response(null, { status: 401, headers: { 'www-authenticate': 'Bearer realm="https://auth.example.test/token",service="r",scope="repository:o/agent:pull"' } });
            }
            const code = Object.entries(status).find(([suffix]) => url.endsWith(suffix))?.[1] ?? 404;
            return new Response(code === 200 ? '{"schemaVersion":2,"config":{},"layers":[]}' : null, { status: code });
        }) as typeof fetch;
        await resolveFlyImage('ghcr.io/o/agent:2', 'fly-token', registry({ '/manifests/2': 200 }));
        assert.equal(calls.at(-1)?.authorization, 'Bearer anon');
        assert.ok(!calls.some(call => call.authorization?.includes(Buffer.from('x:fly-token').toString('base64'))), 'the Fly token stays on registry.fly.io');
        await assert.rejects(resolveFlyImage('ghcr.io/o/agent:gone', 'fly-token', registry({})), (error: FlyImageResolutionError) => error.status === 404);
        calls.length = 0;
        await assert.rejects(resolveFlyImage('registry.fly.io/agents:gone', 'fly-token', (async (input: string | URL | Request, init?: RequestInit) => {
            calls.push({ url: String(input), method: init?.method ?? 'GET', authorization: new Headers(init?.headers).get('authorization') ?? undefined });
            return new Response(null, { status: 404 });
        }) as typeof fetch), (error: FlyImageResolutionError) => error.status === 404);
        assert.equal(calls[0].url, 'https://registry.fly.io/v2/agents/manifests/gone');
        assert.match(calls[0].authorization ?? '', /^Basic /);
        await assert.rejects(resolveFlyImage('Not An Image', 'fly-token', registry({})), /not a valid image reference/);
    });
});
