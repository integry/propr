import assert from 'node:assert/strict';
import { after, mock, test } from 'node:test';

process.env.PROPR_DEMO_MODE = 'true';

// The configuration store cannot be read here; the repository shows the status in titles (the default).
await mock.module('../src/config/repositoryPrTitleStatusSetting.js', { namedExports: {
    loadRepositoryPrTitleStatus: async () => true,
    resolveRepositoryPrTitleStatus: () => true,
} });

const { closeConnection } = await import('../src/db/connection.js');
const { createEpicPRWithDraftFallback } = await import('../src/services/epicPRService.js');
const { disablePullRequestStatusSync, enablePullRequestStatusSync } = await import('../src/services/pullRequestStatus/pullRequestStatusSync.js');

after(async () => {
    disablePullRequestStatusSync();
    await closeConnection();
});

function recordingOctokit() {
    const created: Array<Record<string, unknown>> = [];
    const octokit = {
        request: async (_route: string, parameters: Record<string, unknown>) => {
            created.push(parameters);
            return { data: { number: 900, html_url: 'https://github.com/integry/propr/pull/900' } };
        },
    };
    return { created, octokit: octokit as unknown as Parameters<typeof createEpicPRWithDraftFallback>[0] };
}

test('a new epic PR is created with 🔨 0/N before [Epic] and the status block in its body', async () => {
    enablePullRequestStatusSync({ redis: null });
    const { created, octokit } = recordingOctokit();
    await createEpicPRWithDraftFallback(octokit, {
        owner: 'integry', repo: 'propr', title: '[Epic] Scheduler primitives', head: '800-epic-scheduler-primitives-x7y', base: 'main',
        body: '## Epic PR', progress: { merged: 0, total: 5 }, nextIssue: 800,
    });
    assert.equal(created[0].title, '🔨 0/5 [Epic] Scheduler primitives');
    assert.match(String(created[0].body), /^<!-- propr:pr-status -->\n\*\*ProPR\*\* 🔨 0 of 5 issues merged · #800 starts next · updated \d{2}:\d{2} UTC\n<!-- \/propr:pr-status -->\n\n## Epic PR$/);
    assert.equal('progress' in created[0], false, 'only GitHub fields are sent');
});

test('without status maintenance the epic PR is created exactly as given', async () => {
    disablePullRequestStatusSync();
    const { created, octokit } = recordingOctokit();
    await createEpicPRWithDraftFallback(octokit, {
        owner: 'integry', repo: 'propr', title: '[Epic] Plan', head: '800-epic-plan-branch-x7y', base: 'main', body: 'body', progress: { merged: 0, total: 2 },
    });
    assert.equal(created[0].title, '[Epic] Plan');
    assert.equal(created[0].body, 'body');
});
