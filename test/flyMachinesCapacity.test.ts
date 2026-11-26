import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { FlyMachinesRuntime } from '../packages/core/src/agents/runtime/flyMachinesRuntime.ts';
import { AgentRunSpecBuilder, agentRunNetwork } from '../packages/core/src/agents/runtime/agentRunSpec.ts';
import { acquireFlyMachineSlot, flyMachinesMax } from '../packages/core/src/agents/runtime/fly/capacity.ts';
import { flyConfig } from '../packages/core/src/agents/runtime/fly/config.ts';
import { MachinesHttpError, type MachineLaunch, type MachineRef, type MachinesApi } from '../packages/core/src/agents/runtime/fly/api.ts';
import { RUN } from '../packages/core/src/agents/runtime/fly/wrapper.ts';
import { WORKSPACE_TRANSPORT_RESULT_DIR as RESULT, WORKSPACE_TRANSPORT_SCRIPT } from '../packages/core/src/git/workspaceTransportScript.ts';
import { closeConnection } from '../packages/core/src/db/connection.ts';

after(closeConnection);

const base = { PROPR_FLY_APP: 'agents', PROPR_FLY_API_TOKEN: 'FlyV1 synthetic-worker-credential', PROPR_FLY_IMAGE: 'registry.fly.io/agents@sha256:test' };

test('PROPR_FLY_MACHINES_MAX is unlimited when unset and must be a positive integer', () => {
    assert.equal(flyMachinesMax({}), undefined);
    assert.equal(flyMachinesMax({ PROPR_FLY_MACHINES_MAX: ' ' }), undefined);
    assert.equal(flyMachinesMax({ PROPR_FLY_MACHINES_MAX: '2' }), 2);
    for (const value of ['0', '-1', '1.5', 'two']) assert.throws(() => flyMachinesMax({ PROPR_FLY_MACHINES_MAX: value }), /Invalid PROPR_FLY_MACHINES_MAX/);
    assert.equal(flyConfig({ ...base, PROPR_FLY_MACHINES_MAX: '2' }).maxMachines, 2);
    assert.equal(flyConfig(base).maxMachines, undefined);
});

test('slots are granted in arrival order, and an aborted wait leaves the queue', async () => {
    const never = new AbortController().signal;
    const first = await acquireFlyMachineSlot('fifo', 1, never);
    const granted: string[] = [];
    const cancel = new AbortController();
    const second = acquireFlyMachineSlot('fifo', 1, cancel.signal).then(r => { granted.push('second'); return r; });
    const third = acquireFlyMachineSlot('fifo', 1, never).then(r => { granted.push('third'); return r; });
    await delay(5);
    assert.deepEqual(granted, []);
    cancel.abort(new Error('cancelled'));
    await assert.rejects(second, /cancelled/);
    first();
    first(); // idempotent: must not free a second slot
    const releaseThird = await third;
    assert.deepEqual(granted, ['third']);
    const fourth = acquireFlyMachineSlot('fifo', 1, never);
    let fourthGranted = false;
    void fourth.then(() => { fourthGranted = true; });
    await delay(5);
    assert.equal(fourthGranted, false);
    releaseThird();
    (await fourth)();
    assert.equal(typeof await acquireFlyMachineSlot('fifo', undefined, never), 'function');
});

/** Machines that finish as soon as they start; destroy is held until the test lets it go. */
class Machines implements MachinesApi {
    created: string[] = [];
    names: string[] = [];
    live = 0;
    peak = 0;
    started = new Set<string>();
    destroys: Array<() => void> = [];
    async create(launch: MachineLaunch) {
        const id = 'm' + this.created.length;
        this.created.push(id);
        this.names.push(launch.name);
        this.peak = Math.max(this.peak, ++this.live);
        return id;
    }
    async logs() {}
    async exec(id: string, args: string[]) {
        if (args[0] === '/usr/bin/touch') { this.started.add(id); return { stdout: '', exit_code: 0 }; }
        const [op, file, offset, length] = args.slice(3);
        if (op === 'probe') return { stdout: this.started.has(id) ? 'exited 0\n1\n' : 'ready\n0', exit_code: 0 };
        const files: Record<string, Buffer> = { [RUN + '/stdout']: Buffer.from('ok\n'), [RUN + '/stderr']: Buffer.alloc(0),
            [RUN + '/workspace/status']: Buffer.from('bundle test'), [RUN + '/workspace/result.bundle']: Buffer.from([1]) };
        const data = files[file];
        if (op === 'size') return { stdout: String(data?.length), exit_code: data ? 0 : 44 };
        return { stdout: data!.subarray(+offset, +offset + +length).toString('base64'), exit_code: 0 };
    }
    async signal() {}
    async gone() { return false; }
    destroy() { return new Promise<void>(resolve => this.destroys.push(() => { this.live--; resolve(); })); }
}

