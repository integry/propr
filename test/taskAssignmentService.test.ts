import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import knex from 'knex';
import { MAX_TASK_ASSIGNEES } from '@propr/shared';
import { down, up } from '../packages/core/src/db/migrations/20261012010000_create_task_assignees.js';

const root = await mkdtemp(path.join(tmpdir(), 'task-assignees-'));
process.env.DATA_DIR = root;
process.env.DB_FILENAME = path.join(root, 'core.sqlite');
process.env.NODE_ENV = 'test';

const { db, runMigrations, closeConnection } = await import('../packages/core/src/db/connection.js');
const { resetUnresolvedGitHubUserIds } = await import('../packages/core/src/services/githubUserProfileService.js');
const {
    TaskAssignmentError,
    resolveTaskSubject,
    syncTaskAssignees,
    refreshTaskAssignees,
    setTaskAssignees,
    loadTaskAssignees,
    syncSubjectAssignees,
    taskIdsAssignedTo,
    isUserAssignedToTask,
} = await import('../packages/core/src/services/taskAssignmentService.js');
type TaskAssignmentClient = import('../packages/core/src/services/taskAssignmentService.js').TaskAssignmentClient;

const T0 = new Date('2026-10-09T10:00:00.000Z');
const T1 = new Date('2026-10-09T11:00:00.000Z');

const USERS: Record<string, { login: string; name: string | null }> = {
    '1': { login: 'octocat', name: 'Mona' },
    '2': { login: 'hubot', name: null },
    '3': { login: 'outsider', name: 'No Access' },
    '4': { login: 'human', name: 'Added In UI' },
    ...Object.fromEntries(Array.from({ length: 8 }, (_, index) => [String(index + 5), { login: `member-${index + 5}`, name: null }])),
};

function user(id: string) {
    return { id: Number(id), login: USERS[id].login, name: USERS[id].name, avatar_url: `https://avatars.example/u/${id}` };
}

/**
 * A stub of GitHub's issue assignment API. `assigned` holds the live assignee
 * ids per issue number; users in `noAccess` are silently ignored on assign, as
 * GitHub does for users without repository access.
 */
function fakeGitHub(assigned: Record<number, string[]>, options: { fail?: boolean; failWrites?: boolean; noAccess?: string[] } = {}) {
    const calls: Array<{ route: string; parameters: Record<string, unknown> }> = [];
    const issue = (number: number) => ({ number, assignees: (assigned[number] ?? []).map(id => ({ id: Number(id), login: USERS[id].login, avatar_url: `https://avatars.example/u/${id}` })) });
    const idOf = (login: unknown) => Object.keys(USERS).find(id => USERS[id].login.toLowerCase() === String(login).toLowerCase());
    const client: TaskAssignmentClient = {
        async request(route, parameters) {
            calls.push({ route, parameters });
            if (options.fail) throw new Error('GitHub is down');
            if (route === 'GET /users/{username}') {
                const id = idOf(parameters.username);
                if (!id) throw Object.assign(new Error('Not Found'), { status: 404 });
                return { data: user(id) };
            }
            const number = Number(parameters.issue_number);
            if (route === 'GET /repos/{owner}/{repo}/issues/{issue_number}') return { data: issue(number) };
            if (options.failWrites) throw Object.assign(new Error('Forbidden'), { status: 403 });
            const ids = (parameters.assignees as string[]).map(idOf).filter((id): id is string => Boolean(id));
            if (route === 'POST /repos/{owner}/{repo}/issues/{issue_number}/assignees') {
                const current = new Set(assigned[number] ?? []);
                // GitHub silently ignores additions past its assignee cap.
                for (const id of ids) if (!options.noAccess?.includes(id) && current.size < MAX_TASK_ASSIGNEES) current.add(id);
                assigned[number] = [...current];
                return { data: issue(number) };
            }
            if (route === 'DELETE /repos/{owner}/{repo}/issues/{issue_number}/assignees') {
                assigned[number] = (assigned[number] ?? []).filter(id => !ids.includes(id));
                return { data: issue(number) };
            }
            throw new Error(`Unexpected route ${route}`);
        },
    };
    return { client, calls, assigned };
}

async function insertTask(task: { task_id: string; repository?: string; issue_number?: number | null; pr_number?: number | null; task_type?: string }) {
    await db('tasks').insert({ repository: 'acme/widgets', task_type: 'issue', ...task });
}

