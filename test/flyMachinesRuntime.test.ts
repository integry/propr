import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const credentialRunDir = fs.mkdtempSync(path.join(os.tmpdir(), 'propr-fly-credential-runs-'));
process.env.PROPR_AGENT_CREDENTIAL_RUN_DIR = credentialRunDir;

// The runtime modules import @propr/core, which opens the shared database connection;
// close it or the test process never exits.
after(async () => {
    const { closeConnection } = await import('../packages/core/src/db/connection.ts');
    await closeConnection();
    fs.rmSync(credentialRunDir, { recursive: true, force: true });
});

const { FlyMachinesRuntime, flyMachinesCapabilities, FLY_MACHINES_RUNTIME_KIND } = await import('../packages/core/src/agents/runtime/flyMachinesRuntime.ts');
const { resolveFlyMachinesConfig, flyMachineGuest, flyInternalMcpUrl, dockerMemoryToMb, FlyMachinesConfigError } = await import('../packages/core/src/agents/runtime/flyMachinesConfig.ts');
const { renderFlyMachineRequest, parseFlyLogLine, flyMachineName, FLY_LOG_MARKERS, FLY_RUN_FILES } = await import('../packages/core/src/agents/runtime/flyMachinesLaunch.ts');
const { flyAuthorization, flyMachineExitCode } = await import('../packages/core/src/agents/runtime/flyMachinesApi.ts');
const { uploadAgentRunFiles } = await import('../packages/core/src/agents/runtime/agentRunFileUpload.ts');
const { AgentRunSpecBuilder, agentRunNetwork } = await import('../packages/core/src/agents/runtime/agentRunSpec.ts');
const { getAgentRuntime, registerAgentRuntime, assertAgentRuntimeSupports, runAgent, registeredAgentRuntimes, AgentRuntimeCapabilityError } = await import('../packages/core/src/agents/runtime/registry.ts');
const { planAgentRunMcpTransport } = await import('../packages/core/src/agents/runtime/agentRunMcpTransport.ts');
const { AgentRunStoppedError } = await import('../packages/core/src/agents/runtime/dockerRuntime.ts');

const FLY_ENV = { PROPR_FLY_API_TOKEN: 'FlyV1 fm2_test', PROPR_FLY_APP: 'propr-agents', PROPR_FLY_REGION: 'ams' };

function spec(overrides: { user?: string } = {}) {
    const built = new AgentRunSpecBuilder({
        agentType: 'claude', image: 'propr/agent:test', name: 'claude-issue-7-abc', stdin: true, user: overrides.user ?? '0:0',
        network: agentRunNetwork('bridge'),
        workspace: { hostPath: '/tmp/w', containerPath: '/home/node/workspace', readOnly: false, mode: 'clone' },
    }).env('A', '1').env('INHERITED').command('claude', '-p').build();
    built.entrypoint = '/home/node/claude-entrypoint.sh';
    built.labels = { 'propr.task.id': 'task-7' };
    built.workspace.clone = { remote: 'https://github.com/o/r.git', baseRef: 'refs/propr/runs/x/base', baseCommit: 'abc', branch: 'b', resultRef: 'refs/propr/runs/x/result', resultDir: '/tmp/r', script: 'clone-script' };
    return built;
}

interface FakeMachine {
    id: string;
    state: string;
    request: any;
    files: Map<string, Buffer>;
    events: any[];
    pendingLogs: string[];
    signals: number[];
    ran?: boolean;
}

/** An in-memory Machines + logs API. `agent` decides what a run prints and how it exits. */
class FakeFly {
    machines = new Map<string, FakeMachine>();
    requests: Array<{ method: string; url: string; body?: any; authorization?: string }> = [];
    destroyed: string[] = [];
    agent: (machine: FakeMachine) => void = machine => this.finish(machine, 'out\n', 'err\n', 0);
    /** Log polls before the agent "runs". */
    delayPolls = 1;
    ignoreSignals = false;
    private nextId = 1;

