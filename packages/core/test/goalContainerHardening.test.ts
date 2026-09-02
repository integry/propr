import assert from 'node:assert/strict';
import * as actualChildProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mock, test } from 'node:test';
import type { GoalSessionAdapter } from '../src/agents/goalSession/contract.js';
import { InMemoryGoalSessionPorts } from '../src/agents/goalSession/InMemoryGoalSessionPorts.js';

const spawnCalls: Array<{ args: string[]; env?: NodeJS.ProcessEnv }> = [];
let stdinHandler: ((data: string) => void) | undefined;
const outputStream = () => Object.assign(new EventEmitter(), {
    pause: mock.fn(),
    resume: mock.fn(),
});
const child = Object.assign(new EventEmitter(), {
    stdout: outputStream(),
    stderr: outputStream(),
    stdin: { destroyed: false, writableEnded: false, write(data: string, cb: (e?: Error | null) => void) { stdinHandler?.(data); cb(); return true; }, end() { this.writableEnded = true; } },
    exitCode: null as number | null,
    kill: mock.fn(() => true),
});

await mock.module('child_process', {
    namedExports: {
        ...actualChildProcess,
        spawn: mock.fn((_command: string, args: string[], options?: { env?: NodeJS.ProcessEnv }) => {
            spawnCalls.push({ args, env: options?.env });
            return child;
        }),
        execFileSync: mock.fn(),
    },
});

const { GoalContainerSupervisor, buildGoalContainerLayout } = await import('../src/agents/goalSession/GoalContainerSupervisor.js');
const { createSupervisedCodexAppServerFactory } = await import('../src/agents/goalSession/supervisedCodexOpenFactory.js');
const { GoalSessionSupervisor } = await import('../src/agents/goalSession/GoalSessionSupervisor.js');
type EventSink = ConstructorParameters<typeof GoalContainerSupervisor>[1];

const events = { append: async () => ({ accepted: true }), appendControl: async () => ({ accepted: true }), replay: async () => [] } as unknown as EventSink;
const idBits = { goalId: 'g', sessionId: 's', controllerEpoch: 1, turnId: 't', executionId: 'e', attemptId: 'a' };
const approvedWorktree = fs.mkdtempSync(path.join(os.tmpdir(), 'goal-worktree-'));
const approvedCredential = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'goal-credential-')), 'token');
fs.writeFileSync(approvedCredential, 'secret');
const isolation = {
    environmentKeys: ['OPENAI_API_KEY'],
    worktreePaths: [approvedWorktree],
    providerHomeTargets: ['/home/node/.codex'],
    credentialMounts: [{ source: approvedCredential, target: '/home/node/.creds' }],
};
const firstEffects = {
    start: async <T>(_fence: unknown, effect: () => { completion: Promise<T> }): Promise<T> => effect().completion,
};

function baseRequest() {
    return {
        ...idBits,
        operationFence: {
            goalId: idBits.goalId, sessionId: idBits.sessionId, controllerEpoch: idBits.controllerEpoch,
            turnId: idBits.turnId, executionId: idBits.executionId, attemptId: idBits.attemptId,
            generation: 1, operationId: 'turn-operation', kind: 'turn' as const,
        },
        image: 'propr/agent:test',
        command: ['agent-command'],
        worktreePath: approvedWorktree,
        worktreeFingerprint: 'fingerprint-one',
        providerHomeTarget: '/home/node/.codex',
    };
}

function createSupervisor(base: string, policy = isolation): InstanceType<typeof GoalContainerSupervisor> {
    return new GoalContainerSupervisor(base, events, undefined, { isolation: policy, providerFirstEffects: firstEffects });
}

async function waitForFile(filePath: string): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
        if (fs.existsSync(filePath) && fs.statSync(filePath).size > 0) return;
        await new Promise<void>(resolve => setTimeout(resolve, 5));
    }
    throw new Error(`Timed out waiting for ${filePath}`);
}

