import assert from 'node:assert/strict';
import { after, beforeEach, mock, test } from 'node:test';
import knex from 'knex';
import path from 'node:path';

const database = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
await database.schema.createTable('goals', table => {
    table.string('worktree_path'); table.string('result_state'); table.timestamp('task_reconciled_at');
});
await database.schema.createTable('pr_followup_handoffs', table => {
    table.string('worktree_path'); table.string('status');
});
await database.schema.createTable('tasks', table => { table.string('task_id'); table.string('repository'); });
await database.schema.createTable('task_history', table => {
    table.increments('history_id'); table.string('task_id'); table.string('state');
});
let sweeps = 0;
const warnings: string[] = [];
const warningContexts: unknown[] = [];
const dockerCalls: string[][] = [];
let dockerResponse = { exitCode: 0, stdout: '', stderr: '' };
const { runningContainerMountSources: inspectMounts } = await import('../packages/core/src/git/worktreeMounts.js');
const { resolveRepositoryWorktreeRoot } = await import('../packages/core/src/git/repositoryPaths.js');
await mock.module('@propr/core', { namedExports: {
    db: database, probeWorktreeReclamationDocker: async () => {},
    logger: { warn: (_context: unknown, message: string) => { warnings.push(message); warningContexts.push(_context); } },
    sweepIdleWorktrees: async () => { sweeps++; return { removed: [], kept: 0, skipped: 0 }; },
    runningContainerMountSources: () => inspectMounts(async (_command, args) => {
        dockerCalls.push(args); return dockerResponse;
    }), resolveRepositoryWorktreeRoot,
} });
const { referencedWorktreePaths, scheduleWorktreeSweep, sweepWorktrees, runningContainerMountSources } = await import('../src/daemon/worktreeSweep.js');
const previousHours = process.env.WORKTREE_RETENTION_HOURS;
const previousInterval = process.env.WORKTREE_SWEEP_INTERVAL_MS;
after(async () => {
    if (previousHours === undefined) delete process.env.WORKTREE_RETENTION_HOURS; else process.env.WORKTREE_RETENTION_HOURS = previousHours;
    if (previousInterval === undefined) delete process.env.WORKTREE_SWEEP_INTERVAL_MS; else process.env.WORKTREE_SWEEP_INTERVAL_MS = previousInterval;
    await database.destroy();
});
beforeEach(async () => {
    delete process.env.WORKTREE_RETENTION_HOURS;
    delete process.env.WORKTREE_SWEEP_INTERVAL_MS;
    sweeps = 0; warnings.length = 0; warningContexts.length = 0; dockerCalls.length = 0;
    dockerResponse = { exitCode: 0, stdout: '', stderr: '' };
    for (const table of ['goals', 'pr_followup_handoffs', 'tasks', 'task_history']) await database(table).delete();
});

test('invalid retention and timer settings disable sweeping instead of bypassing age or spinning', async () => {
    for (const value of ['abc', '', '0', '-1', '1.5', '2hours', 'Infinity', '9007199254740991']) {
        process.env.WORKTREE_RETENTION_HOURS = value;
        assert.equal(await sweepWorktrees(), null, value);
        assert.equal(scheduleWorktreeSweep(), null, value);
    }
    delete process.env.WORKTREE_RETENTION_HOURS;
    for (const value of ['abc', '', '0', '-1', '1.5', '20ms', 'Infinity', '2147483648']) {
        process.env.WORKTREE_SWEEP_INTERVAL_MS = value;
        assert.equal(scheduleWorktreeSweep(), null, value);
    }
    assert.equal(sweeps, 0);
    assert.ok(warnings.length > 0);
    assert.equal(dockerCalls.length, 0);
});

test('default and valid settings run once at startup (after Git trusts the managed folders) and schedule the requested interval', async () => {
    const defaults = scheduleWorktreeSweep();
    assert.ok(defaults);
    clearInterval(defaults);
    process.env.WORKTREE_RETENTION_HOURS = '2';
    process.env.WORKTREE_SWEEP_INTERVAL_MS = '60000';
    const configured = scheduleWorktreeSweep();
    assert.ok(configured);
    clearInterval(configured);
    // The first sweep waits for the startup trust entries, which resolve in a few ticks.
    for (let tick = 0; tick < 50 && sweeps < 2; tick += 1) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(sweeps, 2);
});