    finish(machine: FakeMachine, stdout: string, stderr: string, exitCode: number): void {
        machine.files.set(FLY_RUN_FILES.stdout, Buffer.from(stdout));
        machine.files.set(FLY_RUN_FILES.stderr, Buffer.from(stderr));
        machine.files.set(FLY_RUN_FILES.exitStatus, Buffer.from(`${exitCode}\n`));
        for (const line of stdout.split('\n').filter(Boolean)) machine.pendingLogs.push(`${FLY_LOG_MARKERS.stdout}${line}`);
        for (const line of stderr.split('\n').filter(Boolean)) machine.pendingLogs.push(`${FLY_LOG_MARKERS.stderr}${line}`);
        machine.pendingLogs.push('[info] Main child exited normally', `${FLY_LOG_MARKERS.exit}${exitCode}`);
    }

    fetch = async (url: string, init: RequestInit = {}): Promise<Response> => {
        const method = init.method ?? 'GET';
        const body = init.body ? JSON.parse(String(init.body)) : undefined;
        this.requests.push({ method, url, body, authorization: (init.headers as Record<string, string>)?.Authorization });
        const parsed = new URL(url);
        const json = (status: number, value: unknown) => new Response(value === undefined ? '' : JSON.stringify(value), { status });
        if (parsed.pathname.endsWith('/logs')) {
            const machine = this.machines.get(parsed.searchParams.get('instance')!);
            if (!machine) return json(200, { data: [], meta: {} });
            if (this.delayPolls > 0) { this.delayPolls--; return json(200, { data: [], meta: { next_token: 't0' } }); }
            if (!machine.ran) { machine.ran = true; this.agent(machine); }
            const lines = machine.pendingLogs.splice(0);
            return json(200, { data: lines.map(message => ({ attributes: { timestamp: '2026-11-24T10:00:00Z', message } })), meta: { next_token: 't1' } });
        }
        const match = /\/apps\/([^/]+)\/machines(?:\/([^/?]+))?(?:\/([a-z]+))?/.exec(parsed.pathname)!;
        const [, , id, action] = match;
        if (method === 'POST' && !id) {
            const machine: FakeMachine = { id: `m${this.nextId++}`, state: 'created', request: body, files: new Map(), events: [], pendingLogs: [], signals: [] };
            for (const file of body.config.files ?? []) machine.files.set(file.guest_path, Buffer.from(file.raw_value, 'base64'));
            this.machines.set(machine.id, machine);
            return json(200, { id: machine.id, state: 'created', region: body.region, instance_id: 'i1' });
        }
        const machine = this.machines.get(id!);
        if (!machine) return json(404, { error: 'machine not found' });
        if (action === 'wait') { machine.state = 'started'; return json(200, { ok: true }); }
        if (action === 'signal') {
            machine.signals.push(body.signal);
            if (!this.ignoreSignals && !machine.files.has(FLY_RUN_FILES.exitStatus)) this.finish(machine, 'partial\n', 'terminated\n', 128 + body.signal);
            return json(200, {});
        }
        if (action === 'exec') {
            const [, , script, , file, offset, length] = body.command as string[];
            const content = machine.files.get(file);
            if (script.includes('stat -c')) return json(200, content ? { exit_code: 0, stdout: `${content.length}\n` } : { exit_code: 3 });
            const slice = content!.subarray(Number(offset), Number(offset) + Number(length));
            return json(200, { exit_code: 0, stdout: slice.toString('base64') });
        }
        if (method === 'DELETE') { this.machines.delete(machine.id); this.destroyed.push(machine.id); return json(200, { ok: true }); }
        if (method === 'GET') return json(200, { id: machine.id, state: machine.state, events: machine.events });
        return json(400, { error: `unexpected ${method} ${url}` });
    };
}

function runtime(fly: FakeFly, environment: Record<string, string> = FLY_ENV) {
    return new FlyMachinesRuntime({ environment, fetch: fly.fetch, pollIntervalMs: 2 });
}

