import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import knex from 'knex';
import type { Redis } from 'ioredis';
import { boundOverlapPaths, computeFileOverlaps, describeOverlapPaths, normalizeHotPaths, overlapsForTask } from '../src/services/taskFileOverlap.js';
import {
    checkRepositoryFileOverlaps, getCurrentFileOverlaps, listActiveFileChangesTasks, registerActiveFileChangesTask,
    startLiveFileChangesCapture, activeFileChangesTasksKey,
} from '../src/services/taskFileOverlapMonitor.js';

/** The handful of Redis commands the overlap monitor uses, in memory. */
class FakeRedis {
    strings = new Map<string, string>();
    zsets = new Map<string, Map<string, number>>();
    status = 'ready';
    private zset(key: string) {
        let set = this.zsets.get(key);
        if (!set) this.zsets.set(key, set = new Map());
        return set;
    }
    async get(key: string) { return this.strings.get(key) ?? null; }
    async mget(...keys: string[]) { return keys.map(key => this.strings.get(key) ?? null); }
    async setex(key: string, _ttl: number, value: string) { this.strings.set(key, value); return 'OK'; }
    async set(key: string, value: string, ...args: unknown[]) {
        if (args.includes('NX') && this.strings.has(key)) return null;
        this.strings.set(key, value);
        return 'OK';
    }
    async expire() { return 1; }
    async zadd(key: string, score: number, member: string) { this.zset(key).set(member, score); return 1; }
    async zrem(key: string, member: string) { return this.zset(key).delete(member) ? 1 : 0; }
    async zscore(key: string, member: string) { const score = this.zset(key).get(member); return score === undefined ? null : String(score); }
    async zrange(key: string) { return [...this.zset(key).entries()].sort((a, b) => a[1] - b[1]).map(([member]) => member); }
    async zremrangebyscore(key: string, _min: string, max: number) {
        let removed = 0;
        for (const [member, score] of this.zset(key)) if (score <= max) { this.zset(key).delete(member); removed++; }
        return removed;
    }
}

const files = (...paths: string[]) => JSON.stringify({ files: paths.map(path => ({ path, linesAdded: 1, linesRemoved: 0, diff: '', status: 'modified' })), lastUpdated: '', taskId: '' });

test('computeFileOverlaps reports shared paths per task pair, ignoring order, duplicates and empty sets', () => {
    const overlaps = computeFileOverlaps([
        { taskId: 'b', paths: ['src/a.ts', './src/b.ts', 'README.md'] },
        { taskId: 'a', paths: ['src/b.ts', 'src/a.ts'] },
        { taskId: 'c', paths: ['docs/x.md'] },
        { taskId: 'd', paths: [] },
        { taskId: 'c', paths: ['README.md'] },
    ]);
    assert.deepEqual(overlaps, [
        { taskIds: ['a', 'b'], paths: ['src/a.ts', 'src/b.ts'] },
        { taskIds: ['b', 'c'], paths: ['README.md'] },
    ]);
    assert.deepEqual(overlapsForTask(overlaps, 'b').map(entry => entry.otherTaskId), ['a', 'c']);
    assert.deepEqual(computeFileOverlaps([{ taskId: 'only', paths: ['x'] }]), []);
});

test('computeFileOverlaps treats the same directory under a configured hot path as an overlap', () => {
    const tasks = [
        { taskId: 'a', paths: ['db/migrations/0001_users.sql', 'src/app.ts'] },
        { taskId: 'b', paths: ['db/migrations/0001_orders.sql', 'src/other.ts'] },
    ];
    assert.deepEqual(computeFileOverlaps(tasks), []);
    assert.deepEqual(computeFileOverlaps(tasks, { hotPaths: ['db/migrations/'] }), [{ taskIds: ['a', 'b'], paths: ['db/migrations/'] }]);
    // A shared file already names the directory; non-hot directories never overlap by directory.
    assert.deepEqual(computeFileOverlaps([
        { taskId: 'a', paths: ['db/migrations/0001.sql', 'db/migrations/0002.sql'] },
        { taskId: 'b', paths: ['db/migrations/0001.sql'] },
    ], { hotPaths: ['db/migrations'] }), [{ taskIds: ['a', 'b'], paths: ['db/migrations/0001.sql'] }]);
    assert.deepEqual(normalizeHotPaths(' ./db/migrations/ ,, /locales,db/migrations'), ['db/migrations/', 'locales/']);
});

test('overlap path lists are bounded with the total kept', () => {
    const paths = Array.from({ length: 13 }, (_, index) => `f${index}.ts`);
    const bounded = boundOverlapPaths(paths);
    assert.equal(bounded.paths.length, 10);
    assert.equal(bounded.totalPaths, 13);
    assert.equal(describeOverlapPaths(bounded.paths.slice(0, 2), 13), '`f0.ts`, `f1.ts` and 11 more');
});