test('durable references protect paused/unreconciled goals, handoffs, and host-side nonterminal task repositories', async () => {
    await database('goals').insert([
        { worktree_path: '/paused-goal', result_state: null, task_reconciled_at: 1 },
        { worktree_path: '/unreconciled-goal', result_state: 'completed', task_reconciled_at: null },
        { worktree_path: '/terminal-goal', result_state: 'completed', task_reconciled_at: 1 },
    ]);
    await database('pr_followup_handoffs').insert([
        { worktree_path: '/cleanup-pending', status: 'active' },
        { worktree_path: '/released', status: 'released' },
    ]);
    await database('tasks').insert([
        { task_id: 'issue', repository: 'owner/issue' },
        { task_id: 'agent', repository: 'owner/agent' },
        { task_id: 'ultrafix-ci', repository: 'owner/ultrafix' },
        { task_id: 'unknown', repository: 'owner/unknown' },
        { task_id: 'dot-repo', repository: 'owner/.github' },
        { task_id: 'finished', repository: 'owner/finished' },
        { task_id: 'retry', repository: 'owner/retry' },
    ]);
    await database('task_history').insert([
        { task_id: 'issue', state: 'post_processing' },
        { task_id: 'agent', state: 'processing' },
        { task_id: 'ultrafix-ci', state: 'post_processing' },
        { task_id: 'finished', state: 'processing' },
        { task_id: 'finished', state: 'completed' },
        { task_id: 'retry', state: 'failed' },
        { task_id: 'retry', state: 'processing' },
    ]);
    const refs = await referencedWorktreePaths();
    for (const expected of ['/paused-goal', '/unreconciled-goal', '/cleanup-pending']) assert.ok(refs.includes(expected));
    for (const repo of ['issue', 'agent', 'ultrafix', 'unknown', 'retry', '.github']) {
        assert.ok(refs.includes(path.resolve(process.env.GIT_WORKTREES_BASE_PATH || '/tmp/git-processor/worktrees', 'owner', repo)));
    }
    assert.ok(!refs.includes('/terminal-goal'));
    assert.ok(!refs.includes('/released'));
    assert.ok(!refs.some(ref => ref.endsWith('/finished')));
    assert.ok(JSON.stringify(warningContexts).includes('unknown'));
    assert.ok(warnings.some(message => message.includes('missing history')));
});

test('unknown task authority and Docker errors fail closed', async () => {
    await database('tasks').insert({ task_id: 'bad', repository: '../escape' });
    await assert.rejects(referencedWorktreePaths(), /Invalid active task repository/);
    dockerResponse = { exitCode: 1, stdout: '', stderr: 'permission denied' };
    await assert.rejects(runningContainerMountSources(), /docker ps failed/);
});

test('null task repositories do not disable sweeping and all canonical terminal states release roots', async () => {
    await database('tasks').insert({ task_id: 'no-repository', repository: null });
    for (const state of ['completed', 'failed', 'cancelled']) {
        await database('tasks').insert({ task_id: state, repository: `owner/${state}` });
        await database('task_history').insert({ task_id: state, state });
    }
    await database('tasks').insert({ task_id: 'mixed-case', repository: 'MixedOwner/Mixed.Repo' });
    assert.deepEqual(await referencedWorktreePaths(), [resolveRepositoryWorktreeRoot(
        process.env.GIT_WORKTREES_BASE_PATH || '/tmp/git-processor/worktrees', 'MixedOwner', 'Mixed.Repo')]);
    await database('tasks').insert({ task_id: 'legacy-invalid-42', repository: 'invalid' });
    await assert.rejects(referencedWorktreePaths(), /Invalid active task repository for task legacy-invalid-42: invalid/);
    assert.ok(JSON.stringify(warningContexts).includes('legacy-invalid-42'));
});

