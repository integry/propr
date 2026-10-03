import assert from 'node:assert/strict';
import { type Args, type WriteFixture, fixtureReviewBody } from './mcpPullRequestWrites.js';

/**
 * `fix_review_findings` against a review of an older head: like a hand-typed /fix,
 * it runs on the current head and only drops records whose cited code is gone.
 */
export async function verifyFixReanchor({ t, call, mutate, comments, comparisons }: WriteFixture): Promise<void> {
  await t.test('fix_review_findings re-anchors a review of an older head instead of refusing it', async () => {
    const head = 'a'.repeat(40);
    const reviewedHead = 'e'.repeat(40);
    const pull = { repository: 'acme/repo', pullRequest: 42 };
    const reviewCommentId = 970;
    comments.push({ id: reviewCommentId, repository: 'acme/repo', pullRequest: 42, author: 'propr-dev[bot]',
      createdAt: new Date().toISOString(), body: fixtureReviewBody(reviewedHead) });
    const posted = () => comments.filter(comment => comment.body.startsWith('/fix')).length;

    // The discussion still says the review is not for the current head, but its
    // records remain selectable, as they are for a hand-typed /fix.
    const inspected = await call('get_pull_request_discussion', { ...pull, commentId: reviewCommentId });
    assert.equal(inspected.comments[0].review.matchesCurrentHead, false);
    assert.deepEqual(inspected.comments[0].review.currentFindingIds, []);
    assert.deepEqual(inspected.comments[0].review.selectableFindingIds, ['F20', 'F21']);

    // Head moved, every finding still applies: the fix proceeds on the current head.
    comparisons.set(`${reviewedHead}...${head}`, [{ filename: 'src/config.ts', status: 'modified' }, { filename: 'README.md', status: 'modified' }]);
    const moved = await mutate('fix_review_findings', { ...pull, reviewCommentId, findingIds: ['F20', 'F21'], suggestionIds: ['S30'] });
    assert.equal(moved.state, 'posted', JSON.stringify(moved));
    assert.equal(comments.at(-1)!.body.split('\n')[0], '/fix F20 F21 S30');
    assert.ok(comments.at(-1)!.body.endsWith(`head:${head} -->`));
    assert.equal(moved.result.resolvedHead, head);
    assert.equal(moved.result.reviewedHead, reviewedHead);
    assert.equal(moved.result.reanchored, true);
    assert.equal(moved.result.comparison, 'compared');
    assert.deepEqual(moved.result.findingIds, ['F20', 'F21']);
    assert.deepEqual(moved.result.suggestionIds, ['S30']);
    assert.deepEqual(moved.result.applied, [
      { id: 'F20', kind: 'finding', touchedPaths: ['src/config.ts'] },
      { id: 'F21', kind: 'finding', touchedPaths: [] },
      { id: 'S30', kind: 'suggestion', touchedPaths: [] },
    ]);
    assert.deepEqual(moved.result.skipped, []);

    // Head moved and the code F21 cites was deleted: F20 is posted, F21 is reported.
    comparisons.set(`${reviewedHead}...${head}`, [{ filename: 'src/lease.ts', status: 'removed' }]);
    const partial = await mutate('fix_review_findings', { ...pull, reviewCommentId, findingIds: ['F20', 'F21'] });
    assert.equal(partial.state, 'posted', JSON.stringify(partial));
    assert.equal(comments.at(-1)!.body.split('\n')[0], '/fix F20');
    assert.deepEqual(partial.result.findingIds, ['F20']);
    assert.deepEqual(partial.result.applied, [{ id: 'F20', kind: 'finding', touchedPaths: [] }]);
    assert.deepEqual(partial.result.skipped, [{ id: 'F21', kind: 'finding', reason: 'code_removed', removedPaths: ['src/lease.ts'] }]);

    // Nothing selected still applies, so there is no /fix to post.
    const before = posted();
    const gone = await mutate('fix_review_findings', { ...pull, reviewCommentId, findingIds: ['F21'] });
    assert.equal(gone.state, 'failed');
    assert.equal(gone.result.error.code, 'STALE_FINDINGS');
    assert.equal(gone.result.error.details.reviewedHead, reviewedHead);
    assert.equal(gone.result.error.details.currentHead, head);
    assert.deepEqual(gone.result.error.details.skipped.map((record: Args) => record.id), ['F21']);

    // An explicit expectedHead that does not match is still refused outright.
    const pinned = await mutate('fix_review_findings', { ...pull, expectedHead: reviewedHead, reviewCommentId, findingIds: ['F20'] });
    assert.equal(pinned.result.error.code, 'STALE_HEAD');
    assert.equal(posted(), before, 'a refused selection may not reach GitHub');

    // An unreadable comparison (e.g. a force-pushed review head) does not block the fix.
    comparisons.delete(`${reviewedHead}...${head}`);
    const unverified = await mutate('fix_review_findings', { ...pull, reviewCommentId, findingIds: ['F21'] });
    assert.equal(unverified.state, 'posted', JSON.stringify(unverified));
    assert.equal(unverified.result.comparison, 'unavailable');
    assert.deepEqual(unverified.result.findingIds, ['F21']);
  });
}
