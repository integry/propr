import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { FlyMachinesRuntime } from '../packages/core/src/agents/runtime/flyMachinesRuntime.ts';
import { AgentRunSpecBuilder, agentRunNetwork } from '../packages/core/src/agents/runtime/agentRunSpec.ts';
import { acquireFlyMachineSlot, flyMachinesMax } from '../packages/core/src/agents/runtime/fly/capacity.ts';
import { flyConfig } from '../packages/core/src/agents/runtime/fly/config.ts';
import type { MachineLaunch, MachinesApi } from '../packages/core/src/agents/runtime/fly/api.ts';
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
