import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { after, mock, test } from 'node:test';

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
const { resolveFlyMachinesConfig, flyMachineGuest, flyInternalMcpUrl, dockerMemoryToMb, FlyMachinesConfigError, MIN_FLY_RESULT_LINGER_SECONDS } = await import('../packages/core/src/agents/runtime/flyMachinesConfig.ts');
const { renderFlyMachineRequest, parseFlyLogLine, flyMachineName, FLY_LOG_MARKERS, FLY_RUN_FILES } = await import('../packages/core/src/agents/runtime/flyMachinesLaunch.ts');
const { flyAuthorization, flyMachineExitCode } = await import('../packages/core/src/agents/runtime/flyMachinesApi.ts');
const { uploadAgentRunFiles, AgentRunFileUploadError } = await import('../packages/core/src/agents/runtime/agentRunFileUpload.ts');
const { FLY_CREATION_METADATA_KEY, FLY_CREATE_SETTLE_MS } = await import('../packages/core/src/agents/runtime/flyMachinesCreation.ts');
const { envFileValues } = await import('../packages/core/src/agents/credentials/hostCredentialStaging.ts');
const { AgentRunSpecBuilder, agentRunNetwork } = await import('../packages/core/src/agents/runtime/agentRunSpec.ts');
const { getAgentRuntime, registerAgentRuntime, assertAgentRuntimeSupports, runAgent, registeredAgentRuntimes, AgentRuntimeCapabilityError } = await import('../packages/core/src/agents/runtime/registry.ts');
const { planAgentRunMcpTransport } = await import('../packages/core/src/agents/runtime/agentRunMcpTransport.ts');
const { AgentRunStoppedError } = await import('../packages/core/src/agents/runtime/dockerRuntime.ts');
const { agentRunNetworkPolicy } = await import('../packages/core/src/agents/runtime/agentRunNetworkPolicy.ts');
const { executeWithNetworkPolicy } = await import('../packages/core/src/network/egressExecution.ts');

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

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
    mtimes: Map<string, number>;
    killed?: boolean;
    ran?: boolean;
    /** Log polls until the clone wrapper, spared by the forced stop, finishes publishing and the launcher records the exit. */
    finalizeIn?: number;
    lastKill?: string[];
    /** Guest-clock time the launcher recorded the exit (with {@link FakeFly.guestClock}). */
    exitedAt?: number;
}

/** An in-memory Machines + logs API. `agent` decides what a run prints and how it exits. */
class FakeFly {
    machines = new Map<string, FakeMachine>();
    /** `at`: {@link now} when the request arrived. */
    requests: Array<{ method: string; url: string; body?: any; authorization?: string; at: number }> = [];
    destroyed: string[] = [];
    agent: (machine: FakeMachine) => void = machine => this.finish(machine, 'out\n', 'err\n', 0);
    /** Log polls before the agent "runs". */
    delayPolls = 1;
    ignoreSignals = false;
    /** The forced kill exec fails (e.g. the exec API is down). */
    killFails = false;
    /** After a forced stop, the clone wrapper takes this many log polls to finalize (0: the exit is recorded at once). */
    finalizePolls = 0;
    /** This many DELETE requests fail with 503 before they succeed. */
    failDeletes = 0;
    /** Create requests wait for this before the API answers (a slow image pull/placement). */
    createGate?: Promise<void>;
    /**
     * The next create is accepted but its response is lost: the connection fails (`'network'`) or a proxy
     * answers with this status. `deferred`: the Machine appears only on {@link completeDeferredCreate}.
     */
    lostCreate?: { response: 'network' | number; deferred?: boolean };
    /** The next create is refused with this status; no Machine is created. */
    refuseCreate?: number;
    /** This many list requests fail with 503. */
    failLists = 0;
    private deferredCreate?: () => void;
    /** Content read requests (not stats) per file. */
    contentReads = new Map<string, number>();
    /**
     * When set, the launcher's linger runs on this clock (ms): a finished Machine destroys itself
     * (auto_destroy) once its linger (the rendered launcher argument) passed, unless retained.
     */
    guestClock?: number;
    /** Machines that destroyed themselves at the end of their linger. */
    expired: string[] = [];
    /**
     * When set, every logs request answers after this long (on {@link now}) with a full page and a
     * continuation token: a backlog that never drains. An abort by the client rejects it first.
     */
    slowLogsMs = 0;
    /** Added to {@link now} per millisecond a slow logs page is pending: lets a page take minutes of the run's clock. */
    clockStepMs = 0;
    /** Logs requests not answered yet, and those the client aborted. */
    pendingLogPages = 0;
    abortedLogs = 0;
    private skew = 0;
    private nextId = 1;
    private nextLogPage = 1;

    /** The deferred create of a {@link lostCreate} completes server-side: its Machine appears. */
    completeDeferredCreate(): void {
        this.deferredCreate?.();
        this.deferredCreate = undefined;
    }

    /** The run's clock when a test hands it to the runtime: real time, plus what slow log pages added. */
    now = (): number => Date.now() + this.skew;

    private async slowLogPage(machine: FakeMachine, signal?: AbortSignal | null): Promise<Response> {
        this.pendingLogPages++;
        try {
            for (const started = this.now(); this.now() - started < this.slowLogsMs;) {
                if (signal?.aborted) { this.abortedLogs++; throw signal.reason; }
                await sleep(1);
                this.skew += this.clockStepMs;
            }
        } finally {
            this.pendingLogPages--;
        }
        const lines = [...machine.pendingLogs.splice(0), '[info] health check passed'];
        const data = lines.map(message => ({ attributes: { timestamp: '2026-11-24T10:00:00Z', message } }));
        return new Response(JSON.stringify({ data, meta: { next_token: `p${this.nextLogPage++}` } }), { status: 200 });
    }

    /** The launcher's linger loop, observed lazily: true when the Machine is gone by now. */
    private expire(machine: FakeMachine): boolean {
        if (this.guestClock === undefined || machine.exitedAt === undefined || machine.files.has(FLY_RUN_FILES.retain)) return false;
        if (this.guestClock < machine.exitedAt + Number(machine.request.config.init.cmd[1]) * 1000) return false;
        this.machines.delete(machine.id);
        this.expired.push(machine.id);
        return true;
    }

    finish(machine: FakeMachine, stdout: string, stderr: string, exitCode: number): void {
        machine.files.set(FLY_RUN_FILES.stdout, Buffer.from(stdout));
        machine.files.set(FLY_RUN_FILES.stderr, Buffer.from(stderr));
        machine.files.set(FLY_RUN_FILES.exitStatus, Buffer.from(`${exitCode}\n`));
        if (this.guestClock !== undefined) machine.exitedAt ??= this.guestClock;
        for (const line of stdout.split('\n').filter(Boolean)) machine.pendingLogs.push(`${FLY_LOG_MARKERS.stdout}${line}`);
        for (const line of stderr.split('\n').filter(Boolean)) machine.pendingLogs.push(`${FLY_LOG_MARKERS.stderr}${line}`);
        machine.pendingLogs.push('[info] Main child exited normally', `${FLY_LOG_MARKERS.exit}${exitCode}`);
    }