test('start passes env names only and never leaks secret values into argv', async () => {
    spawnCalls.length = 0;
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'goal-hard-'));
    const supervisor = createSupervisor(base);
    await supervisor.start({
        ...baseRequest(),
        environment: { OPENAI_API_KEY: 'super-secret-value' },
        credentialMounts: [{ source: approvedCredential, target: '/home/node/.creds' }],
    });
    const args = spawnCalls[0].args;
    const envIndex = args.indexOf('--env');
    assert.equal(args[envIndex + 1], 'OPENAI_API_KEY');
    assert.ok(!args.some(arg => arg.includes('super-secret-value')), 'secret value must not appear in argv');
    assert.ok(args.includes(`type=bind,src=${approvedCredential},dst=/home/node/.creds,readonly`));
    assert.deepEqual(spawnCalls[0].env, { OPENAI_API_KEY: 'super-secret-value' });
});

test('layout logPath is an actually used goal-scoped durable output sink', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'goal-log-'));
    const supervisor = createSupervisor(base);
    const { layout } = await supervisor.start(baseRequest());
    child.stdout.emit('data', Buffer.from('auditable output\n'));
    await waitForFile(layout.logPath);

    const records = fs.readFileSync(layout.logPath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.ok(records.some(record => record.channel === 'stdout'
        && record.attemptId === idBits.attemptId
        && record.data === 'auditable output\n'));
    assert.ok(fs.statSync(layout.logPath).size <= 8 * 1024 * 1024);
});

test('goal JSONL persists only public output fields from a secret-poisoned start request', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'goal-log-secret-'));
    const supervisor = createSupervisor(base);
    const poisoned = {
        ...baseRequest(),
        command: ['provider-command', '--token', 'command-secret-value'],
        environment: { OPENAI_API_KEY: 'environment-secret-value' },
        credentialMounts: [{ source: approvedCredential, target: '/home/node/.creds' }],
        taskId: 'private-task-secret',
    };
    const { layout } = await supervisor.start(poisoned);
    child.stderr.emit('data', Buffer.from('public diagnostic\n'));
    await waitForFile(layout.logPath);

    const bytes = fs.readFileSync(layout.logPath, 'utf8');
    for (const secret of [
        'command-secret-value',
        'environment-secret-value',
        approvedCredential,
        approvedWorktree,
        'private-task-secret',
        'provider-command',
    ]) assert.ok(!bytes.includes(secret), `JSONL leaked ${secret}`);
    const record = JSON.parse(bytes.trim().split('\n')[0]);
    assert.deepEqual(Object.keys(record).sort(), [
        'attemptId', 'channel', 'controllerEpoch', 'data', 'executionId', 'goalId',
        'recordedAt', 'sequence', 'sessionId', 'truncated', 'turnId', 'worktreeFingerprint',
    ]);
    assert.equal(record.executionId, idBits.executionId);
    assert.equal(record.attemptId, idBits.attemptId);
    assert.equal(record.data, 'public diagnostic\n');
});

