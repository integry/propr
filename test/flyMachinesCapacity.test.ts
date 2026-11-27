import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { FlyMachinesRuntime } from '../packages/core/src/agents/runtime/flyMachinesRuntime.ts';
import { AgentRunSpecBuilder, agentRunNetwork } from '../packages/core/src/agents/runtime/agentRunSpec.ts';
import { acquireFlyMachineSlot, flyMachinesMax, retainedMachineChecks } from '../packages/core/src/agents/runtime/fly/capacity.ts';
import { flyConfig } from '../packages/core/src/agents/runtime/fly/config.ts';
import { MachineCreateUnconfirmedError, MachinesClient, type MachineLaunch, type MachinesApi } from '../packages/core/src/agents/runtime/fly/api.ts';
import { RUN } from '../packages/core/src/agents/runtime/fly/wrapper.ts';
import { WORKSPACE_TRANSPORT_RESULT_DIR as RESULT, WORKSPACE_TRANSPORT_SCRIPT } from '../packages/core/src/git/workspaceTransportScript.ts';
import { closeConnection } from '../packages/core/src/db/connection.ts';

after(closeConnection);

const base = { PROPR_FLY_APP: 'agents', PROPR_FLY_API_TOKEN: 'FlyV1 synthetic-worker-credential', PROPR_FLY_IMAGE: 'registry.fly.io/agents@sha256:test' };