test('config: token and app are required; size, memory, region and private network are validated', () => {
    assert.throws(() => resolveFlyMachinesConfig({}), /needs PROPR_FLY_API_TOKEN and PROPR_FLY_APP/);
    assert.throws(() => resolveFlyMachinesConfig({ ...FLY_ENV, PROPR_FLY_MACHINE_SIZE: 'huge' }), FlyMachinesConfigError);
    assert.throws(() => resolveFlyMachinesConfig({ ...FLY_ENV, PROPR_FLY_REGION: 'amsterdam' }), /region code/);
    assert.throws(() => resolveFlyMachinesConfig({ ...FLY_ENV, PROPR_FLY_MACHINE_MEMORY_MB: '100' }), /256 or more/);
    const config = resolveFlyMachinesConfig({ ...FLY_ENV, PROPR_FLY_API_TOKEN: '', FLY_API_TOKEN: 'legacy', PROPR_FLY_MACHINES_API_URL: 'http://flaps.internal:4280/v1/' });
    assert.equal(config.token, 'legacy');
    assert.equal(config.apiUrl, 'http://flaps.internal:4280/v1');
    assert.equal(config.size, 'performance-2x');
    assert.equal(config.privateNetwork, false);
    assert.equal(resolveFlyMachinesConfig({ ...FLY_ENV, FLY_APP_NAME: 'propr', FLY_PRIVATE_IP: 'fdaa::3' }).privateNetwork, true);
    assert.equal(resolveFlyMachinesConfig({ ...FLY_ENV, FLY_APP_NAME: 'propr', FLY_PRIVATE_IP: 'fdaa::3', PROPR_FLY_PRIVATE_NETWORK: 'off' }).privateNetwork, false);
    assert.equal(flyInternalMcpUrl({ FLY_APP_NAME: 'propr' }), 'http://propr.internal:4000/api/mcp');
    assert.equal(flyAuthorization('FlyV1 fm2_x'), 'FlyV1 fm2_x');
    assert.equal(flyAuthorization('abc'), 'Bearer abc');
});

test('guest: preset CPUs, memory from config, else the run limit, else the preset', () => {
    assert.equal(dockerMemoryToMb('6g'), 6144);
    assert.equal(dockerMemoryToMb('1000m'), 1000);
    const resources = { init: true, memory: '6g', memorySwap: '6g', cpus: '4', pidsLimit: '512' };
    assert.deepEqual(flyMachineGuest({ size: 'performance-2x' }, resources), { cpu_kind: 'performance', cpus: 2, memory_mb: 6144 });
    assert.deepEqual(flyMachineGuest({ size: 'shared-cpu-4x' }), { cpu_kind: 'shared', cpus: 4, memory_mb: 1024 });
    assert.deepEqual(flyMachineGuest({ size: 'performance-1x', memoryMb: 3000 }, resources), { cpu_kind: 'performance', cpus: 1, memory_mb: 3072 });
});

test('capabilities: clone transport and file upload, no binds or restricted network; MCP private network only on Fly', () => {
    const off = flyMachinesCapabilities({});
    assert.equal(off.supportsBindMounts, false);
    assert.equal(off.supportsFileUpload, true);
    assert.equal(off.supportsRestrictedNetwork, false);
    assert.equal(off.supportsMcpPrivateNetwork, false);
    assert.deepEqual(off.workspaceTransports, ['clone']);
    assert.equal(flyMachinesCapabilities({ FLY_APP_NAME: 'propr', FLY_PRIVATE_IP: 'fdaa::3' }).supportsMcpPrivateNetwork, true);
    assert.ok(registeredAgentRuntimes().includes(FLY_MACHINES_RUNTIME_KIND));
    assert.equal(getAgentRuntime({ runtime: 'fly-machines' }).kind, 'fly-machines');
    const onFly = runtime(new FakeFly(), { ...FLY_ENV, FLY_APP_NAME: 'propr', FLY_PRIVATE_IP: 'fdaa::3' });
    assert.equal(planAgentRunMcpTransport(onFly, {}).transport, 'private-network');
    assert.equal(planAgentRunMcpTransport(runtime(new FakeFly()), { API_PUBLIC_URL: 'https://propr.example' }).transport, 'reachable-url');
});

test('capability checks refuse binds and restricted networking before launch', () => {
    const fly = runtime(new FakeFly());
    const bound = new AgentRunSpecBuilder({
        agentType: 'claude', image: 'i', name: 'n', stdin: false, network: agentRunNetwork('bridge'),
        workspace: { hostPath: '/tmp/w', containerPath: '/home/node/workspace', readOnly: false },
    }).workspaceMount().build();
    assert.throws(() => assertAgentRuntimeSupports(fly, bound), (error: unknown) => error instanceof AgentRuntimeCapabilityError && error.capability === 'bind_mounts');
    const restricted = spec();
    restricted.network = { ...restricted.network, policy: { mode: 'restricted', allow: [], privateAddressAllow: [], source: 'instance' } };
    assert.throws(() => assertAgentRuntimeSupports(fly, restricted), (error: unknown) => error instanceof AgentRuntimeCapabilityError && error.capability === 'restricted_network');
});

