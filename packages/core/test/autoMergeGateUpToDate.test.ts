/**
 * `auto_merge.require_up_to_date` and GitHub's native auto-merge: the option is
 * enforced only by ProPR's guarded merge path, so native auto-merge must not be
 * armed under it, and ProPR's own already-armed request is withdrawn.
 */
import assert from 'node:assert/strict';
import { after, beforeEach, mock, test } from 'node:test';
import knex from 'knex';

const database = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
const log = { info() {}, warn() {}, error() {}, debug() {}, withCorrelation: () => log };
await mock.module('../src/db/connection.js', { namedExports: { db: database, closeConnection: async () => {} } });
await mock.module('../src/utils/logger.js', { defaultExport: log });
await mock.module('../src/auth/githubAuth.js', { namedExports: { getAuthenticatedOctokit: async () => { throw new Error('use the fake client'); } } });
await mock.module('../src/config/planIssueManager.js', { namedExports: { findPlanIssueByRepoAndPR: async () => null } });

const { gateAutoMergeArming, reevaluateArmedAutoMergeOnNewHead, withdrawNativeAutoMergeForUpToDate } = await import('../src/services/autoMergeGate.js');
type GateOctokit = import('../src/services/autoMergeGate.js').AutoMergeGateOctokit;

await database.schema.createTable('tasks', table => {
    table.string('task_id').primary(); table.string('repository'); table.integer('issue_number'); table.string('created_at');
});
await database.schema.createTable('task_history', table => {
    table.increments('history_id'); table.string('task_id'); table.string('state'); table.string('timestamp'); table.text('reason'); table.text('metadata');
});
after(async () => database.destroy());

const UP_TO_DATE_POLICY = 'auto_merge:\n  require_up_to_date: true\n';
const PLAIN_POLICY = 'auto_merge:\n  enabled: true\n';
const PROPR_ARMED = { enabled_by: { login: 'propr-dev[bot]', type: 'Bot' } };
const MAINTAINER_ARMED = { enabled_by: { login: 'maintainer', type: 'User' } };
const botLogin = async () => 'propr-dev[bot]';

interface State { policy: string; autoMerge: { enabled_by: { login: string; type: string } } | null }

function fakeGitHub(state: State) {
    const calls: Array<{ route: string; params: Record<string, unknown> }> = [];
    const graphqlCalls: string[] = [];
    const octokit: GateOctokit = {
        async request(route, params = {}) {
            calls.push({ route, params });
            if (route === 'GET /repos/{owner}/{repo}/pulls/{pull_number}') {
                return { data: { number: params.pull_number, node_id: 'PR_node', base: { ref: 'main' }, head: { sha: 'head1' }, changed_files: 1, auto_merge: state.autoMerge } };
            }
            if (route === 'GET /repos/{owner}/{repo}/contents/{path}') {
                return { data: { type: 'file', encoding: 'base64', size: state.policy.length, content: Buffer.from(state.policy).toString('base64') } };
            }
            if (route === 'GET /repos/{owner}/{repo}/pulls/{pull_number}/files') return { data: [{ filename: 'src/app.ts' }] };
            if (route === 'GET /repos/{owner}/{repo}') return { data: {} };
            if (route === 'POST /repos/{owner}/{repo}/issues/{issue_number}/comments') return { data: {} };
            throw new Error(`Unexpected request ${route}`);
        },
        async graphql<T>(query: string) {
            graphqlCalls.push(query);
            if (/disablePullRequestAutoMerge/.test(query)) state.autoMerge = null;
            return {} as T;
        },
    };
    const comments = () => calls.filter(call => call.route.startsWith('POST ')).map(call => call.params.body as string);
    return { octokit, graphqlCalls, comments };
}

beforeEach(async () => {
    await database('tasks').delete();
    await database('task_history').delete();
    await database('tasks').insert({ task_id: 'task-1', repository: 'acme/repo', issue_number: 70, created_at: '2026-11-11T00:00:00.000Z' });
});

const events = async () => (await database('task_history').orderBy('history_id')).map(row => JSON.parse(row.metadata).autoMergeDecision);
const gate = (github: ReturnType<typeof fakeGitHub>) =>
    gateAutoMergeArming({ owner: 'acme', repo: 'repo', prNumber: 70, opportunity: 'initial_pr', taskId: 'task-1', log }, { octokit: github.octokit, database, botLogin });