function spec(name: string) {
    return new AgentRunSpecBuilder({
        agentType: 'claude', image: 'propr/agent', name, stdin: true, user: '0:0', network: agentRunNetwork('bridge'),
        workspace: { hostPath: '/unused', containerPath: '/home/node/workspace', readOnly: false, mode: 'clone',
            clone: { remote: 'unused', baseRef: 'base', baseCommit: '0123', branch: 'test', resultDir: RESULT, script: WORKSPACE_TRANSPORT_SCRIPT } },
    }).command('claude', '--version').build();
}

const until = async (check: () => boolean) => { while (!check()) await delay(5); };

test('runs over PROPR_FLY_MACHINES_MAX queue until a Machine is destroyed instead of failing', async () => {
    const api = new Machines();
    const runtime = new FlyMachinesRuntime(api, { ...base, PROPR_FLY_APP: 'capped', PROPR_FLY_MACHINES_MAX: '2' }, async () => []);
    const runs = ['a', 'b', 'c'].map(name => runtime.start(spec(name)));
    await until(() => api.destroys.length === 2);
    await delay(20);
    assert.deepEqual(api.created, ['m0', 'm1'], 'the third run waits for a free slot');
    api.destroys.shift()!();
    await until(() => api.created.length === 3);
    while (api.destroys.length || api.live) { api.destroys.shift()?.(); await delay(5); }
    for (const run of runs) assert.equal((await run.wait()).exitCode, 0);
    assert.equal(api.peak, 2);
    await Promise.all(runs.map(run => run.release!()));
});

test('a queued run that is stopped never creates a Machine and frees its place', async () => {
    const api = new Machines();
    const runtime = new FlyMachinesRuntime(api, { ...base, PROPR_FLY_APP: 'stopped', PROPR_FLY_MACHINES_MAX: '1' }, async () => []);
    const first = runtime.start(spec('first'));
    await until(() => api.destroys.length === 1);
    const queued = runtime.start(spec('queued'));
    await delay(20);
    await Promise.all([queued.stop('SIGTERM'), assert.rejects(queued.wait(), /stopped before creation/)]);
    api.destroys.shift()!();
    assert.equal((await first.wait()).exitCode, 0);
    const next = runtime.start(spec('next'));
    await until(() => api.destroys.length === 1);
    api.destroys.shift()!();
    assert.equal((await next.wait()).exitCode, 0);
    assert.deepEqual(api.created, ['m0', 'm1']);
    await Promise.all([first, queued, next].map(run => run.release!()));
});

/** The first deletion of each Machine fails; later attempts are held like `Machines`. */
class FailingFirstDestroy extends Machines {
    failed = new Set<string>();
    override destroy(id: string) {
        if (!this.failed.has(id)) { this.failed.add(id); return Promise.reject(new Error('Fly API 503')); }
        return super.destroy();
    }
}

test('a Machine whose deletion is retried in the background keeps its slot until deletion succeeds', async () => {
    const api = new FailingFirstDestroy();
    const runtime = new FlyMachinesRuntime(api, { ...base, PROPR_FLY_APP: 'retried', PROPR_FLY_MACHINES_MAX: '1' }, async () => []);
    const first = runtime.start(spec('first'));
    const queued = runtime.start(spec('queued'));
    // The first deletion failed after collection: the result is returned while deletion retries in the background.
    assert.equal((await first.wait()).exitCode, 0);
    assert.ok(api.failed.has('m0'));
    await delay(50);
    assert.deepEqual(api.created, ['m0'], 'the queued run must not create a Machine while m0 still exists');
    await until(() => api.destroys.length === 1); // the background retry (after 5 s) is in flight
    assert.deepEqual(api.created, ['m0']);
    api.destroys.shift()!();
    await until(() => api.created.length === 2);
    assert.equal(api.peak, 1);
    await until(() => api.failed.has('m1'));
    await until(() => api.destroys.length === 1);
    api.destroys.shift()!();
    assert.equal((await queued.wait()).exitCode, 0);
    await Promise.all([first, queued].map(run => run.release!()));
});

test('a run that fails before creating a Machine frees its slot at once', async () => {
    const api = new Machines();
    let reads = 0;
    const runtime = new FlyMachinesRuntime(api, { ...base, PROPR_FLY_APP: 'unread', PROPR_FLY_MACHINES_MAX: '1' },
        async () => { if (reads++ === 0) throw new Error('packages unreadable'); return []; });
    const failed = runtime.start(spec('failed'));
    await assert.rejects(failed.wait(), /packages unreadable/);
    const next = runtime.start(spec('next'));
    await until(() => api.destroys.length === 1);
    api.destroys.shift()!();
    assert.equal((await next.wait()).exitCode, 0);
    assert.deepEqual(api.created, ['m0']);
    await Promise.all([failed, next].map(run => run.release!()));
});