async function storedIds(taskId: string): Promise<string[]> {
    return (await db('task_assignees').where({ task_id: taskId }).orderBy('github_user_id')).map(row => row.github_user_id);
}

describe('task_assignees migration', () => {
    test('creates the table with a composite primary key and drops it on rollback', async () => {
        const database = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
        try {
            await up(database);
            const columns = await database('task_assignees').columnInfo();
            assert.deepEqual(Object.keys(columns).sort(), ['created_at', 'github_user_id', 'synced_at', 'task_id']);
            const row = { task_id: 't', github_user_id: '1', synced_at: 'now', created_at: 'now' };
            await database('task_assignees').insert(row);
            await assert.rejects(database('task_assignees').insert(row), /UNIQUE|PRIMARY/);
            await database('task_assignees').insert({ ...row, github_user_id: '2' });
            const indexes = await database.raw("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'task_assignees'");
            assert.ok(indexes.some((index: { name: string }) => index.name === 'task_assignees_github_user_id_index'));
            await down(database);
            assert.equal(await database.schema.hasTable('task_assignees'), false);
        } finally {
            await database.destroy();
        }
    });
});

describe('resolveTaskSubject', () => {
    test('uses the PR number for a PR-comment task', () => {
        assert.deepEqual(
            resolveTaskSubject({ task_id: 'pr-comment-1', repository: 'acme/widgets', issue_number: 42, pr_number: null, task_type: 'pr-comment' }),
            { owner: 'acme', repo: 'widgets', number: 42, kind: 'pull_request' },
        );
        // Historical PR-comment tasks were stored as type "issue"; the id prefix still marks them.
        assert.equal(resolveTaskSubject({ task_id: 'pr-comments-9', repository: 'acme/widgets', issue_number: 9, task_type: 'issue' })?.kind, 'pull_request');
    });

    test('uses the issue for an implementation task until it records a PR', () => {
        assert.deepEqual(
            resolveTaskSubject({ task_id: 'issue-7', repository: 'acme/widgets', issue_number: 7, pr_number: null, task_type: 'issue' }),
            { owner: 'acme', repo: 'widgets', number: 7, kind: 'issue' },
        );
        assert.deepEqual(
            resolveTaskSubject({ task_id: 'issue-7', repository: 'acme/widgets', issue_number: 7, pr_number: 88, task_type: 'issue' }),
            { owner: 'acme', repo: 'widgets', number: 88, kind: 'pull_request' },
        );
    });

    test('returns null without an issue, a PR or a valid repository', () => {
        assert.equal(resolveTaskSubject({ task_id: 'x', repository: 'acme/widgets', issue_number: null, pr_number: null, task_type: 'issue' }), null);
        assert.equal(resolveTaskSubject({ task_id: 'x', repository: 'widgets', issue_number: 7, task_type: 'issue' }), null);
        assert.equal(resolveTaskSubject(null), null);
    });
});

