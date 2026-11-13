import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildReviewDigest, closeConnection, renderReviewDigest } from '@propr/core';
import type { ClaudeCodeResponse, RepositoryValidationResult } from '@propr/core';
import { createPullRequest } from '../src/jobs/issueJobHelpers.js';
import { buildCompletionComment } from '../src/jobs/prCompletionComment.js';
import { buildFollowUpReviewDigest, recordReviewDigestEvent, reviewDigestEvent } from '../src/jobs/reviewDigestRun.js';

// The template fallback setting is read from the configuration database.
after(() => closeConnection());

const validation: RepositoryValidationResult = { overall: 'passed', commands: [{ index: 0, command: 'npm test', status: 'passed', verified: true }] };
const logger = { info() {}, warn() {}, error() {}, debug() {} };

function fakeDatabase(inserted: Array<Record<string, unknown>>) {
    return ((table: string) => ({
        where: () => ({ first: async () => (table === 'tasks' ? { task_id: 'task-1' } : undefined) }),
        insert: async (row: Record<string, unknown>) => { inserted.push({ table, ...row }); },
    })) as never;
}

async function withRepository(fn: (repository: { directory: string; base: string; commit: string }) => Promise<void>): Promise<void> {
    const directory = await mkdtemp(path.join(tmpdir(), 'review-digest-pr-'));
    const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd: directory, encoding: 'utf8' }).trim();
    try {
        git('init', '-q');
        await writeFile(path.join(directory, 'package.json'), '{\n  "dependencies": {\n    "react": "^18.2.0"\n  }\n}\n');
        await writeFile(path.join(directory, 'app.js'), 'export {};\n');
        git('add', '.');
        git('commit', '-qm', 'base');
        const base = git('rev-parse', 'HEAD');
        await writeFile(path.join(directory, 'package.json'), '{\n  "dependencies": {\n    "react": "^18.2.0",\n    "left-pad": "^1.3.0"\n  }\n}\n');
        await writeFile(path.join(directory, 'app.js'), 'export const value = 1;\n');
        await mkdir(path.join(directory, 'docs'));
        await writeFile(path.join(directory, 'docs/usage.md'), '# Usage\n');
        git('add', '.');
        git('commit', '-qm', 'change');
        await fn({ directory, base, commit: git('rev-parse', 'HEAD') });
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}

function pullRequestOctokit(files: Record<string, string> = {}) {
    const published: Array<Record<string, unknown>> = [];
    return {
        published,
        async request<T>(endpoint: string, options: Record<string, unknown>): Promise<T> {
            if (endpoint === 'POST /repos/{owner}/{repo}/pulls') {
                published.push(options);
                return { data: { number: 9, html_url: 'https://github.com/acme/app/pull/9', title: options.title } } as T;
            }
            if (endpoint.startsWith('POST /repos/{owner}/{repo}/issues/')) return { data: [] } as T;
            if (endpoint === 'GET /repos/{owner}/{repo}/commits/{ref}') return { data: { sha: 'base-sha' } } as T;
            const file = String(options.path);
            if (file in files) return { data: { name: file.split('/').at(-1), path: file, type: 'file', encoding: 'base64', content: Buffer.from(files[file]).toString('base64') } } as T;
            throw Object.assign(new Error('Not Found'), { status: 404 });
        },
    };
}

async function publish(octokit: ReturnType<typeof pullRequestOctokit>, worktreePath: string, extra: Record<string, unknown>, summary = 'Added left-pad.'): Promise<string> {
    const claudeResult = { success: true, summary, repositoryValidation: '### Repository validation\n\n- [1] npm test: Passed', repositoryValidationResult: validation, finalResult: { cost_usd: 0.1 } };
    await createPullRequest(octokit as never, { repoOwner: 'acme', repoName: 'app', number: 7, baseBranch: 'main' } as never, { branchName: '7-pad', worktreePath } as never, {
        commitResult: { commitHash: 'abcdef1234567', commitMessage: 'feat: pad', filesChanged: ['app.js'] }, claudeResult: claudeResult as never,
        modelName: 'claude-opus-4-5-20251101', repoValidation: {} as never, PR_LABEL: 'propr', correlatedLogger: logger as never, issueTitle: 'Pad',
        ...extra,
    });
    assert.equal(octokit.published.length, 1);
    return String(octokit.published[0].body);
}

