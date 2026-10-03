import assert from 'node:assert/strict';
import type { McpPrincipal } from '../../mcp/policy.js';
import { type Args, type WriteFixture, interceptRest } from './mcpPullRequestWrites.js';

type GitHubRequest = (route: string, args: Args) => Promise<unknown>;

/** Let the first comment POST through, fail the second with `error`, and pass every later request. */
function failSecondCommentPost(principal: McpPrincipal, error: Error): void {
  const github = principal.github as unknown as { request: GitHubRequest };
  const next = github.request;
  let posts = 0;
  github.request = async (route, args) => {
    if (route === 'POST /repos/{owner}/{repo}/issues/{issue_number}/comments' && ++posts === 2) {
      github.request = next;
      throw error;
    }
    return next(route, args);
  };
}

/**
 * `review_pull_request` with an explicit reviewing model: one alias, a fan-out
 * across several, per-model rejection, and the guarantees that the pull
 * request's model routing is never touched and every review shares one head.
 */
export async function verifyModelReviews({ t, call, mutate, principal, findPullRequest, restCalls, comments }: WriteFixture): Promise<void> {
  await t.test('review_pull_request reviews with one explicit model without rerouting the pull request', async () => {
    const head = 'a'.repeat(40);
    const live = findPullRequest('acme/repo', 42);
    const labelsBefore = [...live.labels];
    const labelWrites = () => restCalls.filter(item => item.route.includes('/labels')).length;
    const writesBefore = labelWrites();
    const review = await mutate('review_pull_request', { repository: 'acme/repo', pullRequest: 42, expectedHead: head, model: 'gpt-5.6' });
    assert.equal(review.state, 'posted', JSON.stringify(review));
    assert.equal(review.result.model, 'gpt-5.6');
    assert.equal(review.result.agentAlias, 'codex');
    assert.equal(review.result.resolvedModel, 'gpt-5.6');
    assert.equal(review.result.resolvedHead, head);
    assert.equal(review.result.headSource, 'caller');
    assert.equal(review.result.reviews.length, 1);
    assert.equal(review.result.reviews[0].commentId, review.result.commentId);
    const stored = comments.find(comment => comment.id === review.result.commentId)!;
    assert.equal(stored.body.split('\n')[0], '/review gpt-5.6');
    assert.ok(stored.body.endsWith(`head:${head} -->`));
    // The PR stays routed to its own model: no label is read or written.
    assert.deepEqual(live.labels, labelsBefore);
    assert.equal(labelWrites(), writesBefore);
  });

  await t.test('review_pull_request fans out one independent review per listed model', async () => {
    const head = 'a'.repeat(40);
    const live = findPullRequest('acme/repo', 42);
    const labelsBefore = [...live.labels];
    const labelWrites = () => restCalls.filter(item => item.route.includes('/labels')).length;
    const writesBefore = labelWrites();
    const pullReads = () => restCalls.filter(item => item.route === 'GET /repos/{owner}/{repo}/pulls/{pull_number}').length;
    const readsBefore = pullReads();
    const posted = comments.length;
    const fanOut = await mutate('review_pull_request', {
      repository: 'acme/repo', pullRequest: 42, expectedHead: head, model: ['claude-opus-5', 'gpt-5.6'], instructions: 'Focus on error handling.',
    });
    assert.equal(fanOut.state, 'posted', JSON.stringify(fanOut));
    assert.equal(fanOut.result.resolvedHead, head);
    // With several models there is no single comment to point at.
    assert.equal(fanOut.result.commentId, undefined);
    const { reviews } = fanOut.result;
    assert.deepEqual(reviews.map((review: Args) => [review.model, review.agentAlias, review.resolvedModel, review.state]),
      [['claude-opus-5', 'claude', 'claude-opus-5', 'posted'], ['gpt-5.6', 'codex', 'gpt-5.6', 'posted']]);
    assert.notEqual(reviews[0].commentId, reviews[1].commentId);
    for (const review of reviews) {
      assert.equal(review.resolvedHead, head);
      assert.equal(review.expectedHead, head);
      assert.ok(review.url.includes('#issuecomment-'));
      const stored = comments.find(comment => comment.id === review.commentId)!;
      assert.equal(stored.body.split('\n')[0], `/review ${review.model}`);
      assert.ok(stored.body.includes('\n\nFocus on error handling.\n\n<!-- propr-mcp:'));
      assert.ok(stored.body.endsWith(`head:${head} -->`));
    }
    assert.equal(comments.length - posted, 2);
    assert.equal(pullReads() - readsBefore, 2, 'every review after the first re-checks the head');
    assert.deepEqual(live.labels, labelsBefore);
    assert.equal(labelWrites(), writesBefore);
  });

  await t.test('review_pull_request rejects every invalid model in a list and posts nothing', async () => {
    const pull = { repository: 'acme/repo', pullRequest: 42, expectedHead: 'a'.repeat(40) };
    const posted = comments.length;
    const invalid = await mutate('review_pull_request', { ...pull, model: ['claude-opus-5', 'not-a-real-model', 'claude-haiku-4-5'] });
    assert.equal(invalid.state, 'failed');
    assert.equal(invalid.result.error.code, 'UNKNOWN_MODEL');
    assert.deepEqual(invalid.result.error.details.rejectedModels.map((entry: Args) => [entry.model, entry.code]),
      [['not-a-real-model', 'UNKNOWN_MODEL'], ['claude-haiku-4-5', 'UNKNOWN_MODEL']]);
    assert.ok(invalid.result.error.message.includes('“not-a-real-model”'));
    assert.ok(invalid.result.error.message.includes('“claude-haiku-4-5”'));
    assert.ok(invalid.result.error.message.includes('codex:gpt-5.6'));
    const duplicate = await mutate('review_pull_request', { ...pull, model: ['gpt-5.6', 'gpt-5.6'] });
    assert.equal(duplicate.result.error.code, 'DUPLICATE_MODEL');
    assert.deepEqual(duplicate.result.error.details.rejectedModels.map((entry: Args) => entry.model), ['gpt-5.6']);
    const single = await mutate('review_pull_request', { ...pull, model: 'not-a-real-model' });
    assert.equal(single.result.error.code, 'UNKNOWN_MODEL');
    // A slash command smuggled through instructions is still refused.
    const smuggled = await mutate('review_pull_request', { ...pull, model: 'gpt-5.6', instructions: '/review claude-opus-5' });
    assert.equal(smuggled.result.error.code, 'INVALID_INPUT');
    await assert.rejects(call('review_pull_request', { ...pull, idempotencyKey: 'spaced-model-key', model: 'gpt-5.6 claude-opus-5' }));
    await assert.rejects(call('review_pull_request', { ...pull, idempotencyKey: 'empty-models-key', model: [] }));
    assert.equal(comments.length, posted, 'a rejected model list must not post any review');
  });

  await t.test('a model fan-out stops at a moved head and reports the rest as not posted', async () => {
    const head = 'a'.repeat(40);
    const live = findPullRequest('acme/repo', 42);
    const posted = comments.length;
    // A push lands while the first review is being posted.
    interceptRest(principal, 'POST /repos/{owner}/{repo}/issues/{issue_number}/comments', async () => { live.head = 'b'.repeat(40); });
    const fanOut = await mutate('review_pull_request', { repository: 'acme/repo', pullRequest: 42, model: ['claude-opus-5', 'claude-sonnet-5', 'gpt-5.6'] });
    live.head = head;
    assert.equal(fanOut.state, 'posted', JSON.stringify(fanOut));
    assert.equal(fanOut.result.headSource, 'server');
    const [first, ...rest] = fanOut.result.reviews;
    assert.equal(first.state, 'posted');
    assert.equal(first.resolvedHead, head);
    for (const review of rest) {
      assert.equal(review.state, 'not_posted');
      assert.equal(review.commentId, undefined);
      assert.equal(review.error.code, 'STALE_HEAD');
      assert.deepEqual(review.error.details, { expectedHead: head, currentHead: 'b'.repeat(40) });
    }
    assert.equal(comments.length - posted, 1);
  });

  await t.test('a model fan-out keeps posted receipts when GitHub rejects a later review', async () => {
    const posted = comments.length;
    const limited = Object.assign(new Error('API rate limit exceeded'), { status: 403, response: { headers: { 'x-ratelimit-remaining': '0' }, data: { message: 'API rate limit exceeded' } } });
    failSecondCommentPost(principal, limited);
    const fanOut = await mutate('review_pull_request', { repository: 'acme/repo', pullRequest: 42, model: ['claude-opus-5', 'claude-sonnet-5', 'gpt-5.6'] });
    assert.equal(fanOut.state, 'posted', JSON.stringify(fanOut));
    const [first, failed, rest] = fanOut.result.reviews;
    assert.equal(first.state, 'posted');
    assert.ok(comments.some(comment => comment.id === first.commentId));
    assert.equal(failed.state, 'rejected');
    assert.equal(failed.commentId, undefined);
    assert.equal(failed.error.code, 'GITHUB_RATE_LIMITED');
    assert.equal(rest.state, 'not_posted');
    assert.equal(rest.error.code, 'PREVIOUS_REVIEW_NOT_POSTED');
    assert.equal(comments.length - posted, 1, 'nothing is posted after the failed review');
  });

  await t.test('a model fan-out reports an uncertain later post as unknown without retrying it', async () => {
    const posted = comments.length;
    const postsBefore = restCalls.filter(item => item.route.startsWith('POST ')).length;
    failSecondCommentPost(principal, Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }));
    const fanOut = await mutate('review_pull_request', { repository: 'acme/repo', pullRequest: 42, model: ['claude-opus-5', 'gpt-5.6'] });
    assert.equal(fanOut.state, 'posted', JSON.stringify(fanOut));
    const [first, uncertain] = fanOut.result.reviews;
    assert.equal(first.state, 'posted');
    assert.equal(uncertain.state, 'unknown');
    assert.equal(uncertain.error.code, 'OUTCOME_UNKNOWN');
    assert.equal(uncertain.error.cause.code, 'UPSTREAM_UNREACHABLE');
    assert.equal(comments.length - posted, 1);
    assert.equal(restCalls.filter(item => item.route.startsWith('POST ')).length - postsBefore, 1, 'the uncertain post is not retried');
  });
}
