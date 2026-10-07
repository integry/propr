import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { buildDockerArgs as buildClaudeDockerArgs } from '../packages/core/src/agents/impl/utils/dockerArgsBuilder.ts';
import { buildCodexAppServerDockerArgs } from '../packages/core/src/agents/impl/utils/codexDockerArgsBuilder.ts';
import { wrapDockerRunArgsWithRepoSetup } from '../packages/core/src/claude/docker/repoSetupWrapper.ts';
import { spawnWithNetworkPolicy, startWithNetworkPolicy } from '../packages/core/src/claude/docker/dockerNetworkPolicy.ts';
import { NetworkPolicyError, executeWithNetworkPolicy, prepareDockerRunNetwork, setUnscopedNetworkPolicyResolver } from '../packages/core/src/network/egressExecution.ts';
import { resolveNetworkPolicy, type InstanceNetworkPolicy, type ResolvedNetworkPolicy } from '../packages/core/src/network/networkPolicy.ts';
import type { AgentConfig, AgentType } from '../packages/core/src/agents/types.ts';

let root: string;
let codexConfigPath: string;
const previousRoot = process.env.PROPR_EGRESS_SOCKET_DIR;
before(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'egress-coverage-'));
    codexConfigPath = await mkdtemp(path.join(tmpdir(), 'egress-coverage-codex-'));
    process.env.PROPR_EGRESS_SOCKET_DIR = root;
});
after(async () => {
    setUnscopedNetworkPolicyResolver(undefined);
    if (previousRoot === undefined) delete process.env.PROPR_EGRESS_SOCKET_DIR; else process.env.PROPR_EGRESS_SOCKET_DIR = previousRoot;
    await rm(root, { recursive: true, force: true });
    await rm(codexConfigPath, { recursive: true, force: true });
    const { closeConnection } = await import('../packages/core/src/db/connection.ts');
    await closeConnection();
});

const restricted = (overrides: Partial<ResolvedNetworkPolicy> = {}): ResolvedNetworkPolicy => ({ mode: 'restricted', source: 'workflow', allow: [], ...overrides });
const instance = (overrides: Partial<InstanceNetworkPolicy> = {}): InstanceNetworkPolicy => ({ mode: 'restricted', enforced: true, allow: [], ignoreRepositoryAllow: false, ...overrides });
const agentArgs = (agentType: AgentType = 'claude', options: string[] = []) =>
    wrapDockerRunArgsWithRepoSetup(['run', '--rm', '--network', 'bridge', ...options, 'propr/agent:test', 'claude', '-p', '-'], 'propr/agent:test', agentType);
const networksOf = (args: string[]) => args.flatMap((arg, index) => arg === '--network' ? [args[index + 1]] : arg.startsWith('--network=') ? [arg.slice(10)] : []);

/** Every `-e`/`--env` entry, in any of Docker's forms. */
function envEntries(args: string[]): string[] {
    return args.flatMap((arg, index) => ['-e', '--env'].includes(arg) ? [args[index + 1]]
        : arg.startsWith('--env=') ? [arg.slice(6)] : /^-e[^-]/.test(arg) ? [arg.slice(2)] : []);
}

test('native Claude and Codex goal containers go through the wrapper and start behind the proxy', async () => {
    const config = (type: AgentType): AgentConfig => ({
        id: `${type}-id`, type, alias: `${type}-test`, enabled: true, dockerImage: 'propr/agent:test',
        configPath: type === 'codex' ? codexConfigPath : `/tmp/${type}-config`, supportedModels: ['test-model'], defaultModel: 'test-model',
    });
    const params = { worktreePath: '/tmp/worktree', githubToken: 'token', modelName: 'test-model', issueNumber: 0, taskId: 'goal-1', executionMode: 'goal' as const };
    const builders: Array<[string, string[]]> = [
        ['Claude native goal', buildClaudeDockerArgs(config('claude'), 1000, { ...params, sessionId: 'session-1' })],
        ['Codex App Server goal', buildCodexAppServerDockerArgs(config('codex'), params)],
    ];
    for (const [name, args] of builders) {
        const { result: rewritten, report } = await executeWithNetworkPolicy(restricted(), async () => {
            const run = await prepareDockerRunNetwork('docker', args);
            assert.ok(run, `${name} is not left open`);
            await run.release();
            return run.args;
        });
        assert.equal(report.restrictedContainers, 1, name);
        assert.deepEqual(report.fallbacks, [], name);
        assert.deepEqual(networksOf(rewritten), ['none'], name);
        const command = args.slice(args.indexOf('-lc') + 2);
        assert.deepEqual(rewritten.slice(-command.length), command, `${name} keeps its command`);
    }
});