describe('taskAssignmentService', () => {
    before(async () => { await runMigrations(); });
    beforeEach(async () => {
        await db('task_assignees').delete();
        await db('github_user_profiles').delete();
        await db('tasks').delete();
        resetUnresolvedGitHubUserIds();
    });
    after(async () => {
        await closeConnection();
        await rm(root, { recursive: true, force: true });
    });

    test('syncTaskAssignees replaces the stored set and caches observed profiles', async () => {
        await insertTask({ task_id: 'issue-7', issue_number: 7 });
        const github = fakeGitHub({ 7: ['1', '2'] });

        const first = await syncTaskAssignees('issue-7', { github: github.client, now: () => T0 });
        assert.equal(first.synced, true);
        assert.deepEqual(first.assignees.map(a => a.login), ['hubot', 'octocat']);
        assert.equal((await db('github_user_profiles').where({ github_user_id: '1' }).first()).login, 'octocat');

        github.assigned[7] = ['2', '4'];
        const second = await syncTaskAssignees('issue-7', { github: github.client, now: () => T1 });
        assert.deepEqual(second.assignees.map(a => a.login), ['hubot', 'human']);
        assert.deepEqual(await storedIds('issue-7'), ['2', '4']);
        const kept = await db('task_assignees').where({ task_id: 'issue-7', github_user_id: '2' }).first();
        assert.equal(kept.created_at, T0.toISOString());
        assert.equal(kept.synced_at, T1.toISOString());
    });

    test('syncTaskAssignees leaves the stored set untouched when GitHub fails', async () => {
        await insertTask({ task_id: 'issue-7', issue_number: 7 });
        await syncTaskAssignees('issue-7', { github: fakeGitHub({ 7: ['1'] }).client, now: () => T0 });

        const result = await syncTaskAssignees('issue-7', { github: fakeGitHub({}, { fail: true }).client, now: () => T1 });
        assert.equal(result.synced, false);
        assert.deepEqual(result.assignees.map(a => a.login), ['octocat']);
        assert.deepEqual(await storedIds('issue-7'), ['1']);
    });

    test('syncTaskAssignees reads the PR for a task that has one', async () => {
        await insertTask({ task_id: 'issue-7', issue_number: 7, pr_number: 88 });
        const github = fakeGitHub({ 7: ['1'], 88: ['2'] });
        const result = await syncTaskAssignees('issue-7', { github: github.client });
        assert.deepEqual(result.subject, { owner: 'acme', repo: 'widgets', number: 88, kind: 'pull_request' });
        assert.deepEqual(result.assignees.map(a => a.login), ['hubot']);
    });

    test('refreshTaskAssignees stores the explicit subject\'s assignees, not the task row\'s', async () => {
        // The implementation task has not recorded its new PR yet.
        await insertTask({ task_id: 'issue-7', issue_number: 7 });
        const github = fakeGitHub({ 7: ['2'], 88: ['1', '4'] });
        const assignees = await refreshTaskAssignees('issue-7', { owner: 'acme', repo: 'widgets', number: 88, kind: 'pull_request' }, { github: github.client, now: () => T0 });
        assert.deepEqual(assignees.map(a => a.login), ['human', 'octocat']);
        assert.deepEqual(await storedIds('issue-7'), ['1', '4']);
        assert.deepEqual(github.calls.map(call => call.parameters.issue_number), [88]);
    });

    test('refreshTaskAssignees throws when GitHub fails and leaves the stored set untouched', async () => {
        await insertTask({ task_id: 'issue-7', issue_number: 7 });
        await syncTaskAssignees('issue-7', { github: fakeGitHub({ 7: ['1'] }).client, now: () => T0 });
        await assert.rejects(
            refreshTaskAssignees('issue-7', { owner: 'acme', repo: 'widgets', number: 88, kind: 'pull_request' }, { github: fakeGitHub({}, { fail: true }).client }),
            /GitHub is down/,
        );
        assert.deepEqual(await storedIds('issue-7'), ['1']);
    });

    test("setTaskAssignees in add mode keeps assignees added in GitHub's UI", async () => {
        await insertTask({ task_id: 'issue-7', issue_number: 7 });
        const github = fakeGitHub({ 7: ['4'] });

        const result = await setTaskAssignees('issue-7', ['@octocat'], { mode: 'add', github: github.client, now: () => T0 });
        assert.deepEqual(result.assignees.map(a => a.login), ['human', 'octocat']);
        assert.deepEqual(result.rejected, []);
        assert.deepEqual(github.assigned[7].sort(), ['1', '4']);
        assert.equal(github.calls.some(call => call.route.startsWith('DELETE')), false);
        assert.deepEqual(await storedIds('issue-7'), ['1', '4']);
    });

    test('setTaskAssignees in replace mode removes only assignees not requested', async () => {
        await insertTask({ task_id: 'issue-7', issue_number: 7 });
        const github = fakeGitHub({ 7: ['1', '4'] });

        const result = await setTaskAssignees('issue-7', ['octocat', 'hubot'], { mode: 'replace', github: github.client, now: () => T0 });
        assert.deepEqual(result.assignees.map(a => a.login), ['hubot', 'octocat']);
        const writes = github.calls.filter(call => !call.route.startsWith('GET'));
        assert.deepEqual(writes.map(call => [call.route.split(' ')[0], call.parameters.assignees]), [['POST', ['hubot']], ['DELETE', ['human']]]);
        assert.deepEqual(await storedIds('issue-7'), ['1', '2']);
    });

    test('setTaskAssignees in replace mode reaches the requested set when the task is at the assignee cap', async () => {
        await insertTask({ task_id: 'issue-7', issue_number: 7 });
        const full = Array.from({ length: MAX_TASK_ASSIGNEES }, (_, index) => String(index + 1));
        const github = fakeGitHub({ 7: [...full] });
        const requested = [...full.slice(1), '11'];

        const result = await setTaskAssignees('issue-7', requested.map(id => USERS[id].login), { mode: 'replace', github: github.client, now: () => T0 });
        assert.deepEqual(result.rejected, []);
        assert.deepEqual([...github.assigned[7]].sort(), [...requested].sort());
        assert.deepEqual(await storedIds('issue-7'), [...requested].sort());
        const writes = github.calls.filter(call => !call.route.startsWith('GET'));
        assert.deepEqual(writes.map(call => [call.route.split(' ')[0], call.parameters.assignees]), [['DELETE', ['octocat']], ['POST', ['member-11']]]);
    });

    test('setTaskAssignees persists what GitHub confirmed, not the request', async () => {
        await insertTask({ task_id: 'issue-7', issue_number: 7 });
        const github = fakeGitHub({ 7: [] }, { noAccess: ['3'] });

        const result = await setTaskAssignees('issue-7', ['octocat', 'outsider'], { mode: 'add', github: github.client, now: () => T0 });
        assert.deepEqual(result.assignees.map(a => a.login), ['octocat']);
        assert.deepEqual(result.rejected.map(a => a.login), ['outsider']);
        assert.deepEqual(await storedIds('issue-7'), ['1']);
    });

    test('setTaskAssignees rejects an unknown login and writes nothing', async () => {
        await insertTask({ task_id: 'issue-7', issue_number: 7 });
        await syncTaskAssignees('issue-7', { github: fakeGitHub({ 7: ['2'] }).client, now: () => T0 });
        const github = fakeGitHub({ 7: ['2'] });

        await assert.rejects(
            setTaskAssignees('issue-7', ['octocat', 'ghost-user'], { mode: 'replace', github: github.client }),
            (error: unknown) => error instanceof TaskAssignmentError && error.code === 'UNKNOWN_LOGIN' && error.logins.join() === 'ghost-user',
        );
        assert.equal(github.calls.some(call => call.route.includes('/issues/')), false);
        assert.deepEqual(await storedIds('issue-7'), ['2']);
    });

    test('setTaskAssignees rejects logins that normalize to empty and writes nothing', async () => {
        await insertTask({ task_id: 'issue-7', issue_number: 7 });
        await syncTaskAssignees('issue-7', { github: fakeGitHub({ 7: ['2'] }).client, now: () => T0 });

        for (const [mode, logins] of [['replace', ['@']], ['replace', ['   ']], ['replace', ['octocat', '']], ['add', [' @ ']]] as const) {
            const github = fakeGitHub({ 7: ['2'] });
            await assert.rejects(
                setTaskAssignees('issue-7', [...logins], { mode, github: github.client }),
                (error: unknown) => error instanceof TaskAssignmentError && error.code === 'UNKNOWN_LOGIN' && error.logins.length === 1,
            );
            assert.deepEqual(github.calls, [], `${mode} ${JSON.stringify(logins)} must not call GitHub`);
            assert.deepEqual(await storedIds('issue-7'), ['2']);
        }
    });

    test('setTaskAssignees with an empty list in replace mode clears every assignee', async () => {
        await insertTask({ task_id: 'issue-7', issue_number: 7 });
        await syncTaskAssignees('issue-7', { github: fakeGitHub({ 7: ['2'] }).client, now: () => T0 });
        const github = fakeGitHub({ 7: ['2'] });

        const result = await setTaskAssignees('issue-7', [], { mode: 'replace', github: github.client, now: () => T0 });

        assert.deepEqual(result.assignees, []);
        assert.deepEqual(await storedIds('issue-7'), []);
    });

    test('setTaskAssignees propagates GitHub write failures and missing subjects', async () => {
        await insertTask({ task_id: 'issue-7', issue_number: 7 });
        await insertTask({ task_id: 'draft', issue_number: null });

        await assert.rejects(
            setTaskAssignees('issue-7', ['octocat'], { mode: 'add', github: fakeGitHub({ 7: [] }, { failWrites: true }).client }),
            (error: unknown) => error instanceof TaskAssignmentError && error.code === 'GITHUB_WRITE_FAILED' && error.status === 403,
        );
        assert.deepEqual(await storedIds('issue-7'), []);
        await assert.rejects(
            setTaskAssignees('draft', ['octocat'], { mode: 'add', github: fakeGitHub({}).client }),
            (error: unknown) => error instanceof TaskAssignmentError && error.code === 'NO_GITHUB_SUBJECT',
        );
        await assert.rejects(
            setTaskAssignees('missing', ['octocat'], { mode: 'add', github: fakeGitHub({}).client }),
            (error: unknown) => error instanceof TaskAssignmentError && error.code === 'TASK_NOT_FOUND',
        );
    });

    test('the list projection catches up with a GitHub-side change on the next live read of the subject', async () => {
        const pr88 = { owner: 'acme', repo: 'widgets', number: 88, kind: 'pull_request' } as const;
        await insertTask({ task_id: 'issue-7', issue_number: 7, pr_number: 88 });
        const github = fakeGitHub({ 88: ['1'] });
        await syncTaskAssignees('issue-7', { github: github.client, now: () => T0 });

        // Reassigned in GitHub's UI, then a follow-up run starts on the same PR.
        github.assigned[88] = ['2'];
        await insertTask({ task_id: 'pr-comment-8', issue_number: 88 });

        // List reads never call GitHub, so they serve the last observed state.
        const callsBefore = github.calls.length;
        assert.deepEqual([...await taskIdsAssignedTo('1')], ['issue-7']);
        assert.deepEqual([...await taskIdsAssignedTo('2')], []);
        assert.equal((await loadTaskAssignees(['pr-comment-8'])).has('pr-comment-8'), false);
        assert.equal(github.calls.length, callsBefore);

        // A live read of the PR (the follow-up gate's) refreshes every task on it.
        await syncSubjectAssignees(pr88, { github: github.client, now: () => T1 });
        assert.deepEqual([...await taskIdsAssignedTo('1')], []);
        assert.deepEqual([...await taskIdsAssignedTo('2')].sort(), ['issue-7', 'pr-comment-8']);
        assert.deepEqual([...await taskIdsAssignedTo('2', { repository: 'acme/widgets' })].sort(), ['issue-7', 'pr-comment-8']);
    });

    test('loadTaskAssignees batch-reads in one query and omits unassigned tasks', async () => {
        await insertTask({ task_id: 'a', issue_number: 1 });
        await insertTask({ task_id: 'b', issue_number: 2 });
        await insertTask({ task_id: 'c', issue_number: 3 });
        const github = fakeGitHub({ 1: ['1'], 2: ['2', '4'], 3: [] });
        for (const id of ['a', 'b', 'c']) await syncTaskAssignees(id, { github: github.client });

        let queries = 0;
        const count = () => { queries += 1; };
        db.on('query', count);
        try {
            const assignees = await loadTaskAssignees(['a', 'b', 'c', 'unknown']);
            assert.equal(queries, 1);
            assert.deepEqual([...assignees.keys()].sort(), ['a', 'b']);
            assert.deepEqual(assignees.get('b'), [
                { id: '2', login: 'hubot', displayName: null, avatarUrl: 'https://avatars.example/u/2' },
                { id: '4', login: 'human', displayName: null, avatarUrl: 'https://avatars.example/u/4' },
            ]);
        } finally {
            db.removeListener('query', count);
        }
        assert.equal((await loadTaskAssignees([])).size, 0);
    });

    test('taskIdsAssignedTo is scoped by repository, and isUserAssignedToTask checks one task', async () => {
        await insertTask({ task_id: 'a', issue_number: 1 });
        await insertTask({ task_id: 'b', issue_number: 2, repository: 'acme/gadgets' });
        const github = fakeGitHub({ 1: ['1'], 2: ['1', '2'] });
        await syncTaskAssignees('a', { github: github.client });
        await syncTaskAssignees('b', { github: github.client });

        assert.deepEqual([...await taskIdsAssignedTo('1')].sort(), ['a', 'b']);
        assert.deepEqual([...await taskIdsAssignedTo(1, { repository: 'Acme/Gadgets' })], ['b']);
        assert.deepEqual([...await taskIdsAssignedTo('2', { repository: 'acme/widgets' })], []);
        assert.equal(await isUserAssignedToTask('b', '2'), true);
        assert.equal(await isUserAssignedToTask('a', '2'), false);
    });
});
