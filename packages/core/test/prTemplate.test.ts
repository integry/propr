import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { defaultPrBody, type PrBodyPiece } from '@propr/shared';
import {
    applyPrTemplate, buildPrTemplateValues, describePullRequest, findGitHubPullRequestTemplate, loadPrTemplate,
    type PrTemplateSource, type PrTemplateSourceEntry,
} from '../src/workflow/prTemplate.js';
import { resolveRepositoryGitHubPrTemplateFallback, type RepoToMonitor } from '../src/config/configManager.js';
import { generateCompletionComment, generateCompletionCommentParts } from '../src/utils/github/logFiles.js';
import { closeConnection } from '../src/db/connection.js';

after(() => closeConnection());

/** In-memory repository at one revision. */
function source(files: Record<string, string>): PrTemplateSource & { reads: string[] } {
    const reads: string[] = [];
    return {
        reads,
        async readFile(path, revision) {
            assert.equal(revision, 'base-sha');
            reads.push(path);
            return path in files ? { content: files[path] } : null;
        },
        async listDirectory(directory, revision) {
            assert.equal(revision, 'base-sha');
            const prefix = directory ? `${directory}/` : '';
            const entries = new Map<string, PrTemplateSourceEntry>();
            for (const path of Object.keys(files)) {
                if (!path.startsWith(prefix)) continue;
                const [name, ...rest] = path.slice(prefix.length).split('/');
                entries.set(name, { name, path: prefix + name, type: rest.length ? 'dir' : 'file' });
            }
            return entries.size ? [...entries.values()] : null;
        },
    };
}

const pieces: PrBodyPiece[] = [
    { section: 'summary', text: '## Summary\n\nCloses #7\n' },
    { section: null, text: '\n---\n\n' },
    { section: 'run', text: '- Time: 1m\n' },
    { section: 'trailer', text: '*ProPR*' },
];
const values = buildPrTemplateValues({ issueNumber: 7, issueTitle: 'Fix it', model: 'claude-opus-4-5-20251101', repository: 'acme/app' });

test('loadPrTemplate prefers .propr/pr-template.md over the GitHub template', async () => {
    const repo = source({ '.propr/pr-template.md': '## run\n', '.github/pull_request_template.md': '- [ ] tested' });
    const template = await loadPrTemplate(repo, 'base-sha', { githubFallback: true });
    assert.equal(template?.kind, 'propr');
    assert.deepEqual(repo.reads, ['.propr/pr-template.md']);
});

test('loadPrTemplate falls back to the GitHub template only when the toggle allows it', async () => {
    const repo = source({ '.github/PULL_REQUEST_TEMPLATE.md': '## Checklist\n- [ ] tested\n' });
    const template = await loadPrTemplate(repo, 'base-sha', { githubFallback: true });
    assert.deepEqual(template, { kind: 'github', path: '.github/PULL_REQUEST_TEMPLATE.md', content: '## Checklist\n- [ ] tested\n' });
    assert.equal(await loadPrTemplate(repo, 'base-sha', { githubFallback: false }), undefined);
    assert.equal(applyPrTemplate(template, pieces, 'title', values).body, '## Summary\n\nCloses #7\n\n- Time: 1m\n\n## Checklist\n- [ ] tested');
});

test('findGitHubPullRequestTemplate follows GitHub locations and the template directory default', async () => {
    assert.equal((await findGitHubPullRequestTemplate(source({ 'pull_request_template.md': 'root' }), 'base-sha'))?.path, 'pull_request_template.md');
    assert.equal((await findGitHubPullRequestTemplate(source({ 'docs/pull_request_template.md': 'docs' }), 'base-sha'))?.path, 'docs/pull_request_template.md');
    assert.equal((await findGitHubPullRequestTemplate(source({
        '.github/PULL_REQUEST_TEMPLATE/bug.md': 'bug', '.github/PULL_REQUEST_TEMPLATE/default.md': 'default',
    }), 'base-sha'))?.content, 'default');
    assert.equal((await findGitHubPullRequestTemplate(source({ '.github/PULL_REQUEST_TEMPLATE/only.md': 'only' }), 'base-sha'))?.content, 'only');
    // Several templates without a default: GitHub asks the author to choose, so none is applied.
    assert.equal(await findGitHubPullRequestTemplate(source({ '.github/PULL_REQUEST_TEMPLATE/a.md': 'a', '.github/PULL_REQUEST_TEMPLATE/b.md': 'b' }), 'base-sha'), undefined);
    assert.equal(await findGitHubPullRequestTemplate(source({ '.github/pull_request_template.md': '  \n' }), 'base-sha'), undefined);
});

test('the GitHub template fallback is enabled unless a repository entry disables it', () => {
    const repo = (name: string, githubPrTemplateFallback?: boolean): RepoToMonitor => ({ id: name, name, enabled: true, githubPrTemplateFallback });
    assert.equal(resolveRepositoryGitHubPrTemplateFallback([repo('acme/app')], 'acme/app'), true);
    assert.equal(resolveRepositoryGitHubPrTemplateFallback([repo('acme/app', true)], 'ACME/app'), true);
    assert.equal(resolveRepositoryGitHubPrTemplateFallback([repo('acme/app', true), repo('Acme/App', false)], 'acme/app'), false);
    assert.equal(resolveRepositoryGitHubPrTemplateFallback([repo('acme/other', false)], 'acme/app'), true);
});

