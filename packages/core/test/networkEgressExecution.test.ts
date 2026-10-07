import assert from 'node:assert/strict';
import { after, before, mock, test } from 'node:test';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import fsPromises from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import path from 'node:path';
import { resolveInstanceNetworkPolicy, resolveNetworkPolicy, validateAgentNetworkSetting, type ResolvedNetworkPolicy } from '../src/network/networkPolicy.js';
import {
    EGRESS_BRIDGE_PRELUDE, EGRESS_ORPHAN_MAX_AGE_MS, NetworkPolicyError, dockerRunNeedsNetworkPolicy, executeWithNetworkPolicy, networkEgressReportFromError,
    egressProcessNamespace, prepareDockerRunNetwork, sweepOrphanedEgressProxies,
} from '../src/network/egressExecution.js';
import { wrapDockerRunArgsWithRepoSetup } from '../src/claude/docker/repoSetupWrapper.js';
import { spawnWithNetworkPolicy } from '../src/claude/docker/dockerNetworkPolicy.js';
import { runWithExecutionAbortSignal } from '../src/claude/docker/dockerExecutionOwnership.js';
import { buildAgentGitCredentialArgs } from '../src/agents/agentGitAccess.js';
import type { AgentType } from '../src/agents/types.js';
import { closeConnection } from '../src/db/connection.js';

let root: string;
const previousEnv = { local: process.env.PROPR_EGRESS_SOCKET_DIR, host: process.env.HOST_PROPR_EGRESS_SOCKET_DIR };
before(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'egress-root-'));
    process.env.PROPR_EGRESS_SOCKET_DIR = root;
    process.env.HOST_PROPR_EGRESS_SOCKET_DIR = '/srv/host/propr-egress';
});
after(closeConnection);
after(async () => {
    for (const [key, value] of [['PROPR_EGRESS_SOCKET_DIR', previousEnv.local], ['HOST_PROPR_EGRESS_SOCKET_DIR', previousEnv.host]] as const) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
});

const restricted = (overrides: Partial<ResolvedNetworkPolicy> = {}): ResolvedNetworkPolicy => ({ mode: 'restricted', source: 'workflow', allow: ['registry.example.com'], ...overrides });

function agentRunArgs(agentType: AgentType = 'claude'): string[] {
    return wrapDockerRunArgsWithRepoSetup([
        'run', '--rm', '-i', '--name', 'claude-issue-1-abc', '--security-opt', 'no-new-privileges', '--network', 'bridge', '--user', '0:0',
        '-e', 'HTTPS_PROXY=http://corporate:8080', '-e', 'no_proxy=internal',
        ...buildAgentGitCredentialArgs(),
        '-w', '/home/node/workspace', 'propr/agent:test', 'claude', '-p', '-',
    ], 'propr/agent:test', agentType);
}

const envOf = (args: string[], key: string): string[] => args.flatMap((arg, index) => args[index - 1] === '-e' && arg.startsWith(`${key}=`) ? [arg.slice(key.length + 1)] : []);

test('the repository may tighten or relax a non-enforced instance mode but cannot open an enforced one', () => {
    const open = { mode: 'open' as const, enforced: false, allow: ['mirror.example.com'], ignoreRepositoryAllow: false };
    assert.deepEqual(resolveNetworkPolicy(open), { mode: 'open', source: 'instance', allow: ['mirror.example.com'], instanceAllow: ['mirror.example.com'] });
    assert.deepEqual(resolveNetworkPolicy(open, { mode: 'restricted', allow: ['Registry.NPMJS.org'] }),
        { mode: 'restricted', source: 'workflow', allow: ['mirror.example.com', 'registry.npmjs.org'], instanceAllow: ['mirror.example.com'] });
    const restrictedDefault = { mode: 'restricted' as const, enforced: false, allow: [], ignoreRepositoryAllow: false };
    assert.equal(resolveNetworkPolicy(restrictedDefault, { mode: 'open' }).mode, 'open');
    assert.equal(resolveNetworkPolicy(restrictedDefault).source, 'instance');
    const enforced = resolveNetworkPolicy({ mode: 'restricted', enforced: true, allow: [], ignoreRepositoryAllow: false }, { mode: 'open', allow: ['cache.example.com'] });
    assert.equal(enforced.mode, 'restricted');
    assert.equal(enforced.source, 'instance_enforced');
    assert.deepEqual(enforced.allow, ['cache.example.com'], 'repository hosts still apply under an enforced policy');
    assert.deepEqual(enforced.instanceAllow, [], 'but they are not the administrator\'s own entries');
    assert.match(enforced.note!, /requested network\.mode: open/);
    // Enforcement only means something with restricted mode.
    assert.equal(resolveNetworkPolicy({ mode: 'open', enforced: true, allow: [], ignoreRepositoryAllow: false }, { mode: 'open' }).mode, 'open');
});

