/* eslint-disable max-lines -- the pull-request write scenarios share one stateful GitHub fixture */
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
 * The Redis surface the MCP tools read, plus the SET NX PX / compare-and-delete /
 * compare-and-pexpire trio a per-pull-request lease needs. Leases behave as a single
 * Redis would, including expiry; `advance` moves the lease clock forward.
 */
export function leaseRedis() {
  const leases = new Map<string, { token: string; expiresAt: number }>();
  // Record-level consumption the worker writes and `projectDiscussionComment`
  // reads, so a consumed suggestion can be exercised without a live Redis.
  const consumedRecords = new Set<string>();
  let clock = 0;
  const held = (key: string) => {
    const lease = leases.get(key);
    if (lease && lease.expiresAt <= clock) leases.delete(key);
    return leases.get(key);
  };
  return {
    get: async () => null,
    sMembers: async (key: string) => (key.endsWith(':findings') ? [...consumedRecords] : []),
    /** Mark one `<commentId>:F|S:<id>` record consumed, as a finished /fix run would. */
    consume: (record: string) => { consumedRecords.add(record); },
    set: async (key: string, value: string, options?: { NX?: boolean; PX?: number }) => {
      if (options?.NX && held(key)) return null;
      leases.set(key, { token: value, expiresAt: options?.PX ? clock + options.PX : Infinity });
      return 'OK';
    },
    eval: async (script: string, { keys, arguments: [token, ttl] }: { keys: string[]; arguments: string[] }) => {
      // The live-output reader's atomic read: no agent output in this fixture.
      if (keys[0].startsWith('agent:output:')) return ['0', 'legacy', '0', '', '0', '', '0'];
      const lease = held(keys[0]);
      if (lease?.token !== token) return 0;
      if (script.includes('pexpire')) lease.expiresAt = clock + Number(ttl);
      else leases.delete(keys[0]);
      return 1;
    },
    advance: (ms: number) => { clock += ms; },
  };
}

export type LeaseRedis = ReturnType<typeof leaseRedis>;

export interface WriteFixture {
  t: TestContext;
  call: (name: string, args: Args, actor?: McpPrincipal) => Promise<Args>;
  mutate: (name: string, args: Args, actor?: McpPrincipal) => Promise<Args>;
  principal: McpPrincipal;
  findPullRequest: (repository: string, number: number) => PullRequestFixture;
  restCalls: Array<{ route: string; args: Args }>;
  comments: CommentFixture[];
  /** Files changed between two heads, keyed by `from...to`, as GitHub's compare endpoint reports them. */
  comparisons: Map<string, Array<{ filename: string; status: string; previous_filename?: string }>>;
  /** Every file path at a commit, keyed by its SHA, as GitHub's recursive tree endpoint reports them. */
  trees: Map<string, string[]>;
  redis: LeaseRedis;
}

type GitHubRequest = (route: string, args: Args) => Promise<unknown>;

/** Run `hook` once, before the next GitHub request to `route` is answered. */
export function interceptRest(principal: McpPrincipal, route: string, hook: () => Promise<void>): void {
  const github = principal.github as unknown as { request: GitHubRequest };
  const next = github.request;
  let pending = true;
  github.request = async (called, args) => {
    if (pending && called === route) {
      pending = false;
      await hook();
    }
    return next(called, args);
  };
}

/**
 * A published review at head `a…a` offering two merge blockers (F20, F21) and
 * five follow-ups (S30…S34), which is what a `/fix` selection is validated
 * against. Both namespaces continue a PR-wide sequence rather than restarting at
 * 1 in each comment, so selecting S32 and S34 exercises a mid-list selection of
 * suggestions a previous review already numbered past.
 */
export function fixtureReviewBody(head: string): string {
  return [
    '## 🔍 AI Code Review — Fixture',
    '',
    '## Overall Evaluation',
    'Two blockers and five follow-ups.',
    '## Merge blockers',
    'Every finding below was introduced by this PR and must be resolved before merging.',
    '',
    '### F20: 🔴 Preserve concurrent updates',
    '- **Required behavior:** Preserve unrelated changes.',
    '- **Evidence:** src/config.ts:10 — the snapshot write replaces the stale list.',
    '- **Minimum fix:** Reject stale revisions.',
    '',
    '### F21: 🔴 Release the renewed lease',
    '- **Required behavior:** A released lease must be reacquirable.',
    '- **Evidence:** src/lease.ts:40 — release compares the old token.',
    '- **Minimum fix:** Compare against the renewed token.',
    '## Suggestions',
    'These are optional follow-ups and are not sent to `/fix`.',
    '### S30: 🟢 Add a cancellation audit log',
    'An audit trail would make operator overlap easier to diagnose.',
    '### S31: 🟢 Document the retry budget',
    'The budget is only described in the code.',
    '### S32: 🟢 Extract the retry helper',
    'The retry block is duplicated in two callers.',
    '### S33: 🟢 Name the lease constants',
    'The magic numbers are hard to follow.',
    '### S34: 🟢 Add a metrics counter',
    'Operators cannot see how often the path runs.',
    '## Score',
    'Score: 6/10',
    `<!-- propr:ai-review model="fixture" head="${head}" -->`,
  ].join('\n');
}

