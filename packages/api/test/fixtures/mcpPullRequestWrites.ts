import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import type { McpPrincipal } from '../../mcp/policy.js';

export interface PullRequestFixture {
  repository: string; number: number; state: 'OPEN' | 'MERGED' | 'CLOSED'; merged: boolean;
  title: string; head: string; createdAt: string; updatedAt: string; labels: string[];
  reviewDecision: string | null; checks: string | null;
}
export interface CommentFixture { id: number; pullRequest: number; repository: string; body: string; createdAt: string; author: string }
export type Args = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/**
 * The Redis surface the MCP tools read, plus the SET NX / compare-and-delete
 * pair a per-pull-request lease needs. Leases behave as a single Redis would.
 */
export function leaseRedis() {
  const leases = new Map<string, string>();
  return {
    get: async () => null, sMembers: async () => [],
    set: async (key: string, value: string, options?: { NX?: boolean }) => {
      if (options?.NX && leases.has(key)) return null;
      leases.set(key, value);
      return 'OK';
    },
    eval: async (_script: string, { keys, arguments: [token] }: { keys: string[]; arguments: string[] }) => {
      if (leases.get(keys[0]) !== token) return 0;
      leases.delete(keys[0]);
      return 1;
    },
  };
}

interface WriteFixture {
  t: TestContext;
  call: (name: string, args: Args, actor?: McpPrincipal) => Promise<Args>;
  mutate: (name: string, args: Args, actor?: McpPrincipal) => Promise<Args>;
  principal: McpPrincipal;
  findPullRequest: (repository: string, number: number) => PullRequestFixture;
  restCalls: Array<{ route: string; args: Args }>;
  comments: CommentFixture[];
}

/**
 * The write half of the pull request surface: commenting, model routing and the
 * ultrafix circuit breaker. It shares the caller's GitHub fixture, so the label
 * state each subtest leaves behind is the state the next one reads.
 */
