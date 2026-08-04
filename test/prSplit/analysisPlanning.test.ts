import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  buildSplitCandidates,
  validateSplitCandidate,
} from '../../packages/core/src/services/prSplit/candidatePlanner.js';
import { readPrSnapshot, type PrSnapshotClient } from '../../packages/core/src/services/prSplit/prSnapshot.js';
import { createSplitPlan } from '../../packages/core/src/services/prSplit/splitPlanner.js';
import type { PrSnapshot, PrSnapshotFile } from '../../packages/core/src/services/prSplit/types.js';

function file(
  filename: string,
  patch = '@@ -0,0 +1 @@\n+export const changed = true;',
): PrSnapshotFile {
  return {
    filename,
    previousFilename: null,
    status: 'modified',
    additions: 1,
    deletions: 0,
    changes: 1,
    patch,
    sha: null,
  };
}

function snapshot(overrides: Partial<PrSnapshot> = {}): PrSnapshot {
  const changedFiles = [
    file('src/auth/service.ts', '@@\n+import type { AuthConfig } from "./types";\n+export function authenticate(config: AuthConfig) {}'),
    file('src/auth/types.ts', '@@\n+export interface AuthConfig { token: string }'),
    file('src/auth/service.test.ts', '@@\n+import { authenticate } from "./service";\n+test("authentication", () => {})'),
    file('src/ui/button.tsx'),
    file('src/analytics/track.ts'),
  ];
  return {
    owner: 'integry',
    repo: 'propr',
    pullNumber: 42,
    baseRef: 'main',
    baseSha: 'a'.repeat(40),
    headRef: 'feature',
    headSha: 'b'.repeat(40),
    sourceHeadRepository: {
      owner: 'integry',
      name: 'propr',
      fullName: 'integry/propr',
      cloneUrl: 'https://github.com/integry/propr.git',
      defaultBranch: 'main',
      private: false,
    },
    title: 'Mixed feature work',
    body: '',
    commits: [
      {
        sha: '1'.repeat(40),
        message: 'Add authentication service and tests',
        title: 'Add authentication service and tests',
        authoredAt: null,
        committedAt: null,
        parents: [],
        files: changedFiles.slice(0, 3).map(item => item.filename),
      },
      {
        sha: '2'.repeat(40),
        message: 'Update UI and analytics',
        title: 'Update UI and analytics',
        authoredAt: null,
        committedAt: null,
        parents: [],
        files: changedFiles.slice(3).map(item => item.filename),
      },
    ],
    changedFiles,
    unifiedDiff: 'diff --git a/src/auth/service.ts b/src/auth/service.ts',
    ...overrides,
  };
}

describe('PR split snapshot', () => {
  test('reads and normalizes metadata, commits, files, and unified diff', async () => {
    const calls: Array<{ route: string; parameters: Record<string, unknown> }> = [];
    const client: PrSnapshotClient = {
      async request(route, parameters) {
        calls.push({ route, parameters });
        if (route.endsWith('/files')) {
          return { data: [{
            filename: 'src/new.ts',
            previous_filename: 'src/old.ts',
            status: 'renamed',
            additions: 2,
            deletions: 1,
            changes: 3,
            patch: '@@ rename',
            sha: 'ABCDEF',
          }] };
        }
        if (route.endsWith('/commits')) {
          return { data: [{
            sha: 'FEDCBA',
            commit: {
              message: 'Rename implementation\n\nDetails',
              author: { date: '2026-08-04T00:00:00Z' },
              committer: { date: '2026-08-04T00:01:00Z' },
            },
            parents: [{ sha: 'AAAA' }],
            files: [{ filename: 'src/new.ts' }],
          }] };
        }
        if (parameters.mediaType) return { data: 'diff --git a/src/old.ts b/src/new.ts' };
        return { data: {
          title: 'Rename implementation',
          body: null,
          base: { ref: 'main', sha: 'ABC123' },
          head: {
            ref: 'rename',
            sha: 'DEF456',
            repo: {
              name: 'fork',
              full_name: 'contributor/fork',
              clone_url: 'https://github.com/contributor/fork.git',
              default_branch: 'main',
              private: false,
              owner: { login: 'contributor' },
            },
          },
        } };
      },
    };

    const result = await readPrSnapshot({ owner: 'integry', repo: 'propr', pullNumber: 7, octokit: client });

    assert.equal(result.baseSha, 'abc123');
    assert.equal(result.headSha, 'def456');
    assert.equal(result.body, '');
    assert.equal(result.sourceHeadRepository?.fullName, 'contributor/fork');
    assert.deepEqual(result.changedFiles[0], {
      filename: 'src/new.ts',
      previousFilename: 'src/old.ts',
      status: 'renamed',
      additions: 2,
      deletions: 1,
      changes: 3,
      patch: '@@ rename',
      sha: 'abcdef',
    });
    assert.deepEqual(result.commits[0].files, ['src/new.ts']);
    assert.equal(result.commits[0].title, 'Rename implementation');
    assert.equal(result.unifiedDiff, 'diff --git a/src/old.ts b/src/new.ts');
    assert.ok(calls.some(call => call.parameters.mediaType !== undefined));
  });
});

