import assert from 'node:assert/strict';
import * as actualChildProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mock, test } from 'node:test';

const spawnCalls: Array<{ args: string[] }> = [];
const child = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    stdin: { destroyed: false, writableEnded: false, write(_d: string, cb: (e?: Error | null) => void) { cb(); return true; }, end() { this.writableEnded = true; } },
    exitCode: null as number | null,
    kill: mock.fn(() => true),
});

await mock.module('child_process', {
    namedExports: {
        ...actualChildProcess,
        spawn: mock.fn((_command: string, args: string[]) => { spawnCalls.push({ args }); return child; }),
        execFileSync: mock.fn(),
    },
});

const { GoalContainerSupervisor, buildGoalContainerLayout } = await import('../src/agents/goalSession/GoalContainerSupervisor.js');
type EventSink = ConstructorParameters<typeof GoalContainerSupervisor>[1];

const events = { append: async () => ({ accepted: true }), appendControl: async () => ({ accepted: true }), replay: async () => [] } as unknown as EventSink;
const idBits = { goalId: 'g', sessionId: 's', controllerEpoch: 1, turnId: 't', executionId: 'e', attemptId: 'a' };

function baseRequest() {
    return {
        ...idBits,
        image: 'propr/agent:test',
        command: ['agent-command'],
        worktreePath: '/tmp/goal-worktree',
        providerHomeTarget: '/home/node/.codex',
    };
}

test('start passes env names only and never leaks secret values into argv', async () => {
    spawnCalls.length = 0;
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'goal-hard-'));
    const supervisor = new GoalContainerSupervisor(base, events);
    await supervisor.start({
        ...baseRequest(),
        environment: { SECRET_TOKEN: 'super-secret-value' },
        credentialMounts: [{ source: '/host/creds', target: '/home/node/.creds' }],
    });
    const args = spawnCalls[0].args;
    const envIndex = args.indexOf('--env');
    assert.equal(args[envIndex + 1], 'SECRET_TOKEN');
    assert.ok(!args.some(arg => arg.includes('super-secret-value')), 'secret value must not appear in argv');
    assert.ok(args.includes('type=bind,src=/host/creds,dst=/home/node/.creds,readonly'));
});

test('start rejects provider homes that shadow reserved or non-provider paths', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'goal-hard-'));
    const supervisor = new GoalContainerSupervisor(base, events);
    await assert.rejects(supervisor.start({ ...baseRequest(), providerHomeTarget: '/workspace' }), /workspace/);
    await assert.rejects(supervisor.start({ ...baseRequest(), providerHomeTarget: '/' }), /reserved/);
    await assert.rejects(supervisor.start({ ...baseRequest(), providerHomeTarget: '/etc/agent' }), /provider-owned/);
});

test('start refuses credentials mounted inside the writable provider home', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'goal-hard-'));
    const supervisor = new GoalContainerSupervisor(base, events);
    await assert.rejects(
        supervisor.start({ ...baseRequest(), credentialMounts: [{ source: '/host/creds', target: '/home/node/.codex/creds' }] }),
        /separately from the writable provider home/,
    );
});

test('cleanTerminalSession removes a real goal directory but refuses a symlink escape', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'goal-clean-'));
    const supervisor = new GoalContainerSupervisor(base, events);
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
    const supervisor = new GoalContainerSupervisor(base, events);
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
    const supervisor = new GoalContainerSupervisor(base, events);
    await assert.rejects(
        supervisor.start({ ...baseRequest(), worktreePath: '/tmp/wt,readonly,bind-propagation=rshared' }),
        /inject Docker --mount options/,
    );
    await assert.rejects(
        supervisor.start({ ...baseRequest(), credentialMounts: [{ source: '/host/creds,readonly', target: '/home/node/.creds' }] }),
        /inject Docker --mount options/,
    );
    await assert.rejects(
        supervisor.start({ ...baseRequest(), credentialMounts: [{ source: '/host/creds', target: '/home/node/.creds,dst=/etc' }] }),
        /inject Docker --mount options/,
    );
    await assert.rejects(
        supervisor.start({ ...baseRequest(), providerHomeTarget: '/home/node/.codex,type=volume' }),
        /inject Docker --mount options/,
    );
});