test('instance settings override environment defaults; invalid values fall back', () => {
    const env = { AGENT_NETWORK_MODE: 'restricted', AGENT_NETWORK_MODE_ENFORCED: 'true', AGENT_NETWORK_ALLOW: 'a.example.com, *.b.example.com' };
    assert.deepEqual(resolveInstanceNetworkPolicy({}, env), { mode: 'restricted', enforced: true, allow: ['a.example.com', '*.b.example.com'], ignoreRepositoryAllow: false });
    assert.deepEqual(resolveInstanceNetworkPolicy({ agent_network_mode: 'open', agent_network_mode_enforced: false, agent_network_allow: [] }, env),
        { mode: 'open', enforced: false, allow: [], ignoreRepositoryAllow: false });
    assert.deepEqual(resolveInstanceNetworkPolicy({ agent_network_mode: 'sideways', agent_network_allow: ['*'] }, env).mode, 'restricted');
    assert.deepEqual(resolveInstanceNetworkPolicy({}, {}), { mode: 'open', enforced: false, allow: [], ignoreRepositoryAllow: false });
    assert.equal(validateAgentNetworkSetting('agent_network_mode', 'closed'), 'agent_network_mode must be "open" or "restricted"');
    assert.equal(validateAgentNetworkSetting('agent_network_mode_enforced', 'yes'), 'agent_network_mode_enforced must be a boolean');
    assert.equal(validateAgentNetworkSetting('agent_network_allow', null), undefined);
});

test('a restricted run starts its agent container without a network, behind its own proxy socket', async () => {
    const args = agentRunArgs();
    const { result: prepared, report } = await executeWithNetworkPolicy(restricted(), async () => {
        const run = await prepareDockerRunNetwork('docker', args);
        assert.ok(run);
        const directories = (await import('node:fs/promises')).readdir(root);
        const [id] = await directories;
        assert.ok(existsSync(path.join(root, id, 'proxy.sock')), 'the proxy listens while the container runs');
        assert.equal((await stat(path.join(root, id))).mode & 0o777, 0o711, 'other local accounts cannot list the run directory');
        assert.equal((await stat(root)).mode & 0o777, 0o711, 'nor enumerate run directories');
        await run.release();
        assert.ok(!existsSync(path.join(root, id)), 'the proxy and its directory go with the container');
        return run;
    });
    const rewritten = prepared!.args;
    assert.deepEqual(rewritten.slice(rewritten.indexOf('--network'), rewritten.indexOf('--network') + 2), ['--network', 'none']);
    assert.ok(!rewritten.includes('--privileged') && !rewritten.includes('NET_ADMIN'));
    const mount = rewritten[rewritten.findIndex(arg => arg.endsWith(':/run/propr-egress:ro'))];
    assert.match(mount, /^\/srv\/host\/propr-egress\/[0-9a-f-]{36}:\/run\/propr-egress:ro$/, 'the Docker host path is mounted read-only');
    for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy']) assert.deepEqual(envOf(rewritten, key), ['http://127.0.0.1:3128'], key);
    assert.deepEqual(envOf(rewritten, 'no_proxy'), ['localhost,127.0.0.1,::1'], 'caller proxy variables are replaced, not duplicated');
    assert.deepEqual(envOf(rewritten, 'GIT_CONFIG_COUNT'), ['3']);
    assert.deepEqual(envOf(rewritten, 'GIT_CONFIG_KEY_2'), ['http.proxy']);
    assert.deepEqual(envOf(rewritten, 'GIT_CONFIG_VALUE_2'), ['http://127.0.0.1:3128']);
    assert.deepEqual(envOf(rewritten, 'GIT_CONFIG_KEY_1'), ['credential.https://github.com.helper'], 'existing git config entries are kept');
    const script = rewritten[rewritten.indexOf('-lc') + 1];
    assert.ok(script.startsWith(EGRESS_BRIDGE_PRELUDE), 'the bridge starts before setup hooks and the agent');
    assert.ok(rewritten.indexOf('--entrypoint') > rewritten.findIndex(arg => arg.startsWith('HTTPS_PROXY=')), 'container options stay before the image');
    assert.deepEqual(rewritten.slice(-3), ['claude', '-p', '-'], 'the agent command is unchanged');
    assert.equal(report.restrictedContainers, 1);
    assert.deepEqual(report.fallbacks, []);
});