describe('deterministic split candidates', () => {
  test('ranks a cohesive tested unit above an unrelated smaller scope', () => {
    const candidates = buildSplitCandidates(snapshot());
    assert.deepEqual(candidates[0].includedFiles, [
      'src/auth/service.test.ts',
      'src/auth/service.ts',
      'src/auth/types.ts',
    ]);
    assert.equal(candidates[0].safeToCreatePr, true);
  });

  test('ranks instruction-matching authentication paths before UI and analytics work', () => {
    const candidates = buildSplitCandidates(snapshot(), 'extract authentication changes');
    assert.equal(candidates[0].kind, 'instruction');
    assert.ok(candidates[0].includedFiles.every(path => path.includes('/auth/')));
    assert.ok(candidates[0].instructionMatchScore > 0);
  });

  test('rejects generated-only scopes', () => {
    const generated = file('dist/client.generated.js');
    const source = file('src/client.ts');
    const input = snapshot({
      changedFiles: [generated, source],
      commits: [
        { sha: '3'.repeat(40), message: 'Build output', title: 'Build output', authoredAt: null, committedAt: null, parents: [], files: [generated.filename] },
        { sha: '4'.repeat(40), message: 'Source', title: 'Source', authoredAt: null, committedAt: null, parents: [], files: [source.filename] },
      ],
    });
    const candidate = buildSplitCandidates(input).find(item => item.includedFiles.includes(generated.filename));
    assert.ok(candidate);
    assert.equal(candidate.rejected, true);
    assert.match(candidate.rejectionReasons.join(' '), /only generated artifacts/i);
  });

  test('marks tests or implementation unsafe when required changed companions are omitted', () => {
    const input = snapshot();
    const testOnly = validateSplitCandidate(input, ['src/auth/service.test.ts']);
    assert.equal(testOnly.rejected, true);
    assert.match(testOnly.rejectionReasons.join(' '), /depends on changed files|without their changed implementation/i);

    const implementationOnly = validateSplitCandidate(input, ['src/auth/service.ts']);
    assert.equal(implementationOnly.rejected, true);
    assert.match(implementationOnly.rejectionReasons.join(' '), /src\/auth\/types\.ts/);

    const implementation = file('src/users/create.ts', '@@\n+await db.insert("users", record);');
    const migration = file('migrations/20260804_create_users.sql', '@@\n+CREATE TABLE users (id INTEGER);');
    const migrationInput = snapshot({ changedFiles: [implementation, migration], commits: [] });
    const missingMigration = validateSplitCandidate(migrationInput, [implementation.filename]);
    assert.equal(missingMigration.rejected, true);
    assert.match(missingMigration.rejectionReasons.join(' '), /create_users\.sql/);
  });
});

describe('split planner', () => {
  test('always returns the required complete plan fields', async () => {
    const plan = await createSplitPlan(snapshot());
    assert.ok(plan.selectedSummary);
    assert.ok(plan.includedFiles.length > 0);
    assert.ok(plan.excludedScope.length > 0);
    assert.ok(plan.validationPlan);
    assert.equal(plan.safeToCreatePr, true);
    assert.equal(plan.preserveSourceDiff, true);
  });

  test('fails closed on malformed or file-inventing planner responses', async () => {
    const malformed = await createSplitPlan(snapshot(), {
      judge: async () => 'not JSON',
    });
    assert.equal(malformed.safeToCreatePr, false);
    assert.match(malformed.failureReason ?? '', /failed closed.*valid JSON/i);
    assert.deepEqual(malformed.includedFiles, []);

    const invented = await createSplitPlan(snapshot(), {
      judge: async ({ candidates }) => ({
        candidateId: candidates[0].id,
        includedFiles: [...candidates[0].includedFiles, 'src/invented.ts'],
      }),
    });
    assert.equal(invented.safeToCreatePr, false);
    assert.match(invented.failureReason ?? '', /invents files/i);
  });
});