test('raw durable event DTOs and replay bytes exclude every poisoned start-request field', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'goal-event-secret-'));
    const persistence = new InMemoryGoalSessionPorts();
    const ids = {
        goalId: 'raw-goal', sessionId: 'raw-session', controllerEpoch: 7,
        turnId: 'raw-turn', executionId: 'raw-execution', attemptId: 'raw-attempt',
    };
    const timestamp = new Date().toISOString();
    await persistence.create({
        goalId: ids.goalId,
        sessionId: ids.sessionId,
        provider: 'raw-provider',
        providerSessionId: 'raw-provider-session',
        recoveryMetadata: { checkpoint: 'public' },
        controllerEpoch: ids.controllerEpoch,
        status: 'running',
        activeTurn: {
            executionId: ids.executionId,
            attemptId: ids.attemptId,
            turnId: ids.turnId,
            executionEpoch: ids.controllerEpoch,
            objective: 'public objective',
            requestedModel: 'public-model',
            repository: { repository: 'integry/propr', worktreePath: approvedWorktree, branch: 'test' },
            status: 'running',
        },
        completedTurnIds: [],
        createdAt: timestamp,
        updatedAt: timestamp,
    });
    let delivered: unknown;
    const runtime = persistence.asRuntimePorts();
    const capturingEvents: EventSink = {
        append: async (publicFence, publicExecution, event) => {
            delivered = structuredClone({ publicFence, publicExecution, event });
            return runtime.events.append(publicFence, publicExecution, event);
        },
        appendControl: (publicFence, publicExecution, event) =>
            runtime.events.appendControl(publicFence, publicExecution, event),
        replay: (eventIdentity, afterSequence) => runtime.events.replay(eventIdentity, afterSequence),
    };
    const supervisor = new GoalContainerSupervisor(base, capturingEvents, undefined, {
        isolation, providerFirstEffects: firstEffects,
    });
    const secrets = [
        'poison-environment-secret', 'poison-command-secret', 'poison-task-secret',
        'poison-excess-secret', approvedCredential, approvedWorktree,
    ];
    await supervisor.start({
        ...baseRequest(),
        ...ids,
        operationFence: {
            ...baseRequest().operationFence, ...ids,
        },
        command: ['provider', '--secret', secrets[1]],
        environment: { OPENAI_API_KEY: secrets[0] },
        credentialMounts: [{ source: approvedCredential, target: '/home/node/.creds' }],
        taskId: secrets[2],
        arbitraryExcess: secrets[3],
    } as ReturnType<typeof baseRequest> & typeof ids & { arbitraryExcess: string; taskId: string });
    child.stdout.emit('data', Buffer.from('public raw output'));
    for (let attempt = 0; attempt < 100 && (await persistence.replay(ids)).length === 0; attempt += 1) {
        await new Promise<void>(resolve => setTimeout(resolve, 5));
    }

    const replayed = await persistence.replay(ids);
    assert.equal(replayed.length, 1);
    assert.deepEqual(Object.keys(replayed[0]).sort(), [
        'attemptId', 'controllerEpoch', 'event', 'executionId', 'goalId', 'recordedAt',
        'sequence', 'sessionId', 'turnId',
    ]);
    assert.deepEqual(Object.keys(replayed[0].event).sort(), ['channel', 'data', 'type']);
    const rawBytes = JSON.stringify({ delivered, replayed });
    for (const secret of secrets) assert.ok(!rawBytes.includes(secret), `raw event persistence leaked ${secret}`);
});

test('layout log sink truncates deterministically at its auditable byte bound', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'goal-log-bound-'));
    const supervisor = createSupervisor(base);
    const { layout, execution } = await supervisor.start({
        ...baseRequest(),
        goalId: 'bounded-log-goal',
        sessionId: 'bounded-log-session',
        operationFence: {
            ...baseRequest().operationFence,
            goalId: 'bounded-log-goal', sessionId: 'bounded-log-session',
        },
    });
    child.stdout.emit('data', Buffer.alloc(8 * 1024 * 1024, 'x'));
    child.emit('close', 0);
    await execution.completion;

    const size = fs.statSync(layout.logPath).size;
    assert.ok(size > 0);
    assert.ok(size <= 8 * 1024 * 1024);
    const records = fs.readFileSync(layout.logPath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.equal(records.at(-1)?.truncated, true);
    assert.ok(records.every(record => record.goalId === 'bounded-log-goal'
        && record.sessionId === 'bounded-log-session'
        && record.attemptId === idBits.attemptId));
});

test('start rejects provider homes that shadow reserved or non-provider paths', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'goal-hard-'));
    const supervisor = createSupervisor(base);
    await assert.rejects(supervisor.start({ ...baseRequest(), providerHomeTarget: '/workspace' }), /workspace/);
    await assert.rejects(supervisor.start({ ...baseRequest(), providerHomeTarget: '/' }), /reserved/);
    await assert.rejects(supervisor.start({ ...baseRequest(), providerHomeTarget: '/etc/agent' }), /provider-owned/);
});