test('an issue PR description carries the digest of the run diff after the summary, before validation and logs', async () => {
    await withRepository(async ({ directory, base }) => {
        const body = await publish(pullRequestOctokit(), directory, { diffBase: base, review: { risk_paths: ['app.js'] } });
        const digestAt = body.indexOf('### Review digest');
        assert.ok(digestAt > body.indexOf('**Summary:**\nAdded left-pad.'), body);
        assert.ok(digestAt < body.indexOf('### Repository validation'), body);
        assert.match(body, /- \*\*High risk\*\* \(2 files\)\n {2}- `app\.js` \(\+1\/−1\): matches `review\.risk_paths`\n {2}- `package\.json` \(\+2\/−1\): dependency manifest\n/);
        assert.match(body, /- \*\*Low risk\*\* \(1 file\)\n {2}- `docs\/usage\.md` \(added, \+1\/−0\)/);
        assert.match(body, /\*\*New dependencies\*\* \(1\): `left-pad` in `package\.json`/);
        assert.match(body, /\*\*Validation evidence\*\* \(passed\)\n\n- \[1\] `npm test`: Passed/);
        assert.match(body, /\*\*Diff size:\*\* 3 files changed, \+4\/−2 lines/);
        assert.ok(!body.includes('export const value'), 'no raw diff content');
    });
});

test('the digest lists the issue acceptance criteria with the agent statement for each, unaddressed ones included', async () => {
    await withRepository(async ({ directory, base }) => {
        const issueBody = '## Context\n\n- not a criterion\n\n## Acceptance criteria\n\n- [ ] Pads the value\n- [ ] Documents usage\n- [ ] Ships a CLI\n';
        const summary = 'Added left-pad.\n\nAcceptance criteria:\n- AC1: met — `app.js`\n- AC3: not applicable — no CLI in this repository';
        const body = await publish(pullRequestOctokit(), directory, { diffBase: base, issueBody }, summary);
        const criteriaAt = body.indexOf('**Acceptance criteria** (1 of 3 met, as stated by the agent)');
        assert.ok(criteriaAt > body.indexOf('### Review digest') && criteriaAt < body.indexOf('**Risk-tiered paths**'), body);
        assert.ok(body.includes([
            '- ✅ **AC1** (met): `Pads the value` — `` `app.js` ``',
            '- ⚠️ **AC2** (not addressed): `Documents usage`',
            '- ➖ **AC3** (not applicable): `Ships a CLI` — `no CLI in this repository`',
        ].join('\n')), body);
        // No heading, no checklist.
        assert.ok(!(await publish(pullRequestOctokit(), directory, { diffBase: base, issueBody: 'Just pad it.' }, summary)).includes('**Acceptance criteria**'));
    });
});

test('without a pinned starting commit or a diff the description has no digest', async () => {
    await withRepository(async ({ directory, commit }) => {
        assert.ok(!(await publish(pullRequestOctokit(), directory, {})).includes('Review digest'));
        assert.ok(!(await publish(pullRequestOctokit(), directory, { diffBase: commit })).includes('Review digest'));
    });
});

