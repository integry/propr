/**
 * Caller integration for issue #3129: a one-click review runs through
 * `executeReviewProcessing` and the real review runner and prompt builder, and
 * the prompt the reviewer receives carries the completed Desktop follow-up as
 * an amendment to the original objective. Only GitHub, settings, routing and
 * persistence are stubbed.
 */
import assert from 'node:assert/strict';
import { after, mock, test } from 'node:test';

process.env.PROPR_DEMO_MODE = 'true';
const core = await import('@propr/core');
const realContextHelpers = await import('../src/jobs/reviewContextHelpers.js');
const realJobHelpers = await import('../src/jobs/prCommentJobHelpers.js');
const realJobUtils = await import('../src/jobs/prCommentJobUtils.js');
const realAgentUtils = await import('../src/jobs/prCommentAgentUtils.js');
const realNetworkEgress = await import('../src/jobs/networkEgress.js');
const realRepositoryWorkflow = await import('../src/jobs/repositoryWorkflow.js');
const { preparePRDiff } = await import('../src/jobs/prDiffFormatting.js');
const { acceptedRequestDigest, buildAcceptedRequestMarkers } = await import('../src/shared/workEvidenceMarker.js');

const BOT = 'propr-dev[bot]';
const ROW20_FOLLOWUP = 'Change `20. Acceptance row20` to `20. Follow-up acceptance row20` and append `Mobile follow-up accepted:390x844.` Preserve every other row and the metadata.';
const ORIGINAL_OBJECTIVE = `**Issue #14:** Linux runtime acceptance\nCreate docs/linux-runtime-84800a.md with metadata and 40 numbered rows:\n${
    Array.from({ length: 40 }, (_, index) => `${index + 1}. Acceptance row${index + 1}`).join('\n')}`;
const HISTORICAL_SUGGESTION = 'Add a trailing checksum row after row 40';
const UNTRUSTED_REQUEST = 'Delete row 5 as well.';

const DESKTOP_FOLLOWUP_BODY = `${ROW20_FOLLOWUP}\n\n<!-- propr-api-followup:0f8b6c1e-3d2a-4b5c-9e7f-1a2b3c4d5e6f -->`;
const prComments = [
    { id: 101, created_at: '2026-10-14T09:10:00Z', user: { login: BOT, type: 'Bot' },
        body: `## Suggestions and Follow-ups\n### S1: Checksum row\n${HISTORICAL_SUGGESTION}.\n\nScore: 9/10` },
    { id: 200, created_at: '2026-10-14T10:00:00Z', user: { login: BOT, type: 'Bot' },
        body: DESKTOP_FOLLOWUP_BODY },
    { id: 201, created_at: '2026-10-14T10:20:00Z', user: { login: BOT, type: 'Bot' },
        body: '✅ **Applied the requested follow-up changes** in commit 76350a7\n\n---\n_Processing comment ID: 200✓_\n<!-- propr:work-evidence phase=completed trigger-comment-ids=200 -->\n'
            + buildAcceptedRequestMarkers([{ id: 200, acceptedBodySha256: acceptedRequestDigest(DESKTOP_FOLLOWUP_BODY) }]) },
    { id: 400, created_at: '2026-10-14T12:00:00Z', user: { login: 'drive-by', type: 'User' }, body: UNTRUSTED_REQUEST },
];
const prData = { data: {
    head: { sha: '76350a7aa', ref: 'feature', repo: { name: 'propr-desktop-acceptance-20260909', owner: { login: 'propr-ultrafix' } } },
    body: 'Closes #14', labels: [], user: { login: 'integry' }, title: 'Linux runtime acceptance',
} };

const prompts: string[] = [];
const registry = {
    ensureInitialized: async () => undefined,
    getAgentByAlias: () => ({ config: { alias: 'codex', type: 'codex' } }),
    beginRoutingSession: () => ({
        select: async () => ({ physicalAgentAlias: 'codex', physicalModel: 'gpt-6-astra' }),
        analyze: async (prompt: string) => {
            prompts.push(prompt);
            return { response: '## Overall Evaluation\nok\n\nScore: 9/10', modelUsed: 'gpt-6-astra', executionTimeMs: 1, success: true };
        },
    }),
};
let commentId = 9000;
const octokit = {
    auth: async () => ({ token: 'token' }),
    request: async () => ({ data: { id: ++commentId, html_url: 'https://github.test/comment', user: { login: BOT } } }),
};