test('start supports an explicitly configured read-only Codex credential file at its native target', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'goal-hard-'));
    const supervisor = createSupervisor(base, {
        ...isolation,
        credentialMounts: [{ source: approvedCredential, target: '/home/node/.codex/creds' }],
    });
    await supervisor.start({
        ...baseRequest(), credentialMounts: [{
            provider: 'codex', source: approvedCredential, target: '/home/node/.codex/creds',
        }],
    });
    assert.ok(spawnCalls.at(-1)?.args.includes(
        `type=bind,src=${approvedCredential},dst=/home/node/.codex/creds,readonly`,
    ));
});

test('separate credential-file ingress supports explicit Claude, Codex, and Antigravity native auth files', async () => {
    const profiles = [
        { provider: 'claude' as const, home: '/home/node/.claude', target: '/home/node/.claude.json' },
        { provider: 'codex' as const, home: '/home/node/.codex', target: '/home/node/.codex/auth.json' },
        { provider: 'antigravity' as const, home: '/home/node/.gemini', target: '/home/node/.gemini/oauth_creds.json' },
    ];
    for (const profile of profiles) {
        const base = fs.mkdtempSync(path.join(os.tmpdir(), `goal-${profile.provider}-auth-`));
        const mount = { provider: profile.provider, source: approvedCredential, target: profile.target };
        const supervisor = createSupervisor(base, {
            ...isolation, providerHomeTargets: [profile.home], credentialMounts: [mount],
        });
        await supervisor.start({
            ...baseRequest(), providerHomeTarget: profile.home, credentialMounts: [mount],
        });
        assert.ok(spawnCalls.at(-1)?.args.includes(
            `type=bind,src=${approvedCredential},dst=${profile.target},readonly`,
        ));
    }
});

test('adapter output observes the exact durable mixed-channel queue with backpressure and unsubscribe', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'goal-adapter-output-'));
    const durable: Array<{ channel: string; data: string }> = [];
    const sink = {
        ...events,
        append: async (_fence: unknown, _execution: unknown, event: { channel: string; data: string }) => {
            durable.push({ channel: event.channel, data: event.data });
            return { accepted: true as const };
        },
    } as unknown as EventSink;
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
    const observed: Array<{ sequence: number; channel: string; data: string }> = [];
    const supervisor = new GoalContainerSupervisor(base, sink, undefined, {
        isolation, providerFirstEffects: firstEffects,
    });
    await supervisor.start({
        ...baseRequest(),
        outputObserver: {
            next: async output => {
                assert.equal(durable.length, output.sequence, 'durability precedes adapter delivery in the same queue');
                observed.push({ sequence: output.sequence, channel: output.channel, data: output.data });
                if (output.sequence === 1) await firstGate;
                if (output.sequence === 2) return 'unsubscribe';
            },
        },
    });
    child.stdout.emit('data', Buffer.from('first'));
    child.stderr.emit('data', Buffer.from('second'));
    for (let attempt = 0; attempt < 100 && observed.length === 0; attempt += 1) {
        await new Promise<void>(resolve => setImmediate(resolve));
    }
    assert.deepEqual(observed.map(output => output.data), ['first']);
    assert.equal(durable.length, 1, 'the supervised source remains backpressured behind the adapter');
    releaseFirst();
    for (let attempt = 0; attempt < 100 && observed.length < 2; attempt += 1) {
        await new Promise<void>(resolve => setImmediate(resolve));
    }
    assert.deepEqual(observed, [
        { sequence: 1, channel: 'stdout', data: 'first' },
        { sequence: 2, channel: 'stderr', data: 'second' },
    ]);
    child.stdout.emit('data', Buffer.from('durable-only'));
    for (let attempt = 0; attempt < 100 && durable.length < 3; attempt += 1) {
        await new Promise<void>(resolve => setImmediate(resolve));
    }
    assert.equal(observed.length, 2, 'unsubscribe does not bypass or tail durable output');
    assert.deepEqual(durable.map(output => output.data), ['first', 'second', 'durable-only']);
});