test('open runs, other commands and containers already without a network are left alone', async () => {
    assert.equal(await prepareDockerRunNetwork('docker', agentRunArgs()), undefined, 'no policy outside a run');
    await executeWithNetworkPolicy({ mode: 'open', source: 'instance', allow: [] }, async () => {
        assert.equal(await prepareDockerRunNetwork('docker', agentRunArgs()), undefined);
    });
    await executeWithNetworkPolicy(restricted(), async () => {
        assert.equal(await prepareDockerRunNetwork('docker', ['images', '-q', 'x']), undefined);
        assert.equal(await prepareDockerRunNetwork('docker', ['run', '--rm', '--network', 'none', 'img']), undefined);
    });
});

test('an agent that cannot use the proxy falls back to open with a recorded warning, or is refused when enforced', async () => {
    const { report } = await executeWithNetworkPolicy(restricted(), async () => {
        assert.equal(await prepareDockerRunNetwork('docker', agentRunArgs('antigravity')), undefined);
    });
    assert.equal(report.restrictedContainers, 0);
    assert.equal(report.fallbacks[0].agentType, 'antigravity');
    assert.match(report.fallbacks[0].reason, /not been verified/);

    const error = await executeWithNetworkPolicy(restricted({ source: 'instance_enforced' }), () => prepareDockerRunNetwork('docker', agentRunArgs('antigravity')))
        .then(() => assert.fail('expected refusal'), (caught: unknown) => caught);
    assert.ok(error instanceof NetworkPolicyError);
    assert.match((error as Error).message, /enforced/);
    assert.equal(networkEgressReportFromError(error)?.mode, 'restricted', 'a refused run still carries its network report');
    assert.equal(networkEgressReportFromError(error)?.refusals[0].agentType, 'antigravity');
});

test('the sweep removes directories left by dead or forgotten owners and keeps live ones', async () => {
    const make = async (id: string, owner: object | null, ageMs = 0) => {
        const directory = path.join(root, id);
        await mkdir(directory, { recursive: true });
        if (owner) await writeFile(path.join(directory, 'owner.json'), JSON.stringify(owner));
        if (ageMs) { const when = new Date(Date.now() - ageMs); await utimes(directory, when, when); }
        return directory;
    };
    const namespace = await egressProcessNamespace();
    const dead = await make('dead', { namespace, hostname: hostname(), pid: 2 ** 22 + 4321 });
    // An earlier process with this PID (a restarted container's PID 1) is gone.
    const reused = await make('reused-pid', { instanceId: 'earlier-process', namespace, hostname: hostname(), pid: process.pid });
    const live = await make('live', { namespace, hostname: hostname(), pid: process.ppid });
    const otherHost = await make('other-host', { namespace: 'another-boot:pid:[1]', hostname: 'another-worker', pid: 1 });
    const stale = await make('stale', { namespace: 'another-boot:pid:[1]', hostname: 'another-worker', pid: 1 }, EGRESS_ORPHAN_MAX_AGE_MS + 60_000);
    const { removed } = await sweepOrphanedEgressProxies({ root });
    assert.equal(removed, 3);
    assert.ok(!existsSync(dead) && !existsSync(reused) && !existsSync(stale));
    assert.ok(existsSync(live) && existsSync(otherHost));
});