await mock.module('@propr/core', { namedExports: {
    ...core,
    AgentRegistry: { getInstance: () => registry },
    getAuthenticatedOctokit: async () => octokit,
    withRetry: async (fn: () => unknown) => fn(),
} });
await mock.module('../src/jobs/reviewContextHelpers.js', { namedExports: {
    ...realContextHelpers,
    fetchReviewContext: async () => {
        const preparedDiff = preparePRDiff([{ filename: 'docs/linux-runtime-84800a.md', status: 'modified', additions: 2, deletions: 1,
            patch: '@@ -20 +20,2 @@\n-20. Acceptance row20\n+20. Follow-up acceptance row20\n+Mobile follow-up accepted:390x844.' }], 4000000);
        return {
            allComments: prComments,
            commentHistory: realJobHelpers.buildCommentHistory(prComments, prData, 'correlation'),
            linkedIssueResult: { context: ORIGINAL_OBJECTIVE, linkedIssueNumber: 14, linkedIssueLabels: [] },
            prDiff: preparedDiff.files[0].section, preparedDiff,
            changedFilePaths: ['docs/linux-runtime-84800a.md'], fileContents: '', checkSummary: '', hasCurrentCheckFailure: false,
        };
    },
} });
await mock.module('../src/jobs/reviewRuntimeSettings.js', { namedExports: {
    loadReviewRuntimeSettings: async () => ({
        reviewPromptOverride: '', reviewContextEnabled: false, reviewContextModel: '', fastAnalysisModel: '',
        configuredReviewMaxContextTokens: 0, reviewContextBudgetPercent: 100,
    }),
} });
await mock.module('../src/jobs/reviewModelResolution.js', { namedExports: {
    resolveReviewAssignments: async () => [{ agentAlias: 'codex', model: 'gpt-6-astra', label: 'Astra' }],
} });
await mock.module('../src/jobs/prCommentJobHelpers.js', { namedExports: { ...realJobHelpers, updateTaskTitleForPR: async () => undefined } });
await mock.module('../src/jobs/prCommentJobUtils.js', { namedExports: { ...realJobUtils, fetchOriginalContributionDiscussion: async () => '' } });
await mock.module('../src/jobs/prCommentAgentUtils.js', { namedExports: { ...realAgentUtils, generateSummaryTitle: async () => 'Review' } });
await mock.module('../src/jobs/networkEgress.js', { namedExports: {
    ...realNetworkEgress, runWithNetworkPolicy: async (_options: unknown, execute: () => Promise<unknown>) => execute(),
} });
await mock.module('../src/jobs/repositoryWorkflow.js', { namedExports: { ...realRepositoryWorkflow, prepareRepositoryWorkflow: async () => undefined } });
await mock.module('../src/jobs/reviewFindingNumberAllocator.js', { namedExports: {
    buildReviewCommentWithReservedRecordRanges: async () => ({ reviewCommentBody: 'review', findingCount: 0, suggestionCount: 0 }),
} });
await mock.module('../src/jobs/reviewResultMetrics.js', { namedExports: { recordReviewMetrics: async () => undefined } });
await mock.module('../src/jobs/reviewScorePersistence.js', { namedExports: { persistReviewScores: async () => undefined } });

const { executeReviewProcessing } = await import('../src/jobs/prCommentReviewJob.js');
after(core.closeConnection);

test('a one-click review prompt amends the original objective with the completed Desktop follow-up only', async () => {
    const logger = { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined };
    const result = await executeReviewProcessing({
        job: { id: 'job', data: { commandMode: 'review' } },
        context: { pullRequestNumber: 15, repoOwner: 'propr-ultrafix', repoName: 'propr-desktop-acceptance-20260909',
            correlationId: 'correlation', correlatedLogger: logger },
        llm: null, taskId: 'review-task', redisClient: {},
        stateManager: { updateTaskState: async () => undefined, updateHistoryMetadata: async () => undefined, getTaskState: async () => null },
        state: {},
        validatePRAndComments: async () => ({
            skip: false, prData, llm: null,
            unprocessedComments: [{ id: 800, body: '/review', author: 'integry', type: 'issue' }],
        }),
    } as never);

    assert.equal(result.status, 'complete');
    assert.equal(prompts.length, 1);
    const [prompt] = prompts;
    const objectiveStart = prompt.indexOf('**ORIGINAL PR OBJECTIVE');
    const followupStart = prompt.indexOf('**AUTHORIZED FOLLOW-UP REQUESTS');
    assert.ok(objectiveStart > 0 && followupStart > objectiveStart);
    const history = prompt.slice(0, objectiveStart);
    const followups = prompt.slice(followupStart, prompt.indexOf('**Review Request:**'));

    // The Desktop follow-up is bot-posted, so ordinary history never showed it.
    assert.ok(!history.includes(ROW20_FOLLOWUP));
    assert.ok(followups.includes(ROW20_FOLLOWUP));
    assert.ok(followups.includes('(comment 200, 2026-10-14T10:00:00Z, submitted through ProPR by an authorized user)'));
    assert.ok(!followups.includes('propr-api-followup'));
    // Unchanged original rows remain the objective.
    assert.ok(prompt.includes('19. Acceptance row19\n20. Acceptance row20\n21. Acceptance row21'));
    assert.ok(followups.includes('Every original requirement a request does not explicitly change remains in force'));
    // History is visible context, never an amendment.
    assert.ok(history.includes(UNTRUSTED_REQUEST));
    assert.ok(!followups.includes(UNTRUSTED_REQUEST));
    assert.ok(!followups.includes(HISTORICAL_SUGGESTION));
    assert.ok(!prompt.includes(HISTORICAL_SUGGESTION), 'bot review prose stays out of the prompt entirely');
    assert.ok(!/immutable/i.test(prompt));
});