test('proxy variables in every docker env form are replaced, and the agent type is read in any form', async () => {
    const args = agentArgs('claude', [
        '--env=HTTPS_PROXY=http://corp.example.com:8080', '--env', 'HTTP_PROXY', '-eno_proxy=internal', '-e=ALL_PROXY=socks5://corp:1080',
        '--env=GIT_CONFIG_COUNT=1', '--env=GIT_CONFIG_KEY_0=core.autocrlf', '--env=GIT_CONFIG_VALUE_0=false',
    ]);
    const { result: rewritten } = await executeWithNetworkPolicy(restricted(), async () => {
        const run = await prepareDockerRunNetwork('docker', args);
        assert.ok(run);
        await run.release();
        return run.args;
    });
    const entries = envEntries(rewritten);
    const proxyEntries = entries.filter(entry => /^(https?|all|no)_proxy(=|$)/i.test(entry));
    assert.deepEqual(proxyEntries.sort(), ['HTTPS_PROXY=http://127.0.0.1:3128', 'HTTP_PROXY=http://127.0.0.1:3128', 'NO_PROXY=localhost,127.0.0.1,::1',
        'http_proxy=http://127.0.0.1:3128', 'https_proxy=http://127.0.0.1:3128', 'no_proxy=localhost,127.0.0.1,::1'].sort(), 'only the run proxy remains, including over inherited variables');
    assert.deepEqual(entries.filter(entry => entry.startsWith('GIT_CONFIG_COUNT')), ['GIT_CONFIG_COUNT=2'], 'an --env= count is extended, not duplicated');
    assert.ok(entries.includes('GIT_CONFIG_KEY_1=http.proxy') && entries.includes('GIT_CONFIG_KEY_0=core.autocrlf'));

    // An agent type given as --env=KEY=value is recognised (no fallback).
    const inline = ['run', '--rm', '--env=PROPR_AGENT_TYPE=codex', '--entrypoint', '/bin/bash', 'propr/agent:test', '-lc', 'exec "$@"', 'codex'];
    const { report } = await executeWithNetworkPolicy(restricted(), async () => { await (await prepareDockerRunNetwork('docker', inline))?.release(); });
    assert.equal(report.restrictedContainers, 1);
    assert.deepEqual(report.fallbacks, []);
});

