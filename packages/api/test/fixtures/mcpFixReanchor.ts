import assert from 'node:assert/strict';
import type { McpPrincipal } from '../../mcp/policy.js';
import { citedPaths, reanchorFixRecords } from '../../mcp/fixReanchor.js';
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

  await t.test('fix_review_findings keeps a record whose surviving citation is extensionless or outside the evidence', async () => {
    const head = 'a'.repeat(40);
    const reviewedHead = 'd'.repeat(40);
    const pull = { repository: 'acme/repo', pullRequest: 42 };
    const reviewCommentId = 971;
    comments.push({ id: reviewCommentId, repository: 'acme/repo', pullRequest: 42, author: 'propr-dev[bot]', createdAt: new Date().toISOString(), body: [
      '## 🔍 AI Code Review — Fixture',
      '',
      '## Overall Evaluation',
      'Two blockers.',
      '## Merge blockers',
      'Every finding below was introduced by this PR and must be resolved before merging.',
      '',
      '### F40: 🔴 Drop the unsupported runtime pin',
      '- **Required behavior:** Build on a supported Node.js runtime.',
      '- **Evidence:** legacy/package.json and Dockerfile both pin Node 14.',
      '- **Minimum fix:** Pin a supported runtime.',
      '',
      '### F41: 🔴 Keep the worker entrypoint in sync',
      '- **Required behavior:** src/worker.ts must start through the shared bootstrap.',
      '- **Evidence:** legacy/boot.ts:12 — the old bootstrap is still wired in.',
      '- **Minimum fix:** Route startup through the shared bootstrap.',
      '## Suggestions',
      'These are optional follow-ups and are not sent to `/fix`.',
      'No suggestions.',
      '## Score',
      'Score: 5/10',
      `<!-- propr:ai-review model="fixture" head="${reviewedHead}" -->`,
    ].join('\n') });

    // Only one of each record's cited files was deleted; the other still needs the fix.
    comparisons.set(`${reviewedHead}...${head}`, [{ filename: 'legacy/package.json', status: 'removed' }, { filename: 'legacy/boot.ts', status: 'removed' }]);
    const kept = await mutate('fix_review_findings', { ...pull, reviewCommentId, findingIds: ['F40', 'F41'] });
    assert.equal(kept.state, 'posted', JSON.stringify(kept));
    assert.equal(comments.at(-1)!.body.split('\n')[0], '/fix F40 F41');
    assert.deepEqual(kept.result.skipped, []);
    assert.deepEqual(kept.result.applied, [
      { id: 'F40', kind: 'finding', touchedPaths: ['legacy/package.json'] },
      { id: 'F41', kind: 'finding', touchedPaths: ['legacy/boot.ts'] },
    ]);
    comparisons.delete(`${reviewedHead}...${head}`);
  });

  await t.test('citation extraction covers every path form a removed-code skip depends on', async () => {
    assert.deepEqual(citedPaths('legacy/package.json and Dockerfile pin Node 14.'), ['legacy/package.json', 'Dockerfile']);
    assert.deepEqual(citedPaths('docker/entrypoint:3, `.env` and ./scripts/run.sh; see src/config.ts.'), ['docker/entrypoint', '.env', 'scripts/run.sh', 'src/config.ts']);

    // A surviving file cited only in the introduced-by-PR explanation still keeps the record.
    const principal = { github: { request: async () => ({ data: { files: [{ filename: 'src/old.ts', status: 'removed' }] } }) } } as unknown as McpPrincipal;
    const target = { repository: 'acme/repo', reviewedHead: 'd'.repeat(40), head: 'a'.repeat(40) };
    const report = await reanchorFixRecords(principal, target, [
      { id: 'F1', kind: 'finding', text: 'Title\nRequirement\nsrc/old.ts:4 is wrong\nThis PR added Makefile targets that call it.\nFix it' },
      { id: 'F2', kind: 'finding', text: 'Title\nRequirement\nsrc/old.ts:9 is wrong\nIntroduced here.\nFix it' },
    ]);
    assert.deepEqual(report.applied, [{ id: 'F1', kind: 'finding', touchedPaths: ['src/old.ts'] }]);
    assert.deepEqual(report.skipped, [{ id: 'F2', kind: 'finding', reason: 'code_removed', removedPaths: ['src/old.ts'] }]);
  });
}