test('protocol observer receives parseable secret bytes while every durable surface is redacted', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'goal-protocol-secret-'));
    const durable: string[] = [];
    const observed: string[] = [];
    const sink = {
        ...events,
        append: async (_fence: unknown, _execution: unknown, event: { data: string }) => {
            durable.push(event.data);
            return { accepted: true as const };
        },
    } as unknown as EventSink;
    const supervisor = new GoalContainerSupervisor(base, sink, undefined, {
        isolation, providerFirstEffects: firstEffects,
    });
    const { layout } = await supervisor.start({
        ...baseRequest(),
        outputObserver: { next: output => { observed.push(output.data); } },
    });
    const protocol = '{"method":"initialize","token":"HOSTILE-PROTOCOL-SECRET"}\n';
    child.stdout.emit('data', Buffer.from(protocol));
    for (let attempt = 0; attempt < 100 && observed.length === 0; attempt += 1) {
        await new Promise<void>(resolve => setImmediate(resolve));
    }
    assert.deepEqual(JSON.parse(observed.join('').trim()), {
        method: 'initialize', token: 'HOSTILE-PROTOCOL-SECRET',
    });
    assert.deepEqual(durable, ['[redacted output]']);
    const serialized = `${JSON.stringify(durable)}\n${fs.readFileSync(layout.logPath, 'utf8')}`;
    assert.doesNotMatch(serialized, /HOSTILE-PROTOCOL-SECRET/);
});

test('control-scoped eager open container has exact open labels and no invented turn label', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'goal-open-container-'));
    const supervisor = new GoalContainerSupervisor(base, events, undefined, {
        isolation, providerFirstEffects: firstEffects,
    });
    await supervisor.startOpen({
        goalId: 'open-goal', sessionId: 'open-session', controllerEpoch: 4,
        executionId: 'open-execution', attemptId: 'open-attempt', deterministicOpenKey: 'open-key-4',
        operationFence: {
            goalId: 'open-goal', sessionId: 'open-session', controllerEpoch: 4,
            executionId: 'open-execution', attemptId: 'open-attempt', generation: 7,
            operationId: 'open-attempt', kind: 'open',
        },
        image: 'provider-image', command: ['codex', 'app-server', '--stdio'],
        worktreePath: approvedWorktree, worktreeFingerprint: 'open-fingerprint',
        providerHomeTarget: '/home/node/.codex',
    });
    const args = spawnCalls.at(-1)!.args;
    assert.ok(args.includes('propr.goal.scope=open'));
    assert.ok(args.includes('propr.goal.open-key=open-key-4'));
    assert.equal(args.some(argument => argument.startsWith('propr.goal.turn=')), false);
    assert.ok(args.includes('/workspace'));
});

test('credential targets reject descendants of proc, sys, and dev even when allow-listed', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'goal-pseudo-fs-'));
    const targets = ['/proc/self/fd/9', '/sys/kernel/credential', '/dev/shm/credential'];
    const supervisor = createSupervisor(base, {
        ...isolation,
        credentialMounts: targets.map(target => ({ source: approvedCredential, target })),
    });
    for (const target of targets) {
        await assert.rejects(
            supervisor.start({ ...baseRequest(), credentialMounts: [{ source: approvedCredential, target }] }),
            /broad or sensitive container path/,
        );
    }
});

test('credential targets reject pseudo-filesystem traversal and symlink-equivalent aliases', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'goal-pseudo-alias-'));
    const targets = [
        '/safe/../proc/self/fd/9',
        '/sys//kernel/credential',
        '/dev/./shm/credential',
        '/dev/fd/9',
        '/proc/self/root/dev/null',
    ];
    const supervisor = createSupervisor(base, {
        ...isolation,
        credentialMounts: targets.map(target => ({ source: approvedCredential, target })),
    });
    for (const target of targets) {
        await assert.rejects(
            supervisor.start({ ...baseRequest(), credentialMounts: [{ source: approvedCredential, target }] }),
            /canonical|broad or sensitive container path/,
        );
    }
});