    fetch = async (url: string, init: RequestInit = {}): Promise<Response> => {
        const method = init.method ?? 'GET';
        const body = init.body ? JSON.parse(String(init.body)) : undefined;
        this.requests.push({ method, url, body, authorization: (init.headers as Record<string, string>)?.Authorization, at: this.now() });
        const parsed = new URL(url);
        const json = (status: number, value: unknown) => new Response(value === undefined ? '' : JSON.stringify(value), { status });
        if (parsed.pathname.endsWith('/logs')) {
            const machine = this.machines.get(parsed.searchParams.get('instance')!);
            if (!machine || this.expire(machine)) return json(200, { data: [], meta: {} });
            if (this.slowLogsMs > 0) return this.slowLogPage(machine, init.signal);
            if (this.delayPolls > 0) { this.delayPolls--; return json(200, { data: [], meta: { next_token: 't0' } }); }
            if (!machine.ran) { machine.ran = true; this.agent(machine); }
            if (machine.finalizeIn !== undefined && --machine.finalizeIn === 0) this.finish(machine, 'partial\n', 'killed\n', 137);
            const lines = machine.pendingLogs.splice(0);
            return json(200, { data: lines.map(message => ({ attributes: { timestamp: '2026-11-24T10:00:00Z', message } })), meta: { next_token: 't1' } });
        }
        const match = /\/apps\/([^/]+)\/machines(?:\/([^/?]+))?(?:\/([a-z]+))?/.exec(parsed.pathname)!;
        const [, , id, action] = match;
        if (method === 'POST' && !id) {
            if (this.createGate) await this.createGate;
            if (this.refuseCreate) { const status = this.refuseCreate; this.refuseCreate = undefined; return json(status, { error: 'invalid config' }); }
            const create = (): FakeMachine => {
                const machine: FakeMachine = { id: `m${this.nextId++}`, state: 'started', request: body, files: new Map(), mtimes: new Map(), events: [], pendingLogs: [], signals: [] };
                for (const file of body.config.files ?? []) machine.files.set(file.guest_path, Buffer.from(file.raw_value, 'base64'));
                this.machines.set(machine.id, machine);
                return machine;
            };
            const lost = this.lostCreate;
            if (lost) {
                this.lostCreate = undefined;
                if (lost.deferred) this.deferredCreate = () => { create(); };
                else create();
                if (lost.response === 'network') throw new TypeError('fetch failed');
                return json(lost.response, { error: 'upstream timed out' });
            }
            const machine = create();
            machine.state = 'created';
            return json(200, { id: machine.id, state: 'created', region: body.region, instance_id: 'i1' });
        }
        if (method === 'GET' && !id) {
            if (this.failLists > 0) { this.failLists--; return json(503, { error: 'service unavailable' }); }
            // Ignores the metadata filter: the client must not rely on it to pick what it destroys.
            return json(200, [...this.machines.values()].map(machine => ({ id: machine.id, state: machine.state, config: { metadata: machine.request.config.metadata } })));
        }
        const machine = this.machines.get(id!);
        if (!machine || this.expire(machine)) return json(404, { error: 'machine not found' });
        if (action === 'wait') { machine.state = 'started'; return json(200, { ok: true }); }
        if (action === 'signal') {
            machine.signals.push(body.signal);
            if (!this.ignoreSignals && !machine.files.has(FLY_RUN_FILES.exitStatus)) this.finish(machine, 'partial\n', 'terminated\n', 128 + body.signal);
            return json(200, {});
        }
        if (action === 'exec') {
            const [, , script, , file, offset, length] = body.command as string[];
            if (script.includes('pwd -P')) {
                // The confined credential reader runs for real, against this host's filesystem.
                const ran = spawnSync('/bin/sh', (body.command as string[]).slice(1), { encoding: 'utf8' });
                return json(200, { exit_code: ran.status, stdout: ran.stdout, stderr: ran.stderr });
            }
            const content = machine.files.get(file);
            if (script.includes('stat -c')) {
                if (!content) return json(200, { exit_code: 3 });
                const mtime = machine.mtimes.get(file) ?? Date.parse('2026-11-24T10:00:00.250Z');
                const human = `${new Date(mtime).toISOString().replace('T', ' ').replace(/\.(\d+)Z$/, '.$1000000')} +0000`;
                return json(200, { exit_code: 0, stdout: `${content.length} ${Math.floor(mtime / 1000)} ${human}\n` });
            }
            if (script.includes('kill -s KILL')) {
                if (this.killFails) return json(200, { exit_code: 1, stderr: 'kill: No such process' });
                machine.killed = true;
                machine.lastKill = body.command;
                if (this.finalizePolls > 0) machine.finalizeIn = this.finalizePolls;
                else this.finish(machine, 'partial\n', 'killed\n', 137);
                return json(200, { exit_code: 0 });
            }
            if (script === ': > "$1"') { machine.files.set(file, Buffer.alloc(0)); return json(200, { exit_code: 0 }); }
            this.contentReads.set(file, (this.contentReads.get(file) ?? 0) + 1);
            const slice = content!.subarray(Number(offset), Number(offset) + Number(length));
            return json(200, { exit_code: 0, stdout: slice.toString('base64') });
        }
        if (method === 'DELETE' && this.failDeletes > 0) { this.failDeletes--; return json(503, { error: 'service unavailable' }); }
        if (method === 'DELETE') { this.machines.delete(machine.id); this.destroyed.push(machine.id); return json(200, { ok: true }); }
        if (method === 'GET') return json(200, { id: machine.id, state: machine.state, events: machine.events });
        return json(400, { error: `unexpected ${method} ${url}` });
    };
}

function runtime(fly: FakeFly, environment: Record<string, string> = FLY_ENV, now?: () => number) {
    return new FlyMachinesRuntime({ environment, fetch: fly.fetch, pollIntervalMs: 2, ...(now ? { now } : {}) });
}