export async function verifyPullRequestWrites(
  { t, call, mutate, principal, findPullRequest, restCalls, comments }: WriteFixture,
): Promise<void> {
  await t.test('comment_on_pull_request rejects slash commands and enforces the expected head', async () => {
    const pull = { repository: 'acme/repo', pullRequest: 42, expectedHead: 'a'.repeat(40) };
    const command = await mutate('comment_on_pull_request', { ...pull, message: '/ultrafix goal=9' });
    assert.equal(command.state, 'failed');
    assert.equal(command.result.error.code, 'USE_EXPLICIT_TOOL');
    const embedded = await mutate('comment_on_pull_request', { ...pull, message: 'Please take another look.\n/merge now' });
    assert.equal(embedded.result.error.code, 'USE_EXPLICIT_TOOL');
    const stale = await mutate('comment_on_pull_request', { ...pull, expectedHead: 'f'.repeat(40), message: 'Cover transient errors too.' });
    assert.equal(stale.result.error.code, 'STALE_HEAD');
    const posted = await mutate('comment_on_pull_request', { ...pull, message: 'Cover transient errors too.' });
    assert.equal(posted.state, 'posted');
    assert.equal(posted.result.expectedHead, 'a'.repeat(40));
    assert.equal(posted.result.pullRequest, 42);
    assert.ok(posted.result.url.includes('#issuecomment-'));
    const stored = comments.find(comment => comment.id === posted.result.commentId)!;
    assert.ok(stored.body.startsWith('Cover transient errors too.'));
    assert.ok(!/^\s*\//m.test(stored.body.split('<!--')[0]));
    // The slash-command attempts must not have reached GitHub.
    assert.ok(!comments.some(comment => comment.body.startsWith('/')));
  });

  await t.test('set_pull_request_model converges on exactly one managed model label', async () => {
    const pull = { repository: 'acme/repo', pullRequest: 42, expectedHead: 'a'.repeat(40) };
    const routed = await mutate('set_pull_request_model', { ...pull, model: 'claude-opus-5' });
    assert.equal(routed.state, 'completed');
    assert.equal(routed.result.label, 'llm-claude-opus-5');
    assert.equal(routed.result.agentAlias, 'claude');
    assert.equal(routed.result.model, 'claude-opus-5');
    assert.deepEqual(routed.result.previousLabels, ['llm-claude-sonnet-5', 'ultrafix', 'auto-merge']);
    assert.deepEqual(routed.result.removedLabels, ['llm-claude-sonnet-5']);
    assert.deepEqual(routed.result.labels, ['ultrafix', 'auto-merge', 'llm-claude-opus-5']);
    const live = findPullRequest('acme/repo', 42).labels;
    assert.deepEqual(live.filter(name => name.startsWith('llm-')), ['llm-claude-opus-5']);
    assert.ok(live.includes('ultrafix') && live.includes('auto-merge'));
    // Re-applying the same model must not add the label twice.
    const adds = restCalls.filter(item => item.route === 'POST /repos/{owner}/{repo}/issues/{issue_number}/labels').length;
    const again = await mutate('set_pull_request_model', { ...pull, model: 'claude-opus-5' });
    assert.deepEqual(again.result.removedLabels, []);
    assert.deepEqual(again.result.labels, ['ultrafix', 'auto-merge', 'llm-claude-opus-5']);
    assert.equal(restCalls.filter(item => item.route === 'POST /repos/{owner}/{repo}/issues/{issue_number}/labels').length, adds);
  });

  await t.test('set_pull_request_model refuses unknown, disabled and undefined labels', async () => {
    const pull = { repository: 'acme/repo', pullRequest: 42, expectedHead: 'a'.repeat(40) };
    const unknown = await mutate('set_pull_request_model', { ...pull, model: 'not-a-real-model' });
    assert.equal(unknown.state, 'failed');
    assert.equal(unknown.result.error.code, 'UNKNOWN_MODEL');
    assert.ok(unknown.result.error.message.includes('claude:claude-opus-5'));
    const disabled = await mutate('set_pull_request_model', { ...pull, model: 'claude-haiku-4-5' });
    assert.equal(disabled.result.error.code, 'UNKNOWN_MODEL');
    const missing = await mutate('set_pull_request_model', { ...pull, model: 'gpt-5.6' });
    assert.equal(missing.result.error.code, 'MODEL_LABEL_MISSING');
    assert.ok(missing.result.error.message.includes('codex:gpt-5.6'));
    assert.deepEqual(findPullRequest('acme/repo', 42).labels.filter(name => name.startsWith('llm-')), ['llm-claude-opus-5']);
  });

  await t.test('get_pull_request reports the ultrafix circuit breaker', async () => {
    const read = await call('get_pull_request', { repository: 'acme/repo', pullRequest: 42 });
    assert.deepEqual(read.ultrafix, { active: true });
    assert.equal((await call('get_pull_request', { repository: 'acme/other', pullRequest: 7 })).ultrafix.active, false);
  });

  await t.test('stop_ultrafix clears the breaker honestly and requires review scope', async () => {
    const pull = { repository: 'acme/repo', pullRequest: 42, expectedHead: 'a'.repeat(40) };
    const withoutReview = { ...principal, scopes: principal.scopes.filter(scope => scope !== 'review') } as McpPrincipal;
    const refused = await mutate('stop_ultrafix', pull, withoutReview);
    assert.equal(refused.state, 'failed');
    assert.equal(refused.result.error.code, 'INSUFFICIENT_SCOPE');
    assert.ok(findPullRequest('acme/repo', 42).labels.includes('ultrafix'));

    const stopped = await mutate('stop_ultrafix', pull);
    assert.equal(stopped.state, 'completed');
    assert.equal(stopped.result.wasActive, true);
    assert.equal(stopped.result.circuitBreaker, 'cleared');
    assert.ok(stopped.result.message.includes('may still finish'));
    assert.doesNotMatch(stopped.result.message, /loop (?:has )?stopped/i);
    assert.ok(!findPullRequest('acme/repo', 42).labels.includes('ultrafix'));
    assert.equal((await call('get_pull_request', { repository: 'acme/repo', pullRequest: 42 })).ultrafix.active, false);
    assert.equal((await call('list_pull_requests', { repository: 'acme/repo' })).pullRequests[0].propr.ultrafixActive, false);

    const deletions = restCalls.filter(item => item.route === 'DELETE /repos/{owner}/{repo}/issues/{issue_number}/labels/{name}' && item.args.name === 'ultrafix').length;
    const already = await mutate('stop_ultrafix', pull);
    assert.equal(already.result.wasActive, false);
    assert.ok(already.result.message.includes('No ultrafix label was present'));
    assert.equal(restCalls.filter(item => item.route === 'DELETE /repos/{owner}/{repo}/issues/{issue_number}/labels/{name}' && item.args.name === 'ultrafix').length, deletions);
    const stale = await mutate('stop_ultrafix', { ...pull, expectedHead: 'f'.repeat(40) });
    assert.equal(stale.result.error.code, 'STALE_HEAD');
  });

  await t.test('a truncated label list leaves the ultrafix breaker undetermined', async () => {
    const listed = await call('list_pull_requests', { repository: 'acme/other' });
    const crowded = listed.pullRequests.find((pull: Args) => pull.number === 6);
    assert.equal(crowded.labels.length, 100);
    assert.equal(crowded.labelsTruncated, true);
    assert.ok(!crowded.labels.includes('ultrafix'));
    // The breaker is beyond the labels GitHub returned: undetermined, not absent.
    assert.equal(crowded.propr.ultrafixActive, null);
    const complete = listed.pullRequests.find((pull: Args) => pull.number === 7);
    assert.equal(complete.labelsTruncated, false);
    assert.equal(complete.propr.ultrafixActive, false);
  });

  await t.test('an incomplete label read never claims the model label is missing', async () => {
    const pull = { repository: 'acme/other', pullRequest: 7, expectedHead: 'd'.repeat(40) };
    // acme/other defines more labels than discovery pages through, and its sonnet
    // label is past that budget: a targeted lookup still has to find it.
    const routed = await mutate('set_pull_request_model', { ...pull, model: 'claude-sonnet-5' });
    assert.equal(routed.state, 'completed');
    assert.equal(routed.result.label, 'llm-claude-sonnet-5');
    assert.deepEqual(routed.result.removedLabels, ['llm-claude-opus-5']);
    assert.deepEqual(findPullRequest('acme/other', 7).labels, ['llm-claude-sonnet-5']);
    const undetermined = await mutate('set_pull_request_model', { ...pull, model: 'gpt-5.6' });
    assert.equal(undetermined.state, 'failed');
    assert.equal(undetermined.result.error.code, 'MODEL_LABEL_LOOKUP_INCOMPLETE');
  });

  await t.test('concurrent model routings of one pull request still converge on one managed label', async () => {
    const pull = { repository: 'acme/repo', pullRequest: 42, expectedHead: 'a'.repeat(40) };
    const live = findPullRequest('acme/repo', 42);
    live.labels = live.labels.filter(name => !name.startsWith('llm-'));
    // Different idempotency keys, different models, same head: both would read an
    // unlabelled pull request and each add its own label without serialization.
    const [opus, sonnet] = await Promise.all([
      mutate('set_pull_request_model', { ...pull, model: 'claude-opus-5' }),
      mutate('set_pull_request_model', { ...pull, model: 'claude-sonnet-5' }),
    ]);
    assert.equal(opus.state, 'completed');
    assert.equal(sonnet.state, 'completed');
    const managed = findPullRequest('acme/repo', 42).labels.filter(name => name.startsWith('llm-'));
    assert.equal(managed.length, 1, `expected one managed label, found ${managed.join(', ')}`);
    // The later routing read the earlier one's label and superseded it.
    const [later, earlier] = managed[0] === opus.result.label ? [opus, sonnet] : [sonnet, opus];
    assert.deepEqual(later.result.removedLabels, [earlier.result.label]);
    assert.deepEqual(earlier.result.removedLabels, []);
    assert.deepEqual(later.result.labels.filter((name: string) => name.startsWith('llm-')), [later.result.label]);
  });
}