test('cleanTerminalSession removes a real goal directory but refuses a symlink escape', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'goal-clean-'));
    const supervisor = createSupervisor(base);
    fs.mkdirSync(path.join(base, 'goals'), { recursive: true });
    const past = new Date(0);
    const future = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000);

    // Happy path: a real, goal-scoped directory is removed once retention lapses.
    const real = buildGoalContainerLayout(base, idBits);
    fs.mkdirSync(real.sessionRoot, { recursive: true });
    fs.writeFileSync(path.join(real.sessionRoot, 'state.json'), '{}');
    assert.equal(await supervisor.cleanTerminalSession(real, past, 'succeeded', future), true);
    assert.equal(fs.existsSync(real.sessionRoot), false);

    // Escape attempt: a symlinked session root pointing outside the goals tree.
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'goal-outside-'));
    fs.writeFileSync(path.join(outside, 'keep.txt'), 'precious');
    const escape = buildGoalContainerLayout(base, { ...idBits, goalId: 'escape-goal' });
    fs.symlinkSync(outside, escape.sessionRoot);
    await assert.rejects(
        supervisor.cleanTerminalSession(escape, past, 'succeeded', future),
        /symlinked goal session directory/,
    );
    assert.equal(fs.existsSync(path.join(outside, 'keep.txt')), true);
});

test('cleanTerminalSession refuses an in-tree symlink to a sibling goal directory', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'goal-sibling-'));
    const supervisor = new GoalContainerSupervisor(base, events, undefined, { providerFirstEffects: firstEffects });
    fs.mkdirSync(path.join(base, 'goals'), { recursive: true });
    const past = new Date(0);
    const future = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000);

    // A real sibling goal directory that must survive cleanup of another goal.
    const sibling = buildGoalContainerLayout(base, { ...idBits, goalId: 'sibling-goal' });
    fs.mkdirSync(sibling.sessionRoot, { recursive: true });
    fs.writeFileSync(path.join(sibling.sessionRoot, 'sibling-state.json'), '{}');

    // The cleaned goal's own session root is a symlink to the sibling's real
    // directory; dirname(resolvedRoot) still equals the goals dir, so the old
    // parent-only check would have deleted the sibling. Identity check rejects it.
    const attacker = buildGoalContainerLayout(base, { ...idBits, goalId: 'attacker-goal' });
    fs.symlinkSync(sibling.sessionRoot, attacker.sessionRoot);
    await assert.rejects(
        supervisor.cleanTerminalSession(attacker, past, 'succeeded', future),
        /symlinked goal session directory/,
    );
    assert.equal(fs.existsSync(path.join(sibling.sessionRoot, 'sibling-state.json')), true);
});

test('buildGoalContainerLayout keeps the log path inside the goal log directory', () => {
    // Separator/traversal-laden execution and attempt ids must not escape logs/.
    const layout = buildGoalContainerLayout('/var/lib/propr', {
        ...idBits,
        executionId: '../../../../etc/cron.d/evil',
        attemptId: 'a/b/../..',
    });
    const logDir = path.join(layout.sessionRoot, 'logs');
    assert.equal(path.dirname(path.resolve(layout.logPath)), path.resolve(logDir));
    assert.ok(layout.logPath.startsWith(`${logDir}/`));
    assert.ok(!layout.logPath.includes('..'));
    assert.ok(!layout.logPath.includes('etc/cron.d'));
});

test('start rejects bind-mount fields that could inject Docker --mount options', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'goal-inject-'));
    const supervisor = createSupervisor(base);
    await assert.rejects(
        supervisor.start({ ...baseRequest(), worktreePath: '/tmp/wt,readonly,bind-propagation=rshared' }),
        /inject Docker --mount options/,
    );
    await assert.rejects(
        supervisor.start({ ...baseRequest(), credentialMounts: [{ source: '/host/creds,readonly', target: '/home/node/.creds' }] }),
        /inject Docker --mount options/,
    );
    await assert.rejects(
        supervisor.start({ ...baseRequest(), credentialMounts: [{ source: approvedCredential, target: '/home/node/.creds,dst=/etc' }] }),
        /inject Docker --mount options/,
    );
    await assert.rejects(
        supervisor.start({ ...baseRequest(), providerHomeTarget: '/home/node/.codex,type=volume' }),
        /inject Docker --mount options/,
    );
});