/** Once the Machine started, the clock jumps a second per reading, so deadlines and stop windows elapse within a few polls. */
function fastClock(fly: FakeFly): () => number {
    let at = Date.now();
    return () => ([...fly.machines.values()].some(machine => machine.state === 'started') ? (at += 1000) : at);
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
    assert.equal(config.resultLingerSeconds, MIN_FLY_RESULT_LINGER_SECONDS, 'a finished Machine waits for its worker the minimum by default');
    // A linger shorter than the worker's collection would let the Machine destroy itself mid-read.
    assert.throws(() => resolveFlyMachinesConfig({ ...FLY_ENV, PROPR_FLY_RESULT_LINGER_SECONDS: '30' }), /PROPR_FLY_RESULT_LINGER_SECONDS must be a whole number of seconds \(7200 or more\)/);
    assert.equal(resolveFlyMachinesConfig({ ...FLY_ENV, PROPR_FLY_RESULT_LINGER_SECONDS: '9000' }).resultLingerSeconds, 9000);
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

test('direct launches refuse restricted networking before any Machine is created', async () => {
    const fly = new FakeFly();
    const direct = runtime(fly);
    const workflowPolicy = { mode: 'restricted' as const, source: 'workflow' as const, allow: ['registry.example.com'], instanceAllow: [] };
    const refused = (error: unknown) => error instanceof AgentRuntimeCapabilityError && error.capability === 'restricted_network'
        && error.runtime === FLY_MACHINES_RUNTIME_KIND && /cannot enforce the restricted network policy \(workflow\)/.test(error.message);
    // Restricted by the spec's neutral policy, by its restriction, or by the policy applying at launch.
    const byPolicy = spec();
    byPolicy.network = { ...byPolicy.network, policy: agentRunNetworkPolicy('claude', workflowPolicy) };
    await assert.rejects(direct.start(byPolicy).wait(), refused);
    const byRestriction = spec();
    byRestriction.network = { ...byRestriction.network, restriction: workflowPolicy };
    await assert.rejects(direct.start(byRestriction, { networkPolicyExempt: 'an exemption does not lift the spec\'s own restriction' }).wait(), refused);
    await assert.rejects(executeWithNetworkPolicy(workflowPolicy, () => direct.start(spec()).wait()), refused);
    assert.deepEqual(fly.requests, [], 'no Machine was created');
    // Rendering a create request refuses the spec's own restriction too.
    const config = { region: 'ams', size: 'performance-2x', resultLingerSeconds: MIN_FLY_RESULT_LINGER_SECONDS };
    assert.throws(() => renderFlyMachineRequest(byPolicy, { config, launchEnvironment: {} }), refused);
    assert.throws(() => renderFlyMachineRequest(byRestriction, { config, launchEnvironment: {} }), refused);
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
        config: { region: 'ams', size: 'performance-2x', resultLingerSeconds: 9000 }, launchEnvironment: { INHERITED: 'yes', BARE: 'bare' }, stdinData: 'the prompt',
    });
    assert.equal(request.name, 'claude-issue-7-abc');
    assert.equal(request.region, 'ams');
    assert.equal(request.config.image, 'propr/agent:test');
    assert.equal(request.config.auto_destroy, true);
    assert.deepEqual(request.config.restart, { policy: 'no' });
    assert.deepEqual(request.config.guest, { cpu_kind: 'performance', cpus: 2, memory_mb: 6144 });
    assert.deepEqual(request.config.init.entrypoint!.slice(0, 2), ['/bin/bash', '-c']);
    assert.deepEqual(request.config.init.cmd, [
        '/tmp/propr-fly-run', '9000', '/home/node/workspace', '0:0', '1', '/tmp/r/phase',
        '/bin/bash', '-lc', 'clone-script', 'setup', '/home/node/claude-entrypoint.sh', 'claude', '-p',
    ]);
    // -e wins over the env file; a bare name inherits from the launch environment.
    assert.deepEqual(request.config.env, { FROM_FILE: '1', A: '1', BARE: 'bare', SETUP: 's', INHERITED: 'yes' });
    const short = renderFlyMachineRequest(spec(), { config: { size: 'performance-1x', resultLingerSeconds: 60 }, launchEnvironment: {} });
    assert.equal(short.config.init.cmd![1], String(MIN_FLY_RESULT_LINGER_SECONDS), 'the launcher never lingers less than the minimum');
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

test('machine request: security restrictions the Machine cannot enforce are refused before launch', () => {
    const render = (run: any) => renderFlyMachineRequest(run, { config: { size: 'performance-1x', resultLingerSeconds: 60 }, launchEnvironment: {} });
    const readOnly = spec();
    readOnly.security.readOnlyRootFilesystem = true;
    assert.throws(() => render(readOnly), /read-only root filesystem, which Fly Machines cannot enforce/);
    const dropped = spec();
    dropped.security.capDrop = ['ALL'];
    assert.throws(() => render(dropped), /dropped capabilities \(ALL\)/);
    const profiled = spec();
    profiled.security.securityOpts = ['seccomp=/etc/profile.json'];
    assert.throws(() => render(profiled), /security option "seccomp=\/etc\/profile.json"/);
    // Relaxations and added capabilities need no enforcement; no-new-privileges is passed to the launcher.
    const relaxed = spec();
    relaxed.security = { noNewPrivileges: false, securityOpts: ['seccomp=unconfined', 'apparmor=unconfined'], capAdd: ['CHOWN'], capDrop: [], readOnlyRootFilesystem: false };
    assert.equal(render(relaxed).config.init.cmd![4], '0');
    relaxed.security.securityOpts.push('no-new-privileges');
    assert.equal(render(relaxed).config.init.cmd![4], '1');
    const script = render(spec()).config.init.entrypoint![2];
    assert.match(script, /no_new_privs=\$5; phase_file=\$6; shift 6/);
    assert.match(script, /\[ "\$no_new_privs" = 1 \] && set -- setpriv --no-new-privs -- "\$@"/);
});

test('machine request: an unreadable env file fails the launch instead of becoming an empty environment', async () => {
    const missing = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'propr-fly-env-')), 'gone.env');
    const run = spec();
    run.envFiles.push({ path: missing, order: -1 });
    assert.throws(
        () => renderFlyMachineRequest(run, { config: { size: 'performance-1x', resultLingerSeconds: 60 }, launchEnvironment: {} }),
        /Cannot read environment file .*gone\.env/,
    );
    // The Docker staging helper keeps relying on Docker to refuse the file.
    assert.deepEqual([...envFileValues(missing, {})], []);
    const fly = new FakeFly();
    await assert.rejects(runtime(fly).start(run, { timeout: 10_000 }).wait(), /Cannot read environment file/);
    assert.equal(fly.machines.size, 0, 'no Machine was created');
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
                readCredentialFile: async (root: string, file: string) => (settled && root === '/home/node/.claude' && file === '.credentials.json' ? { content: Buffer.from('{"token":"refreshed"}'), mtimeMs: 0 } : null),
            };
        },
    }) as any);
    const result = await runAgent({ runtime: 'upload-fake' } as any, run, { timeout: 1000 });
    assert.equal(result.exitCode, 0);
    assert.deepEqual(started.mounts, []);
    assert.equal(fs.readFileSync(path.join(store, '.credentials.json'), 'utf8'), '{"token":"refreshed"}');
});

test('timeout: an agent that ignores TERM is killed before the run settles, keeping its partial output and files', async () => {
    const fly = new FakeFly();
    fly.agent = () => undefined;
    fly.ignoreSignals = true;
    const handle = runtime(fly, FLY_ENV, fastClock(fly)).start(spec(), { timeout: 30, preserveOutputOnTimeout: true });
    const result = await handle.wait();
    const machine = fly.machines.get('m1')!;
    assert.equal(machine.killed, true, 'the agent was killed after its grace period');
    assert.deepEqual(machine.signals, [15]);
    assert.equal(result.timedOut, true);
    assert.equal(result.exitCode, 137, 'the exit status the launcher recorded after the kill');
    assert.equal(result.stdout, 'partial\n');
    assert.deepEqual(fly.destroyed, [], 'the stopped Machine keeps its result files');
    assert.equal((await handle.readFile!(FLY_RUN_FILES.stderr))!.toString(), 'killed\n');
    await handle.release!();
    assert.deepEqual(fly.destroyed, ['m1']);
});

test('timeout: a clone run\'s forced stop spares its wrapper and waits for it to publish the workspace', async () => {
    const fly = new FakeFly();
    fly.agent = () => undefined;
    fly.ignoreSignals = true;
    // Well past the 15 s a run without the clone wrapper gets (the clock advances a second per reading).
    fly.finalizePolls = 40;
    const handle = runtime(fly, FLY_ENV, fastClock(fly)).start(spec(), { timeout: 30, preserveOutputOnTimeout: true });
    const result = await handle.wait();
    const machine = fly.machines.get('m1')!;
    assert.deepEqual(machine.lastKill!.slice(3), ['sh', FLY_RUN_FILES.pid, '/tmp/r/phase', 'node'], 'the forced stop is told where the wrapper records its phase, and whom the agent runs as');
    assert.equal(result.timedOut, true);
    assert.equal(result.exitCode, 137, 'the exit recorded once the wrapper finished');
    assert.deepEqual(fly.destroyed, [], 'the finalizing Machine was not destroyed');
    await handle.release!();
});

/** A run's agent that keeps running and ignores TERM, behind a log backlog whose pages take 20 s each (within the 30 s request timeout). */
function slowLogsFly(): FakeFly {
    const fly = new FakeFly();
    fly.agent = () => undefined;
    fly.ignoreSignals = true;
    fly.slowLogsMs = 20_000;
    return fly;
}

const logRequests = (fly: FakeFly) => fly.requests.filter(request => request.url.includes('/logs')).length;

test('cancellation is not held up by log pagination: the page in flight is aborted and the Machine destroyed', async () => {
    const cancelled = slowLogsFly();
    const controller = new AbortController();
    const run = runtime(cancelled).start(spec(), { timeout: 600_000, signal: controller.signal });
    const outcome = run.wait().then(() => 'resolved', (error: Error) => error.message);
    while (cancelled.pendingLogPages === 0) await sleep(2);
    controller.abort(new Error('cancelled by the caller'));
    assert.equal(await Promise.race([outcome, sleep(3_000).then(() => 'still running')]), 'cancelled by the caller');
    assert.deepEqual(cancelled.destroyed, ['m1']);
    assert.equal(cancelled.abortedLogs, 1, 'the page in flight was aborted');
    const requested = logRequests(cancelled);
    await sleep(20);
    assert.equal(logRequests(cancelled), requested, 'no further page is requested');

    // stop(): once its window ends, the cancellation reaches the run in the middle of a page.
    const stopped = slowLogsFly();
    const handle = runtime(stopped).start(spec(), { timeout: 600_000 });
    const pending = handle.wait();
    while (stopped.pendingLogPages === 0) await sleep(2);
    await handle.stop('SIGTERM', 0);
    await assert.rejects(pending, (error: unknown) => error instanceof AgentRunStoppedError);
    assert.equal(stopped.machines.size, 0);
    assert.deepEqual(stopped.destroyed, ['m1']);
    assert.equal(stopped.abortedLogs, 1);

    // Past the deadline, in the TERM window of the timeout stop: the cancellation destroys the Machine, no KILL.
    const timedOut = slowLogsFly();
    const late = new AbortController();
    const expiring = runtime(timedOut).start(spec(), { timeout: 50, signal: late.signal });
    const expired = expiring.wait().then(() => 'resolved', (error: Error) => error.message);
    while (!timedOut.machines.get('m1')?.signals.length || timedOut.pendingLogPages === 0) await sleep(2);
    late.abort(new Error('cancelled during the timeout stop'));
    assert.equal(await Promise.race([expired, sleep(3_000).then(() => 'still running')]), 'cancelled during the timeout stop');
    assert.deepEqual(timedOut.destroyed, ['m1']);
    assert.equal(timedOut.machines.size, 0);
    assert.ok(!timedOut.requests.some(request => request.url.endsWith('/exec') && String(request.body.command[2]).includes('kill -s KILL')), 'destroyed instead of killed');
});

