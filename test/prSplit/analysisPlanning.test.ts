import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  buildSplitCandidates,
  validateSplitCandidate,
} from '../../packages/core/src/services/prSplit/candidatePlanner.js';
import { readPrSnapshot, type PrSnapshotClient } from '../../packages/core/src/services/prSplit/prSnapshot.js';
import { createSplitPlan } from '../../packages/core/src/services/prSplit/splitPlanner.js';
import { inferValidationHints } from '../../packages/core/src/services/prSplit/validationHints.js';
import type { PrSnapshot, PrSnapshotFile } from '../../packages/core/src/services/prSplit/types.js';

function file(
  filename: string,
  patch: string | null = '@@ -0,0 +1 @@\n+export const changed = true;',
  overrides: Partial<PrSnapshotFile> = {},
): PrSnapshotFile {
  const content = (patch ?? '')
    .split(/\r?\n/)
    .filter(line => !line.startsWith('@@') && !line.startsWith('---') && !line.startsWith('+++'))
    .map(line => /^[+ ]/.test(line) ? line.slice(1) : line)
    .filter(line => !line.startsWith('-'))
    .join('\n');
  return {
    filename,
    previousFilename: null,
    status: 'modified',
    additions: 1,
    deletions: 0,
    changes: 1,
    patch,
    sha: null,
    baseContent: content,
    headContent: content,
    contentComplete: true,
    ...overrides,
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
    mergeBaseSha: null,
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
        filesComplete: true,
      },
      {
        sha: '2'.repeat(40),
        message: 'Update UI and analytics',
        title: 'Update UI and analytics',
        authoredAt: null,
        committedAt: null,
        parents: [],
        files: changedFiles.slice(3).map(item => item.filename),
        filesComplete: true,
      },
    ],
    changedFiles,
    repositoryFiles: [
      {
        path: 'package.json',
        content: JSON.stringify({ scripts: { test: 'node --test', typecheck: 'tsc --noEmit' } }),
        contentComplete: true,
      },
      { path: 'package-lock.json', content: '{}', contentComplete: true },
    ],
    repositoryTreeComplete: true,
    unifiedDiff: 'diff --git a/src/auth/service.ts b/src/auth/service.ts',
    unifiedDiffComplete: false,
    ...overrides,
  };
}