/**
 * The write half of the pull request surface: commenting, model routing and the
 * ultrafix circuit breaker. It shares the caller's GitHub fixture, so the label
 * state each subtest leaves behind is the state the next one reads.
 */
export async function verifyPullRequestWrites(
  { t, call, mutate, principal, findPullRequest, restCalls, comments, redis }: WriteFixture,
): Promise<void> {
  await t.test('comment_on_pull_request resolves an omitted head and enforces a supplied head', async () => {
    const pull = { repository: 'acme/repo', pullRequest: 42, expectedHead: 'a'.repeat(40) };
    const pullReads = () => restCalls.filter(item => item.route === 'GET /repos/{owner}/{repo}/pulls/{pull_number}').length;
    const command = await mutate('comment_on_pull_request', { ...pull, message: '/ultrafix goal=9' });
    assert.equal(command.state, 'failed');
    assert.equal(command.result.error.code, 'USE_EXPLICIT_TOOL');
    const embedded = await mutate('comment_on_pull_request', { ...pull, message: 'Please take another look.\n/merge now' });
    assert.equal(embedded.result.error.code, 'USE_EXPLICIT_TOOL');
    const stale = await mutate('comment_on_pull_request', { ...pull, expectedHead: 'f'.repeat(40), message: 'Cover transient errors too.' });
    assert.equal(stale.result.error.code, 'STALE_HEAD');
    assert.equal(stale.result.error.stage, 'precondition');
    assert.deepEqual(stale.result.error.details, { expectedHead: 'f'.repeat(40), currentHead: 'a'.repeat(40) });
    const beforeCallerRead = pullReads();
    const posted = await mutate('comment_on_pull_request', { ...pull, message: 'Cover transient errors too.' });
    assert.equal(pullReads() - beforeCallerRead, 1, 'a caller-pinned comment reads the pull request once');
    assert.equal(posted.state, 'posted');
    assert.equal(posted.result.expectedHead, 'a'.repeat(40));
    assert.equal(posted.result.resolvedHead, 'a'.repeat(40));
    assert.equal(posted.result.headSource, 'caller');
    assert.equal(posted.result.pullRequest, 42);
    assert.ok(posted.result.url.includes('#issuecomment-'));
    const stored = comments.find(comment => comment.id === posted.result.commentId)!;
    assert.ok(stored.body.startsWith('Cover transient errors too.'));
    assert.ok(stored.body.endsWith(`head:${'a'.repeat(40)} -->`));
    assert.ok(!/^\s*\//m.test(stored.body.split('<!--')[0]));

    const beforeServerRead = pullReads();
    const beforeServerPost = comments.length;
    const resolved = await mutate('comment_on_pull_request', {
      repository: pull.repository, pullRequest: pull.pullRequest, message: 'Use the current revision.',
    });
    assert.equal(pullReads() - beforeServerRead, 1, 'a server-resolved comment reads the pull request once');
    assert.equal(comments.length - beforeServerPost, 1, 'a server-resolved comment posts once');
    assert.equal(resolved.state, 'posted');
    assert.equal(resolved.result.expectedHead, undefined);
    assert.equal(resolved.result.resolvedHead, 'a'.repeat(40));
    assert.equal(resolved.result.headSource, 'server');
    assert.ok(comments.at(-1)!.body.endsWith(`head:${'a'.repeat(40)} -->`));
    // The slash-command attempts must not have reached GitHub.
    assert.ok(!comments.some(comment => comment.body.startsWith('/')));
  });

  await t.test('review and ultrafix receipts report the resolved head source', async () => {
    const base = { repository: 'acme/repo', pullRequest: 42 };
    const review = await mutate('review_pull_request', base);
    assert.equal(review.state, 'posted');
    assert.equal(review.result.resolvedHead, 'a'.repeat(40));
    assert.equal(review.result.headSource, 'server');
    assert.ok(comments.at(-1)!.body.endsWith(`head:${'a'.repeat(40)} -->`));

    const ultrafix = await mutate('run_ultrafix', { ...base, expectedHead: 'a'.repeat(40) });
    assert.equal(ultrafix.state, 'posted');
    assert.equal(ultrafix.result.resolvedHead, 'a'.repeat(40));
    assert.equal(ultrafix.result.headSource, 'caller');
    const stale = await mutate('run_ultrafix', { ...base, expectedHead: 'f'.repeat(40) });
    assert.equal(stale.result.error.code, 'STALE_HEAD');
    assert.equal(stale.result.error.stage, 'precondition');
    assert.deepEqual(stale.result.error.details, { expectedHead: 'f'.repeat(40), currentHead: 'a'.repeat(40) });
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

  await t.test('set_pull_request_model checks the head and open state after label discovery', async () => {
    const pull = { repository: 'acme/repo', pullRequest: 42, expectedHead: 'a'.repeat(40) };
    const live = findPullRequest('acme/repo', 42);
    const before = [...live.labels];
    const writes = () => restCalls.filter(item => item.route.includes('/issues/{issue_number}/labels')).length;
    const baseline = writes();
    // The running implementation pushes a new head while repository labels are still
    // being discovered; the model lease does not govern that push.
    interceptRest(principal, 'GET /repos/{owner}/{repo}/labels', async () => { live.head = 'b'.repeat(40); });
    const pushed = await mutate('set_pull_request_model', { ...pull, model: 'claude-sonnet-5' });
    live.head = 'a'.repeat(40);
    assert.equal(pushed.state, 'failed');
    assert.equal(pushed.result.error.code, 'STALE_HEAD');
    // The pull request closes during discovery instead.
    interceptRest(principal, 'GET /repos/{owner}/{repo}/labels', async () => { live.state = 'CLOSED'; });
    const closed = await mutate('set_pull_request_model', { ...pull, model: 'claude-sonnet-5' });
    live.state = 'OPEN';
    assert.equal(closed.state, 'failed');
    assert.equal(closed.result.error.code, 'PULL_REQUEST_CLOSED');
    assert.equal(writes(), baseline, 'no label may be written after the precondition changed');
    assert.deepEqual(live.labels, before);
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

  await t.test('start_ultrafix re-arms the loop through the /ultrafix command at a pinned head', async () => {
    const { saveUltrafixRatingGoal, saveUltrafixMaxCycles } = await import('@propr/core');
    const pull = { repository: 'acme/repo', pullRequest: 42, expectedHead: 'a'.repeat(40) };
    const withoutReview = { ...principal, scopes: principal.scopes.filter(scope => scope !== 'review') } as McpPrincipal;
    const posted = () => comments.filter(comment => comment.repository === 'acme/repo' && comment.pullRequest === 42 && comment.body.startsWith('/ultrafix')).length;
    const before = posted();
    const refused = await mutate('start_ultrafix', pull, withoutReview);
    assert.equal(refused.result.error.code, 'INSUFFICIENT_SCOPE');
    const stale = await mutate('start_ultrafix', { ...pull, expectedHead: 'f'.repeat(40) });
    assert.equal(stale.result.error.code, 'STALE_HEAD');
    assert.equal(stale.result.error.stage, 'precondition');
    assert.equal(posted(), before, 'a refused start must post nothing');

    // Omitted bounds track the instance settings, including after they change.
    await saveUltrafixRatingGoal(8);
    await saveUltrafixMaxCycles(4);
    const started = await mutate('start_ultrafix', pull);
    assert.equal(started.state, 'posted');
    assert.equal(started.lifecycle.state, 'accepted');
    assert.equal(started.result.goal, 8);
    assert.equal(started.result.maxCycles, 4);
    assert.equal(started.result.resolvedHead, 'a'.repeat(40));
    assert.equal(started.result.headSource, 'caller');
    assert.equal(started.result.wasActive, false);
    assert.equal(started.result.circuitBreaker, 'requested');
    const body = comments.at(-1)!.body;
    assert.match(body, /^\/ultrafix goal=8 max=4\n\n<!-- propr-mcp:[^;]+; head:a{40} -->$/);
    assert.equal(started.result.commentId, comments.at(-1)!.id);
    // The /ultrafix intake owns the label; the tool never writes it directly.
    assert.ok(!restCalls.some(item => item.route === 'POST /repos/{owner}/{repo}/issues/{issue_number}/labels' && (item.args.labels as string[]).includes('ultrafix')));

    await saveUltrafixRatingGoal(6);
    assert.equal((await mutate('start_ultrafix', pull)).result.goal, 6);
    const explicit = await mutate('start_ultrafix', { ...pull, ultrafixGoal: 10, ultrafixMaxCycles: 2 });
    assert.equal(explicit.result.goal, 10);
    assert.equal(explicit.result.maxCycles, 2);
    assert.ok(comments.at(-1)!.body.startsWith('/ultrafix goal=10 max=2\n'));
    await saveUltrafixRatingGoal(8);
  });

  await t.test('resolve_merge_conflicts posts /merge at a pinned head on a labelled pull request', async () => {
    const pull = { repository: 'acme/repo', pullRequest: 42, expectedHead: 'a'.repeat(40) };
    const posted = () => comments.filter(comment => comment.repository === 'acme/repo' && comment.pullRequest === 42 && comment.body.startsWith('/merge')).length;
    const before = posted();
    const stale = await mutate('resolve_merge_conflicts', { ...pull, expectedHead: 'f'.repeat(40) });
    assert.equal(stale.result.error.code, 'STALE_HEAD');
    assert.equal(stale.result.error.stage, 'precondition');
    // /merge intake ignores pull requests without a processing label, so the tool refuses up front.
    const unmanaged = await mutate('resolve_merge_conflicts', pull);
    assert.equal(unmanaged.result.error.code, 'PULL_REQUEST_NOT_MANAGED');
    assert.equal(unmanaged.result.error.stage, 'precondition');
    assert.equal(posted(), before, 'a refused merge must post nothing');

    const labels = findPullRequest('acme/repo', 42).labels;
    labels.push('AI');
    try {
      const started = await mutate('resolve_merge_conflicts', pull);
      assert.equal(started.state, 'posted');
      assert.equal(started.lifecycle.state, 'accepted');
      assert.equal(started.result.resolvedHead, 'a'.repeat(40));
      assert.equal(started.result.headSource, 'caller');
      assert.equal(started.result.state, 'posted');
      const body = comments.at(-1)!.body;
      assert.match(body, /^\/merge\n\n<!-- propr-mcp:[^;]+; head:a{40} -->$/);
      assert.equal(started.result.commentId, comments.at(-1)!.id);
      assert.equal(posted(), before + 1);
      // The comment-driven path does the merge; the clean update-branch endpoint is never called.
      assert.ok(!restCalls.some(item => item.route === 'PUT /repos/{owner}/{repo}/pulls/{pull_number}/update-branch'));
    } finally {
      labels.splice(labels.indexOf('AI'), 1);
    }
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
  await t.test('a routing whose lease lapsed during label discovery writes no label', async () => {
    const pull = { repository: 'acme/repo', pullRequest: 42, expectedHead: 'a'.repeat(40) };
    const live = findPullRequest('acme/repo', 42);
    live.labels = live.labels.filter(name => !name.startsWith('llm-'));
    let takeover: Args | undefined;
    // The first routing has read an unlabelled pull request; its discovery then stalls
    // past the lease TTL, and a second routing acquires, labels and releases meanwhile.
    interceptRest(principal, 'GET /repos/{owner}/{repo}/labels', async () => {
      redis.advance(61_000);
      takeover = await mutate('set_pull_request_model', { ...pull, model: 'claude-sonnet-5' });
    });
    const stale = await mutate('set_pull_request_model', { ...pull, model: 'claude-opus-5' });
    assert.equal(takeover?.state, 'completed');
    assert.equal(takeover?.result.label, 'llm-claude-sonnet-5');
    assert.equal(stale.state, 'failed');
    assert.equal(stale.result.error.code, 'MODEL_LABEL_LEASE_LOST');
    assert.deepEqual(findPullRequest('acme/repo', 42).labels.filter(name => name.startsWith('llm-')), ['llm-claude-sonnet-5']);
  });

  await t.test('a routing that outlasts one lease TTL renews it and still converges', async () => {
    const pull = { repository: 'acme/repo', pullRequest: 42, expectedHead: 'a'.repeat(40) };
    // Each stage stays inside the TTL, but together they exceed it.
    interceptRest(principal, 'GET /repos/{owner}/{repo}/labels', async () => { redis.advance(50_000); });
    interceptRest(principal, 'POST /repos/{owner}/{repo}/issues/{issue_number}/labels', async () => { redis.advance(50_000); });
    interceptRest(principal, 'DELETE /repos/{owner}/{repo}/issues/{issue_number}/labels/{name}', async () => { redis.advance(50_000); });
    const routed = await mutate('set_pull_request_model', { ...pull, model: 'claude-opus-5' });
    assert.equal(routed.state, 'completed');
    assert.deepEqual(routed.result.removedLabels, ['llm-claude-sonnet-5']);
    assert.deepEqual(findPullRequest('acme/repo', 42).labels.filter(name => name.startsWith('llm-')), ['llm-claude-opus-5']);
  });

  await t.test('fix_review_findings selects findings and suggestions together, or names what it rejected', async () => {
    const head = 'a'.repeat(40);
    const pull = { repository: 'acme/repo', pullRequest: 42, expectedHead: head };
    const reviewCommentId = 960;
    comments.push({ id: reviewCommentId, repository: 'acme/repo', pullRequest: 42, author: 'propr-dev[bot]',
      createdAt: new Date().toISOString(), body: fixtureReviewBody(head) });
    const staleCommentId = 961;
    comments.push({ id: staleCommentId, repository: 'acme/repo', pullRequest: 42, author: 'propr-dev[bot]',
      createdAt: new Date().toISOString(), body: fixtureReviewBody('b'.repeat(40)) });
    const plainCommentId = comments.find(comment => comment.id === 101)!.id;
    const posted = () => comments.filter(comment => comment.body.startsWith('/fix')).length;

    // Both namespaces are projected for selection, from the same consumed set.
    const inspected = await call('get_pull_request_discussion', { repository: 'acme/repo', pullRequest: 42, commentId: reviewCommentId });
    assert.deepEqual(inspected.comments[0].review.currentFindingIds, ['F20', 'F21']);
    assert.deepEqual(inspected.comments[0].review.currentSuggestionIds, ['S30', 'S31', 'S32', 'S33', 'S34']);

    // Backward compatibility: a findings-only request posts what it always did.
    const findingsOnly = await mutate('fix_review_findings', { ...pull, reviewCommentId, findingIds: ['F20'] });
    assert.equal(findingsOnly.state, 'posted', JSON.stringify(findingsOnly));
    assert.equal(comments.at(-1)!.body.split('\n')[0], '/fix F20');
    assert.deepEqual(findingsOnly.result.findingIds, ['F20']);
    assert.deepEqual(findingsOnly.result.suggestionIds, []);
    assert.equal(findingsOnly.result.resolvedHead, head);
    assert.equal(findingsOnly.result.headSource, 'caller');
    // Head unchanged since the review: nothing to re-anchor, nothing skipped.
    assert.equal(findingsOnly.result.reviewedHead, head);
    assert.equal(findingsOnly.result.reanchored, false);
    assert.equal(findingsOnly.result.comparison, 'same_head');
    assert.deepEqual(findingsOnly.result.applied, [{ id: 'F20', kind: 'finding', touchedPaths: [] }]);
    assert.deepEqual(findingsOnly.result.skipped, []);

    // Both namespaces, mixed and lower case on input, canonical on the wire,
    // with the caller's instructions carried through unchanged below the command.
    const mixed = await mutate('fix_review_findings', {
      ...pull, reviewCommentId, findingIds: ['f20'], suggestionIds: ['s32', 's34'],
      instructions: 'Keep the public helper signature unchanged.',
    });
    assert.equal(mixed.state, 'posted', JSON.stringify(mixed));
    const mixedBody = comments.at(-1)!.body;
    assert.equal(mixedBody.split('\n')[0], '/fix F20 S32 S34');
    assert.ok(mixedBody.includes('\n\nKeep the public helper signature unchanged.\n\n<!-- propr-mcp:'));
    assert.deepEqual(mixed.result.findingIds, ['F20']);
    assert.deepEqual(mixed.result.suggestionIds, ['S32', 'S34']);

    // Suggestions alone are a complete request.
    const suggestionsOnly = await mutate('fix_review_findings', {
      repository: pull.repository, pullRequest: pull.pullRequest, reviewCommentId, suggestionIds: ['S30'],
    });
    assert.equal(suggestionsOnly.state, 'posted', JSON.stringify(suggestionsOnly));
    assert.equal(comments.at(-1)!.body.split('\n')[0], '/fix S30');
    assert.equal(suggestionsOnly.result.resolvedHead, head);
    assert.equal(suggestionsOnly.result.headSource, 'server');
    assert.ok(comments.at(-1)!.body.endsWith(`head:${head} -->`));

    const before = posted();
    const empty = await mutate('fix_review_findings', { ...pull, reviewCommentId });
    assert.equal(empty.state, 'failed');
    assert.equal(empty.result.error.code, 'MISSING_INPUT');
    const bothEmpty = await mutate('fix_review_findings', { ...pull, reviewCommentId, findingIds: [], suggestionIds: [] });
    assert.equal(bothEmpty.result.error.code, 'MISSING_INPUT');

    // An identifier the review does not offer is named, never dropped.
    const unknown = await mutate('fix_review_findings', { ...pull, reviewCommentId, findingIds: ['F99'], suggestionIds: ['S9'] });
    assert.equal(unknown.state, 'failed');
    assert.equal(unknown.result.error.code, 'FINDINGS_UNAVAILABLE');
    assert.equal(unknown.result.error.stage, 'precondition');
    assert.deepEqual(unknown.result.error.details.unavailable, [
      { id: 'F99', kind: 'finding', reason: 'not_in_review' },
      { id: 'S9', kind: 'suggestion', reason: 'not_in_review' },
    ]);
    assert.deepEqual(unknown.result.error.details.offeredFindingIds, ['F20', 'F21']);
    assert.ok(unknown.result.error.message.includes('F99'), unknown.result.error.message);
    assert.ok(unknown.result.error.message.includes('S9'), unknown.result.error.message);
    assert.ok(unknown.result.error.message.includes('F20, F21'), unknown.result.error.message);
    assert.ok(unknown.result.error.message.includes('S30, S31, S32, S33, S34'), unknown.result.error.message);

    // A suggestion an earlier run already implemented is no longer selectable.
    redis.consume(`${reviewCommentId}:S:S31`);
    const consumed = await mutate('fix_review_findings', { ...pull, reviewCommentId, suggestionIds: ['S31'] });
    assert.equal(consumed.result.error.code, 'FINDINGS_UNAVAILABLE');
    assert.deepEqual(consumed.result.error.details.unavailable, [{ id: 'S31', kind: 'suggestion', reason: 'consumed' }]);
    assert.ok(consumed.result.error.message.includes('S31'), consumed.result.error.message);

    // A review older than the window /fix reads back offers nothing, and says why.
    const expiredCommentId = 962;
    comments.push({ id: expiredCommentId, repository: 'acme/repo', pullRequest: 42, author: 'propr-dev[bot]',
      createdAt: new Date(Date.now() - 8 * 24 * 3600 * 1000).toISOString(), body: fixtureReviewBody(head) });
    const expired = await mutate('fix_review_findings', { ...pull, reviewCommentId: expiredCommentId, findingIds: ['F20'] });
    assert.equal(expired.result.error.code, 'FINDINGS_UNAVAILABLE');
    assert.deepEqual(expired.result.error.details.unavailable, [{ id: 'F20', kind: 'finding', reason: 'expired' }]);
    assert.ok(expired.result.error.message.includes('seven days'), expired.result.error.message);

    // A namespace mismatch is refused by the schema before anything is posted.
    await assert.rejects(mutate('fix_review_findings', { ...pull, reviewCommentId, findingIds: ['S32'] }));
    await assert.rejects(mutate('fix_review_findings', { ...pull, reviewCommentId, suggestionIds: ['F20'] }));
    await assert.rejects(mutate('fix_review_findings', { ...pull, reviewCommentId, findingIds: ['F0'] }));

    // The head preconditions are unchanged.
    const staleHead = await mutate('fix_review_findings', { ...pull, expectedHead: 'f'.repeat(40), reviewCommentId, findingIds: ['F20'] });
    assert.equal(staleHead.result.error.code, 'STALE_HEAD');
    // A caller pinning the head is still protected against a review of an older one.
    const pinnedOlder = await mutate('fix_review_findings', { ...pull, expectedHead: 'b'.repeat(40), reviewCommentId: staleCommentId, findingIds: ['F20'] });
    assert.equal(pinnedOlder.result.error.code, 'STALE_HEAD');
    const notAReview = await mutate('fix_review_findings', { ...pull, reviewCommentId: plainCommentId, findingIds: ['F20'] });
    assert.equal(notAReview.result.error.code, 'NOT_A_REVIEW');
    assert.equal(notAReview.result.error.details.reviewCommentId, plainCommentId);

    assert.equal(posted(), before, 'no rejected selection may reach GitHub');
  });
}