test('timeout: log pagination gives way at the run deadline and at the end of each stop window', async () => {
    const fly = slowLogsFly();
    // Each page takes 20 s of the run's clock, which passes 250 times faster while a page is pending.
    fly.clockStepMs = 250;
    const handle = runtime(fly, FLY_ENV, fly.now).start(spec(), { timeout: 30_000, preserveOutputOnTimeout: true });
    const result = await handle.wait();
    const at = (predicate: (request: FakeFly['requests'][number]) => boolean) => fly.requests.find(predicate)!.at;
    const created = at(request => request.method === 'POST' && request.url.endsWith('/machines'));
    const term = at(request => request.url.endsWith('/signal'));
    const kill = at(request => request.url.endsWith('/exec') && String(request.body.command[2]).includes('kill -s KILL'));
    assert.ok(term - created < 30_000 + 5_000, `TERM at the run deadline, not after the backlog (${term - created} ms)`);
    assert.ok(kill - term < 10_000 + 5_000, `KILL at the end of the TERM window, not after the backlog (${kill - term} ms)`);
    assert.ok(fly.abortedLogs >= 2, 'the pages in flight at the deadline and at the end of the TERM window were aborted');
    assert.equal(result.timedOut, true);
    assert.equal(result.exitCode, 137, 'the exit status the launcher recorded after the kill');
    assert.deepEqual(fly.destroyed, [], 'the stopped Machine keeps its result files');
    await handle.release!();
});

test('timeout: when the kill cannot be confirmed the Machine is destroyed before settling, or the run fails', async () => {
    const fly = new FakeFly();
    fly.agent = () => undefined;
    fly.ignoreSignals = true;
    fly.killFails = true;
    const handle = runtime(fly, FLY_ENV, fastClock(fly)).start(spec(), { timeout: 30, preserveOutputOnTimeout: true });
    const result = await handle.wait();
    assert.deepEqual(fly.destroyed, ['m1'], 'destroyed before wait() settled');
    assert.equal(result.timedOut, true);
    assert.equal(result.exitCode, null);
    assert.equal(await handle.readFile!(FLY_RUN_FILES.stdout), null, 'nothing is read from a destroyed run');

    // Neither the kill nor the destroy succeeds: the run does not report a settled timeout.
    const stuck = new FakeFly();
    stuck.agent = () => undefined;
    stuck.ignoreSignals = true;
    stuck.killFails = true;
    stuck.failDeletes = 1;
    const failing = runtime(stuck, FLY_ENV, fastClock(stuck)).start(spec(), { timeout: 30, preserveOutputOnTimeout: true });
    await assert.rejects(failing.wait(), /timed out and its Fly Machine m1 could not be stopped/);
    assert.equal(await failing.readFile!(FLY_RUN_FILES.stdout), null, 'a run that may still be executing is not read');
    await failing.release!();
    assert.deepEqual(stuck.destroyed, ['m1'], 'cleanup retried the destroy');
});

test('cancellation: a failed destroy leaves the Machine eligible for cleanup, and a failed release can be retried', async () => {
    const fly = new FakeFly();
    fly.agent = () => undefined;
    fly.failDeletes = 2;
    const controller = new AbortController();
    const handle = runtime(fly).start(spec(), { timeout: 10_000, signal: controller.signal });
    while (!(handle as any).id) await new Promise(resolve => setTimeout(resolve, 2));
    controller.abort();
    await assert.rejects(handle.wait(), /aborted/i);
    assert.deepEqual(fly.destroyed, [], 'the cancel-time destroy failed');
    assert.ok(fly.machines.has('m1'));
    await assert.rejects(handle.release!(), /returned 503/);
    await handle.release!();
    assert.deepEqual(fly.destroyed, ['m1'], 'a later release destroyed it');
    const deletes = fly.requests.filter(request => request.method === 'DELETE').length;
    assert.equal(deletes, 3);
    await handle.release!();
    assert.equal(fly.requests.filter(request => request.method === 'DELETE').length, deletes, 'release is idempotent once it succeeded');
});

test('retain(): marks the run retained inside the Machine before later reads, and only release() destroys it', async () => {
    const fly = new FakeFly();
    const handle = runtime(fly).start(spec(), { timeout: 10_000 });
    await handle.wait();
    handle.retain!();
    // A read issued right after retain() waits for the mark.
    assert.equal((await handle.readFile!(FLY_RUN_FILES.stderr))!.toString(), 'err\n');
    assert.ok(fly.machines.get('m1')!.files.has(FLY_RUN_FILES.retain), 'the launcher sees the retain marker and keeps lingering');
    assert.deepEqual(fly.destroyed, []);
    await handle.release!();
    assert.deepEqual(fly.destroyed, ['m1']);
    const script = renderFlyMachineRequest(spec(), { config: { size: 'performance-1x', resultLingerSeconds: 60 }, launchEnvironment: {} }).config.init.entrypoint![2];
    assert.match(script, /\[ -f "\$run_dir\/retain" \] \|\| break/, 'the linger loop continues while the marker exists');
});

test('readFileWithStat: the remote modification time is returned and an oversized file is refused after the stat', async () => {
    const fly = new FakeFly();
    fly.agent = machine => {
        fly.finish(machine, 'out\n', 'err\n', 0);
        machine.files.set('/home/node/.claude/.credentials.json', Buffer.from('{"t":2}'));
        machine.mtimes.set('/home/node/.claude/.credentials.json', Date.parse('2026-11-24T09:59:30.123Z'));
        machine.files.set('/home/node/.claude/big.json', Buffer.alloc(4096));
    };
    const handle = runtime(fly).start(spec(), { timeout: 10_000 });
    await handle.wait();
    const read = await handle.readFileWithStat!('/home/node/.claude/.credentials.json', { maxBytes: 1024 });
    assert.ok(read && read !== 'oversized');
    assert.equal(read.content.toString(), '{"t":2}');
    assert.equal(read.mtimeMs, Date.parse('2026-11-24T09:59:30.123Z'));
    assert.equal(await handle.readFileWithStat!('/home/node/.claude/big.json', { maxBytes: 1024 }), 'oversized');
    assert.equal(fly.contentReads.get('/home/node/.claude/big.json'), undefined, 'no content of the oversized file was transferred');
    await handle.release!();
});

function credentialRun(store: string, name: string) {
    const run = new AgentRunSpecBuilder({
        agentType: 'claude', image: 'i', name, stdin: false, network: agentRunNetwork('bridge'),
        workspace: { hostPath: '/tmp/w', containerPath: '/home/node/workspace', readOnly: false, mode: 'bind' },
    }).credentialBind(store, '/home/node/.claude', false, { provider: 'claude', store: 'config', perRun: true }).command('claude').build();
    run.entrypoint = '/home/node/claude-entrypoint.sh';
    return run;
}

function credentialStore(): string {
    const store = fs.mkdtempSync(path.join(os.tmpdir(), 'propr-fly-claude-'));
    fs.writeFileSync(path.join(store, '.credentials.json'), '{"token":"old"}', { mode: 0o600 });
    return store;
}