test('buildPrTemplateValues sanitizes untrusted text and formats run data', () => {
    const built = buildPrTemplateValues({
        issueNumber: 12, issueTitle: 'Leak\n ghp_abcdefghijklmnopqrstuvwxyz0123456789', model: 'claude-opus-4-5-20251101',
        summary: 'Implemented the fix.\nI did not create a commit.', sessionId: 's-1', cost: 1.234, totalTokens: 1234567,
        executionTime: '3m 2s', branch: '12-leak', repository: 'acme/app',
        commits: [{ sha: '0123456789abcdef', message: 'Fix leak\n\nBody' }], filesChanged: ['a.ts', 'a.ts', 'we`ird.ts'],
    });
    assert.equal(built.issue_number, '12');
    assert.doesNotMatch(built.issue_title, /ghp_/);
    assert.doesNotMatch(built.issue_title, /\n/);
    assert.equal(built.summary, 'Implemented the fix.');
    assert.equal(built.agent, 'claude');
    assert.equal(built.cost, '$1.23');
    assert.equal(built.tokens, '1,234,567');
    assert.equal(built.commits, '- `0123456` Fix leak');
    assert.equal(built.files_changed, '- `a.ts`\n- `we\\`ird.ts`');
    assert.equal(built.session_id, 's-1');
});

test('buildPrTemplateValues bounds the changed-file list', () => {
    const files = Array.from({ length: 60 }, (_, index) => `f${index}.ts`);
    const list = buildPrTemplateValues({ filesChanged: files }).files_changed.split('\n');
    assert.equal(list.length, 51);
    assert.equal(list.at(-1), '- …and 10 more');
});

test('describePullRequest applies a ProPR template to title and body', async () => {
    const description = await describePullRequest({
        pieces, defaultTitle: '[7 by Claude Opus] Fix it', values,
        loadTemplate: async () => ({ kind: 'propr', path: '.propr/pr-template.md', template: { sections: { title: 'feat: {{issue_title}} (#{{issue_number}})', run: '' }, problems: [] } }),
    });
    assert.deepEqual(description, {
        title: 'feat: Fix it (#7)', body: '## Summary\n\nCloses #7\n\n*ProPR*',
        template: { kind: 'propr', path: '.propr/pr-template.md' },
    });
});

test('describePullRequest falls back to the default description and reports template errors', async () => {
    const reported: string[] = [];
    for (const loadTemplate of [
        async () => { throw new Error('contents API failed'); },
        async () => ({ kind: 'propr' as const, path: '.propr/pr-template.md', template: { sections: { summary: '{{unknown}}' }, problems: [] } }),
        async () => ({ kind: 'propr' as const, path: '.propr/pr-template.md', template: { sections: {}, problems: [{ kind: 'too_large' as const, message: 'too large' }] } }),
    ]) {
        const description = await describePullRequest({ pieces, defaultTitle: 'default', values, loadTemplate, onError: message => { reported.push(message); } });
        assert.equal(description.title, 'default');
        assert.equal(description.body, defaultPrBody(pieces));
        assert.ok(description.error);
    }
    assert.deepEqual(reported, ['contents API failed', 'Unknown placeholder {{unknown}}', 'too large']);
    // A failing reporter must not fail the run either.
    const description = await describePullRequest({ pieces, defaultTitle: 'default', values, loadTemplate: async () => { throw new Error('x'); }, onError: () => { throw new Error('timeline down'); } });
    assert.equal(description.body, defaultPrBody(pieces));
});

test('describePullRequest without a template is the default description', async () => {
    assert.deepEqual(await describePullRequest({ pieces, defaultTitle: 'default', values, loadTemplate: async () => undefined }), { title: 'default', body: defaultPrBody(pieces) });
});

test('generateCompletionComment is its parts joined in order', async () => {
    const result = { success: true, summary: 'Done.', repositoryValidation: '**Validation:** ok', finalResult: { cost_usd: 0.5 }, executionTime: 61_000 };
    const issueRef = { number: 3, repoOwner: 'acme', repoName: 'app' };
    const parts = await generateCompletionCommentParts(result, issueRef);
    const comment = await generateCompletionComment(result, issueRef);
    // Execution details carry a minute-precision timestamp; compare without it.
    const strip = (text: string) => text.replace(/- Timestamp: .*\n/, '');
    assert.equal(strip(comment), strip(`${parts.run}${parts.summary}${parts.validation}${parts.logs}---\n${parts.trailer}`));
    assert.match(parts.trailer, /^\*This PR was created automatically/);
    assert.deepEqual(parts.stats, { executionTime: '1m 1s', totalTokens: 0, cost: 0.5 });
});
