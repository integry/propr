import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, mock, test } from 'node:test';

let summaryScores: Array<{ path: string; score: number }> = [];
let summaryError: Error | null = null;
const scoreSemanticRelevance = mock.fn(async () => {
  if (summaryError) throw summaryError;
  return summaryScores;
});

await mock.module('../src/services/relevance/semanticScorer.js', { namedExports: { scoreSemanticRelevance } });
await mock.module('../src/db/connection.js', {
  namedExports: { db: () => { throw new Error('db should not be used'); }, closeConnection: async () => {} },
});
const silentLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
await mock.module('../src/utils/logger.js', {
  defaultExport: { ...silentLogger, withCorrelation: () => silentLogger },
});

const { findRelevantFiles } = await import('../src/services/relevanceService.js');

// --- Fixture: `main` is checked out, `feature` holds different files and history ---

const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'relevance-commit-'));
const git = (...args: string[]) => execFileSync('git', args, { cwd: repoPath, encoding: 'utf8' }).trim();
const write = (file: string, content: string) => {
  fs.mkdirSync(path.dirname(path.join(repoPath, file)), { recursive: true });
  fs.writeFileSync(path.join(repoPath, file), content);
};

git('init', '-q', '-b', 'main');
git('config', 'user.email', 'test@example.com');
git('config', 'user.name', 'Test');
git('config', 'commit.gpgsign', 'false');
write('src/widget/main.ts', 'export {};\n');
git('add', '-A');
git('commit', '-q', '-m', 'initial');
git('checkout', '-q', '-b', 'feature');
write('src/widget/featureOnly.ts', 'export {};\n');
git('add', '-A');
git('commit', '-q', '-m', 'add widget feature');
const featureCommit = git('rev-parse', 'HEAD');
git('checkout', '-q', 'main');
write('src/widget/mainOnly.ts', 'export {};\n');
git('add', '-A');
git('commit', '-q', '-m', 'add widget main');

after(() => fs.rmSync(repoPath, { recursive: true, force: true }));

beforeEach(() => {
  summaryScores = [];
  summaryError = null;
});

const agent = { config: { alias: 'claude' } } as never;

test('commit-scoped relevance scores the commit tree and history, not the checkout', async () => {
  const result = await findRelevantFiles(repoPath, 'widget', { commit: featureCommit });
  const paths = result.files.map(file => file.path).sort();

  assert.deepEqual(paths, ['src/widget/featureOnly.ts', 'src/widget/main.ts']);
  const featureOnly = result.files.find(file => file.path === 'src/widget/featureOnly.ts');
  assert.deepEqual(featureOnly?.signals?.slice().sort(), ['git-history', 'path-match']);
  // Unscoped scoring still reflects the checkout.
  const unscoped = await findRelevantFiles(repoPath, 'widget');
  assert.ok(unscoped.files.some(file => file.path === 'src/widget/mainOnly.ts'));
});

test('commit-scoped relevance drops summary candidates absent from the commit tree', async () => {
  summaryScores = [
    { path: 'src/widget/mainOnly.ts', score: 100 },
    { path: 'src/widget/featureOnly.ts', score: 90 },
  ];

  const result = await findRelevantFiles(repoPath, 'widget', { commit: featureCommit, useSummaryScoring: true, agent });

  assert.ok(!result.files.some(file => file.path === 'src/widget/mainOnly.ts'));
  assert.ok(result.files.some(file => file.path === 'src/widget/featureOnly.ts' && file.signals?.includes('semantic')));
  assert.equal(result.usedSummaryScoring, true);
});

test('usedSummaryScoring reports whether summaries actually contributed', async () => {
  summaryError = new Error('model unavailable');
  const failed = await findRelevantFiles(repoPath, 'widget', { commit: featureCommit, useSummaryScoring: true, agent });
  assert.equal(failed.usedSummaryScoring, false);
  assert.ok(failed.files.length > 0);

  summaryError = null;
  summaryScores = [{ path: 'src/widget/mainOnly.ts', score: 100 }];
  const onlyAbsent = await findRelevantFiles(repoPath, 'widget', { commit: featureCommit, useSummaryScoring: true, agent });
  assert.equal(onlyAbsent.usedSummaryScoring, false);
});

test('maxResults of Infinity returns every file above the threshold', async () => {
  summaryScores = Array.from({ length: 600 }, (_, i) => ({ path: `generated/file${i}.ts`, score: 80 }));

  const capped = await findRelevantFiles(repoPath, 'widget', { useSummaryScoring: true, agent });
  assert.equal(capped.files.length, 500);

  const all = await findRelevantFiles(repoPath, 'widget', { useSummaryScoring: true, agent, maxResults: Number.POSITIVE_INFINITY });
  assert.equal(all.files.filter(file => file.path.startsWith('generated/')).length, 600);
});