/** A finished run whose credential file the collector reads back. */
function finishedHandle(run: any, read: (file: string, options: { maxBytes: number }) => Promise<any>) {
    let retained = 0;
    let released = 0;
    const handle: any = {
        spec: run, stdout: null, stderr: null,
        wait: async () => ({ stdout: '', stderr: '', exitCode: 0, messageTimestamps: new Map() }),
        stop: async () => undefined, inspect: async () => ({ liveness: 'stopped', name: run.name }), isAlive: async () => false,
        readCredentialFile: (root: string, relative: string, options: { maxBytes: number }) => read(path.posix.join(root, relative), options),
        retain: () => { retained++; },
        release: async () => { released++; },
    };
    return { handle, counts: () => ({ retained, released }) };
}

test('credential write-back orders concurrent refreshes by the run\'s modification time, not collection time', async () => {
    const store = credentialStore();
    const run = credentialRun(store, 'older-refresh');
    const uploaded = uploadAgentRunFiles(run);
    // Another run refreshed and committed after this one refreshed (but before this one finished).
    const refreshedAt = Date.now() - 60_000;
    fs.writeFileSync(path.join(store, '.credentials.json'), '{"token":"newer"}');
    const older = finishedHandle(run, async file => (file.endsWith('.credentials.json') ? { content: Buffer.from('{"token":"older"}'), mtimeMs: refreshedAt } : null));
    const collected = await uploaded.collect(older.handle);
    assert.deepEqual(collected.results.map(result => result.outcome), ['kept-canonical']);
    assert.equal(fs.readFileSync(path.join(store, '.credentials.json'), 'utf8'), '{"token":"newer"}');

    // A refresh made after the canonical change still wins.
    const later = uploadAgentRunFiles(credentialRun(store, 'newer-refresh'));
    fs.writeFileSync(path.join(store, '.credentials.json'), '{"token":"other"}', { flag: 'w' });
    fs.utimesSync(path.join(store, '.credentials.json'), new Date(Date.now() - 120_000), new Date(Date.now() - 120_000));
    const newer = finishedHandle(run, async file => (file.endsWith('.credentials.json') ? { content: Buffer.from('{"token":"latest"}'), mtimeMs: Date.now() } : null));
    assert.deepEqual((await later.collect(newer.handle)).results.map(result => result.outcome), ['written-newer']);
    assert.equal(fs.readFileSync(path.join(store, '.credentials.json'), 'utf8'), '{"token":"latest"}');

    // Without a modification time from the runtime, a changed canonical credential is kept.
    const untimed = uploadAgentRunFiles(credentialRun(store, 'untimed-refresh'));
    fs.writeFileSync(path.join(store, '.credentials.json'), '{"token":"canonical"}');
    const legacy = finishedHandle(run, async file => (file.endsWith('.credentials.json') ? { content: Buffer.from('{"token":"untimed"}'), mtimeMs: 0 } : null)).handle;
    assert.deepEqual((await untimed.collect(legacy)).results.map(result => result.outcome), ['kept-canonical']);
    assert.equal(fs.readFileSync(path.join(store, '.credentials.json'), 'utf8'), '{"token":"canonical"}');
});

test('credential write-back: an oversized credential is refused with a bound and never committed', async () => {
    const store = credentialStore();
    const run = credentialRun(store, 'oversized-refresh');
    const uploaded = uploadAgentRunFiles(run);
    const bounds: number[] = [];
    const { handle } = finishedHandle(run, async (_file, options) => { bounds.push(options.maxBytes); return 'oversized'; });
    const collected = await uploaded.collect(handle);
    assert.ok(bounds.length > 0 && bounds.every(bound => bound === 1024 * 1024), 'every credential read carries the size limit');
    assert.deepEqual(collected.results, []);
    assert.equal(collected.keepRun, false);
    assert.equal(fs.readFileSync(path.join(store, '.credentials.json'), 'utf8'), '{"token":"old"}');
});

test('credential write-back failure saves the refreshed copy for recovery; an unreadable one keeps the run', async () => {
    const { CredentialBroker } = await import('../packages/core/src/agents/credentials/broker.ts');
    const { collectingHandle } = await import('../packages/core/src/agents/runtime/agentRunFileUpload.ts');
    const { STAGING_RETAINED_FILE } = await import('../packages/core/src/agents/credentials/hostCredentialStaging.ts');
    const store = credentialStore();
    const run = credentialRun(store, 'commit-fails');
    const broker = new CredentialBroker({ lock: { lockRoot: path.join(credentialRunDir, '.locks') } });
    broker.commit = async () => { throw new Error('EROFS: read-only file system'); };
    const uploaded = uploadAgentRunFiles(run, { broker });
    const refreshed = finishedHandle(run, async file => (file.endsWith('.credentials.json') ? { content: Buffer.from('{"token":"refreshed"}'), mtimeMs: Date.now() } : null));
    const wrapped = collectingHandle(refreshed.handle, handle => uploaded.collect(handle));
    await wrapped.wait();
    const collected = await uploaded.collect(refreshed.handle);
    assert.ok(collected.recoveryDir?.startsWith(credentialRunDir));
    assert.equal(collected.keepRun, false, 'the saved copy releases the run');
    const saved = path.join(collected.recoveryDir!, 'claude-config', '.credentials.json');
    assert.equal(fs.readFileSync(saved, 'utf8'), '{"token":"refreshed"}');
    assert.equal(fs.statSync(saved).mode & 0o777, 0o600);
    assert.equal(fs.statSync(collected.recoveryDir!).mode & 0o777, 0o700);
    const marker = JSON.parse(fs.readFileSync(path.join(collected.recoveryDir!, STAGING_RETAINED_FILE), 'utf8'));
    assert.deepEqual(marker.files, [{ staged: saved, canonical: path.join(store, '.credentials.json') }]);
    assert.match(marker.error, /EROFS/);
    await wrapped.release!();
    assert.deepEqual(refreshed.counts(), { retained: 1, released: 1 }, 'retained while its credentials were read, then released as usual');

    // The refreshed credential cannot be read back: the run may hold its only copy and is kept.
    const unreadable = uploadAgentRunFiles(credentialRun(store, 'read-fails'));
    const failing = finishedHandle(run, async () => { throw new Error('exec API unavailable'); });
    const kept = collectingHandle(failing.handle, handle => unreadable.collect(handle));
    await kept.wait();
    assert.equal((await unreadable.collect(failing.handle)).keepRun, true);
    await kept.release!();
    assert.deepEqual(failing.counts(), { retained: 2, released: 0 }, 'retained before reading and again when kept; release() does not discard it');
});

test('credential read-back refuses symlinks on the path and never uses the general file reader', async () => {
    // A real store directory inside the "Machine": the confined reader script runs under /bin/sh.
    const guest = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'propr-fly-guest-')));
    const root = path.join(guest, 'claude');
    fs.mkdirSync(path.join(root, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(guest, 'root-only-secret'), 'TOP SECRET');
    fs.writeFileSync(path.join(root, '.credentials.json'), '{"token":"refreshed"}');
    fs.utimesSync(path.join(root, '.credentials.json'), new Date('2026-11-24T09:59:30Z'), new Date('2026-11-24T09:59:30Z'));
    fs.symlinkSync(path.join(guest, 'root-only-secret'), path.join(root, 'link.json'));
    fs.mkdirSync(path.join(guest, 'elsewhere'));
    fs.writeFileSync(path.join(guest, 'elsewhere', 'token.json'), 'TOP SECRET');
    fs.symlinkSync(path.join(guest, 'elsewhere'), path.join(root, 'linked-dir'));
    fs.writeFileSync(path.join(root, 'big.json'), Buffer.alloc(4096));
    fs.symlinkSync(root, path.join(guest, 'store-link'));
    const fly = new FakeFly();
    const handle = runtime(fly).start(spec(), { timeout: 10_000 });
    await handle.wait();
    const read = await handle.readCredentialFile!(root, '.credentials.json', { maxBytes: 1024 });
    assert.ok(read && read !== 'oversized');
    assert.equal(read.content.toString(), '{"token":"refreshed"}');
    assert.equal(read.mtimeMs, Date.parse('2026-11-24T09:59:30Z'));
    assert.equal(await handle.readCredentialFile!(root, 'link.json', { maxBytes: 1024 }), null, 'a symlinked output is not followed');
    assert.equal(await handle.readCredentialFile!(root, 'linked-dir/token.json', { maxBytes: 1024 }), null, 'nor a symlinked parent directory');
    assert.equal(await handle.readCredentialFile!(path.join(guest, 'store-link'), '.credentials.json', { maxBytes: 1024 }), null, 'nor a symlinked store root');
    assert.equal(await handle.readCredentialFile!(root, 'sub', { maxBytes: 1024 }), null, 'a directory is not a credential');
    assert.equal(await handle.readCredentialFile!(root, 'missing.json', { maxBytes: 1024 }), null);
    assert.equal(await handle.readCredentialFile!(root, 'big.json', { maxBytes: 1024 }), 'oversized');
    await assert.rejects(handle.readCredentialFile!(root, '../root-only-secret', { maxBytes: 1024 }), /not a plain path/);
    await assert.rejects(handle.readCredentialFile!(root, '/etc/shadow', { maxBytes: 1024 }), /not a plain path/);
    await handle.release!();
    fs.rmSync(guest, { recursive: true, force: true });

    // The collector never falls back to the general reader, which follows links.
    const store = credentialStore();
    const uploaded = uploadAgentRunFiles(credentialRun(store, 'no-confined-reader'));
    const { handle: general } = finishedHandle(spec(), async () => null);
    delete general.readCredentialFile;
    const generalReads: string[] = [];
    general.readFile = async (file: string) => { generalReads.push(file); return Buffer.from('TOP SECRET'); };
    general.readFileWithStat = async (file: string) => { generalReads.push(file); return { content: Buffer.from('TOP SECRET'), mtimeMs: Date.now() }; };
    const collected = await uploaded.collect(general);
    assert.deepEqual(generalReads, []);
    assert.equal(collected.keepRun, true, 'an output that cannot be read safely keeps the run');
    assert.equal(fs.readFileSync(path.join(store, '.credentials.json'), 'utf8'), '{"token":"old"}');
});