/** Workspace retrieval fails, so the Machine is kept for recovery; `gone` lookups are held until the test answers them. */
class RecoveryMachines extends Machines {
    lookups: Array<{ machine: MachineRef; answer: (gone: boolean) => void }> = [];
    override async exec(id: string, args: string[]) {
        if (args[3] === 'size' && args[4] === RUN + '/workspace/status') return { stdout: '', exit_code: 1 };
        return super.exec(id, args);
    }
    override async destroy() { throw new Error('a recovery Machine must not be deleted'); }
    gone(machine: MachineRef) { return new Promise<boolean>(answer => this.lookups.push({ machine, answer })); }
}

test('a Machine kept for recovery holds its slot until Fly confirms it gone', async () => {
    const api = new RecoveryMachines();
    const runtime = new FlyMachinesRuntime(api, { ...base, PROPR_FLY_APP: 'recovery', PROPR_FLY_MACHINES_MAX: '1' }, async () => []);
    const first = runtime.start(spec('first'));
    const queued = runtime.start(spec('queued'));
    const result = await first.wait();
    assert.match(result.outputIncomplete ?? '', /Recover from Fly app recovery, Machine m0/);
    await until(() => api.lookups.length === 1);
    assert.deepEqual(api.lookups[0].machine, { id: 'm0', name: api.names[0] });
    await delay(50);
    assert.deepEqual(api.created, ['m0'], 'the queued run must wait while the recovery Machine still exists');
    // Still present (for example within its retention window): the slot stays held.
    api.lookups.shift()!.answer(false);
    await delay(50);
    assert.deepEqual(api.created, ['m0']);
    assert.equal(api.lookups.length, 0, 'the next check waits for the poll interval');
    await first.release!();
    assert.deepEqual(api.created, ['m0'], 'releasing the run handle does not free a Machine that still exists');
    await Promise.all([queued.stop('SIGTERM'), assert.rejects(queued.wait(), /stopped before creation/)]);
});

test('the recovery Machine frees its slot once its guest exits and Fly destroys it', async () => {
    const api = new RecoveryMachines();
    const runtime = new FlyMachinesRuntime(api, { ...base, PROPR_FLY_APP: 'expired', PROPR_FLY_MACHINES_MAX: '1' }, async () => []);
    const first = runtime.start(spec('first'));
    const queued = runtime.start(spec('queued'));
    await first.wait();
    await until(() => api.lookups.length === 1);
    assert.deepEqual(api.created, ['m0']);
    api.lookups.shift()!.answer(true);
    await until(() => api.created.length === 2);
    await until(() => api.lookups.length === 1); // m1 is kept for recovery too
    assert.equal(api.lookups[0].machine.id, 'm1');
    api.lookups.shift()!.answer(true);
    await queued.wait();
    await Promise.all([first, queued].map(run => run.release!()));
});

/** The first create loses its response; later creates succeed. */
class LostCreate extends Machines {
    lookups: Array<{ machine: MachineRef; answer: (gone: boolean) => void }> = [];
    constructor(private readonly failure: Error) { super(); }
    override async create(launch: MachineLaunch) {
        if (!this.failed) { this.failed = true; throw this.failure; }
        return super.create(launch);
    }
    failed = false;
    gone(machine: MachineRef) { return new Promise<boolean>(answer => this.lookups.push({ machine, answer })); }
}

test('a create whose outcome is unknown keeps its slot until a lookup by name finds no Machine', async () => {
    const api = new LostCreate(new Error('socket hang up'));
    const runtime = new FlyMachinesRuntime(api, { ...base, PROPR_FLY_APP: 'lost', PROPR_FLY_MACHINES_MAX: '1' }, async () => []);
    const first = runtime.start(spec('first'));
    const queued = runtime.start(spec('queued'));
    await assert.rejects(first.wait(), /socket hang up/);
    await until(() => api.lookups.length === 1);
    assert.equal(api.lookups[0].machine.id, undefined);
    assert.match(api.lookups[0].machine.name, /^propr-[0-9a-f-]{36}$/);
    await delay(50);
    assert.deepEqual(api.created, [], 'the queued run waits while the first Machine may exist');
    api.lookups.shift()!.answer(true);
    await until(() => api.destroys.length === 1);
    api.destroys.shift()!();
    assert.equal((await queued.wait()).exitCode, 0);
    await Promise.all([first, queued].map(run => run.release!()));
});

test('a create Fly rejected frees its slot at once', async () => {
    const api = new LostCreate(new MachinesHttpError('POST', 422, 'Your organization has reached its machine limit'));
    const runtime = new FlyMachinesRuntime(api, { ...base, PROPR_FLY_APP: 'rejected', PROPR_FLY_MACHINES_MAX: '1' }, async () => []);
    const first = runtime.start(spec('first'));
    const queued = runtime.start(spec('queued'));
    await assert.rejects(first.wait(), /HTTP 422/);
    await until(() => api.destroys.length === 1);
    assert.equal(api.lookups.length, 0);
    api.destroys.shift()!();
    assert.equal((await queued.wait()).exitCode, 0);
    await Promise.all([first, queued].map(run => run.release!()));
});