test('a container sharing this hostname but not this PID namespace never has its live directory removed', async () => {
    const directory = path.join(root, 'same-hostname');
    await mkdir(directory, { recursive: true });
    // Another container (the indexing worker, say) given the same hostname: its PID means nothing here.
    await writeFile(path.join(directory, 'owner.json'), JSON.stringify({ instanceId: 'indexing-worker', namespace: 'same-boot:pid:[4026532999]', hostname: hostname(), pid: 2 ** 22 + 77 }));
    assert.equal((await sweepOrphanedEgressProxies({ root })).removed, 0);
    assert.ok(existsSync(directory));
    await rm(directory, { recursive: true, force: true });
});

test('a directory this process wrote and no longer serves is removed', async () => {
    await executeWithNetworkPolicy(restricted(), async () => {
        const before = new Set(await readdir(root));
        const run = await prepareDockerRunNetwork('docker', agentRunArgs());
        assert.ok(run);
        const id = (await readdir(root)).find(entry => !before.has(entry))!;
        const owner = JSON.parse(await readFile(path.join(root, id, 'owner.json'), 'utf8'));
        assert.equal(owner.namespace, await egressProcessNamespace());
        assert.equal(typeof owner.instanceId, 'string');
        const copy = path.join(root, 'forgotten');
        await mkdir(copy);
        await writeFile(path.join(copy, 'owner.json'), JSON.stringify(owner));
        assert.equal((await sweepOrphanedEgressProxies({ root })).removed, 1, 'only the forgotten copy goes; the served directory stays');
        assert.ok(!existsSync(copy) && existsSync(path.join(root, id)));
        await run.release();
    });
});

test('the sweep never removes a directory whose proxy is still serving, however long the run lasts', async () => {
    await executeWithNetworkPolicy(restricted(), async () => {
        const before = new Set(await readdir(root));
        const run = await prepareDockerRunNetwork('docker', agentRunArgs());
        assert.ok(run);
        const id = (await readdir(root)).find(entry => !before.has(entry))!;
        const directory = path.join(root, id);
        try {
            const longAgo = new Date(Date.now() - EGRESS_ORPHAN_MAX_AGE_MS - 60_000);
            await utimes(directory, longAgo, longAgo);
            await sweepOrphanedEgressProxies({ root });
            assert.ok(existsSync(path.join(directory, 'proxy.sock')), 'an active run keeps its proxy socket past the age limit');
            assert.ok(Date.now() - (await stat(directory)).mtimeMs < EGRESS_ORPHAN_MAX_AGE_MS, 'the sweep refreshes an active directory for workers on other hosts');
        } finally {
            await run.release();
        }
        assert.ok(!existsSync(directory));
    });
});