test('a writable credential store the worker cannot write back to refuses the run before launch', async (context) => {
    const store = credentialStore();
    fs.chmodSync(store, 0o500);
    context.after(() => fs.chmodSync(store, 0o700));
    let writable = true;
    try { fs.accessSync(store, fs.constants.W_OK); } catch { writable = false; }
    if (writable) { context.skip('running as root: the store stays writable'); return; }
    const run = credentialRun(store, 'unwritable-store');
    assert.throws(() => uploadAgentRunFiles(run), /cannot write refreshed tokens back to the claude config credential store/);
    // Through runAgent: nothing is started.
    let starts = 0;
    registerAgentRuntime('upload-unwritable-fake', () => ({
        kind: 'upload-unwritable-fake',
        capabilities: { supportsBindMounts: false, supportsFileUpload: true, supportsRestrictedNetwork: false, supportsMcpPrivateNetwork: false, reattach: false, workspaceTransports: ['bind'] },
        start() { starts++; throw new Error('must not start'); },
    }) as any);
    await assert.rejects(runAgent({ runtime: 'upload-unwritable-fake' } as any, run, { timeout: 1000 }), /cannot write refreshed tokens back/);
    assert.equal(starts, 0);
    // A read-only mount of the same store needs no write-back and still runs.
    const readOnly = { ...run, mounts: run.mounts.map((mount: any) => ({ ...mount, readOnly: true })) };
    assert.ok(uploadAgentRunFiles(readOnly).spec.files!.some(file => file.path === '/home/node/.claude/.credentials.json'));
});

test('a credential store holding provider session state (perRun: false) refuses the run before launch', async () => {
    const { buildClaudeRunSpec } = await import('../packages/core/src/agents/impl/utils/dockerArgsBuilder.ts');
    const store = credentialStore();
    // The session history a resumed goal session reads lives beside the credentials, outside the manifest.
    fs.mkdirSync(path.join(store, 'projects', '-home-node-workspace'), { recursive: true });
    fs.writeFileSync(path.join(store, 'projects', '-home-node-workspace', 'claude-session.jsonl'), '{"type":"user"}\n');
    const config = {
        id: 'claude-id', type: 'claude', alias: 'claude-test', enabled: true, dockerImage: 'propr/agent:test',
        configPath: store, supportedModels: ['test-model'], defaultModel: 'test-model',
    } as any;
    const goal = buildClaudeRunSpec(config, 1000, {
        worktreePath: '/tmp/worktree', githubToken: 'token', modelName: 'test-model', issueNumber: 0, taskId: 'goal-123',
        executionMode: 'goal', resumeSessionId: 'claude-session',
    } as any);
    assert.ok(goal.args.includes('--resume'), 'a resuming goal session');
    assert.ok(goal.mounts.some(mount => mount.type === 'bind' && mount.credentialStore?.perRun === false), 'its store keeps session state');
    let materialized = 0;
    const broker = { materialize: () => { materialized++; throw new Error('must not be materialized'); } } as any;
    assert.throws(
        () => uploadAgentRunFiles(goal, { broker }),
        (error: unknown) => error instanceof AgentRunFileUploadError && /keeps provider session state in the claude config credential store/.test(error.message),
    );
    assert.equal(materialized, 0, 'refused before any per-run copy is made');

    // Through runAgent, on a runtime without bind mounts: nothing is started.
    let starts = 0;
    registerAgentRuntime('upload-session-fake', () => ({
        kind: 'upload-session-fake',
        capabilities: { supportsBindMounts: false, supportsFileUpload: true, supportsRestrictedNetwork: false, supportsMcpPrivateNetwork: false, reattach: false, workspaceTransports: ['bind'] },
        start() { starts++; throw new Error('must not start'); },
    }) as any);
    const run = credentialRun(store, 'session-store');
    run.mounts = run.mounts.map((mount: any) => (mount.credentialStore ? { ...mount, credentialStore: { ...mount.credentialStore, perRun: false } } : mount));
    await assert.rejects(runAgent({ runtime: 'upload-session-fake' } as any, run, { timeout: 1000 }), /keeps provider session state/);
    assert.equal(starts, 0);
    // A read-only session store is refused too: what the run writes there would not persist either.
    const readOnly = { ...run, mounts: run.mounts.map((mount: any) => ({ ...mount, readOnly: true })) };
    assert.throws(() => uploadAgentRunFiles(readOnly), /keeps provider session state/);
});

test('a failed explicit release of a retained Machine keeps retrying the destroy with backoff', async () => {
    const fly = new FakeFly();
    const handle = runtime(fly).start(spec(), { timeout: 10_000 });
    await handle.wait();
    // A clone run: retained before its result is retrieved, which cancels the automatic removal.
    handle.retain!();
    assert.equal((await handle.readFile!(FLY_RUN_FILES.stdout))!.toString(), 'out\n');
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
        fly.failDeletes = 2;
        await assert.rejects(handle.release!(), /returned 503/);
        const deletes = () => fly.requests.filter(request => request.method === 'DELETE').length;
        const flush = async () => { for (let index = 0; index < 20; index++) await new Promise(resolve => setImmediate(resolve)); };
        assert.equal(deletes(), 1);
        mock.timers.tick(59_000);
        await flush();
        assert.equal(deletes(), 1, 'retried with backoff, not at once');
        mock.timers.tick(1_000);
        await flush();
        assert.equal(deletes(), 2, 'the destroy was retried without another release() call');
        assert.deepEqual(fly.destroyed, []);
        mock.timers.tick(120_000);
        await flush();
        assert.equal(deletes(), 3, 'a failed retry backs off and retries again');
        assert.deepEqual(fly.destroyed, ['m1']);
        mock.timers.tick(10 * 60_000);
        await flush();
        assert.equal(deletes(), 3, 'nothing is retried once the destroy succeeded');
        await handle.release!();
        assert.equal(deletes(), 3);
    } finally {
        mock.timers.reset();
    }
});