function singleFileSnapshotClient(options: {
  metadata?: () => Record<string, unknown>;
  files?: () => unknown[];
  content?: (parameters: Record<string, unknown>) => Promise<string> | string;
  commitMessage?: string;
} = {}): PrSnapshotClient {
  const defaultMetadata = (): Record<string, unknown> => ({
    title: 'Stable change', body: '', changed_files: 1, commits: 1,
    base: { ref: 'main', sha: 'a'.repeat(40) },
    head: {
      ref: 'feature', sha: 'b'.repeat(40),
      repo: {
        name: 'fork', full_name: 'contributor/fork', owner: { login: 'contributor' },
        clone_url: 'https://github.com/contributor/fork.git', default_branch: 'main', private: false,
      },
    },
  });
  return {
    async request(route, parameters) {
      if (route.endsWith('/files')) {
        return { data: options.files?.() ?? [{
          filename: 'src/a.ts', status: 'modified', additions: 1, deletions: 0,
          changes: 1, patch: '@@\n+export const a = 1;',
        }] };
      }
      if (route.endsWith('/commits')) {
        return { data: [{
          sha: '1'.repeat(40),
          commit: { message: options.commitMessage ?? 'Change a', author: {}, committer: {} },
          parents: [],
        }] };
      }
      if (route.endsWith('/commits/{ref}')) {
        return { data: {
          commit: { message: options.commitMessage ?? 'Change a', author: {}, committer: {} },
          parents: [], files: [{ filename: 'src/a.ts' }],
        } };
      }
      if (route.endsWith('/contents/{path}')) {
        return { data: await (options.content?.(parameters) ?? 'export const a = 1;') };
      }
      if (route.endsWith('/git/trees/{tree_sha}')) {
        return { data: { truncated: false, tree: [] } };
      }
      if (route.endsWith('/compare/{basehead}')) {
        return { data: { merge_base_commit: { sha: '9'.repeat(40) } } };
      }
      if (parameters.mediaType) return { data: 'diff --git a/src/a.ts b/src/a.ts' };
      return { data: options.metadata?.() ?? defaultMetadata() };
    },
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
          }] };
        }
        if (route.endsWith('/commits/{ref}')) {
          return { data: {
            commit: {
              message: 'Rename implementation\n\nDetails',
              author: { date: '2026-08-04T00:00:00Z' },
              committer: { date: '2026-08-04T00:01:00Z' },
            },
            parents: [{ sha: 'AAAA' }],
            files: [{ filename: 'src/new.ts' }],
          } };
        }
        if (route.endsWith('/contents/{path}')) {
          if (parameters.path === 'package.json') {
            return { data: JSON.stringify({ scripts: { test: 'node --test' } }) };
          }
          return { data: 'export const renamed = true;' };
        }
        if (route.endsWith('/git/trees/{tree_sha}')) {
          return { data: { truncated: false, tree: [{ type: 'blob', path: 'package.json' }] } };
        }
        if (route.endsWith('/compare/{basehead}')) {
          return { data: { merge_base_commit: { sha: 'A1B2C3' } } };
        }
        if (parameters.mediaType) return { data: 'diff --git a/src/old.ts b/src/new.ts' };
        return { data: {
          title: 'Rename implementation',
          body: null,
          changed_files: 1,
          commits: 1,
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
    assert.equal(result.mergeBaseSha, 'a1b2c3');
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
      baseContent: 'export const renamed = true;',
      headContent: 'export const renamed = true;',
      contentComplete: true,
    });
    assert.deepEqual(result.commits[0].files, ['src/new.ts']);
    assert.equal(result.commits[0].filesComplete, true);
    assert.equal(result.commits[0].title, 'Rename implementation');
    assert.equal(result.unifiedDiff, 'diff --git a/src/old.ts b/src/new.ts');
    assert.equal(result.unifiedDiffComplete, false);
    assert.equal(result.repositoryTreeComplete, true);
    assert.ok(calls.some(call => call.parameters.mediaType !== undefined));
  });

  test('retries when the PR head changes during collection', async () => {
    let metadataReads = 0;
    const client: PrSnapshotClient = {
      async request(route, parameters) {
        if (route.endsWith('/files')) {
          return { data: [{ filename: 'src/a.ts', status: 'modified', additions: 1, deletions: 0, changes: 1, patch: '@@\n+export const a = 1;' }] };
        }
        if (route.endsWith('/commits')) {
          return { data: [{ sha: '1'.repeat(40), commit: { message: 'Change a', author: {}, committer: {} }, parents: [] }] };
        }
        if (route.endsWith('/commits/{ref}')) {
          return { data: { commit: { message: 'Change a', author: {}, committer: {} }, parents: [], files: [{ filename: 'src/a.ts' }] } };
        }
        if (route.endsWith('/contents/{path}')) return { data: 'export const a = 1;' };
        if (route.endsWith('/git/trees/{tree_sha}')) return { data: { truncated: false, tree: [] } };
        if (route.endsWith('/compare/{basehead}')) return { data: {} };
        if (parameters.mediaType) return { data: 'diff --git a/src/a.ts b/src/a.ts' };
        metadataReads += 1;
        const headSha = metadataReads === 1 ? 'b'.repeat(40) : 'c'.repeat(40);
        return { data: {
          title: 'Moving head', body: '', changed_files: 1, commits: 1,
          base: { ref: 'main', sha: 'a'.repeat(40) },
          head: { ref: 'feature', sha: headSha, repo: null },
        } };
      },
    };

    const result = await readPrSnapshot({ owner: 'integry', repo: 'propr', pullNumber: 8, octokit: client });
    assert.equal(result.headSha, 'c'.repeat(40));
    assert.equal(metadataReads, 4);
  });

  test('paginates ordinary commit-detail file lists', async () => {
    const detailFiles = Array.from({ length: 101 }, (_, index) => ({ filename: `src/detail-${index}.ts` }));
    const client: PrSnapshotClient = {
      async request(route, parameters) {
        if (route.endsWith('/files')) {
          return { data: [{ filename: 'src/detail-0.ts', status: 'modified', additions: 1, deletions: 0, changes: 1, patch: '@@\n+export {}' }] };
        }
        if (route.endsWith('/commits')) {
          return { data: [{ sha: '2'.repeat(40), commit: { message: 'Large commit', author: {}, committer: {} }, parents: [] }] };
        }
        if (route.endsWith('/commits/{ref}')) {
          const page = Number(parameters.page);
          return {
            data: {
              commit: { message: 'Large commit', author: {}, committer: {} },
              parents: [],
              files: page === 1 ? detailFiles.slice(0, 100) : detailFiles.slice(100),
            },
            headers: page === 1 ? { link: '<next>; rel="next"' } : {},
          };
        }
        if (route.endsWith('/contents/{path}')) return { data: 'export {}' };
        if (route.endsWith('/git/trees/{tree_sha}')) return { data: { truncated: false, tree: [] } };
        if (parameters.mediaType) return { data: 'diff --git a/src/detail-0.ts b/src/detail-0.ts' };
        return { data: {
          title: 'Large commit', body: '', changed_files: 1, commits: 1,
          base: { ref: 'main', sha: 'a'.repeat(40) },
          head: { ref: 'feature', sha: 'b'.repeat(40), repo: null },
        } };
      },
    };

    const result = await readPrSnapshot({ owner: 'integry', repo: 'propr', pullNumber: 9, octokit: client });
    assert.equal(result.commits[0].files.length, 101);
    assert.equal(result.commits[0].filesComplete, true);
  });

  test('rejects pull requests beyond GitHub list endpoint caps', async () => {
    const client: PrSnapshotClient = {
      async request() {
        return { data: {
          title: 'Oversized', body: '', changed_files: 3_001, commits: 1,
          base: { ref: 'main', sha: 'a'.repeat(40) },
          head: { ref: 'feature', sha: 'b'.repeat(40), repo: null },
        } };
      },
    };
    await assert.rejects(
      readPrSnapshot({ owner: 'integry', repo: 'propr', pullNumber: 10, octokit: client }),
      /at most 3000 files/i,
    );
  });

  test('retries when the base moves and verifies both SHAs and counts', async () => {
    let metadataReads = 0;
    const client = singleFileSnapshotClient({
      metadata: () => {
        metadataReads += 1;
        const baseSha = metadataReads === 1 ? 'a'.repeat(40) : 'd'.repeat(40);
        return {
          title: 'Moving base', body: '', changed_files: 1, commits: 1,
          base: { ref: 'main', sha: baseSha },
          head: { ref: 'feature', sha: 'b'.repeat(40), repo: null },
        };
      },
    });

    const result = await readPrSnapshot({ owner: 'integry', repo: 'propr', pullNumber: 11, octokit: client });
    assert.equal(result.baseSha, 'd'.repeat(40));
    assert.equal(metadataReads, 4);
  });

  test('retries consistency failures caused by changing file counts', async () => {
    let metadataReads = 0;
    const client = singleFileSnapshotClient({
      metadata: () => {
        metadataReads += 1;
        return {
          title: 'Moving count', body: '', changed_files: metadataReads === 1 ? 2 : 1, commits: 1,
          base: { ref: 'main', sha: 'a'.repeat(40) },
          head: { ref: 'feature', sha: 'b'.repeat(40), repo: null },
        };
      },
    });

    const result = await readPrSnapshot({ owner: 'integry', repo: 'propr', pullNumber: 12, octokit: client });
    assert.equal(result.changedFiles.length, 1);
    assert.equal(metadataReads, 3);
  });

  test('uses the fork namespace for head reads and accepts empty commit messages', async () => {
    const contentReads: Array<{ owner: unknown; repo: unknown; ref: unknown }> = [];
    const baseClient = singleFileSnapshotClient({ commitMessage: '' });
    const client: PrSnapshotClient = {
      async request(route, parameters) {
        if (route.endsWith('/contents/{path}')) {
          contentReads.push({ owner: parameters.owner, repo: parameters.repo, ref: parameters.ref });
        }
        return baseClient.request(route, parameters);
      },
    };

    const result = await readPrSnapshot({ owner: 'integry', repo: 'propr', pullNumber: 13, octokit: client });
    assert.equal(result.commits[0].message, '');
    assert.equal(result.commits[0].title, '(empty commit message)');
    assert.ok(contentReads.some(read => read.owner === 'integry' && read.repo === 'propr'
      && read.ref === 'a'.repeat(40)));
    assert.ok(contentReads.some(read => read.owner === 'contributor' && read.repo === 'fork'
      && read.ref === 'b'.repeat(40)));
  });

  test('aborts operational GitHub failures instead of downgrading them', async () => {
    const client = singleFileSnapshotClient({
      content: (parameters) => {
        if (parameters.ref === 'b'.repeat(40)) {
          throw Object.assign(new Error('rate limited'), { status: 403 });
        }
        return 'export const a = 1;';
      },
    });
    await assert.rejects(
      readPrSnapshot({ owner: 'integry', repo: 'propr', pullNumber: 14, octokit: client }),
      /rate limited/i,
    );
  });

  test('enforces aggregate request and retained-byte budgets before unsafe growth', async () => {
    const oversizedMetadata = singleFileSnapshotClient({
      metadata: () => ({
        title: 'Many files', body: '', changed_files: 100, commits: 1,
        base: { ref: 'main', sha: 'a'.repeat(40) },
        head: { ref: 'feature', sha: 'b'.repeat(40), repo: null },
      }),
    });
    await assert.rejects(
      readPrSnapshot({
        owner: 'integry', repo: 'propr', pullNumber: 15, octokit: oversizedMetadata,
        resourceLimits: { maxRequests: 20 },
      }),
      /aggregate snapshot budget/i,
    );

    await assert.rejects(
      readPrSnapshot({
        owner: 'integry', repo: 'propr', pullNumber: 16,
        octokit: singleFileSnapshotClient({ content: () => 'x'.repeat(100) }),
        resourceLimits: { maxRetainedBytes: 50 },
      }),
      /retained-byte budget/i,
    );

    const hangingClient: PrSnapshotClient = {
      async request() {
        return new Promise<never>(() => undefined);
      },
    };
    await assert.rejects(
      readPrSnapshot({
        owner: 'integry', repo: 'propr', pullNumber: 17, octokit: hangingClient,
        resourceLimits: { maxElapsedMs: 5 },
      }),
      /time budget/i,
    );
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
        { sha: '3'.repeat(40), message: 'Build output', title: 'Build output', authoredAt: null, committedAt: null, parents: [], files: [generated.filename], filesComplete: true },
        { sha: '4'.repeat(40), message: 'Source', title: 'Source', authoredAt: null, committedAt: null, parents: [], files: [source.filename], filesComplete: true },
      ],
    });
    const candidate = validateSplitCandidate(input, [generated.filename]);
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

  test('does not label overlapping aggregate file diffs as atomic commits', () => {
    const shared = file('src/shared.ts');
    const first = file('src/first.ts');
    const second = file('src/second.ts');
    const input = snapshot({
      changedFiles: [shared, first, second],
      commits: [
        { sha: '5'.repeat(40), message: 'First step', title: 'First step', authoredAt: null, committedAt: null, parents: [], files: [shared.filename, first.filename], filesComplete: true },
        { sha: '6'.repeat(40), message: 'Second step', title: 'Second step', authoredAt: null, committedAt: null, parents: [], files: [shared.filename, second.filename], filesComplete: true },
      ],
    });
    assert.equal(buildSplitCandidates(input).some(candidate => candidate.kind === 'atomic-commit'), false);
  });

  test('uses reverse imports and manifest-lockfile pairs as mandatory companions', () => {
    const contract = file('src/contracts.ts', '@@\n+export interface Contract { id: string }');
    const consumer = file('src/consumer.ts', '@@\n+import type { Contract } from "./contracts";\n+export const consume = (value: Contract) => value.id;');
    const unrelated = file('src/unrelated.ts');
    const reverse = validateSplitCandidate(snapshot({ changedFiles: [contract, consumer, unrelated], commits: [] }), [contract.filename]);
    assert.equal(reverse.rejected, true);
    assert.match(reverse.rejectionReasons.join(' '), /consumer\.ts/);

    const manifest = file('package.json', '@@\n+{"dependencies":{"x":"1"}}', { headContent: '{"dependencies":{"x":"1"}}' });
    const lockfile = file('package-lock.json', '@@\n+{"lockfileVersion":3}', { headContent: '{"lockfileVersion":3}' });
    const pair = validateSplitCandidate(snapshot({ changedFiles: [manifest, lockfile, unrelated], commits: [] }), [manifest.filename]);
    assert.equal(pair.rejected, true);
    assert.match(pair.rejectionReasons.join(' '), /package-lock\.json/);

    const aliasConsumer = file('src/alias-consumer.ts', '@@\n+import type { Contract } from "@app/contracts";');
    const aliasInput = snapshot({
      changedFiles: [contract, aliasConsumer, unrelated],
      commits: [],
      repositoryFiles: [
        ...snapshot().repositoryFiles,
        {
          path: 'tsconfig.json',
          content: '{"compilerOptions":{"baseUrl":".","paths":{"@app/*":["src/*"]}}}',
          contentComplete: true,
        },
      ],
    });
    const aliasAssessment = validateSplitCandidate(aliasInput, [contract.filename]);
    assert.equal(aliasAssessment.rejected, true);
    assert.match(aliasAssessment.rejectionReasons.join(' '), /alias-consumer\.ts/);
  });

  test('requires changed manifests and import configuration with affected source', () => {
    const source = file('packages/api/src/client.ts', '@@\n+import leftPad from "left-pad";\n+export const value = leftPad("x", 2);');
    const manifest = file('packages/api/package.json', '@@', {
      baseContent: '{"dependencies":{}}',
      headContent: '{"dependencies":{"left-pad":"1.3.0"}}',
    });
    const lockfile = file('package-lock.json', '@@', {
      baseContent: '{"lockfileVersion":3}', headContent: '{"lockfileVersion":3,"packages":{}}',
    });
    const tsconfig = file('packages/api/tsconfig.json', '@@', {
      baseContent: '{"compilerOptions":{}}',
      headContent: '{"compilerOptions":{"paths":{"@models":["src/models.ts"]}}}',
    });
    const unrelated = file('README.md');
    const input = snapshot({ changedFiles: [source, manifest, lockfile, tsconfig, unrelated], commits: [] });

    const assessment = validateSplitCandidate(input, [source.filename]);
    assert.equal(assessment.safeToCreatePr, false);
    assert.match(assessment.rejectionReasons.join(' '), /packages\/api\/package\.json/);
    assert.match(assessment.rejectionReasons.join(' '), /packages\/api\/tsconfig\.json/);
  });

  test('resolves NodeNext, Python relative, exact aliases, and workspace package exports', () => {
    const dependency = file('src/dependency.ts', '@@\n+export const dependency = true;');
    const nodeConsumer = file('src/node-consumer.ts', '@@\n+import { dependency } from "./dependency.js";');
    const nodeAssessment = validateSplitCandidate(
      snapshot({ changedFiles: [dependency, nodeConsumer, file('README.md')], commits: [] }),
      [dependency.filename],
    );
    assert.match(nodeAssessment.rejectionReasons.join(' '), /node-consumer\.ts/);

    const models = file('pkg/models.py', '@@\n+class Model: pass');
    const pythonConsumer = file('pkg/service.py', '@@\n+from . import models\n+value = models.Model()');
    const pythonAssessment = validateSplitCandidate(
      snapshot({ changedFiles: [models, pythonConsumer, file('README.md')], commits: [] }),
      [models.filename],
    );
    assert.match(pythonAssessment.rejectionReasons.join(' '), /service\.py/);

    const exactTarget = file('src/exact.ts');
    const exactConsumer = file('src/exact-consumer.ts', '@@\n+import "@exact";');
    const exactInput = snapshot({
      changedFiles: [exactTarget, exactConsumer, file('README.md')], commits: [],
      repositoryFiles: [{
        path: 'tsconfig.json',
        content: '{"compilerOptions":{"paths":{"@exact":["src/exact.ts"]}}}',
        contentComplete: true,
      }],
    });
    assert.match(
      validateSplitCandidate(exactInput, [exactTarget.filename]).rejectionReasons.join(' '),
      /exact-consumer\.ts/,
    );

    const workspaceTarget = file('packages/contracts/src/public.ts');
    const workspaceConsumer = file('packages/api/src/use-contract.ts', '@@\n+import "@acme/contracts/public";');
    const workspaceInput = snapshot({
      changedFiles: [workspaceTarget, workspaceConsumer, file('README.md')], commits: [],
      repositoryFiles: [{
        path: 'packages/contracts/package.json',
        content: '{"name":"@acme/contracts","exports":{"./*":"./src/*.js"}}',
        contentComplete: true,
      }],
    });
    assert.match(
      validateSplitCandidate(workspaceInput, [workspaceTarget.filename]).rejectionReasons.join(' '),
      /use-contract\.ts/,
    );
  });

  test('fails closed for incomplete content and rename or deletion scopes', () => {
    const incomplete = file('src/incomplete.ts', null, {
      patch: null,
      baseContent: null,
      headContent: null,
      contentComplete: false,
    });
    const unrelated = file('src/unrelated.ts');
    const missing = validateSplitCandidate(snapshot({ changedFiles: [incomplete, unrelated], commits: [] }), [incomplete.filename]);
    assert.equal(missing.safeToCreatePr, false);
    assert.match(missing.rejectionReasons.join(' '), /complete base\/head contents|complete patch/i);

    const truncated = file('src/truncated.ts', '@@\n+import "./unknown";', {
      baseContent: null,
      headContent: null,
      contentComplete: false,
    });
    const truncatedAssessment = validateSplitCandidate(
      snapshot({ changedFiles: [truncated, unrelated], commits: [] }),
      [truncated.filename],
    );
    assert.equal(truncatedAssessment.safeToCreatePr, false);
    assert.match(truncatedAssessment.rejectionReasons.join(' '), /complete base\/head contents/i);

    const renamed = file('src/new.ts', '@@ rename', {
      status: 'renamed',
      previousFilename: 'src/old.ts',
    });
    const renameAssessment = validateSplitCandidate(snapshot({ changedFiles: [renamed, unrelated], commits: [] }), [renamed.filename]);
    assert.equal(renameAssessment.safeToCreatePr, false);
    assert.match(renameAssessment.rejectionReasons.join(' '), /renamed/i);

    const removed = file('src/legacy.ts', '@@ removed', {
      status: 'removed', headContent: null, baseContent: 'export const legacy = true;',
    });
    const caller = file('src/caller.ts', '@@\n-import { legacy } from "./legacy";\n+export const current = true;', {
      baseContent: 'import { legacy } from "./legacy";',
      headContent: 'export const current = true;',
    });
    const deletionAssessment = validateSplitCandidate(
      snapshot({ changedFiles: [removed, caller, unrelated], commits: [] }),
      [caller.filename],
    );
    assert.equal(deletionAssessment.safeToCreatePr, false);
    assert.match(deletionAssessment.rejectionReasons.join(' '), /legacy\.ts|removed/i);
  });

  test('detects non-JavaScript dependencies without crossing unrelated modules', () => {
    const model = file('pkg/models.py', '@@\n+class Model: pass');
    const consumer = file('pkg/service.py', '@@\n+from .models import Model\n+value = Model()');
    const unrelated = file('pkg/other.py');
    const python = validateSplitCandidate(
      snapshot({ changedFiles: [model, consumer, unrelated], commits: [] }),
      [model.filename],
    );
    assert.equal(python.rejected, true);
    assert.match(python.rejectionReasons.join(' '), /service\.py/);

    const testFile = file('packages/c/tests/service.test.ts', '@@\n+test("local", () => {});');
    const moduleA = file('packages/a/src/service.ts');
    const moduleB = file('packages/b/src/service.ts');
    const candidates = buildSplitCandidates(snapshot({ changedFiles: [testFile, moduleA, moduleB], commits: [] }));
    const testScope = candidates.find(candidate => candidate.includedFiles.includes(testFile.filename));
    assert.ok(testScope);
    assert.equal(testScope.includedFiles.includes(moduleA.filename), false);
    assert.equal(testScope.includedFiles.includes(moduleB.filename), false);
  });

  test('allows unrelated test-only scopes and avoids common-token special dependencies', () => {
    const isolatedTest = file('packages/a/tests/health.test.ts', '@@\n+test("health", () => {});');
    const unrelatedImplementation = file('packages/b/src/worker.ts');
    const readme = file('README.md');
    const testAssessment = validateSplitCandidate(
      snapshot({ changedFiles: [isolatedTest, unrelatedImplementation, readme], commits: [] }),
      [isolatedTest.filename],
    );
    assert.equal(testAssessment.safeToCreatePr, true);

    const implementation = file('src/worker.ts', '@@\n+export interface ChangedWorker { value: string }');
    const commonTypes = file('src/other/types.ts', '@@\n+export interface ChangedRecord { value: string }');
    const tokenAssessment = validateSplitCandidate(
      snapshot({ changedFiles: [implementation, commonTypes, readme], commits: [] }),
      [implementation.filename],
    );
    assert.equal(tokenAssessment.missingDependencyFiles.includes(commonTypes.filename), false);
  });

  test('demotes dependency-expanded commits and creates globally unique stable IDs', () => {
    const consumer = file('src/consumer.ts', '@@\n+import "./dependency";');
    const dependency = file('src/dependency.ts');
    const unrelated = file('src/unrelated.ts');
    const input = snapshot({
      changedFiles: [consumer, dependency, unrelated],
      commits: [
        { sha: '7'.repeat(40), message: 'Consumer', title: 'Consumer', authoredAt: null, committedAt: null, parents: [], files: [consumer.filename], filesComplete: true },
        { sha: '8'.repeat(40), message: 'Dependency', title: 'Dependency', authoredAt: null, committedAt: null, parents: [], files: [dependency.filename], filesComplete: true },
        { sha: '9'.repeat(40), message: 'Unrelated', title: 'Unrelated', authoredAt: null, committedAt: null, parents: [], files: [unrelated.filename], filesComplete: true },
      ],
    });
    const candidates = buildSplitCandidates(input);
    const expanded = candidates.find(candidate => candidate.summary.startsWith('Dependency-closed expansion of commit: Consumer'));
    assert.ok(expanded);
    assert.equal(expanded.kind, 'dependency-closed');
    assert.deepEqual(expanded.commitShas, []);
    assert.equal(new Set(candidates.map(candidate => candidate.id)).size, candidates.length);

    const collidingNames = [file('src/foo!.ts'), file('src/foo@.ts')];
    const collisionCandidates = buildSplitCandidates(snapshot({
      changedFiles: [...collidingNames, file('README.md')], commits: [],
    })).filter(candidate => candidate.kind === 'dependency-closed'
      && candidate.includedFiles.length === 1
      && collidingNames.some(item => item.filename === candidate.includedFiles[0]));
    assert.equal(collisionCandidates.length, 2);
    assert.equal(new Set(collisionCandidates.map(candidate => candidate.id)).size, 2);
  });

  test('bounds candidate generation for large pull requests', () => {
    const changedFiles = Array.from({ length: 220 }, (_, index) => file(`src/module-${index}.ts`));
    const candidates = buildSplitCandidates(snapshot({ changedFiles, commits: [] }));
    assert.ok(candidates.length <= 128);
    assert.ok(candidates.some(candidate => candidate.includedFiles.includes('src/module-219.ts')));
  });
});