test('every docker run in a restricted run is policy-bearing unless it has no network or is exempted with a reason', async () => {
    const withoutNetwork = agentRunArgs().filter((arg, index, all) => arg !== '--network' && all[index - 1] !== '--network');
    const inline = agentRunArgs().map(arg => arg === '--network' ? '--network=bridge' : arg).filter((arg, index, all) => all[index - 1] !== '--network=bridge');
    const host = agentRunArgs().map((arg, index, all) => all[index - 1] === '--network' ? 'host' : arg);
    const { report } = await executeWithNetworkPolicy(restricted(), async () => {
        for (const args of [withoutNetwork, inline, host]) {
            assert.ok(dockerRunNeedsNetworkPolicy('docker', args), args.join(' '));
            const run = await prepareDockerRunNetwork('docker', args);
            assert.ok(run, 'the container is started behind the proxy');
            await run.release();
            const networks = run.args.flatMap((arg, index) => arg === '--network' ? [run.args[index + 1]] : arg.startsWith('--network=') || arg.startsWith('--net=') ? [arg] : []);
            assert.deepEqual(networks, ['none'], 'whatever network was named (or implied) is replaced by none');
        }
        assert.ok(!dockerRunNeedsNetworkPolicy('docker', ['run', '--rm', '--network=none', 'img']));
        // A trusted probe keeps its network deliberately and is neither proxied nor reported.
        const probe = ['run', '--rm', '-e', 'PROPR_AGENT_TYPE=agent-tank', 'img', 'sh', '-c', 'probe'];
        assert.ok(!dockerRunNeedsNetworkPolicy('docker', probe, 'usage probe runs only ProPR code'));
        assert.equal(await prepareDockerRunNetwork('docker', probe, 'usage probe runs only ProPR code'), undefined);
        // Without that reason the same container is no longer silently open.
        assert.equal(await prepareDockerRunNetwork('docker', probe), undefined);
    });
    assert.equal(report.restrictedContainers, 3);
    assert.deepEqual(report.fallbacks, [{ agentType: 'agent-tank', reason: 'container does not identify a supported agent' }]);
    const refused = await executeWithNetworkPolicy(restricted({ source: 'instance_enforced' }), () => prepareDockerRunNetwork('docker', ['run', '--rm', 'img']))
        .then(() => assert.fail('expected refusal'), (caught: unknown) => caught);
    assert.ok(refused instanceof NetworkPolicyError, 'an enforced run refuses a container on the default network');
});

test('a failed directory removal on release is logged, never replacing the container result', async () => {
    await executeWithNetworkPolicy(restricted(), async () => {
        const before = new Set(await readdir(root));
        const run = await prepareDockerRunNetwork('docker', agentRunArgs());
        assert.ok(run);
        const id = (await readdir(root)).find(entry => !before.has(entry))!;
        const rm = mock.method(fsPromises, 'rm', async () => { throw Object.assign(new Error('EBUSY: resource busy'), { code: 'EBUSY' }); });
        try {
            await run.release();
        } finally {
            rm.mock.restore();
        }
        assert.equal(rm.mock.callCount() >= 1, true);
        // The sweeper owns what is left once the run no longer serves it.
        assert.equal((await sweepOrphanedEgressProxies({ root })).removed, 1);
        assert.ok(!existsSync(path.join(root, id)));
    });
});

test('a directly spawned agent container keeps its proxy until the process closes', async () => {
    const spawned: string[][] = [];
    const fakeChild = () => Object.assign(new EventEmitter(), { kill() { return true; } }) as unknown as ChildProcess;
    await executeWithNetworkPolicy(restricted(), async () => {
        const before = new Set(await readdir(root));
        let child: ChildProcess | undefined;
        child = await spawnWithNetworkPolicy(agentRunArgs(), args => { spawned.push(args); return child = fakeChild(); });
        const id = (await readdir(root)).find(entry => !before.has(entry))!;
        assert.ok(spawned[0].includes('none') && spawned[0].some(arg => arg.endsWith(':/run/propr-egress:ro')), 'spawned with the rewritten arguments');
        assert.ok(existsSync(path.join(root, id, 'proxy.sock')));
        child.emit('close', 0);
        for (let attempt = 0; attempt < 50 && existsSync(path.join(root, id)); attempt++) await new Promise(resolve => setTimeout(resolve, 10));
        assert.ok(!existsSync(path.join(root, id)), 'the proxy goes with the process');

        const controller = new AbortController();
        const pending = runWithExecutionAbortSignal(controller.signal,
            () => spawnWithNetworkPolicy(agentRunArgs(), () => { throw new Error('must not spawn after cancellation'); }));
        controller.abort(new Error('aborted by user'));
        await assert.rejects(pending);
        assert.deepEqual(new Set(await readdir(root)), before, 'a cancelled spawn releases its proxy');
    });
});