test('release() during a slow create waits for the Machine and keeps retrying its failed destroy', async () => {
    const fly = new FakeFly();
    fly.agent = () => undefined;
    let answerCreate!: () => void;
    fly.createGate = new Promise(resolve => { answerCreate = resolve; });
    // The cancellation's destroy and release's own destroy both fail.
    fly.failDeletes = 2;
    const handle = runtime(fly).start(spec(), { timeout: 10_000 });
    const waited = handle.wait().then(() => 'resolved', error => error);
    while (!fly.requests.some(request => request.method === 'POST')) await new Promise(resolve => setTimeout(resolve, 2));
    const deletes = () => fly.requests.filter(request => request.method === 'DELETE').length;
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
        const flush = async () => { for (let index = 0; index < 20; index++) await new Promise(resolve => setImmediate(resolve)); };
        let releaseOutcome: unknown = 'pending';
        const released = handle.release!().then(() => { releaseOutcome = 'resolved'; }, error => { releaseOutcome = error; });
        await flush();
        // stop()'s settle window (10 s + 5 s) elapses while the create request is still outstanding.
        mock.timers.tick(15_000);
        await flush();
        assert.equal(releaseOutcome, 'pending', 'release stays pending while the Machine may still be created');
        assert.equal(deletes(), 0);
        answerCreate();
        await released;
        assert.ok(await waited instanceof AgentRunStoppedError, 'the run is cancelled');
        assert.match(String((releaseOutcome as Error).message), /returned 503/, 'release reports the failed destroy instead of a cached success');
        assert.equal(deletes(), 2, 'the cancellation destroy, then release\'s own');
        assert.ok(fly.machines.has('m1'));
        mock.timers.tick(60_000);
        await flush();
        assert.equal(deletes(), 3, 'the failed destroy is retried without another release() call');
        assert.deepEqual(fly.destroyed, ['m1']);
        await handle.release!();
        assert.equal(deletes(), 3, 'release is idempotent once the destroy succeeded');
    } finally {
        mock.timers.reset();
    }
});

/** A Machine of another run, which no reconciliation of this run's create may touch. */
function otherRunMachine(fly: FakeFly): void {
    fly.machines.set('other', {
        id: 'other', state: 'started', request: { config: { metadata: { propr_run: 'another-run', [FLY_CREATION_METADATA_KEY]: 'another-creation' } } },
        files: new Map(), mtimes: new Map(), events: [], pendingLogs: [], signals: [],
    });
}

const creationLookups = (fly: FakeFly) => fly.requests.filter(request => request.method === 'GET' && /\/machines\?/.test(request.url));
const createdCreationId = (fly: FakeFly): string => fly.requests.find(request => request.method === 'POST')!.body.config.metadata[FLY_CREATION_METADATA_KEY];

test('a create whose response is lost: its Machine is found by the run\'s creation id and destroyed before the run settles, no other', async () => {
    const ids = new Set<string>();
    for (const response of ['network', 504] as const) {
        const fly = new FakeFly();
        otherRunMachine(fly);
        fly.lostCreate = { response };
        const handle = runtime(fly).start(spec(), { timeout: 10_000 });
        await assert.rejects(handle.wait(), response === 'network' ? /fetch failed/ : /returned 504/);
        const creation = createdCreationId(fly);
        assert.match(creation, /^[0-9a-f]{8}-[0-9a-f-]{27}$/, 'the create request carries the run\'s creation id');
        ids.add(creation);
        assert.deepEqual(fly.destroyed, ['m1'], 'the Machine the create left is destroyed before wait() settles');
        assert.ok(fly.machines.has('other'), 'a Machine without the run\'s creation id is never destroyed, whatever the API listed');
        const [lookup] = creationLookups(fly);
        assert.equal(new URL(lookup!.url).searchParams.get(`metadata.${FLY_CREATION_METADATA_KEY}`), creation, 'looked up by its creation id');
        await handle.release!();
        assert.equal(creationLookups(fly).length, 1, 'settled: release() has nothing left to look for');
        assert.deepEqual(fly.destroyed, ['m1']);
    }
    assert.equal(ids.size, 2, 'each run has its own creation id');

    // The API refused the create: nothing was created, nothing is looked for.
    const refused = new FakeFly();
    refused.refuseCreate = 422;
    const handle = runtime(refused).start(spec(), { timeout: 10_000 });
    await assert.rejects(handle.wait(), /returned 422/);
    await handle.release!();
    assert.equal(creationLookups(refused).length, 0);
    assert.equal(refused.requests.filter(request => request.method === 'DELETE').length, 0);
});

test('a lost create keeps its cleanup obligation until a lookup settles it', async () => {
    // The lookups fail: the Machine stays to be destroyed, and release() does not report it released.
    const failing = new FakeFly();
    failing.lostCreate = { response: 'network' };
    failing.failLists = 2;
    const handle = runtime(failing).start(spec(), { timeout: 10_000 });
    await assert.rejects(handle.wait(), /fetch failed/);
    assert.ok(failing.machines.has('m1'));
    await assert.rejects(handle.release!(), /returned 503/);
    await handle.release!();
    assert.deepEqual(failing.destroyed, ['m1']);

    // The create completes after its response was lost: not found at first, destroyed once it appears.
    let clock = Date.now();
    const late = new FakeFly();
    late.lostCreate = { response: 'network', deferred: true };
    const lateHandle = runtime(late, FLY_ENV, () => clock).start(spec(), { timeout: 10_000 });
    await assert.rejects(lateHandle.wait(), /fetch failed/);
    await assert.rejects(lateHandle.release!(), /may still complete/, 'a lookup finding nothing while the create may still complete settles nothing');
    late.completeDeferredCreate();
    await lateHandle.release!();
    assert.deepEqual(late.destroyed, ['m1']);

    // None ever appears: only a lookup that succeeds once the create can no longer complete ends the obligation.
    const absent = new FakeFly();
    absent.lostCreate = { response: 504, deferred: true };
    const absentHandle = runtime(absent, FLY_ENV, () => clock).start(spec(), { timeout: 10_000 });
    await assert.rejects(absentHandle.wait(), /returned 504/);
    clock += FLY_CREATE_SETTLE_MS;
    absent.failLists = 1;
    await assert.rejects(absentHandle.release!(), /returned 503/, 'a failed lookup is no evidence of absence');
    await absentHandle.release!();
    const lookups = creationLookups(absent).length;
    await absentHandle.release!();
    assert.equal(creationLookups(absent).length, lookups, 'settled: nothing more is looked for');
    assert.deepEqual(absent.destroyed, []);
});

test('a lost create\'s Machine is destroyed by the cleanup its settlement schedules, without release()', async () => {
    const fly = new FakeFly();
    fly.lostCreate = { response: 'network' };
    fly.failLists = 1;
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
        const flush = async () => { for (let index = 0; index < 20; index++) await new Promise(resolve => setImmediate(resolve)); };
        const handle = runtime(fly).start(spec(), { timeout: 10_000 });
        await assert.rejects(handle.wait(), /fetch failed/);
        assert.ok(fly.machines.has('m1'), 'the lookup at create time failed');
        mock.timers.tick(30_000);
        await flush();
        assert.deepEqual(fly.destroyed, ['m1']);
        mock.timers.tick(10 * 60_000);
        await flush();
        assert.equal(creationLookups(fly).length, 2, 'nothing is looked for once it was destroyed');
    } finally {
        mock.timers.reset();
    }
});

/** A credential run whose store lives at `guestRoot` (the fake Machine's filesystem is this host's). */
function guestCredentialRun(store: string, guestRoot: string, name: string) {
    const run = new AgentRunSpecBuilder({
        agentType: 'claude', image: 'propr/agent:test', name, stdin: false, user: '0:0', network: agentRunNetwork('bridge'),
        workspace: { hostPath: '/tmp/w', containerPath: '/home/node/workspace', readOnly: false, mode: 'clone' },
    }).credentialBind(store, guestRoot, false, { provider: 'claude', store: 'config', perRun: true }).command('claude').build();
    run.entrypoint = '/home/node/claude-entrypoint.sh';
    run.workspace.clone = spec().workspace.clone;
    return run;
}

