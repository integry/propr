import assert from 'node:assert/strict';
import { after, mock, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import knex from 'knex';

// REST finalize publishes through executeDraft: each plan_issues row must
// record its plan item and its prerequisites as issue numbers, also when a
// prerequisite is published after the task that needs it.
const database = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
await database.migrate.latest({ directory: fileURLToPath(new URL('../src/db/migrations/', import.meta.url)) });

let nextIssue = 40;
const posted: string[] = [];
// GitHub "blocked by" links as "dependant<-blocker"; issue ids are number * 1000.
const blockedBy: string[] = [];
let dependencyFailure: Error | undefined;
// Issue creation for this title fails, as an external GitHub failure would.
let failingTitle: string | undefined;
const octokit = {
  request: async (route: string, args: Record<string, unknown>) => {
    posted.push(route);
    if (route === 'POST /repos/{owner}/{repo}/issues' && args.title === failingTitle) {
      throw Object.assign(new Error('Validation Failed'), { status: 422 });
    }
    if (route === 'POST /repos/{owner}/{repo}/issues') {
      nextIssue += 1;
      return { data: { id: nextIssue * 1000, number: nextIssue, html_url: `https://github.com/acme/repo/issues/${nextIssue}`, title: args.title } };
    }
    if (route.includes('/dependencies/blocked_by') && dependencyFailure) throw dependencyFailure;
    if (route === 'GET /repos/{owner}/{repo}/issues/{issue_number}/dependencies/blocked_by') return { data: [] };
    if (route === 'POST /repos/{owner}/{repo}/issues/{issue_number}/dependencies/blocked_by') {
      blockedBy.push(`${args.issue_number}<-${Number(args.issue_id) / 1000}`);
      return { data: {} };
    }
    return { data: {} };
  },
};
const publisher = { publishDraftUpdate: async () => true, publishActivity: async () => true };
await mock.module('../src/db/connection.js', { namedExports: { db: database, closeConnection: async () => {} } });
const githubAuth = await import('../src/auth/githubAuth.js');
await mock.module('../src/auth/githubAuth.js', { namedExports: { ...githubAuth, getAuthenticatedOctokit: async () => octokit } });
const eventPublisher = await import('../src/utils/eventPublisher.js');
await mock.module('../src/utils/eventPublisher.js', { namedExports: { ...eventPublisher, getEventPublisher: () => publisher } });
await mock.module('../src/config/planIssueDefaults.js', { namedExports: {
  resolvePlanIssueDefaultSelection: async () => ({ agent_alias: 'claude', model_name: 'claude-opus-5-5' }),
} });
const helpers = await import('../src/services/taskExecutionHelpers.js');
await mock.module('../src/services/taskExecutionHelpers.js', { namedExports: { ...helpers, generateAndSaveTaskTitle: async () => {} } });
const { executeDraft } = await import('../src/services/taskExecutionService.js');

after(() => database.destroy());

const task = (title: string, extra: Record<string, unknown> = {}) => ({ title, body: `${title} body`, implementation: `${title} steps`, ...extra });

async function insertDraft(draftId: string, plan: unknown[], status = 'executing'): Promise<void> {
  await database('task_drafts').insert({ draft_id: draftId, user_id: 'user-1', repository: 'acme/repo', name: 'Plan',
    status, plan_json: JSON.stringify(plan), context_config: '{}' });
}

const rows = (draftId: string) => database('plan_issues').where({ draft_id: draftId }).orderBy('issue_number')
  .select('issue_number', 'plan_item_id', 'depends_on_issues');

test('REST publication records item ids and prerequisite issue numbers, including forward references', async () => {
  const draftId = '20000000-0000-4000-8000-000000000001';
  await insertDraft(draftId, [
    task('UI', { id: 'ui', dependsOn: ['api', 'schema'] }),
    task('Schema', { id: 'schema' }),
    task('API', { id: 'api', dependsOn: ['schema'] }),
  ]);

  const result = await executeDraft(draftId, 'user-1');

  assert.equal(result.success, true);
  assert.deepEqual(await rows(draftId), [
    { issue_number: 41, plan_item_id: 'ui', depends_on_issues: '[43,42]' },
    { issue_number: 42, plan_item_id: 'schema', depends_on_issues: '[]' },
    { issue_number: 43, plan_item_id: 'api', depends_on_issues: '[42]' },
  ]);
  const stored = JSON.parse((await database('task_drafts').where({ draft_id: draftId }).first()).plan_json);
  assert.deepEqual(stored.map((item: { id: string; dependsOn?: string[]; issue_number: number }) =>
    [item.id, item.dependsOn ?? [], item.issue_number]), [['ui', ['api', 'schema'], 41], ['schema', [], 42], ['api', ['schema'], 43]]);
  // The second pass links each issue on GitHub, including to prerequisites created after it.
  assert.deepEqual(blockedBy, ['41<-43', '41<-42', '43<-42']);
  const context = JSON.parse((await database('task_drafts').where({ draft_id: draftId }).first()).context_config);
  assert.deepEqual(context.dependencyLinks.links.map((link: { status: string }) => link.status), ['created', 'created', 'created']);
  assert.equal(posted.includes('GET /repos/{owner}/{repo}/issues/{issue_number}'), false, 'ids come from the creation response');

  // Re-finalizing detaches the old rows and records the same relation for the new issues.
  await database('task_drafts').where({ draft_id: draftId }).update({ status: 'executed' });
  await executeDraft(draftId, 'user-1');
  assert.deepEqual(await rows(draftId), [
    { issue_number: 44, plan_item_id: 'ui', depends_on_issues: '[46,45]' },
    { issue_number: 45, plan_item_id: 'schema', depends_on_issues: '[]' },
    { issue_number: 46, plan_item_id: 'api', depends_on_issues: '[45]' },
  ]);
});

test('REST publication succeeds when GitHub refuses the dependency links', async () => {
  const draftId = '20000000-0000-4000-8000-000000000004';
  await insertDraft(draftId, [task('Schema', { id: 'schema' }), task('API', { id: 'api', dependsOn: ['schema'] })]);
  dependencyFailure = Object.assign(new Error('Resource not accessible by integration'), { status: 403 });
  try {
    const result = await executeDraft(draftId, 'user-1');
    assert.equal(result.success, true);
  } finally { dependencyFailure = undefined; }
  const draft = await database('task_drafts').where({ draft_id: draftId }).first();
  assert.equal(draft.status, 'executed');
  const [schema, api] = (await rows(draftId)).map(row => row.issue_number);
  assert.deepEqual(JSON.parse(draft.context_config).dependencyLinks.links, [
    { issue: api, blockedBy: schema, status: 'failed', error: '403: Resource not accessible by integration' },
  ]);
});

test('REST publication gives an older draft item ids and refuses invalid dependencies', async () => {
  const legacy = '20000000-0000-4000-8000-000000000002';
  await insertDraft(legacy, [task('Only')]);
  const callsBefore = posted.length;
  await executeDraft(legacy, 'user-1');
  assert.equal(posted.slice(callsBefore).some(route => route.includes('/dependencies/')), false, 'a plan without dependencies makes no link calls');
  const [row] = await rows(legacy);
  const [item] = JSON.parse((await database('task_drafts').where({ draft_id: legacy }).first()).plan_json);
  assert.match(item.id, /^item-/);
  assert.equal(row.plan_item_id, item.id);
  assert.equal(row.depends_on_issues, '[]');

  const cyclic = '20000000-0000-4000-8000-000000000003';
  await insertDraft(cyclic, [task('A', { id: 'a', dependsOn: ['b'] }), task('B', { id: 'b', dependsOn: ['a'] })]);
  const before = posted.length;
  await assert.rejects(executeDraft(cyclic, 'user-1'), /dependency cycle/);
  assert.equal(posted.length, before, 'no issue is created for an invalid plan');
});

test('REST publication keeps a failed prerequisite as unresolved on its dependant', async () => {
  const draftId = '20000000-0000-4000-8000-000000000005';
  await insertDraft(draftId, [
    task('Prerequisite', { id: 'a' }),
    task('Dependant', { id: 'b', dependsOn: ['a'] }),
    task('Independent', { id: 'c' }),
  ]);
  failingTitle = 'Prerequisite';
  try {
    const result = await executeDraft(draftId, 'user-1');
    assert.equal(result.success, true);
  } finally { failingTitle = undefined; }
  const [dependant, independent] = await rows(draftId);
  assert.equal(dependant.plan_item_id, 'b');
  // The dependant does not read as independent: its prerequisite is recorded as never published.
  assert.equal(dependant.depends_on_issues, '[{"unresolved":"a"}]');
  assert.equal(independent.depends_on_issues, '[]');
});