test('start blocks host-controlled environment aliases even when configured', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'goal-env-'));
    const supervisor = createSupervisor(base, {
        ...isolation,
        environmentKeys: ['DOCKER_HOST', 'docker_host', 'LD_PRELOAD'],
    });
    await assert.rejects(supervisor.start({ ...baseRequest(), environment: { DOCKER_HOST: 'tcp://attacker' } }), /host-controlled/);
    await assert.rejects(supervisor.start({ ...baseRequest(), environment: { docker_host: 'tcp://attacker' } }), /host-controlled/);
    await assert.rejects(supervisor.start({ ...baseRequest(), environment: { LD_PRELOAD: '/tmp/evil.so' } }), /host-controlled/);
});

test('start rejects unapproved, broad, sensitive, and symlink-aliased mount sources', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'goal-mounts-'));
    const outsideWorktree = fs.mkdtempSync(path.join(os.tmpdir(), 'other-worktree-'));
    const worktreeAlias = path.join(os.tmpdir(), `worktree-alias-${process.pid}`);
    fs.symlinkSync(approvedWorktree, worktreeAlias);
    const sensitiveDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mount-owner-'));
    const sshDir = path.join(sensitiveDir, '.ssh');
    fs.mkdirSync(sshDir);
    const sshKey = path.join(sshDir, 'id_rsa');
    fs.writeFileSync(sshKey, 'private');
    const supervisor = createSupervisor(base, {
        ...isolation,
        credentialMounts: [
            { source: '/', target: '/home/node/key' },
            { source: sshKey, target: '/home/node/key' },
            { source: approvedCredential, target: '/run/docker.sock' },
        ],
        worktreePaths: [approvedWorktree, worktreeAlias],
    });

    await assert.rejects(supervisor.start({ ...baseRequest(), worktreePath: outsideWorktree }), /not explicitly allow-listed/);
    await assert.rejects(supervisor.start({ ...baseRequest(), worktreePath: worktreeAlias }), /symlink alias/);
    await assert.rejects(
        supervisor.start({
            ...baseRequest(),
            worktreePath: `${path.dirname(approvedWorktree)}/alias/../${path.basename(approvedWorktree)}`,
        }),
        /traversal aliases/,
    );
    await assert.rejects(
        supervisor.start({ ...baseRequest(), providerHomeTarget: '/home/node/alias/../.codex' }),
        /traversal aliases/,
    );
    await assert.rejects(
        supervisor.start({
            ...baseRequest(),
            credentialMounts: [{ source: approvedCredential, target: '/home/node/alias/../.creds' }],
        }),
        /traversal aliases/,
    );
    await assert.rejects(
        supervisor.start({ ...baseRequest(), credentialMounts: [{ source: '/', target: '/home/node/key' }] }),
        /broad or sensitive/,
    );
    await assert.rejects(
        supervisor.start({ ...baseRequest(), credentialMounts: [{ source: sshKey, target: '/home/node/key' }] }),
        /broad or sensitive/,
    );
    await assert.rejects(
        supervisor.start({ ...baseRequest(), credentialMounts: [{ source: approvedCredential, target: '/run/docker.sock' }] }),
        /broad or sensitive/,
    );
});