test('machine request: image entrypoint chain, Docker env semantics, uploads, prompt file, auto-destroy and no restart', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'propr-fly-env-'));
    const envFile = path.join(directory, 'agent.env');
    fs.writeFileSync(envFile, 'FROM_FILE=1\nA=from-file\n# comment\nBARE\n');
    const run = spec();
    run.envFiles.push({ path: envFile, order: -1 });
    run.repoSetup = { agentType: 'claude', shell: '/bin/bash', script: 'setup', providerEntrypoint: '/home/node/claude-entrypoint.sh', env: [{ name: 'SETUP', value: 's' }] };
    run.files = [
        { type: 'directory', path: '/home/node/.claude', mode: 0o700, purpose: 'credential' },
        { type: 'file', path: '/home/node/.claude/.credentials.json', content: Buffer.from('{"t":1}'), mode: 0o600, purpose: 'credential' },
    ];
    run.resources = { init: true, memory: '6g', memorySwap: '6g', cpus: '4', pidsLimit: '512' };
    const request = renderFlyMachineRequest(run, {
        config: { region: 'ams', size: 'performance-2x', resultLingerSeconds: 600 }, launchEnvironment: { INHERITED: 'yes', BARE: 'bare' }, stdinData: 'the prompt',
    });
    assert.equal(request.name, 'claude-issue-7-abc');
    assert.equal(request.region, 'ams');
    assert.equal(request.config.image, 'propr/agent:test');
    assert.equal(request.config.auto_destroy, true);
    assert.deepEqual(request.config.restart, { policy: 'no' });
    assert.deepEqual(request.config.guest, { cpu_kind: 'performance', cpus: 2, memory_mb: 6144 });
    assert.deepEqual(request.config.init.entrypoint!.slice(0, 2), ['/bin/bash', '-c']);
    assert.deepEqual(request.config.init.cmd, [
        '/tmp/propr-fly-run', '600', '/home/node/workspace', '0:0',
        '/bin/bash', '-lc', 'clone-script', 'setup', '/home/node/claude-entrypoint.sh', 'claude', '-p',
    ]);
    // -e wins over the env file; a bare name inherits from the launch environment.
    assert.deepEqual(request.config.env, { FROM_FILE: '1', A: '1', BARE: 'bare', SETUP: 's', INHERITED: 'yes' });
    const files = new Map(request.config.files!.map(file => [file.guest_path, Buffer.from(file.raw_value, 'base64').toString()]));
    assert.equal(files.get('/home/node/.claude/.credentials.json'), '{"t":1}');
    assert.equal(files.get(FLY_RUN_FILES.stdin), 'the prompt');
    assert.equal(files.get(FLY_RUN_FILES.uploads), 'd\t0700\t/home/node/.claude\nf\t0600\t/home/node/.claude/.credentials.json\n');
    assert.equal(request.config.metadata!.propr_task_id, 'task-7');
    assert.equal(flyMachineName('--Claude_Issue 7--'), 'claude-issue-7');
    const bound = spec();
    bound.mounts.push({ type: 'bind', source: '/x', target: '/y', readOnly: true, purpose: 'data', order: 9 });
    assert.throws(() => renderFlyMachineRequest(bound, { config: { size: 'performance-1x', resultLingerSeconds: 60 }, launchEnvironment: {} }), /bind-mounts \/y/);
});

test('log lines: only launcher-marked lines are output; the exit marker carries the status', () => {
    assert.deepEqual(parseFlyLogLine(`${FLY_LOG_MARKERS.stdout}{"type":"x"}`), { stream: 'stdout', text: '{"type":"x"}\n' });
    assert.deepEqual(parseFlyLogLine(`${FLY_LOG_MARKERS.stderr}oops\n`), { stream: 'stderr', text: 'oops\n' });
    assert.deepEqual(parseFlyLogLine(`${FLY_LOG_MARKERS.exit}137`), { exitCode: 137 });
    assert.equal(parseFlyLogLine(' INFO Starting init (commit: abc)'), undefined);
    assert.equal(flyMachineExitCode({ id: 'm', events: [{ timestamp: 1, request: { exit_event: { exit_code: 1 } } }, { timestamp: 2, request: { exit_event: { exit_code: 137, oom_killed: true } } }] }), 137);
});