const database = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
await database.schema.createTable('tasks', table => {
    table.string('task_id').primary(); table.string('repository'); table.integer('issue_number'); table.string('task_type');
});
await database.schema.createTable('task_history', table => {
    table.increments('history_id'); table.string('task_id'); table.string('state'); table.string('timestamp'); table.text('reason'); table.text('metadata');
});
after(() => database.destroy());

test('a new overlap writes one timeline event on both tasks, once per pair, without changing their state', async () => {
    const redis = new FakeRedis();
    const repository = 'Acme/App';
    await database('tasks').insert([
        { task_id: 't1', repository, issue_number: 11, task_type: 'issue' },
        { task_id: 't2', repository, issue_number: 22, task_type: 'pr_comment' },
        { task_id: 't3', repository, issue_number: 33, task_type: 'issue' },
    ]);
    await database('task_history').insert([
        { task_id: 't1', state: 'claude_execution' }, { task_id: 't2', state: 'processing' }, { task_id: 't3', state: 'claude_execution' },
    ]);
    const client = redis as unknown as Redis;
    let now = 1_000_000;
    redis.strings.set('task:file-changes:t1', files('src/shared.ts', 'src/one.ts'));
    redis.strings.set('task:file-changes:t2', files('src/shared.ts'));
    redis.strings.set('task:file-changes:t3', files('src/three.ts'));

    await registerActiveFileChangesTask(client, repository, 't1', now);
    assert.equal((await checkRepositoryFileOverlaps({ redis: client, repository, database, now, hotPaths: [] })).status, 'single_task');
    await registerActiveFileChangesTask(client, repository, 't2', now);
    await registerActiveFileChangesTask(client, repository, 't3', now);

    const first = await checkRepositoryFileOverlaps({ redis: client, repository, database, now, hotPaths: [] });
    assert.deepEqual(first, { status: 'checked', newPairs: [['t1', 't2']] });
    // Throttled within the 30-second window.
    assert.equal((await checkRepositoryFileOverlaps({ redis: client, repository, database, now, hotPaths: [] })).status, 'throttled');

    const events = await database('task_history').whereNotNull('metadata').orderBy('history_id');
    assert.deepEqual(events.map(event => [event.task_id, event.state]), [['t1', 'claude_execution'], ['t2', 'processing']]);
    assert.equal(events[0].reason, 'Also being changed by task t2 (PR #22): `src/shared.ts`');
    assert.equal(events[1].reason, 'Also being changed by task t1 (issue #11): `src/shared.ts`');
    assert.deepEqual(JSON.parse(events[0].metadata).fileOverlap, { otherTaskId: 't2', repository, issueNumber: 22, paths: ['src/shared.ts'], totalPaths: 1 });

    // The pair stays deduplicated on later checks, even as the shared set grows.
    redis.strings.delete('task:file-overlap:throttle:{acme/app}');
    redis.strings.set('task:file-changes:t2', files('src/shared.ts', 'src/one.ts'));
    assert.deepEqual(await checkRepositoryFileOverlaps({ redis: client, repository, database, now, hotPaths: [] }), { status: 'checked', newPairs: [] });
    assert.equal(await database('task_history').whereNotNull('metadata').count({ count: '*' }).first().then(row => Number(row?.count)), 2);

    const current = await getCurrentFileOverlaps(client, 't1', now);
    assert.deepEqual(current, [{ taskId: 't2', paths: ['src/one.ts', 'src/shared.ts'], totalPaths: 2, repository, issueNumber: 22, taskType: 'pr_comment' }]);
    assert.deepEqual(await getCurrentFileOverlaps(client, 't3', now), []);

    // Once the other task stops capturing, the overlap is no longer current.
    now += 121_000;
    await registerActiveFileChangesTask(client, repository, 't1', now);
    assert.deepEqual(await getCurrentFileOverlaps(client, 't1', now), []);
    assert.deepEqual(await listActiveFileChangesTasks(client, repository, now), ['t1']);
});

test('the live capture writes changes, registers the run as active, compares, and unregisters on stop', async () => {
    const redis = new FakeRedis();
    const client = redis as unknown as Redis;
    const captured: string[] = [];
    const checks: string[] = [];
    const capture = startLiveFileChangesCapture({
        taskId: 'followup-1', worktreePath: '/tmp/worktree', repository: 'acme/app', redis: client, intervalMs: 60_000,
        capture: async (taskId, worktreePath) => { captured.push(`${taskId}@${worktreePath}`); },
        checkOverlaps: async options => { checks.push(options.repository); return { status: 'single_task', newPairs: [] }; },
    });
    await capture.tick();
    assert.deepEqual(captured, ['followup-1@/tmp/worktree']);
    assert.deepEqual(checks, ['acme/app']);
    assert.ok(await redis.zscore(activeFileChangesTasksKey('acme/app'), 'followup-1'));
    await capture.stop();
    assert.equal(await redis.zscore(activeFileChangesTasksKey('acme/app'), 'followup-1'), null);
});
