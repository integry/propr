import assert from 'node:assert/strict';
import { test } from 'node:test';
import { syncPlanDependencyLinks, summarizePlanDependencyLinks, type GitHubRequest } from '../src/services/planDependencyLinks.js';

const LIST = 'GET /repos/{owner}/{repo}/issues/{issue_number}/dependencies/blocked_by';
const ADD = 'POST /repos/{owner}/{repo}/issues/{issue_number}/dependencies/blocked_by';
const ISSUE = 'GET /repos/{owner}/{repo}/issues/{issue_number}';

/** A fake GitHub holding blocked-by links as dependant → blocker numbers; issue ids are number * 1000. */
function fakeGitHub(options: { links?: Record<number, number[]>; fail?: (route: string, args: Record<string, unknown>) => unknown;
  /** Extra listed blockers per dependant, e.g. issues from another repository. */
  foreign?: Record<number, Array<{ id: number; number: number; repository_url: string }>> } = {}) {
  const links = new Map<number, number[]>(Object.entries(options.links ?? {}).map(([issue, blockers]) => [Number(issue), [...blockers]]));
  const calls: Array<{ route: string; args: Record<string, unknown> }> = [];
  const request: GitHubRequest = async (route, args) => {
    calls.push({ route, args });
    const failure = options.fail?.(route, args);
    if (failure) throw failure;
    const issue = Number(args.issue_number);
    if (route === LIST) {
      return { data: [...options.foreign?.[issue] ?? [], ...(links.get(issue) ?? []).map(number => ({ id: number * 1000, number }))] };
    }
    if (route === ISSUE) return { data: { id: issue * 1000, number: issue } };
    if (route === ADD) {
      const blocker = Number(args.issue_id) / 1000;
      links.set(issue, [...links.get(issue) ?? [], blocker]);
      return { data: { id: blocker * 1000, number: blocker } };
    }
    throw new Error(`unexpected route ${route}`);
  };
  return { request, calls, links };
}

const item = (id: string, dependsOn?: string[]) => ({ id, title: id, ...(dependsOn ? { dependsOn } : {}) });
const base = { owner: 'acme', repo: 'repo' };

test('links each issue as blocked by its prerequisites, using the captured ids', async () => {
  const github = fakeGitHub();
  const plan = [item('schema'), item('api', ['schema']), item('ui', ['api'])];
  const result = await syncPlanDependencyLinks({ ...base, request: github.request, plan, issueNumbers: [10, 11, 12],
    issueIds: new Map([[10, 10_000], [11, 11_000], [12, 12_000]]) });

  assert.deepEqual(result?.links, [
    { issue: 11, blockedBy: 10, status: 'created' },
    { issue: 12, blockedBy: 11, status: 'created' },
  ]);
  assert.deepEqual(Object.fromEntries(github.links), { 11: [10], 12: [11] });
  assert.equal(github.calls.filter(call => call.route === ISSUE).length, 0, 'known ids are not looked up');
  const add = github.calls.find(call => call.route === ADD)!;
  assert.deepEqual(add.args, { owner: 'acme', repo: 'repo', issue_number: 11, issue_id: 10_000 });
});

test('links a prerequisite published after its dependant, looking up a missing id', async () => {
  const github = fakeGitHub();
  const plan = [item('ui', ['api']), item('api')];
  const result = await syncPlanDependencyLinks({ ...base, request: github.request, plan, issueNumbers: [20, 21] });

  assert.deepEqual(result?.links, [{ issue: 20, blockedBy: 21, status: 'created' }]);
  assert.deepEqual(github.calls.filter(call => call.route === ISSUE).map(call => call.args.issue_number), [21]);
});

test('repeating the step keeps existing links and does not duplicate them', async () => {
  const github = fakeGitHub({ links: { 31: [30] } });
  const plan = [item('a'), item('b'), item('c', ['a', 'b'])];
  const first = await syncPlanDependencyLinks({ ...base, request: github.request, plan, issueNumbers: [30, 31, 32] });
  assert.deepEqual(first?.links.map(link => link.status), ['created', 'created']);

  const second = await syncPlanDependencyLinks({ ...base, request: github.request, plan, issueNumbers: [30, 31, 32] });
  assert.deepEqual(second?.links, [
    { issue: 32, blockedBy: 30, status: 'existing' },
    { issue: 32, blockedBy: 31, status: 'existing' },
  ]);
  assert.deepEqual(github.links.get(32), [30, 31]);
});