describe('validation hints', () => {
  test('keeps workflow run text display-only', () => {
    const workflow = file('.github/workflows/ci.yml', '@@\n+      run: npm test; touch /tmp/not-allowed', {
      headContent: 'jobs:\n  test:\n    steps:\n      - run: npm test; touch /tmp/not-allowed',
    });
    const plan = inferValidationHints(snapshot({
      changedFiles: [workflow, file('README.md')],
      commits: [],
      repositoryFiles: [],
    }), [workflow.filename]);
    assert.deepEqual(plan.commands, []);
    assert.equal(plan.hints[0]?.executable, false);
    assert.match(plan.hints[0]?.reason ?? '', /display-only/i);
  });

  test('uses real package scripts, repository package manager, and monorepo working directory', () => {
    const source = file('packages/foo/src/index.ts');
    const input = snapshot({
      changedFiles: [source, file('README.md')],
      commits: [],
      repositoryFiles: [
        { path: 'pnpm-lock.yaml', content: 'lockfileVersion: 9', contentComplete: true },
        { path: 'package.json', content: '{"scripts":{"test":"node --test"}}', contentComplete: true },
        { path: 'packages/foo/package.json', content: '{"dependencies":{"test":"1"},"scripts":{"typecheck":"tsc --noEmit"}}', contentComplete: true },
      ],
    });
    const plan = inferValidationHints(input, [source.filename]);
    assert.deepEqual(plan.commands, [{
      command: 'pnpm run typecheck',
      workingDirectory: 'packages/foo',
      requiresSandbox: true,
    }]);
    assert.equal(plan.hints[0].workingDirectory, 'packages/foo');
    assert.equal(plan.hints[0].confidence, 'high');
  });

  test('uses candidate-effective base configuration when changed config is excluded', () => {
    const source = file('src/index.ts');
    const manifest = file('package.json', '@@', {
      baseContent: '{"scripts":{"test":"node --test"}}',
      headContent: '{"scripts":{"typecheck":"tsc --noEmit"}}',
    });
    const input = snapshot({
      changedFiles: [source, manifest, file('README.md')],
      commits: [],
      repositoryFiles: [{
        path: 'package.json',
        content: manifest.headContent,
        contentComplete: true,
      }],
    });

    const excludedConfig = inferValidationHints(input, [source.filename]);
    assert.deepEqual(excludedConfig.commands, [{
      command: 'npm test', workingDirectory: '.', requiresSandbox: true,
    }]);
    const includedConfig = inferValidationHints(input, [source.filename, manifest.filename]);
    assert.deepEqual(includedConfig.commands, [{
      command: 'npm run typecheck', workingDirectory: '.', requiresSandbox: true,
    }]);
  });

  test('only infers commands established by exact repository markers', () => {
    const sourceFiles = [file('src/App.java'), file('src/plugin.php'), file('src/model.rb'), file('src/index.ts')];
    const plan = inferValidationHints(snapshot({
      changedFiles: [...sourceFiles, file('README.md')], commits: [],
      repositoryFiles: [
        { path: 'build.gradle', content: 'plugins {}', contentComplete: true },
        { path: 'composer.json', content: '{"scripts":{"lint":"php -l"}}', contentComplete: true },
        { path: 'Gemfile', content: 'gem "rake"', contentComplete: true },
        { path: 'package.json', content: '{"scripts":{"Test":"node --test"}}', contentComplete: true },
      ],
    }), sourceFiles.map(item => item.filename));
    assert.deepEqual(plan.commands, []);
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

  test('isolates judge inputs and bounds judge output text', async () => {
    let mutationBlocked = false;
    const plan = await createSplitPlan(snapshot(), {
      judge: async (input) => {
        try {
          (input.candidates[0].includedFiles as string[]).push('src/mutated.ts');
        } catch {
          mutationBlocked = true;
        }
        return {
          candidateId: input.candidates[0].id,
          reason: `selected\u0000 ${'x'.repeat(2_000)}`,
        };
      },
    });
    assert.equal(mutationBlocked, true);
    assert.equal(plan.safeToCreatePr, true);
    assert.equal(plan.includedFiles.includes('src/mutated.ts'), false);
    assert.ok(plan.selectionReason.length <= 500);
    assert.equal(/[\u0000-\u001f\u007f]/.test(plan.selectionReason), false);
  });

  test('bounds candidates and file lists sent to the optional judge', async () => {
    const changedFiles = Array.from({ length: 180 }, (_, index) => file(`src/feature-${index}.ts`));
    let observedCandidateCount = 0;
    let observedPrompt = '';
    const plan = await createSplitPlan(snapshot({ changedFiles, commits: [] }), {
      judge: async (input) => {
        observedCandidateCount = input.candidates.length;
        observedPrompt = input.prompt;
        return { candidateId: input.candidates[0].id };
      },
    });
    assert.equal(plan.safeToCreatePr, true);
    assert.ok(observedCandidateCount <= 20);
    assert.doesNotMatch(observedPrompt, /"excludedScope"/);
  });

  test('bounds exported planner inputs, instruction summaries, and prompt size', async () => {
    const hugeInstruction = `auth ${'x'.repeat(500_000)}`;
    let observedInstruction = '';
    let observedPrompt = '';
    let observedSummary = '';
    const plan = await createSplitPlan(snapshot(), {
      instruction: hugeInstruction,
      judge: async (input) => {
        observedInstruction = input.instruction;
        observedPrompt = input.prompt;
        observedSummary = input.candidates[0].summary;
        return { candidateId: input.candidates[0].id };
      },
    });
    assert.equal(plan.safeToCreatePr, true);
    assert.ok(observedInstruction.length <= 8_000);
    assert.ok(observedSummary.length <= 600);
    assert.ok(observedPrompt.length <= 120_000);
  });

  test('fails closed when optional judgement exceeds its deadline', async () => {
    let signalAborted = false;
    const plan = await createSplitPlan(snapshot(), {
      judgementTimeoutMs: 10,
      judge: async ({ signal }) => new Promise((_resolve) => {
        signal.addEventListener('abort', () => { signalAborted = true; }, { once: true });
      }),
    });
    assert.equal(plan.safeToCreatePr, false);
    assert.equal(signalAborted, true);
    assert.match(plan.failureReason ?? '', /timed out/i);
  });
});
