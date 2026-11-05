import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { closeConnection } from '@propr/core';
import { runRepositoryWorkflow } from '../src/jobs/repositoryWorkflow.js';
import { extensionLaunchIntegrationFixture } from './fixtures/extensionLaunchIntegration.js';
after(closeConnection);

test('the issue workflow captures the enforced policy before extension preparation', async t => {
  const fixture = await extensionLaunchIntegrationFixture(); t.after(fixture.cleanup);
  const result = await runRepositoryWorkflow({ taskId: 'issue-extension-policy', repoOwner: 'acme', repoName: 'web', redisClient: {} as any, stateManager: { getTaskState: async () => ({ state: 'claude_execution' }) } as any, correlatedLogger: { warn() {} } as any },
    () => fixture.execute({ extensionProfile: fixture.selection, extensionActorId: '1', taskId: 'issue-extension-policy', issueRef: { repoOwner: 'acme', repoName: 'web', number: 1 }, worktreePath: '/unused', prompt: 'Check documentation', githubToken: '' }));
  assert.equal(result.success, true);
  assert.equal(fixture.captures(), 1);
});


test('submission resume retains extension authority at worker pickup before and after queue acknowledgement', async t => {
  const fixture = await extensionLaunchIntegrationFixture(); t.after(fixture.cleanup);
  const { database } = fixture;
  const { up } = await import('../packages/core/src/db/migrations/20260922000000_add_task_submissions.js');
  const { up: identity } = await import('../packages/core/src/db/migrations/20260922010000_preserve_task_submission_identity.js');
  await up(database); await identity(database);
  await database.schema.alterTable('task_submissions', c => c.text('extension_authorization'));
  const { insertTaskSubmission, sealSubmissionExtensions, resumeTaskSubmission, associateSubmissionTask, findIssueSubmission, submissionExtensionsForRun } = await import('../packages/core/src/services/taskSubmissionService.js');
  const environment = { SYSTEM_TASK_SECRET: 'synthetic-integration-custody' };
  for (const earlyPickup of [true, false]) {
    const number = earlyPickup ? 2 : 3;
    const taskId = `submission-extension-${number}`;
    const issueRef = { repoOwner: 'acme', repoName: 'web', number };
    const row = await insertTaskSubmission(database, { user_id: '1', submission_key: taskId, payload_hash: taskId, repository: 'acme/web', attachments: '[]', payload: JSON.stringify({ instruction: 'Check docs', agentAlias: 'claude', model: 'synthetic', extensionProfile: fixture.selection }) });
    await sealSubmissionExtensions(database, row, environment);
    const pickup = async (expectedState: string) => {
      const saved = await findIssueSubmission(issueRef as any, database);
      assert.equal(saved!.state, expectedState);
      const extensions = submissionExtensionsForRun(saved, { taskId, agentAlias: 'claude', model: 'synthetic', repository: 'acme/web', issueNumber: number }, environment);
      assert.deepEqual(extensions.extensionProfile, fixture.selection);
      const result = await runRepositoryWorkflow({ taskId, repoOwner: 'acme', repoName: 'web', redisClient: {} as any, stateManager: { getTaskState: async () => ({ state: 'claude_execution' }) } as any, correlatedLogger: { warn() {} } as any },
        () => fixture.execute({ ...extensions, taskId, issueRef, worktreePath: '/unused', prompt: 'Check docs', githubToken: '' }));
      assert.equal(result.success, true);
    };
    const resumed = await resumeTaskSubmission(database, row.id, {
      createIssue: async () => ({ number, url: `https://github.com/acme/web/issues/${number}` }),
      reconcileIssue: async () => null,
      dispatch: async () => {
        await associateSubmissionTask(database, row.id, taskId);
        if (earlyPickup) await pickup('issue_created');
      },
    });
    assert.equal(resumed.state, 'queued');
    if (!earlyPickup) await pickup('queued');
  }
  assert.equal(fixture.captures(), 2);
});
