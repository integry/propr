import assert from 'node:assert/strict';
import { reanchorFixRecords } from '../../mcp/fixReanchor.js';
import { reanchorPrincipal } from './mcpFixReanchor.js';
import { type WriteFixture, fixtureReviewBody } from './mcpPullRequestWrites.js';

/**
 * A deleted file alone does not show a finding's code is gone: it may have moved
 * into a file the review never named, so the finding stays applied.
 */
export async function verifyFixRelocation({ t, mutate, comments, comparisons, trees }: WriteFixture): Promise<void> {
  await t.test('a deleted citation does not withhold a record while its code may have moved elsewhere', async () => {
    const target = { repository: 'acme/repo', reviewedHead: 'e'.repeat(40), head: 'a'.repeat(40) };
    const records = [{ id: 'F1', kind: 'finding' as const, text: 'src/lease.ts:9 — the helper skips the ownership check.' }];
    const tree = ['src/worker.ts', 'src/config.ts'];
    const lease = { filename: 'src/lease.ts', status: 'removed' };
    const run = async (files: Array<{ filename: string; status: string; additions?: number }>) =>
      reanchorFixRecords(reanchorPrincipal(files, tree), target, records);

    // The helper moved into an existing, uncited file that gained lines.
    const moved = await run([lease, { filename: 'src/worker.ts', status: 'modified', additions: 12 }]);
    assert.deepEqual(moved.applied, [{ id: 'F1', kind: 'finding', touchedPaths: ['src/lease.ts'] }]);
    assert.deepEqual(moved.skipped, []);
    // A new file, or a modification whose addition count is unknown, may hold it too.
    assert.deepEqual((await run([lease, { filename: 'src/lease/owner.ts', status: 'added', additions: 30 }])).skipped, []);
    assert.deepEqual((await run([lease, { filename: 'src/worker.ts', status: 'modified' }])).skipped, []);
    // A comparison GitHub may have cut short can hide the destination.
    const many = Array.from({ length: 299 }, (_, index) => ({ filename: `old/${index}.ts`, status: 'removed' }));
    assert.deepEqual((await run([lease, ...many])).skipped, []);

    // Only when no surviving file gained a line is the deletion evidence enough.
    const gone = await run([lease, { filename: 'src/worker.ts', status: 'modified', additions: 0 }]);
    assert.deepEqual(gone.skipped, [{ id: 'F1', kind: 'finding', reason: 'code_removed', removedPaths: ['src/lease.ts'] }]);
    assert.deepEqual((await run([lease, ...many.slice(1)])).skipped.map(record => record.id), ['F1']);
  });

  await t.test('fix_review_findings posts a finding whose code moved into an existing uncited file, alone or mixed', async () => {
    const head = 'a'.repeat(40);
    const reviewedHead = 'b'.repeat(40);
    const pull = { repository: 'acme/repo', pullRequest: 42 };
    const reviewCommentId = 975;
    comments.push({ id: reviewCommentId, repository: 'acme/repo', pullRequest: 42, author: 'propr-dev[bot]',
      createdAt: new Date().toISOString(), body: fixtureReviewBody(reviewedHead) });
    // F21 cites only src/lease.ts; its helper now lives in src/worker.ts, which no record names.
    comparisons.set(`${reviewedHead}...${head}`, [
      { filename: 'src/lease.ts', status: 'removed' },
      { filename: 'src/worker.ts', status: 'modified', additions: 14 } as { filename: string; status: string },
    ]);
    trees.set(head, ['src/config.ts', 'src/worker.ts', 'README.md']);

    const alone = await mutate('fix_review_findings', { ...pull, reviewCommentId, findingIds: ['F21'] });
    assert.equal(alone.state, 'posted', JSON.stringify(alone));
    assert.equal(comments.at(-1)!.body.split('\n')[0], '/fix F21');
    assert.deepEqual(alone.result.applied, [{ id: 'F21', kind: 'finding', touchedPaths: ['src/lease.ts'] }]);
    assert.deepEqual(alone.result.skipped, []);
    const mixed = await mutate('fix_review_findings', { ...pull, reviewCommentId, findingIds: ['F20', 'F21'] });
    assert.equal(mixed.state, 'posted', JSON.stringify(mixed));
    assert.equal(comments.at(-1)!.body.split('\n')[0], '/fix F20 F21');
    assert.deepEqual(mixed.result.findingIds, ['F20', 'F21']);
    assert.deepEqual(mixed.result.skipped, []);
    comparisons.delete(`${reviewedHead}...${head}`);
    trees.delete(head);
  });
}