test('with require_up_to_date the gate allows the merge but only through ProPR, without a native merge method', async () => {
    const github = fakeGitHub({ policy: UP_TO_DATE_POLICY, autoMerge: null });
    const result = await gate(github);
    assert.equal(result.arm, true);
    assert.equal(result.directMergeOnly, true);
    assert.equal(result.mergeMethod, undefined, 'nothing to arm GitHub auto-merge with');
    assert.equal(github.graphqlCalls.length, 0);
    assert.equal(github.comments().length, 0);

    // Without the option the gate still arms natively.
    const plain = await gate(fakeGitHub({ policy: PLAIN_POLICY, autoMerge: null }));
    assert.equal(plain.directMergeOnly, undefined);
    assert.equal(plain.mergeMethod, 'SQUASH');
});

test('an arming opportunity under require_up_to_date withdraws the native request ProPR armed earlier', async () => {
    const github = fakeGitHub({ policy: UP_TO_DATE_POLICY, autoMerge: PROPR_ARMED });
    const result = await gate(github);
    assert.equal(result.directMergeOnly, true);
    assert.equal(github.graphqlCalls.length, 1);
    assert.match(github.graphqlCalls[0], /disablePullRequestAutoMerge/);
    assert.equal(github.comments().length, 1);
    assert.match(github.comments()[0], /GitHub auto-merge withdrawn.*require_up_to_date/);
    assert.deepEqual((await events()).map(event => [event.reason, event.action ?? null]), [['armed', null], ['armed', 'disarmed']]);
});

test('a new head under require_up_to_date withdraws ProPR\'s native request and keeps the merge with ProPR', async () => {
    const github = fakeGitHub({ policy: UP_TO_DATE_POLICY, autoMerge: PROPR_ARMED });
    const result = await reevaluateArmedAutoMergeOnNewHead({ owner: 'acme', repo: 'repo', prNumber: 70, log }, { octokit: github.octokit, database, botLogin });
    assert.equal(result.disarmed, true);
    assert.equal(result.decision?.arm, true, 'the policy still allows ProPR to merge it');
    assert.equal(github.graphqlCalls.length, 1);
    assert.match(github.comments()[0], /GitHub auto-merge withdrawn/);
    const [event] = await events();
    assert.equal(event.action, 'disarmed');
    assert.equal(event.opportunity, 'new_head');
    assert.match(event.detail, /require_up_to_date/);
});

test('require_up_to_date leaves a native request someone else armed alone', async () => {
    for (const run of [
        (github: ReturnType<typeof fakeGitHub>) => reevaluateArmedAutoMergeOnNewHead({ owner: 'acme', repo: 'repo', prNumber: 70, log }, { octokit: github.octokit, database, botLogin }),
        gate,
    ]) {
        const github = fakeGitHub({ policy: UP_TO_DATE_POLICY, autoMerge: MAINTAINER_ARMED });
        await run(github);
        assert.equal(github.graphqlCalls.length, 0);
        assert.equal(github.comments().length, 0);
    }
});

test('a maintainer taking over the request during evaluation is not withdrawn', async () => {
    // The evaluated snapshot was read before a maintainer took the request over.
    const github = fakeGitHub({ policy: UP_TO_DATE_POLICY, autoMerge: MAINTAINER_ARMED });
    const pullRequest = { number: 70, nodeId: 'PR_node', baseRef: 'main', headSha: 'head1', changedFiles: 1, autoMergeArmed: true, autoMergeEnabledBy: 'propr-dev[bot]' };
    const withdrawn = await withdrawNativeAutoMergeForUpToDate({ owner: 'acme', repo: 'repo', prNumber: 70, pullRequest, opportunity: 'check_merge', log },
        { octokit: github.octokit, database, botLogin });
    assert.equal(withdrawn, false);
    assert.equal(github.graphqlCalls.length, 0);
});

test('a ProPR request on a PR whose policy has no require_up_to_date is kept on a new head', async () => {
    const github = fakeGitHub({ policy: PLAIN_POLICY, autoMerge: PROPR_ARMED });
    const result = await reevaluateArmedAutoMergeOnNewHead({ owner: 'acme', repo: 'repo', prNumber: 70, log }, { octokit: github.octokit, database, botLogin });
    assert.equal(result.disarmed, false);
    assert.equal(github.graphqlCalls.length, 0);
});
