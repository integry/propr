import assert from 'node:assert/strict';
import { after, mock, test } from 'node:test';

/**
 * A run flagged unfinished that committed nothing must not be published as
 * confirmed completion: neither the issue comment's headline nor its report
 * may claim the work was already complete or point at committed changes.
 */
process.env.PROPR_DEMO_MODE = 'true';

const published: string[] = [];
await mock.module('../src/jobs/noChangeCompletion.js', {
  namedExports: {
    completeNoChangeIssue: async (options: { comment: string }) => { published.push(options.comment); },
  },
});

const { closeConnection } = await import('@propr/core');
const { handleNoCodeChanges } = await import('../src/jobs/issueJobPostProcessingHelpers.ts');
const { redisClient } = await import('../src/jobs/issueJob/config.ts');
const { buildCompletionComment } = await import('../src/jobs/prCompletionComment.ts');

after(async () => {
  redisClient.disconnect();
  await closeConnection();
});

const log = { info() {}, debug() {}, warn() {}, error() {} };
const WAITING = 'Tests are still running in the background; I will report back once they finish.';
const REASON = 'Still waiting for the background test run.';

async function publishNoChange(claudeResult: Record<string, unknown>): Promise<string> {
  published.length = 0;
  await handleNoCodeChanges({
    octokit: { request: async () => ({}) } as never,
    issueRef: { number: 7, repoOwner: 'o', repoName: 'r' } as never,
    claudeResult: { executionTime: 1, conversationLog: [], modifiedFiles: [], ...claudeResult } as never,
    currentIssueData: { data: { labels: [{ name: 'AI' }] } },
    AI_PROCESSING_TAG: 'AI-processing',
    AI_DONE_TAG: 'AI-done',
    correlatedLogger: log as never,
  });
  assert.equal(published.length, 1);
  return published[0];
}

test('the no-change issue comment of an unfinished run does not claim the work was complete', async () => {
  const comment = await publishNoChange({ success: true, summary: WAITING, unfinishedReason: REASON });
  assert.doesNotMatch(comment, /✅/);
  assert.doesNotMatch(comment, /already complete/);
  assert.match(comment, /^⚠️ \*\*No code changes were committed, and the agent did not confirm the work was complete\.\*\*/);
  assert.match(comment, /AI Processing Ended Unconfirmed/);
  assert.match(comment, /The run ended before the agent confirmed completion\.\*\* Still waiting for the background test run\./);
  assert.match(comment, /No changes were committed, so the requested work may still be outstanding\./);
  assert.doesNotMatch(comment, /[Cc]ommitted changes/);
  assert.doesNotMatch(comment, /committed diff/);
  assert.match(comment, /\*\*Last agent update:\*\*\nTests are still running/);
});

test('the no-change issue comment of a finished run keeps its success headline', async () => {
  const comment = await publishNoChange({ success: true, summary: 'The fix was already on the default branch.' });
  assert.match(comment, /^✅ \*\*No code changes needed - the implementation was already complete\.\*\*/);
  assert.match(comment, /AI Processing Completed/);
  assert.doesNotMatch(comment, /confirmed completion/);
});

test('the no-change follow-up comment of an unfinished run does not claim nothing was needed', async () => {
  const comment = await buildCompletionComment(null, [], {
    changesSummary: WAITING, commitMessage: null, llm: 'm', authorsText: '@a',
  } as never, {
    success: true, summary: WAITING, unfinishedReason: REASON, modifiedFiles: [], executionTime: 1, conversationLog: [],
  } as never);
  assert.match(comment, /The run ended before the agent confirmed completion\.\*\* Still waiting/);
  assert.match(comment, /No changes were committed, so the requested work may still be outstanding\./);
  assert.match(comment, /No code changes were committed\.\n/);
  assert.doesNotMatch(comment, /No code changes were necessary/);
  assert.doesNotMatch(comment, /Review the committed changes/);
});