test('an agent container started outside any run follows the enforced instance policy instead of running open', async () => {
    const started: string[][] = [];
    const start = async (args: string[]) => { started.push(args); };
    setUnscopedNetworkPolicyResolver(async () => resolveNetworkPolicy(instance()));
    try {
        await startWithNetworkPolicy('docker', agentArgs(), {}, start);
        assert.deepEqual(networksOf(started[0]), ['none'], 'the unwrapped agent container runs behind a proxy');
        assert.deepEqual(await readdir(root), [], 'its proxy goes with it');

        const fakeChild = Object.assign(new EventEmitter(), { kill: () => true }) as unknown as ChildProcess;
        let spawned: string[] = [];
        const child = await spawnWithNetworkPolicy(agentArgs(), args => { spawned = args; return fakeChild; });
        assert.deepEqual(networksOf(spawned), ['none'], 'a native session spawned outside a run is covered too');
        child.emit('close', 0);
        for (let attempt = 0; attempt < 50 && (await readdir(root)).length; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
        assert.deepEqual(await readdir(root), []);

        await assert.rejects(startWithNetworkPolicy('docker', agentArgs('antigravity'), {}, start), NetworkPolicyError, 'an agent that cannot use the proxy is refused');

        // Only agent containers qualify: ProPR's own helper containers and exempt probes are unchanged.
        const helper = ['run', '--rm', '--entrypoint', 'sh', 'propr/agent:test', '-c', 'apt list'];
        await startWithNetworkPolicy('docker', helper, {}, start);
        assert.deepEqual(started.at(-1), helper);
        await startWithNetworkPolicy('docker', agentArgs(), { networkPolicyExempt: 'usage probe' }, start);
        assert.deepEqual(networksOf(started.at(-1)!), ['bridge']);

        setUnscopedNetworkPolicyResolver(async () => resolveNetworkPolicy(instance({ enforced: false })));
        await startWithNetworkPolicy('docker', agentArgs(), {}, start);
        assert.deepEqual(networksOf(started.at(-1)!), ['bridge'], 'a non-enforced default does not reach code paths outside a run');

        // Inside a run, the run's own policy decides and the resolver is not consulted.
        setUnscopedNetworkPolicyResolver(async () => assert.fail('the run policy applies'));
        await executeWithNetworkPolicy({ mode: 'open', source: 'workflow', allow: [] }, () => startWithNetworkPolicy('docker', agentArgs(), {}, start));
        assert.deepEqual(networksOf(started.at(-1)!), ['bridge']);

        setUnscopedNetworkPolicyResolver(async () => { throw new Error('settings database unavailable'); });
        await assert.rejects(startWithNetworkPolicy('docker', agentArgs(), {}, async () => assert.fail('must not start')), /settings database unavailable/,
            'an unreadable policy fails closed');
    } finally {
        setUnscopedNetworkPolicyResolver(undefined);
    }
});

test('an enforcing instance can ignore repository network.allow additions', () => {
    const repository = { mode: 'open' as const, allow: ['mirror.example.com', 'Paste.Example.org'] };
    const bounded = resolveNetworkPolicy(instance({ allow: ['mirror.example.com'], ignoreRepositoryAllow: true }), repository);
    assert.deepEqual(bounded.allow, ['mirror.example.com']);
    assert.match(bounded.note!, /requested network\.mode: open/);
    assert.match(bounded.note!, /network\.allow was ignored/);
    assert.equal(resolveNetworkPolicy(instance({ allow: ['mirror.example.com'], ignoreRepositoryAllow: true }), { allow: ['mirror.example.com'] }).note, undefined,
        'a repository entry the instance already lists is not reported as ignored');
    assert.deepEqual(resolveNetworkPolicy(instance(), repository).allow, ['mirror.example.com', 'paste.example.org'], 'without the toggle repository hosts apply');
    // The toggle bounds enforced restricted mode only.
    const open = resolveNetworkPolicy(instance({ mode: 'restricted', enforced: false, ignoreRepositoryAllow: true }), { mode: 'restricted', allow: ['paste.example.org'] });
    assert.deepEqual(open.allow, ['paste.example.org']);
});

test('only the instance list opens a private address inside a run; a repository entry for the same address does not', async () => {
    const upstream = net.createServer(socket => socket.end());
    await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
    const target = `127.0.0.1:${(upstream.address() as net.AddressInfo).port}`;
    const status = (policy: ResolvedNetworkPolicy) => executeWithNetworkPolicy(policy, async () => {
        const before = new Set(await readdir(root));
        const run = await prepareDockerRunNetwork('docker', agentArgs());
        assert.ok(run);
        const id = (await readdir(root)).find(entry => !before.has(entry))!;
        try {
            return await new Promise<string>((resolve, reject) => {
                const socket = net.connect(path.join(root, id, 'proxy.sock'));
                socket.on('error', reject);
                socket.once('data', chunk => { resolve(chunk.toString().split('\r\n')[0]); socket.destroy(); });
                socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
            });
        } finally {
            await run.release();
        }
    });
    try {
        const repository = await status(resolveNetworkPolicy(instance({ enforced: false }), { mode: 'restricted', allow: [target] }));
        assert.equal(repository.result, 'HTTP/1.1 403 Forbidden');
        const administrator = await status(resolveNetworkPolicy(instance({ allow: [target] })));
        assert.equal(administrator.result, 'HTTP/1.1 200 Connection Established');
    } finally {
        await new Promise(resolve => upstream.close(resolve));
    }
});
