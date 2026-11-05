import assert from 'node:assert/strict';
import type { McpPrincipal } from '../../mcp/policy.js';
import { citedPaths, hasUnparsedPath, reanchorFixRecords } from '../../mcp/fixReanchor.js';
import { type Args, type WriteFixture, fixtureReviewBody } from './mcpPullRequestWrites.js';

/**
 * `fix_review_findings` against a review of an older head: like a hand-typed /fix,
 * it runs on the current head and only drops records whose cited code is gone.
 */
/** A principal whose comparison reports `files` and whose head tree holds `tree`; a null tree is unreadable. */
export function reanchorPrincipal(files: Array<{ filename: string; status: string; additions?: number }>, tree: string[] | null): McpPrincipal {
  const request = async (route: string) => {
    if (route === 'GET /repos/{owner}/{repo}/compare/{basehead}') return { data: { files } };
    if (tree) return { data: { truncated: false, tree: tree.map(path => ({ path, type: 'blob' })) } };
    throw Object.assign(new Error('Not Found'), { status: 404 });
  };
  return { github: { request } } as unknown as McpPrincipal;
}

export async function verifyFixReanchor({ t, call, mutate, comments, comparisons, trees }: WriteFixture): Promise<void> {
  await t.test('fix_review_findings re-anchors a review of an older head instead of refusing it', async () => {
    const head = 'a'.repeat(40);
    const reviewedHead = 'e'.repeat(40);
    const pull = { repository: 'acme/repo', pullRequest: 42 };
    const reviewCommentId = 970;
    comments.push({ id: reviewCommentId, repository: 'acme/repo', pullRequest: 42, author: 'propr-dev[bot]',
      createdAt: new Date().toISOString(), body: fixtureReviewBody(reviewedHead) });
    const posted = () => comments.filter(comment => comment.body.startsWith('/fix')).length;
    trees.set(head, ['src/config.ts', 'README.md', 'package.json']);

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

    // Pinning the PR head pins the PR, not the review: a current expectedHead with
    // a review of an older head still proceeds, as a hand-typed /fix would.
    const pinnedCurrent = await mutate('fix_review_findings', { ...pull, expectedHead: head, reviewCommentId, findingIds: ['F20'] });
    assert.equal(pinnedCurrent.state, 'posted', JSON.stringify(pinnedCurrent));
    assert.equal(comments.at(-1)!.body.split('\n')[0], '/fix F20');
    assert.equal(pinnedCurrent.result.headSource, 'caller');
    assert.equal(pinnedCurrent.result.reviewedHead, reviewedHead);
    assert.equal(pinnedCurrent.result.reanchored, true);

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
    assert.equal(gone.result.error.code, 'FINDINGS_CODE_REMOVED');
    assert.equal(gone.result.error.stage, 'precondition');
    assert.equal(gone.result.error.details.reviewedHead, reviewedHead);
    assert.equal(gone.result.error.details.currentHead, head);
    assert.deepEqual(gone.result.error.details.skipped.map((record: Args) => record.id), ['F21']);

    // An explicit expectedHead that does not match is still refused outright.
    const pinned = await mutate('fix_review_findings', { ...pull, expectedHead: reviewedHead, reviewCommentId, findingIds: ['F20'] });
    assert.equal(pinned.result.error.code, 'STALE_HEAD');
    assert.equal(posted(), before, 'a refused selection may not reach GitHub');

    // Without the current tree, withholding F21 rests on incomplete evidence, so it is kept.
    trees.delete(head);
    const uncertain = await mutate('fix_review_findings', { ...pull, reviewCommentId, findingIds: ['F21'] });
    assert.equal(uncertain.state, 'posted', JSON.stringify(uncertain));
    assert.deepEqual(uncertain.result.findingIds, ['F21']);
    assert.deepEqual(uncertain.result.skipped, []);
    trees.set(head, ['src/config.ts', 'README.md', 'package.json']);

    // An unreadable comparison (e.g. a force-pushed review head) does not block the fix.
    comparisons.delete(`${reviewedHead}...${head}`);
    const unverified = await mutate('fix_review_findings', { ...pull, reviewCommentId, findingIds: ['F21'] });
    assert.equal(unverified.state, 'posted', JSON.stringify(unverified));
    assert.equal(unverified.result.comparison, 'unavailable');
    assert.deepEqual(unverified.result.findingIds, ['F21']);
    trees.delete(head);
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
    const principal = reanchorPrincipal([{ filename: 'src/old.ts', status: 'removed' }], ['src/config.ts', 'Makefile']);
    const target = { repository: 'acme/repo', reviewedHead: 'd'.repeat(40), head: 'a'.repeat(40) };
    const report = await reanchorFixRecords(principal, target, [
      { id: 'F1', kind: 'finding', text: 'Title\nRequirement\nsrc/old.ts:4 is wrong\nThis PR added Makefile targets that call it.\nFix it' },
      { id: 'F2', kind: 'finding', text: 'Title\nRequirement\nsrc/old.ts:9 is wrong\nIntroduced here.\nFix it' },
    ]);
    assert.deepEqual(report.applied, [{ id: 'F1', kind: 'finding', touchedPaths: ['src/old.ts'] }]);
    assert.deepEqual(report.skipped, [{ id: 'F2', kind: 'finding', reason: 'code_removed', removedPaths: ['src/old.ts'] }]);
  });

  await t.test('a surviving Markdown-emphasised citation keeps a record whose other citation was deleted', async () => {
    assert.deepEqual(citedPaths('`legacy/package.json` and **Dockerfile** both pin Node 14.'), ['legacy/package.json', 'Dockerfile']);
    assert.deepEqual(citedPaths('See *src/app/[slug]/page.tsx:12*, ***Makefile*** and **.env**.'), ['src/app/[slug]/page.tsx', 'Makefile', '.env']);

    const principal = reanchorPrincipal([{ filename: 'legacy/package.json', status: 'removed' }], ['Dockerfile', 'package.json']);
    const target = { repository: 'acme/repo', reviewedHead: 'd'.repeat(40), head: 'a'.repeat(40) };
    const report = await reanchorFixRecords(principal, target, [
      { id: 'F1', kind: 'finding', text: 'Drop the unsupported runtime pin\nBuild on a supported runtime.\n`legacy/package.json` and **Dockerfile** both pin Node 14.\nPin a supported runtime.' },
      { id: 'F2', kind: 'finding', text: 'Drop the unsupported runtime pin\nBuild on a supported runtime.\n**legacy/package.json** pins Node 14.\nPin a supported runtime.' },
    ]);
    assert.deepEqual(report.applied, [{ id: 'F1', kind: 'finding', touchedPaths: ['legacy/package.json'] }]);
    assert.deepEqual(report.skipped, [{ id: 'F2', kind: 'finding', reason: 'code_removed', removedPaths: ['legacy/package.json'] }]);
  });

  await t.test('a surviving bracketed route path keeps a record whose other citation was deleted', async () => {
    assert.deepEqual(citedPaths('src/old.ts and src/app/[slug]/page.tsx: fix both.'), ['src/old.ts', 'src/app/[slug]/page.tsx']);
    assert.deepEqual(
      citedPaths('app/[[...rest]]/page.tsx, app/(marketing)/@modal/layout.tsx and routes/+page.svelte.'),
      ['app/[[...rest]]/page.tsx', 'app/(marketing)/@modal/layout.tsx', 'routes/+page.svelte'],
    );
    // A slash-separated token the extraction cannot fully read keeps the record.
    assert.equal(hasUnparsedPath('src/old.ts and src/{weird}/x.ts', ['src/old.ts']), true);
    assert.equal(hasUnparsedPath('src/old.ts:4 (see ./src/old.ts) is wrong.', ['src/old.ts']), false);

    const principal = reanchorPrincipal([{ filename: 'src/old.ts', status: 'removed' }], ['src/config.ts', 'Makefile']);
    const target = { repository: 'acme/repo', reviewedHead: 'd'.repeat(40), head: 'a'.repeat(40) };
    const report = await reanchorFixRecords(principal, target, [
      { id: 'F1', kind: 'finding', text: 'Title\nRequirement\nsrc/old.ts:4 and `src/app/[slug]/page.tsx:12` both need it\nFix both' },
      { id: 'F2', kind: 'finding', text: 'Title\nRequirement\nsrc/old.ts:9 and src/{weird}/x.ts need it\nFix both' },
      { id: 'F3', kind: 'finding', text: 'Title\nRequirement\nsrc/old.ts:9 is wrong\nFix it' },
    ]);
    assert.deepEqual(report.applied, [
      { id: 'F1', kind: 'finding', touchedPaths: ['src/old.ts'] },
      { id: 'F2', kind: 'finding', touchedPaths: ['src/old.ts'] },
    ]);
    assert.deepEqual(report.skipped, [{ id: 'F3', kind: 'finding', reason: 'code_removed', removedPaths: ['src/old.ts'] }]);
  });

  await t.test('a surviving root-level file no extraction rule recognises keeps a record whose other citation was deleted', async () => {
    // `gradlew` has no slash, no extension and is not a known extensionless name.
    assert.deepEqual(citedPaths('`legacy/bootstrap.sh` and `gradlew` run unverified code.'), ['legacy/bootstrap.sh']);
    assert.equal(hasUnparsedPath('`legacy/bootstrap.sh` and `gradlew` run unverified code.', ['legacy/bootstrap.sh']), true);
    assert.equal(hasUnparsedPath('`legacy/bootstrap.sh:4` and `./configure:12` too.', ['legacy/bootstrap.sh']), true);
    // Recognised names and code identifiers are not unread file citations.
    assert.equal(hasUnparsedPath('`legacy/bootstrap.sh`, `Dockerfile` and `.env` in `citedPaths` (HTTP `409`).', ['legacy/bootstrap.sh', 'Dockerfile', '.env']), false);

    const principal = reanchorPrincipal([{ filename: 'legacy/bootstrap.sh', status: 'removed' }], ['gradlew', 'configure', 'src/fetch.ts']);
    const target = { repository: 'acme/repo', reviewedHead: 'd'.repeat(40), head: 'a'.repeat(40) };
    const report = await reanchorFixRecords(principal, target, [
      { id: 'F1', kind: 'finding', text: 'Verify downloads\nRequirement\n`legacy/bootstrap.sh` and `gradlew` execute downloaded shell code without verifying its checksum.\nFix both' },
      { id: 'F2', kind: 'finding', text: 'Verify downloads\nRequirement\n`legacy/bootstrap.sh:9` and `configure` skip the check.\nFix both' },
      { id: 'F3', kind: 'finding', text: 'Verify downloads\nRequirement\n`legacy/bootstrap.sh:9` skips the check in `fetchScript`.\nFix it' },
    ]);
    assert.deepEqual(report.applied, [
      { id: 'F1', kind: 'finding', touchedPaths: ['legacy/bootstrap.sh'] },
      { id: 'F2', kind: 'finding', touchedPaths: ['legacy/bootstrap.sh'] },
    ]);
    assert.deepEqual(report.skipped, [{ id: 'F3', kind: 'finding', reason: 'code_removed', removedPaths: ['legacy/bootstrap.sh'] }]);
  });

  await t.test('a surviving file named in plain prose or emphasis keeps a record whose other citation was deleted', async () => {
    // Neither form is extracted, and plain prose cannot be told apart from ordinary words.
    const plain = 'legacy/bootstrap.sh and gradlew execute downloaded shell code without verification.';
    const emphasised = '`legacy/bootstrap.sh` and **gradlew** execute downloaded shell code without verifying its checksum.';
    assert.deepEqual(citedPaths(plain), ['legacy/bootstrap.sh']);
    assert.deepEqual(citedPaths(emphasised), ['legacy/bootstrap.sh']);
    assert.equal(hasUnparsedPath(emphasised, ['legacy/bootstrap.sh']), true);
    assert.equal(hasUnparsedPath('`legacy/bootstrap.sh` and _configure_ or ***gradlew:12***.', ['legacy/bootstrap.sh']), true);
    assert.equal(hasUnparsedPath('**legacy/bootstrap.sh** and **Dockerfile** in `citedPaths`.', ['legacy/bootstrap.sh', 'Dockerfile']), false);

    const records = [
      { id: 'F1', kind: 'finding' as const, text: `Verify downloads\nRequirement\n${plain}\nFix both` },
      { id: 'F2', kind: 'finding' as const, text: `Verify downloads\nRequirement\n${emphasised}\nFix both` },
      { id: 'F3', kind: 'finding' as const, text: 'Verify downloads\nRequirement\nlegacy/bootstrap.sh:9 skips the check.\nFix it' },
    ];
    const target = { repository: 'acme/repo', reviewedHead: 'd'.repeat(40), head: 'a'.repeat(40) };
    const removed = [{ filename: 'legacy/bootstrap.sh', status: 'removed' }];
    const report = await reanchorFixRecords(reanchorPrincipal(removed, ['gradlew', 'src/fetch.ts']), target, records);
    assert.deepEqual(report.applied, [
      { id: 'F1', kind: 'finding', touchedPaths: ['legacy/bootstrap.sh'] },
      { id: 'F2', kind: 'finding', touchedPaths: ['legacy/bootstrap.sh'] },
    ]);
    assert.deepEqual(report.skipped, [{ id: 'F3', kind: 'finding', reason: 'code_removed', removedPaths: ['legacy/bootstrap.sh'] }]);

    // Once gradlew is gone too, the plain-prose record is withheld like any other.
    const both = await reanchorFixRecords(reanchorPrincipal(removed, ['src/fetch.ts']), target, records.slice(0, 1));
    assert.deepEqual(both.skipped.map(record => record.id), ['F1']);
    // An unreadable tree leaves applicability uncertain, so nothing is withheld.
    const unread = await reanchorFixRecords(reanchorPrincipal(removed, null), target, records);
    assert.deepEqual(unread.applied.map(record => record.id), ['F1', 'F2', 'F3']);
    assert.deepEqual(unread.skipped, []);
  });

  await t.test('a surviving file name with spaces or non-ASCII letters keeps a record whose other citation was deleted', async () => {
    const spaced = 'legacy/bootstrap.sh and `build wrapper` execute unverified code.';
    assert.deepEqual(citedPaths(spaced), ['legacy/bootstrap.sh']);
    assert.equal(hasUnparsedPath(spaced, ['legacy/bootstrap.sh']), false);
    // A marked bare name in any script is an unread citation, like `gradlew`.
    assert.equal(hasUnparsedPath('`legacy/bootstrap.sh` and `配置` run unverified code.', ['legacy/bootstrap.sh']), true);
    assert.equal(hasUnparsedPath('`legacy/bootstrap.sh` and **créer** run unverified code.', ['legacy/bootstrap.sh']), true);

    const records = [
      { id: 'F1', kind: 'finding' as const, text: `Verify downloads\nRequirement\n${spaced}\nFix both` },
      { id: 'F2', kind: 'finding' as const, text: 'Verify downloads\nRequirement\nlegacy/bootstrap.sh and 配置 execute unverified code.\nFix both' },
      { id: 'F3', kind: 'finding' as const, text: 'Verify downloads\nRequirement\nlegacy/bootstrap.sh calls the build wrappers.\nFix it' },
    ];
    const target = { repository: 'acme/repo', reviewedHead: 'd'.repeat(40), head: 'a'.repeat(40) };
    const removed = [{ filename: 'legacy/bootstrap.sh', status: 'removed' }];
    const report = await reanchorFixRecords(reanchorPrincipal(removed, ['build wrapper', '配置', 'src/fetch.ts']), target, records);
    assert.deepEqual(report.applied, [
      { id: 'F1', kind: 'finding', touchedPaths: ['legacy/bootstrap.sh'] },
      { id: 'F2', kind: 'finding', touchedPaths: ['legacy/bootstrap.sh'] },
    ]);
    // A name is only matched whole: "build wrappers" does not cite `build wrapper`.
    assert.deepEqual(report.skipped, [{ id: 'F3', kind: 'finding', reason: 'code_removed', removedPaths: ['legacy/bootstrap.sh'] }]);

    // Once those files are gone too, the records are withheld like any other.
    const gone = await reanchorFixRecords(reanchorPrincipal(removed, ['src/fetch.ts']), target, records.slice(0, 2));
    assert.deepEqual(gone.skipped.map(record => record.id), ['F1', 'F2']);
  });

  await t.test('a surviving file name that contains a deleted citation keeps its record', async () => {
    const evidence = '`Dockerfile` and `Dockerfile production` both pin an unsupported runtime.';
    assert.deepEqual(citedPaths(evidence), ['Dockerfile']);
    assert.equal(hasUnparsedPath(evidence, ['Dockerfile']), false);

    const records = [
      { id: 'F1', kind: 'finding' as const, text: `Pin a supported runtime\nRequirement\n${evidence}\nFix both` },
      { id: 'F2', kind: 'finding' as const, text: 'Pin a supported runtime\nRequirement\n`legacy/Dockerfile` pins an unsupported runtime.\nFix it' },
    ];
    const target = { repository: 'acme/repo', reviewedHead: 'd'.repeat(40), head: 'a'.repeat(40) };
    const removed = [{ filename: 'Dockerfile', status: 'removed' }, { filename: 'legacy/Dockerfile', status: 'removed' }];
    const report = await reanchorFixRecords(reanchorPrincipal(removed, ['Dockerfile production', 'docker/Dockerfile']), target, records);
    assert.deepEqual(report.applied, [{ id: 'F1', kind: 'finding', touchedPaths: ['Dockerfile'] }]);
    // A tree name found only inside a deleted citation (`Dockerfile` in `legacy/Dockerfile`) does not keep it.
    assert.deepEqual(report.skipped, [{ id: 'F2', kind: 'finding', reason: 'code_removed', removedPaths: ['legacy/Dockerfile'] }]);

    // Once the longer file is gone too, the record is withheld like any other.
    const gone = await reanchorFixRecords(reanchorPrincipal(removed, ['docker/Dockerfile']), target, records.slice(0, 1));
    assert.deepEqual(gone.skipped.map(record => record.id), ['F1']);
  });

  await t.test('fix_review_findings posts a plain-prose or emphasised surviving citation alone or mixed', async () => {
    const head = 'a'.repeat(40);
    const reviewedHead = 'c'.repeat(40);
    const pull = { repository: 'acme/repo', pullRequest: 42 };
    const reviewCommentId = 972;
    comments.push({ id: reviewCommentId, repository: 'acme/repo', pullRequest: 42, author: 'propr-dev[bot]', createdAt: new Date().toISOString(), body: [
      '## 🔍 AI Code Review — Fixture',
      '',
      '## Overall Evaluation',
      'Three blockers.',
      '## Merge blockers',
      'Every finding below was introduced by this PR and must be resolved before merging.',
      '',
      '### F50: 🔴 Verify downloaded scripts',
      '- **Required behavior:** Downloaded shell code must be verified before it runs.',
      '- **Evidence:** legacy/bootstrap.sh and gradlew execute downloaded shell code without verification.',
      '- **Minimum fix:** Check a pinned checksum.',
      '',
      '### F51: 🔴 Verify the wrapper checksum',
      '- **Required behavior:** Downloaded shell code must be verified before it runs.',
      '- **Evidence:** `legacy/bootstrap.sh` and **gradlew** execute downloaded shell code without verifying its checksum.',
      '- **Minimum fix:** Check a pinned checksum.',
      '',
      '### F52: 🔴 Drop the legacy fetch',
      '- **Required behavior:** Downloaded shell code must be verified before it runs.',
      '- **Evidence:** legacy/bootstrap.sh:9 skips the check.',
      '- **Minimum fix:** Check a pinned checksum.',
      '## Suggestions',
      'These are optional follow-ups and are not sent to `/fix`.',
      'No suggestions.',
      '## Score',
      'Score: 4/10',
      `<!-- propr:ai-review model="fixture" head="${reviewedHead}" -->`,
    ].join('\n') });
    comparisons.set(`${reviewedHead}...${head}`, [{ filename: 'legacy/bootstrap.sh', status: 'removed' }]);
    trees.set(head, ['gradlew', 'src/fetch.ts']);

    for (const id of ['F50', 'F51']) {
      const alone = await mutate('fix_review_findings', { ...pull, reviewCommentId, findingIds: [id] });
      assert.equal(alone.state, 'posted', JSON.stringify(alone));
      assert.equal(comments.at(-1)!.body.split('\n')[0], `/fix ${id}`);
      assert.deepEqual(alone.result.skipped, []);
    }
    const mixed = await mutate('fix_review_findings', { ...pull, reviewCommentId, findingIds: ['F50', 'F51', 'F52'] });
    assert.equal(mixed.state, 'posted', JSON.stringify(mixed));
    assert.equal(comments.at(-1)!.body.split('\n')[0], '/fix F50 F51');
    assert.deepEqual(mixed.result.skipped, [{ id: 'F52', kind: 'finding', reason: 'code_removed', removedPaths: ['legacy/bootstrap.sh'] }]);
    comparisons.delete(`${reviewedHead}...${head}`);
    trees.delete(head);
  });

  await t.test('fix_review_findings posts a surviving citation whose file name has a space, alone or mixed', async () => {
    const head = 'a'.repeat(40);
    const reviewedHead = 'c'.repeat(40);
    const pull = { repository: 'acme/repo', pullRequest: 42 };
    const reviewCommentId = 973;
    comments.push({ id: reviewCommentId, repository: 'acme/repo', pullRequest: 42, author: 'propr-dev[bot]', createdAt: new Date().toISOString(), body: [
      '## 🔍 AI Code Review — Fixture',
      '',
      '## Overall Evaluation',
      'Two blockers.',
      '## Merge blockers',
      'Every finding below was introduced by this PR and must be resolved before merging.',
      '',
      '### F60: 🔴 Verify the build wrapper',
      '- **Required behavior:** Downloaded shell code must be verified before it runs.',
      '- **Evidence:** legacy/bootstrap.sh and `build wrapper` execute unverified code.',
      '- **Minimum fix:** Check a pinned checksum.',
      '',
      '### F61: 🔴 Drop the legacy fetch',
      '- **Required behavior:** Downloaded shell code must be verified before it runs.',
      '- **Evidence:** legacy/bootstrap.sh:9 skips the check.',
      '- **Minimum fix:** Check a pinned checksum.',
      '## Suggestions',
      'These are optional follow-ups and are not sent to `/fix`.',
      'No suggestions.',
      '## Score',
      'Score: 4/10',
      `<!-- propr:ai-review model="fixture" head="${reviewedHead}" -->`,
    ].join('\n') });
    comparisons.set(`${reviewedHead}...${head}`, [{ filename: 'legacy/bootstrap.sh', status: 'removed' }]);
    trees.set(head, ['build wrapper', 'src/fetch.ts']);

    const alone = await mutate('fix_review_findings', { ...pull, reviewCommentId, findingIds: ['F60'] });
    assert.equal(alone.state, 'posted', JSON.stringify(alone));
    assert.equal(comments.at(-1)!.body.split('\n')[0], '/fix F60');
    assert.deepEqual(alone.result.skipped, []);
    const mixed = await mutate('fix_review_findings', { ...pull, reviewCommentId, findingIds: ['F60', 'F61'] });
    assert.equal(mixed.state, 'posted', JSON.stringify(mixed));
    assert.equal(comments.at(-1)!.body.split('\n')[0], '/fix F60');
    assert.deepEqual(mixed.result.skipped, [{ id: 'F61', kind: 'finding', reason: 'code_removed', removedPaths: ['legacy/bootstrap.sh'] }]);
    comparisons.delete(`${reviewedHead}...${head}`);
    trees.delete(head);
  });

  await t.test('fix_review_findings posts a surviving file whose name contains a deleted citation, alone or mixed', async () => {
    const head = 'a'.repeat(40);
    const reviewedHead = 'c'.repeat(40);
    const pull = { repository: 'acme/repo', pullRequest: 42 };
    const reviewCommentId = 974;
    comments.push({ id: reviewCommentId, repository: 'acme/repo', pullRequest: 42, author: 'propr-dev[bot]', createdAt: new Date().toISOString(), body: [
      '## 🔍 AI Code Review — Fixture',
      '',
      '## Overall Evaluation',
      'Two blockers.',
      '## Merge blockers',
      'Every finding below was introduced by this PR and must be resolved before merging.',
      '',
      '### F70: 🔴 Pin a supported runtime',
      '- **Required behavior:** Images must use a supported runtime.',
      '- **Evidence:** `Dockerfile` and `Dockerfile production` both pin an unsupported runtime.',
      '- **Minimum fix:** Pin a supported runtime.',
      '',
      '### F71: 🔴 Drop the legacy image',
      '- **Required behavior:** Images must use a supported runtime.',
      '- **Evidence:** `Dockerfile:3` pins an unsupported runtime.',
      '- **Minimum fix:** Pin a supported runtime.',
      '## Suggestions',
      'These are optional follow-ups and are not sent to `/fix`.',
      'No suggestions.',
      '## Score',
      'Score: 4/10',
      `<!-- propr:ai-review model="fixture" head="${reviewedHead}" -->`,
    ].join('\n') });
    comparisons.set(`${reviewedHead}...${head}`, [{ filename: 'Dockerfile', status: 'removed' }]);
    trees.set(head, ['Dockerfile production', 'src/fetch.ts']);

    const alone = await mutate('fix_review_findings', { ...pull, reviewCommentId, findingIds: ['F70'] });
    assert.equal(alone.state, 'posted', JSON.stringify(alone));
    assert.equal(comments.at(-1)!.body.split('\n')[0], '/fix F70');
    assert.deepEqual(alone.result.skipped, []);
    const mixed = await mutate('fix_review_findings', { ...pull, reviewCommentId, findingIds: ['F70', 'F71'] });
    assert.equal(mixed.state, 'posted', JSON.stringify(mixed));
    assert.equal(comments.at(-1)!.body.split('\n')[0], '/fix F70');
    assert.deepEqual(mixed.result.skipped, [{ id: 'F71', kind: 'finding', reason: 'code_removed', removedPaths: ['Dockerfile'] }]);
    comparisons.delete(`${reviewedHead}...${head}`);
    trees.delete(head);
  });
}