test('a run creates one Machine, streams live output, returns the exact captured output and is destroyed on release', async () => {
    const fly = new FakeFly();
    const exact = '{"type":"system","session_id":"s-1"}\n{"type":"assistant","message":{"id":"m-1"}}\nno newline at end';
    fly.agent = machine => fly.finish(machine, exact, 'warn\n', 0);
    const containers: string[] = [];
    const sessions: string[] = [];
    const handle = runtime(fly).start(spec(), {
        timeout: 10_000, stdinData: 'prompt', extraEnvVars: { INHERITED: 'from-launch' },
        onContainerId: id => { containers.push(id); }, onSessionId: id => { sessions.push(id); },
    });
    const live: string[] = [];
    handle.stdout.on('data', chunk => live.push(chunk.toString()));
    const result = await handle.wait();
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, exact, 'the capture file wins over the line-split live stream');
    assert.equal(result.stderr, 'warn\n');
    assert.equal(result.messageTimestamps.get('m-1'), '2026-11-24T10:00:00Z');
    assert.deepEqual(containers, ['m1']);
    assert.deepEqual(sessions, ['s-1']);
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(live.join('').includes('"session_id":"s-1"'));
    const create = fly.requests.find(request => request.method === 'POST' && request.url.endsWith('/apps/propr-agents/machines'))!;
    assert.equal(create.authorization, 'FlyV1 fm2_test');
    assert.equal(create.body.config.env.INHERITED, 'from-launch');
    assert.ok(typeof (handle as any).timing.coldStartMs === 'number');
    assert.equal((await handle.inspect()).liveness, 'stopped', 'a lingering Machine whose agent exited is not a running run');
    assert.equal((await handle.readFile!(FLY_RUN_FILES.stderr))!.toString(), 'warn\n');
    assert.equal(await handle.readFile!('/missing'), null);
    await handle.release!();
    assert.deepEqual(fly.destroyed, ['m1']);
    assert.equal((await handle.inspect()).liveness, 'not_found');
    assert.equal(await handle.readFile!(FLY_RUN_FILES.stderr), null);
});

test('stop() signals the agent through the Machine and the run settles with its exit status', async () => {
    const fly = new FakeFly();
    fly.agent = () => undefined; // keeps running until signalled
    fly.delayPolls = 0;
    const handle = runtime(fly).start(spec(), { timeout: 10_000 });
    while (!fly.machines.get('m1')?.request) await new Promise(resolve => setTimeout(resolve, 2));
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(await handle.isAlive(), true);
    await handle.stop('SIGTERM', 1000);
    const result = await handle.wait();
    assert.deepEqual(fly.machines.get('m1')!.signals, [15]);
    assert.equal(result.exitCode, 143);
    assert.equal(result.stdout, 'partial\n');
    await handle.release!();
});

test('cancellation destroys the Machine and rejects; a timeout keeps partial output when asked', async () => {
    const fly = new FakeFly();
    fly.agent = () => undefined;
    const controller = new AbortController();
    const cancelled = runtime(fly).start(spec(), { timeout: 10_000, signal: controller.signal });
    while (!fly.machines.has('m1')) await new Promise(resolve => setTimeout(resolve, 2));
    controller.abort();
    await assert.rejects(cancelled.wait(), /aborted/i);
    assert.deepEqual(fly.destroyed, ['m1']);

    // An agent that does not exit on the signal is cancelled outright.
    fly.ignoreSignals = true;
    const stopped = runtime(fly).start(spec(), { timeout: 10_000 });
    const pending = stopped.wait();
    while (!(stopped as any).id) await new Promise(resolve => setTimeout(resolve, 2));
    await new Promise(resolve => setTimeout(resolve, 20));
    const stopStarted = Date.now();
    await stopped.stop('SIGTERM', 0);
    assert.ok(Date.now() - stopStarted >= 4_000, 'the agent got the stop window before the Machine was destroyed');
    await assert.rejects(pending, (error: unknown) => error instanceof AgentRunStoppedError);
    assert.ok(fly.destroyed.includes('m2'));

    const slow = new FakeFly();
    slow.agent = () => undefined;
    const timed = await runtime(slow).start(spec(), { timeout: 30, preserveOutputOnTimeout: true }).wait();
    assert.equal(timed.timedOut, true);
    assert.equal(timed.exitCode, 143);
    assert.match(timed.stderr, /timed out after 30ms/);
});