test('a template moves the digest with {{digest}} or removes it with an empty section', async () => {
    await withRepository(async ({ directory, base }) => {
        const moved = await publish(pullRequestOctokit({ '.propr/pr-template.md': '## summary\nCloses #{{issue_number}}\n\n## digest\n\n## trailer\n<details>\n\n{{digest}}\n\n</details>\n' }), directory, { diffBase: base });
        assert.match(moved, /^Closes #7\n\n/);
        assert.match(moved, /<details>\n\n### Review digest\n[\s\S]*\*\*Diff size:\*\* 3 files changed, \+4\/−2 lines\n\n<\/details>$/);
        // Default position: it follows the template's summary.
        const positioned = await publish(pullRequestOctokit({ '.propr/pr-template.md': '## summary\nCloses #{{issue_number}}\n' }), directory, { diffBase: base });
        assert.match(positioned, /^Closes #7\n\n### Review digest\n/);
        const removed = await publish(pullRequestOctokit({ '.propr/pr-template.md': '## digest\n' }), directory, { diffBase: base });
        assert.ok(!removed.includes('Review digest'));
    });
});

test('a follow-up completion comment shows the digest of its commit after the summary of changes', async () => {
    await withRepository(async ({ directory, commit }) => {
        const inserted: Array<Record<string, unknown>> = [];
        const section = await buildFollowUpReviewDigest({
            taskId: 'task-1', worktreePath: directory, commitHash: commit, validation, correlatedLogger: logger,
            database: fakeDatabase(inserted), currentState: async () => 'post_processing',
        });
        assert.deepEqual(inserted.map(row => [row.table, JSON.parse(String(row.metadata)).event]), [['task_history', 'review.digest']]);
        assert.equal(section, renderReviewDigest(buildReviewDigest([
            { path: 'app.js', linesAdded: 1, linesRemoved: 1 }, { path: 'docs/usage.md', linesAdded: 1, linesRemoved: 0, status: 'added' },
            { path: 'package.json', linesAdded: 2, linesRemoved: 1, diff: '@@ -1 +1 @@\n   "dependencies": {\n+    "left-pad": "^1.3.0",\n   }' },
        ], validation)));
        const result = { success: true, executionTime: 1000, output: null, logs: '', exitCode: 0, finalResult: null, modifiedFiles: ['app.js'], commitMessage: null, summary: 'Padded the value.' } as ClaudeCodeResponse;
        const comment = await buildCompletionComment({ commitHash: commit }, [], {
            changesSummary: 'Padded the value.', commitMessage: 'fix', llm: null, authorsText: '@octo', reviewDigestSection: section,
        }, result);
        assert.ok(comment.indexOf('### Review digest') > comment.indexOf('## Summary of Changes'), comment);
        const withoutDigest = await buildCompletionComment({ commitHash: commit }, [], { changesSummary: 'Padded the value.', commitMessage: 'fix', llm: null, authorsText: '@octo' }, result);
        assert.equal(comment.replace(section, ''), withoutDigest);
    });
});

test('the digest is recorded as one task_history metadata event without changing the task state', async () => {
    const digest = buildReviewDigest([{ path: 'src/a.ts', linesAdded: 2, linesRemoved: 1 }], validation)!;
    const inserted: Array<Record<string, unknown>> = [];
    await recordReviewDigestEvent('task-1', digest, logger, { database: fakeDatabase(inserted), currentState: async () => 'post_processing' });
    assert.equal(inserted.length, 1);
    assert.equal(inserted[0].table, 'task_history');
    assert.equal(inserted[0].state, 'post_processing');
    assert.equal(inserted[0].reason, 'Review digest: 1 file (+2/−1): 0 high, 1 normal, 0 low risk; validation passed');
    assert.deepEqual(JSON.parse(String(inserted[0].metadata)), { event: 'review.digest', reviewDigest: JSON.parse(JSON.stringify(digest)) });
    assert.deepEqual(reviewDigestEvent(digest).metadata, { event: 'review.digest', reviewDigest: digest });
    const withCriteria = buildReviewDigest([{ path: 'src/a.ts', linesAdded: 2, linesRemoved: 1 }], validation, {}, {
        criteria: [{ id: 'AC1', text: 'Adds a' }, { id: 'AC2', text: 'Tests a' }], agentReport: '- AC1: met — `src/a.ts`',
    })!;
    const criteriaRows: Array<Record<string, unknown>> = [];
    await recordReviewDigestEvent('task-1', withCriteria, logger, { database: fakeDatabase(criteriaRows), currentState: async () => 'post_processing' });
    assert.equal(criteriaRows[0].reason, 'Review digest: 1 file (+2/−1): 0 high, 1 normal, 0 low risk; validation passed; 1/2 acceptance criteria met');
    assert.deepEqual(JSON.parse(String(criteriaRows[0].metadata)).reviewDigest.acceptanceCriteria, [
        { id: 'AC1', text: 'Adds a', status: 'met', evidence: '`src/a.ts`' },
        { id: 'AC2', text: 'Tests a', status: 'not_addressed' },
    ]);
    // A timeline failure is logged, never thrown.
    const warnings: unknown[] = [];
    await recordReviewDigestEvent('task-1', digest, { warn: (...args: unknown[]) => warnings.push(args) } as never, { database: (() => { throw new Error('down'); }) as never });
    assert.equal(warnings.length, 1);
});