test('PROPR_FLY_MACHINES_MAX is unlimited when unset and must be a positive integer', () => {
    assert.equal(flyMachinesMax({}), undefined);
    assert.equal(flyMachinesMax({ PROPR_FLY_MACHINES_MAX: ' ' }), undefined);
    assert.equal(flyMachinesMax({ PROPR_FLY_MACHINES_MAX: '2' }), 2);
    for (const value of ['0', '-1', '1.5', 'two', '1e2', '0x2', '2 slots', '99999999999999999999']) assert.throws(() => flyMachinesMax({ PROPR_FLY_MACHINES_MAX: value }), /Invalid PROPR_FLY_MACHINES_MAX/);
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
    live = 0;
    peak = 0;
    started = new Set<string>();
    destroys: Array<() => void> = [];
    async create(_launch: MachineLaunch) {
        const id = 'm' + this.created.length;
        this.created.push(id);
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
    destroy() { return new Promise<void>(resolve => this.destroys.push(() => { this.live--; resolve(); })); }
    /** Machines Fly no longer lists; a kept Machine leaves it only when the test says so. */
    vanished = new Set<string>();
    goneChecks: string[] = [];
    async gone(id: string) { this.goneChecks.push(id); return this.vanished.has(id); }
    async find(): Promise<string | undefined> { return undefined; }
}

function spec(name: string) {
    return new AgentRunSpecBuilder({
        agentType: 'claude', image: 'propr/agent', name, stdin: true, user: '0:0', network: agentRunNetwork('bridge'),
        workspace: { hostPath: '/unused', containerPath: '/home/node/workspace', readOnly: false, mode: 'clone',
            clone: { remote: 'unused', baseRef: 'base', baseCommit: '0123', branch: 'test', resultDir: RESULT, script: WORKSPACE_TRANSPORT_SCRIPT } },
    }).command('claude', '--version').build();
}

/** Most waits settle within milliseconds; the 5 s default makes a lifecycle regression fail promptly instead of hanging. */
const UNTIL_TIMEOUT_MS = 5_000;
/** A wait that spans the runtime's fixed 5 s background cleanup retry needs room for that delay. */
const CLEANUP_RETRY_TIMEOUT_MS = 15_000;

const until = async (what: string, check: () => boolean, timeoutMs = UNTIL_TIMEOUT_MS) => {
    const deadline = Date.now() + timeoutMs;
    while (!check()) {
        if (Date.now() >= deadline) assert.fail(`timed out after ${timeoutMs} ms waiting until ${what}`);
        await delay(5);
    }
};

test('runs over PROPR_FLY_MACHINES_MAX queue until a Machine is destroyed instead of failing', async () => {
    const api = new Machines();
    const runtime = new FlyMachinesRuntime(api, { ...base, PROPR_FLY_APP: 'capped', PROPR_FLY_MACHINES_MAX: '2' }, async () => []);
    const runs = ['a', 'b', 'c'].map(name => runtime.start(spec(name)));
    await until('both capped runs are deleting their Machines', () => api.destroys.length === 2);
    await delay(20);
    assert.deepEqual(api.created, ['m0', 'm1'], 'the third run waits for a free slot');
    api.destroys.shift()!();
    await until('the queued run creates its Machine after a deletion is confirmed', () => api.created.length === 3);
    while (api.destroys.length || api.live) { api.destroys.shift()?.(); await delay(5); }
    for (const run of runs) assert.equal((await run.wait()).exitCode, 0);
    assert.equal(api.peak, 2);
    await Promise.all(runs.map(run => run.release!()));
});

test('a queued run that is stopped never creates a Machine and frees its place', async () => {
    const api = new Machines();
    const runtime = new FlyMachinesRuntime(api, { ...base, PROPR_FLY_APP: 'stopped', PROPR_FLY_MACHINES_MAX: '1' }, async () => []);
    const first = runtime.start(spec('first'));
    await until('the first run is deleting its Machine', () => api.destroys.length === 1);
    const queued = runtime.start(spec('queued'));
    await delay(20);
    await Promise.all([queued.stop('SIGTERM'), assert.rejects(queued.wait(), /stopped before creation/)]);
    api.destroys.shift()!();
    assert.equal((await first.wait()).exitCode, 0);
    const next = runtime.start(spec('next'));
    await until('the next run, admitted after the stopped one left the queue, is deleting its Machine', () => api.destroys.length === 1);
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
    await until('the background retry (after 5 s) of m0\'s deletion is in flight', () => api.destroys.length === 1, CLEANUP_RETRY_TIMEOUT_MS);
    assert.deepEqual(api.created, ['m0']);
    api.destroys.shift()!();
    await until('the queued run creates its Machine once m0\'s deletion succeeds', () => api.created.length === 2);
    assert.equal(api.peak, 1);
    await until('the first deletion of m1 has failed', () => api.failed.has('m1'));
    await until('the background retry of m1\'s deletion is in flight', () => api.destroys.length === 1, CLEANUP_RETRY_TIMEOUT_MS);
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
    await until('the next run, admitted after the failed one freed its slot, is deleting its Machine', () => api.destroys.length === 1);
    api.destroys.shift()!();
    assert.equal((await next.wait()).exitCode, 0);
    assert.deepEqual(api.created, ['m0']);
    await Promise.all([failed, next].map(run => run.release!()));
});

/** m0's workspace result cannot be retrieved, so its run keeps the Machine for recovery. */
class KeptForRecovery extends Machines {
    override async exec(id: string, args: string[]) {
        if (id === 'm0' && args[4] === RUN + '/workspace/result.bundle') throw new Error('Fly API 503');
        return super.exec(id, args);
    }
}

test('a Machine kept for recovery holds its slot until Fly confirms it is gone', async t => {
    Object.assign(retainedMachineChecks, { intervalMs: 10, maxIntervalMs: 20 });
    t.after(() => Object.assign(retainedMachineChecks, { intervalMs: 30_000, maxIntervalMs: 300_000 }));
    const api = new KeptForRecovery();
    const runtime = new FlyMachinesRuntime(api, { ...base, PROPR_FLY_APP: 'kept', PROPR_FLY_MACHINES_MAX: '1', PROPR_FLY_CREDENTIAL_RETENTION_SECONDS: '1' }, async () => []);
    const kept = runtime.start(spec('kept'));
    const queued = runtime.start(spec('queued'));
    const outcome = await kept.wait().then(result => result.outputIncomplete ?? '', (error: Error) => error.message);
    assert.match(outcome, /Fly workspace result retrieval failed/);
    assert.equal(kept.recoveryLocation, `Fly app kept, Machine m0, ${RUN}/workspace`);
    assert.equal(api.destroys.length, 0, 'the recovery Machine is not deleted');
    await delay(300);
    assert.deepEqual(api.goneChecks, [], 'no check before the recovery window ends');
    assert.deepEqual(api.created, ['m0'], 'the queued run waits while the recovery Machine exists');
    await until('Fly has been asked at least 3 times whether the recovery Machine is gone', () => api.goneChecks.length >= 3);
    assert.deepEqual(api.created, ['m0'], 'a Machine Fly still lists keeps its slot');
    api.vanished.add('m0');
    api.live--;
    await until('the queued run creates its Machine once Fly reports m0 gone', () => api.created.length === 2);
    assert.equal(api.peak, 1);
    await until('the queued run is deleting its Machine', () => api.destroys.length === 1);
    api.destroys.shift()!();
    assert.equal((await queued.wait()).exitCode, 0);
    await Promise.all([kept, queued].map(run => run.release!().catch(() => {})));
});

/** The first create's response and lookup are lost, but Fly did launch m0 under the run's name. */
class LostCreate extends Machines {
    lookups = 0;
    lookupFails = true;
    deleted: string[] = [];
    launches: string[] = [];
    override async create(launch: MachineLaunch) {
        this.launches.push(launch.name);
        const id = await super.create(launch);
        if (id === 'm0') throw new MachineCreateUnconfirmedError('Fly Machines API POST returned HTTP 502');
        return id;
    }
    override async find(name: string) {
        this.lookups++;
        if (this.lookupFails) throw new Error('Fly API 503');
        return name === this.launches[0] ? 'm0' : undefined;
    }
    override destroy(id: string) {
        if (id === 'm0') { this.deleted.push(id); this.live--; return Promise.resolve(); }
        return super.destroy();
    }
}

test('a run whose create outcome is unknown keeps its slot until the Machine is found and deleted or absent', async t => {
    Object.assign(retainedMachineChecks, { intervalMs: 10, maxIntervalMs: 20 });
    t.after(() => Object.assign(retainedMachineChecks, { intervalMs: 30_000, maxIntervalMs: 300_000 }));
    const api = new LostCreate();
    const runtime = new FlyMachinesRuntime(api, { ...base, PROPR_FLY_APP: 'lost', PROPR_FLY_MACHINES_MAX: '1' }, async () => []);
    const lost = runtime.start(spec('lost'));
    const queued = runtime.start(spec('queued'));
    await assert.rejects(lost.wait(), /HTTP 502/);
    await delay(100);
    assert.deepEqual(api.created, ['m0'], 'a failed lookup is not evidence that no Machine exists');
    assert.ok(api.lookups >= 2, 'the lookup is retried');
    api.lookupFails = false;
    await until('the queued run creates its Machine once the lost create is resolved', () => api.created.length === 2);
    assert.deepEqual(api.deleted, ['m0'], 'the found Machine, whose agent never started, is deleted first');
    assert.equal(api.peak, 1);
    await until('the queued run is deleting its Machine', () => api.destroys.length === 1);
    api.destroys.shift()!();
    assert.equal((await queued.wait()).exitCode, 0);
    await Promise.all([lost, queued].map(run => run.release!().catch(() => {})));
});

/** m0 was already deleted at Fly (by an operator, or a deletion whose response was lost): deleting it returns HTTP 404. */
class AlreadyDeleted extends Machines {
    client = new MachinesClient(flyConfig(base));
    deleteStatuses: number[] = [];
    override destroy(id: string) {
        if (id !== 'm0') return super.destroy();
        this.live--;
        return this.client.destroy(id);
    }
}

test('a deletion answered with HTTP 404 frees the slot at once and admits the queued run', async t => {
    const api = new AlreadyDeleted();
    t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
        assert.equal(init.method, 'DELETE');
        assert.match(url, /\/machines\/m0\?force=true/);
        api.deleteStatuses.push(404);
        return new Response('{"error":"machine not found"}', { status: 404 });
    });
    const runtime = new FlyMachinesRuntime(api, { ...base, PROPR_FLY_APP: 'unknown', PROPR_FLY_MACHINES_MAX: '1' }, async () => []);
    const first = runtime.start(spec('first'));
    const queued = runtime.start(spec('queued'));
    assert.equal((await first.wait()).exitCode, 0);
    await until('the queued run creates its Machine after m0\'s deletion returned 404', () => api.created.length === 2);
    assert.deepEqual(api.deleteStatuses, [404], 'one deletion attempt, not a retry loop');
    await until('the queued run is deleting its Machine', () => api.destroys.length === 1);
    api.destroys.shift()!();
    assert.equal((await queued.wait()).exitCode, 0);
    assert.equal(api.peak, 1);
    await Promise.all([first, queued].map(run => run.release!()));
});