test('a Machine that ends without reporting (OOM) settles from its exit event and the streamed output', async () => {
    const fly = new FakeFly();
    fly.agent = machine => {
        machine.pendingLogs.push(`${FLY_LOG_MARKERS.stdout}{"type":"assistant"}`);
        machine.state = 'stopped';
        machine.events.push({ type: 'exit', timestamp: 5, request: { exit_event: { exit_code: 137, oom_killed: true } } });
    };
    const result = await runtime(fly).start(spec(), { timeout: 10_000 }).wait();
    assert.equal(result.exitCode, 137);
    assert.equal(result.stdout, '{"type":"assistant"}\n');
});

test('upload step: credential stores become per-run files and refreshed tokens are written back', async () => {
    const store = fs.mkdtempSync(path.join(os.tmpdir(), 'propr-fly-claude-'));
    fs.writeFileSync(path.join(store, '.credentials.json'), '{"token":"old"}', { mode: 0o600 });
    fs.writeFileSync(path.join(store, 'settings.json'), '{}');
    fs.writeFileSync(path.join(store, 'history.jsonl'), 'not in the manifest');
    const seed = path.join(store, 'seed.json');
    fs.writeFileSync(seed, '{"seed":true}');
    const run = new AgentRunSpecBuilder({
        agentType: 'claude', image: 'i', name: 'upload-run', stdin: false, network: agentRunNetwork('bridge'),
        workspace: { hostPath: '/tmp/w', containerPath: '/home/node/workspace', readOnly: false, mode: 'bind' },
    })
        .bind('/tmp/claude-logs-missing-for-test', '/tmp/claude-logs', false, 'logs')
        .credentialBind(store, '/home/node/.claude', false, { provider: 'claude', store: 'config', perRun: true })
        .strictBind(seed, '/home/node/.claude.json.seed', true, 'credential')
        .command('claude')
        .build();
    run.entrypoint = '/home/node/claude-entrypoint.sh';
    const uploaded = uploadAgentRunFiles(run);
    assert.deepEqual(uploaded.spec.mounts, []);
    const paths = uploaded.spec.files!.map(file => `${file.type}:${file.path}`);
    assert.ok(paths.includes('file:/home/node/.claude/.credentials.json'));
    assert.ok(paths.includes('file:/home/node/.claude/settings.json'));
    assert.ok(!paths.some(entry => entry.includes('history.jsonl')), 'only manifest files are uploaded');
    assert.ok(paths.includes('file:/home/node/.claude.json.seed'));
    assert.ok(paths.includes('directory:/tmp/claude-logs'));
    assert.throws(() => uploadAgentRunFiles({ ...run, mounts: [{ type: 'bind', source: '/nope', target: '/x', readOnly: true, purpose: 'data', order: 1, syntax: 'mount' }] }), /does not exist/);

    // Through runAgent, on a runtime that uploads instead of binding.
    let started: any;
    registerAgentRuntime('upload-fake', () => ({
        kind: 'upload-fake',
        capabilities: { supportsBindMounts: false, supportsFileUpload: true, supportsRestrictedNetwork: false, supportsMcpPrivateNetwork: false, reattach: false, workspaceTransports: ['bind'] },
        start(startedSpec: any) {
            started = startedSpec;
            let settled = false;
            return {
                spec: startedSpec, stdout: null as any, stderr: null as any,
                wait: async () => { settled = true; return { stdout: '', stderr: '', exitCode: 0, messageTimestamps: new Map() }; },
                stop: async () => undefined, inspect: async () => ({ liveness: 'stopped', name: startedSpec.name }), isAlive: async () => false,
                readFile: async (file: string) => (settled && file === '/home/node/.claude/.credentials.json' ? Buffer.from('{"token":"refreshed"}') : null),
            };
        },
    }) as any);
    const result = await runAgent({ runtime: 'upload-fake' } as any, run, { timeout: 1000 });
    assert.equal(result.exitCode, 0);
    assert.deepEqual(started.mounts, []);
    assert.equal(fs.readFileSync(path.join(store, '.credentials.json'), 'utf8'), '{"token":"refreshed"}');
});