test('credential collection retains the Machine (awaited) before reading refreshed credentials, then releases it normally', async () => {
    const { collectingHandle } = await import('../packages/core/src/agents/runtime/agentRunFileUpload.ts');
    const store = credentialStore();
    const guestRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'propr-fly-guest-store-')));
    fs.writeFileSync(path.join(guestRoot, '.credentials.json'), '{"token":"refreshed"}');
    const run = guestCredentialRun(store, guestRoot, 'retain-before-collect');
    const uploaded = uploadAgentRunFiles(run);
    const fly = new FakeFly();
    const order: string[] = [];
    const fetch = fly.fetch;
    let markAnswered = false;
    fly.fetch = async (url, init) => {
        const command: string[] | undefined = init?.body ? JSON.parse(String(init.body)).command : undefined;
        if (command?.[2] === ': > "$1"') {
            order.push('retain-requested');
            // The mark takes a while (a slow exec API); nothing may be read before it is in the Machine.
            await new Promise(resolve => setTimeout(resolve, 50));
            const response = await fetch(url, init);
            markAnswered = true;
            order.push('retain-marked');
            return response;
        }
        if (command?.[2]?.includes('pwd -P')) order.push(markAnswered ? 'credential-read' : 'credential-read-before-mark');
        return fetch(url, init);
    };
    const handle = collectingHandle(runtime(fly).start(uploaded.spec, { timeout: 10_000 }), candidate => uploaded.collect(candidate));
    await handle.wait();
    assert.deepEqual(order.slice(0, 2), ['retain-requested', 'retain-marked'], 'the mark is requested and in the Machine first');
    assert.ok(order.includes('credential-read'), 'then the refreshed credential is read');
    assert.ok(!order.includes('credential-read-before-mark'), 'never before the mark');
    assert.ok(fly.machines.get('m1')!.files.has(FLY_RUN_FILES.retain), 'the launcher keeps lingering past its result linger while collection reads');
    const collected = await uploaded.collect(handle);
    assert.equal(collected.retained, true);
    assert.equal(collected.keepRun, false);
    assert.equal(fs.readFileSync(path.join(store, '.credentials.json'), 'utf8'), '{"token":"refreshed"}');
    await handle.release!();
    assert.deepEqual(fly.destroyed, ['m1'], 'a successful collection does not keep the Machine past release()');
    fs.rmSync(guestRoot, { recursive: true, force: true });
});

test('credential collection reports a retention it could not establish instead of treating the Machine as kept', async () => {
    const { collectingHandle } = await import('../packages/core/src/agents/runtime/agentRunFileUpload.ts');
    const store = credentialStore();
    const run = guestCredentialRun(store, '/nonexistent/propr-guest/.claude', 'retain-fails');
    const uploaded = uploadAgentRunFiles(run);
    const fly = new FakeFly();
    const fetch = fly.fetch;
    let marks = 0;
    let execDown = true;
    fly.fetch = async (url, init) => {
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        if (!execDown) return fetch(url, init);
        // The exec API is down: neither the retain mark nor the credential read gets through.
        if (body?.command?.[2] === ': > "$1"') { marks++; return new Response(JSON.stringify({ error: 'exec unavailable' }), { status: 503 }); }
        if (body?.command?.[2]?.includes('pwd -P')) return new Response(JSON.stringify({ error: 'exec unavailable' }), { status: 503 });
        return fetch(url, init);
    };
    const flyHandle = runtime(fly).start(uploaded.spec, { timeout: 10_000 });
    const handle = collectingHandle(flyHandle, candidate => uploaded.collect(candidate));
    await handle.wait();
    const collected = await uploaded.collect(handle);
    assert.ok(marks >= 3, 'the mark was attempted (and retried) before reading');
    assert.equal(collected.keepRun, true, 'the unread refresh still asks to keep the run');
    assert.equal(collected.retained, false, 'but the run is not reported as kept');
    assert.equal(fly.machines.get('m1')!.files.has(FLY_RUN_FILES.retain), false);
    assert.equal(await flyHandle.retain!(), false, 'retain() resolves false while the mark cannot be written');
    // Once the exec API is back, a later retain() writes the mark.
    execDown = false;
    assert.equal(await flyHandle.retain!(), true);
    assert.ok(fly.machines.get('m1')!.files.has(FLY_RUN_FILES.retain));
    await flyHandle.release!();
});

/**
 * The worst case between the agent's exit and the worker's last read: the exit is noticed only
 * after five log polls of 20 pages, each answered just inside its timeout, and every exec reaches
 * the Machine as late as its request timeout allows (exec timeout + 15 s). The launcher's linger
 * runs on the guest clock all along.
 */
function slowCollectionFly(): FakeFly {
    const fly = new FakeFly();
    fly.guestClock = 0;
    fly.agent = machine => {
        machine.files.set('/tmp/r/status', Buffer.from('bundle abc\n'));
        fly.finish(machine, 'out\n', 'err\n', 0);
        // Only the capture file has this line: the result must come from the Machine, not the logs.
        machine.files.set(FLY_RUN_FILES.stdout, Buffer.from('out\nexact-only\n'));
    };
    const fetch = fly.fetch;
    let noticed = false;
    fly.fetch = async (url, init) => {
        const script: string | undefined = init?.body ? JSON.parse(String(init.body)).command?.[2] : undefined;
        if (script !== undefined && fly.machines.get('m1')?.exitedAt !== undefined) {
            if (!noticed) { noticed = true; fly.guestClock! += 5 * 20 * 30_000; }
            fly.guestClock! += script.includes('base64') ? 75_000 : 45_000;
        }
        return fetch(url, init);
    };
    return fly;
}

test('slow collection: the Machine keeps its output, refreshed credentials and result until the worker retained or released it', async () => {
    const { collectingHandle } = await import('../packages/core/src/agents/runtime/agentRunFileUpload.ts');
    const store = credentialStore();
    const guestRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'propr-fly-guest-store-')));
    fs.writeFileSync(path.join(guestRoot, '.credentials.json'), '{"token":"refreshed"}');
    const uploaded = uploadAgentRunFiles(guestCredentialRun(store, guestRoot, 'slow-collection'));
    const fly = slowCollectionFly();
    const environment = { ...FLY_ENV, PROPR_FLY_RESULT_LINGER_SECONDS: String(MIN_FLY_RESULT_LINGER_SECONDS) };
    const handle = collectingHandle(runtime(fly, environment).start(uploaded.spec, { timeout: 10_000 }), candidate => uploaded.collect(candidate));
    const result = await handle.wait();
    assert.ok(fly.guestClock! > 30 * 1000 + 15 * 60_000, 'collection outlasted the old minimum and default lingers');
    assert.equal(result.stdout, 'out\nexact-only\n', 'the exact output was read from the Machine');
    const collected = await uploaded.collect(handle);
    assert.equal(collected.retained, true, 'retention was established before the Machine could expire');
    assert.equal(collected.keepRun, false);
    assert.equal(fs.readFileSync(path.join(store, '.credentials.json'), 'utf8'), '{"token":"refreshed"}', 'the refreshed credential was written back');
    assert.equal((await handle.readFile!('/tmp/r/status'))?.toString(), 'bundle abc\n', 'the workspace result is still there for the transport');
    assert.deepEqual(fly.expired, [], 'the Machine never destroyed itself');
    await handle.release!();
    assert.deepEqual(fly.destroyed, ['m1'], 'release() destroys it as usual');
    fs.rmSync(guestRoot, { recursive: true, force: true });
});

test('slow collection: an unretained run keeps its result for the workspace transport, and the launcher still ends an abandoned one', async () => {
    const fly = slowCollectionFly();
    const handle = runtime(fly).start(spec(), { timeout: 10_000 });
    assert.equal((await handle.wait()).stdout, 'out\nexact-only\n');
    // Nothing retained it: the transport reads the result status, then the worker's own removal is due.
    assert.equal((await handle.readFile!('/tmp/r/status'))?.toString(), 'bundle abc\n');
    fly.guestClock! += 10 * 60_000;
    assert.deepEqual(fly.expired, []);
    assert.equal((await handle.inspect()).liveness, 'stopped', 'the finished Machine is still there when the worker would remove it');
    // A worker that never comes back: the Machine destroys itself once its linger passed.
    fly.guestClock = fly.machines.get('m1')!.exitedAt! + MIN_FLY_RESULT_LINGER_SECONDS * 1000;
    assert.equal((await handle.inspect()).liveness, 'not_found');
    assert.deepEqual(fly.expired, ['m1']);
    await handle.release!();
});