test('production Codex factory composes claimed supervisor, duplex, and exact App Server open', async t => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-factory-open-'));
    const ports = new InMemoryGoalSessionPorts();
    const runtime = ports.asRuntimePorts();
    const containers = new GoalContainerSupervisor(base, runtime.events, undefined, {
        isolation: {
            environmentKeys: [], worktreePaths: [approvedWorktree],
            providerHomeTargets: ['/home/node/.codex'], credentialMounts: [],
        },
        providerFirstEffects: runtime.providerFirstEffects,
    });
    const repository = {
        repository: 'integry/propr', worktreePath: approvedWorktree, branch: 'factory-open', headSha: 'abcdef',
    };
    const factory = createSupervisedCodexAppServerFactory(containers, {
        repository, worktreeFingerprint: 'factory-fingerprint', image: 'codex-provider:test',
    });
    const adapter: GoalSessionAdapter = {
        provider: 'codex',
        capabilities: {
            nativeSessionId: 'eager', steering: 'active_turn', pause: 'after_turn', modelChange: 'next_turn',
        },
        supportsDeterministicOpen: true,
        publishOperationBarrier: async () => undefined,
        openSession: request => factory.open(request),
        beginTurn: async function* () { yield { type: 'completion', outcome: 'succeeded' }; },
        resumeSession: async (_request, snapshot) => snapshot,
        requestModelChange: async request => ({ requestedModel: request.model, appliesAt: 'next_turn' }),
        cancel: async () => undefined,
        reconcile: async () => ({ outcome: 'failed', reason: 'unused' }),
    };
    child.exitCode = null;
    child.stdin.writableEnded = false;
    stdinHandler = data => {
        const request = JSON.parse(data) as { id?: string; method: string };
        if (!request.id) return;
        let result: Record<string, unknown>;
        if (request.method === 'initialize') result = {
            userAgent: 'propr_goal_runtime/0.146.0 (Linux; x86_64) factory',
            codexHome: '/home/node/.codex', platformFamily: 'unix', platformOs: 'linux',
        };
        else if (request.method === 'model/list') result = {
            data: [{ id: 'gpt-5.6-sol', model: 'gpt-5.6-sol' }], nextCursor: null,
        };
        else result = exactFactoryThreadResponse();
        setImmediate(() => {
            child.stdout.emit('data', Buffer.from(`${JSON.stringify({ id: request.id, result })}\n`));
            if (request.method === 'thread/start') {
                child.exitCode = 0;
                child.emit('close', 0);
            }
        });
    };
    t.after(() => { stdinHandler = undefined; child.exitCode = null; child.stdin.writableEnded = false; });

    const supervisor = new GoalSessionSupervisor(adapter, runtime);
    const opened = await supervisor.openSession({
        goalId: 'factory-goal', sessionId: 'factory-session', provider: 'codex', controllerEpoch: 1,
        supervisedOpen: factory.plan,
    });
    assert.equal(opened.status, 'idle');
    assert.equal(opened.providerSessionId, 'factory-thread');
    const args = spawnCalls.at(-1)!.args;
    assert.ok(args.includes('/workspace'));
    assert.ok(args.includes('propr.goal.scope=open'));
    assert.ok(args.some(value => value.startsWith('propr.goal.operation-generation=')));
    assert.ok(args.some(value => value.startsWith('propr.goal.operation-id=')));
});

function exactFactoryThreadResponse(): Record<string, unknown> {
    return {
        thread: {
            id: 'factory-thread', extra: null, sessionId: 'factory-session-native', forkedFromId: null,
            parentThreadId: null, preview: '', ephemeral: false, isPinned: false,
            historyMode: 'paginated', modelProvider: 'openai', createdAt: 1, updatedAt: 1,
            recencyAt: 1, status: { type: 'idle' }, path: null, cwd: '/workspace', cliVersion: '0.146.0',
            source: 'appServer', canAcceptDirectInput: true, threadSource: null, agentNickname: null,
            agentRole: null, gitInfo: null, name: null, turns: [],
        },
        model: 'gpt-5.6-sol', modelProvider: 'openai', serviceTier: null, cwd: '/workspace',
        runtimeWorkspaceRoots: ['/workspace'], instructionSources: [], approvalPolicy: 'never',
        approvalsReviewer: 'user', sandbox: {
            type: 'workspaceWrite', writableRoots: ['/workspace'], networkAccess: false,
            excludeTmpdirEnvVar: false, excludeSlashTmp: false,
        },
        activePermissionProfile: null, reasoningEffort: null, multiAgentMode: 'explicitRequestOnly',
    };
}