test('a 422 on add counts as existing when the link is now listed', async () => {
  // Another attempt adds the link between this one's list and its add.
  const github = fakeGitHub();
  const raceRequest: GitHubRequest = async (route, args) => {
    if (route === ADD) {
      await github.request(route, args);
      throw Object.assign(new Error('Validation Failed'), { status: 422 });
    }
    return github.request(route, args);
  };
  const result = await syncPlanDependencyLinks({ ...base, request: raceRequest, plan: [item('a'), item('b', ['a'])], issueNumbers: [40, 41] });
  assert.deepEqual(result?.links, [{ issue: 41, blockedBy: 40, status: 'existing' }]);
});

// Issue numbers are repository-local: #70 in another repository is not the plan's #70.
const otherRepoBlocker = { id: 987_654, number: 70, repository_url: 'https://api.github.com/repos/other/elsewhere' };

test('an unrelated cross-repository blocker sharing the prerequisite number does not count as the link', async () => {
  const github = fakeGitHub({ foreign: { 71: [otherRepoBlocker] } });
  const result = await syncPlanDependencyLinks({ ...base, request: github.request, plan: [item('a'), item('b', ['a'])], issueNumbers: [70, 71] });

  assert.deepEqual(result?.links, [{ issue: 71, blockedBy: 70, status: 'created' }]);
  assert.deepEqual(github.calls.filter(call => call.route === ADD).map(call => call.args),
    [{ owner: 'acme', repo: 'repo', issue_number: 71, issue_id: 70_000 }]);

  // Once the real link exists it is recognised by id, so a repeat adds nothing.
  const repeat = await syncPlanDependencyLinks({ ...base, request: github.request, plan: [item('a'), item('b', ['a'])], issueNumbers: [70, 71] });
  assert.deepEqual(repeat?.links, [{ issue: 71, blockedBy: 70, status: 'existing' }]);
  assert.equal(github.calls.filter(call => call.route === ADD).length, 1);
});

test('a 422 is not confirmed by an unrelated cross-repository blocker sharing the prerequisite number', async () => {
  const github = fakeGitHub({ foreign: { 71: [otherRepoBlocker] },
    fail: route => route === ADD ? Object.assign(new Error('Validation Failed'), { status: 422 }) : undefined });
  const result = await syncPlanDependencyLinks({ ...base, request: github.request, plan: [item('a'), item('b', ['a'])], issueNumbers: [70, 71],
    issueIds: new Map([[70, 70_000]]) });

  assert.deepEqual(result?.links, [{ issue: 71, blockedBy: 70, status: 'failed', error: '422: Validation Failed' }]);
  assert.equal(github.calls.filter(call => call.route === LIST).length, 2, 'the 422 is re-checked against the list');
});

test('API failures are recorded per link and never thrown', async () => {
  const forbidden = Object.assign(new Error('Resource not accessible by integration'), { status: 403 });
  const listFails = fakeGitHub({ fail: (route, args) => route === LIST && args.issue_number === 52 ? forbidden : undefined });
  const plan = [item('a'), item('b', ['a']), item('c', ['b'])];
  const result = await syncPlanDependencyLinks({ ...base, request: listFails.request, plan, issueNumbers: [50, 51, 52] });
  assert.deepEqual(result?.links, [
    { issue: 51, blockedBy: 50, status: 'created' },
    { issue: 52, blockedBy: 51, status: 'failed', error: '403: Resource not accessible by integration' },
  ]);

  const addFails = fakeGitHub({ fail: route => route === ADD ? Object.assign(new Error('Not Found'), { status: 404 }) : undefined });
  const failed = await syncPlanDependencyLinks({ ...base, request: addFails.request, plan, issueNumbers: [50, 51, 52] });
  assert.deepEqual(failed?.links.map(link => link.status), ['failed', 'failed']);
  assert.deepEqual(summarizePlanDependencyLinks(failed), { syncedAt: failed?.syncedAt, created: 0, existing: 0, failed: [
    { issue: 51, blockedBy: 50, error: '404: Not Found' },
    { issue: 52, blockedBy: 51, error: '404: Not Found' },
  ] });
});

test('a plan without dependencies makes no GitHub calls', async () => {
  const github = fakeGitHub();
  const result = await syncPlanDependencyLinks({ ...base, request: github.request, plan: [item('a'), item('b')], issueNumbers: [60, 61],
    beforeIssue: async () => { throw new Error('not called'); } });
  assert.equal(result, null);
  assert.equal(github.calls.length, 0);

  // A prerequisite that was not published is left out, so nothing is linked either.
  const unpublished = await syncPlanDependencyLinks({ ...base, request: github.request, plan: [item('a'), item('b', ['a'])], issueNumbers: [undefined, 61] });
  assert.equal(unpublished, null);
  assert.equal(github.calls.length, 0);
  assert.equal(summarizePlanDependencyLinks(undefined), null);
});