/** Every deletion of m0 fails with HTTP 500; the Machine disappears at Fly only when the test says so. */
class DeletionAlwaysFails extends Machines {
    attempts = 0;
    override destroy(id: string) {
        if (id !== 'm0') return super.destroy();
        this.attempts++;
        return Promise.reject(new Error('Fly Machines API DELETE returned HTTP 500'));
    }
}

test('a Machine that disappears while its deletion keeps failing frees its slot and ends the retries', async () => {
    const api = new DeletionAlwaysFails();
    const runtime = new FlyMachinesRuntime(api, { ...base, PROPR_FLY_APP: 'vanishing', PROPR_FLY_MACHINES_MAX: '1' }, async () => []);
    const first = runtime.start(spec('first'));
    const queued = runtime.start(spec('queued'));
    assert.equal((await first.wait()).exitCode, 0);
    assert.equal(api.attempts, 1);
    assert.deepEqual(api.goneChecks, ['m0'], 'a failed deletion asks Fly whether the Machine is gone');
    await delay(50);
    assert.deepEqual(api.created, ['m0'], 'a Machine Fly still lists keeps its slot');
    api.vanished.add('m0');
    api.live--;
    await until('the queued run creates its Machine once a retry finds m0 gone', () => api.created.length === 2, CLEANUP_RETRY_TIMEOUT_MS);
    assert.equal(api.attempts, 2);
    assert.deepEqual(api.goneChecks, ['m0', 'm0']);
    await until('the queued run is deleting its Machine', () => api.destroys.length === 1);
    api.destroys.shift()!();
    assert.equal((await queued.wait()).exitCode, 0);
    assert.equal(api.attempts, 2, 'no retry after Fly confirmed the Machine is gone');
    assert.equal(api.peak, 1);
    await Promise.all([first, queued].map(run => run.release!()));
});