test('Docker inspection preserves service classification without exempting task ancestor mounts', async () => {
    const rows = [
        [['npm', 'run', 'daemon'], { 'com.docker.compose.service': 'daemon' }],
        [['node', 'dist/src/worker.js'], { 'propr.service': 'worker' }],
        [['node', 'agent.js'], null],
        [['node', 'dist/src/worker.js'], null],
    ].map(([command, labels]) => [command, labels, [{ Source: '/tmp/git-processor' }]].map(value => JSON.stringify(value)).join('\t')).join('\n');
    const mounts = await inspectMounts(async (_command, args) => ({ exitCode: 0, stderr: '', stdout: args[0] === 'ps' ? 'containers' : rows }));
    assert.deepEqual(mounts, [true, true, false, false].map(service => ({ source: '/tmp/git-processor', service })));
    await assert.rejects(inspectMounts(async (_command, args) => ({ exitCode: 0, stderr: '', stdout: args[0] === 'ps' ? 'container' : '{broken' })));
    await assert.rejects(inspectMounts(async () => { throw Object.assign(new Error('spawn docker ENOENT'), { code: 'ENOENT' }); }), /ENOENT/);
});

test('blocked-repository diagnostics are bounded while authority remains fresh', async () => {
    await database('tasks').insert(Array.from({ length: 60 }, (_, i) => ({ task_id: `orphan-${i}`, repository: 'owner/blocked' })));
    assert.equal((await referencedWorktreePaths()).length, 1);
    const diagnostic = warningContexts[0] as { taskCount: number; blockedRepositoryCount: number; sample: unknown[] };
    assert.equal(diagnostic.taskCount, 60);
    assert.equal(diagnostic.blockedRepositoryCount, 1);
    assert.equal(diagnostic.sample.length, 20);
    await database('task_history').insert(Array.from({ length: 60 }, (_, i) => ({ task_id: `orphan-${i}`, state: 'completed' })));
    assert.deepEqual(await referencedWorktreePaths(database, false), []);
    assert.equal(warningContexts.length, 1);
});

test('deployment service labels tolerate wrapper entrypoints and extra arguments', async () => {
    const rows = [
        [['wrapper', 'node', 'dist/src/worker.js', '--production'], { 'propr.service': 'worker' }],
        [['node', 'dist/src/daemon.js', '--production'], { 'com.docker.compose.service': 'daemon' }],
        [['npm', 'run', 'worker'], { 'propr.service': 'agent' }],
    ].map(([command, labels]) => [command, labels, [{ Source: '/tmp/git-processor' }]].map(value => JSON.stringify(value)).join('\t')).join('\n');
    assert.deepEqual(await inspectMounts(async (_command, args) => ({ exitCode: 0, stderr: '', stdout: args[0] === 'ps' ? 'containers' : rows })),
        [true, true, false].map(service => ({ source: '/tmp/git-processor', service })));
});

test('startup Docker failure is reported once per process', async () => {
    const fs = await import('node:fs/promises');
    const os = await import('node:os');
    const { default: coreLogger } = await import('../packages/core/src/utils/logger.js');
    const { probeWorktreeReclamationDocker } = await import('../packages/core/src/git/worktreeMounts.js');
    const bin = await fs.mkdtemp(path.join(os.tmpdir(), 'docker-probe-'));
    await fs.writeFile(path.join(bin, 'docker'), '#!/bin/sh\nexit 42\n', { mode: 0o755 });
    const previous = process.env.PATH;
    const warning = mock.method(coreLogger, 'warn', () => {});
    process.env.PATH = bin;
    try {
        await Promise.all([probeWorktreeReclamationDocker(), probeWorktreeReclamationDocker()]);
        await probeWorktreeReclamationDocker();
        assert.equal(warning.mock.callCount(), 1);
        assert.match(String(warning.mock.calls[0].arguments[1]), /Worktree reclamation disabled: Docker unavailable/);
    } finally {
        process.env.PATH = previous;
        warning.mock.restore();
        await fs.rm(bin, { recursive: true });
    }
});
