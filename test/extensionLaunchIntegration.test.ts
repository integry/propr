import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { closeConnection } from '@propr/core';
import { runRepositoryWorkflow } from '../src/jobs/repositoryWorkflow.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildDockerArgs as buildClaudeDockerArgs } from '../packages/core/src/agents/impl/utils/dockerArgsBuilder.js';
import { buildCodexDockerArgs } from '../packages/core/src/agents/impl/utils/codexDockerArgsBuilder.js';
import { PROPR_MCP_BEARER_TOKEN_ENV, PROPR_MCP_SERVER_NAME } from '../packages/core/src/agents/agentToolPolicy.js';
import type { AgentConfig, AgentTaskOptions } from '@propr/core';
import { extensionLaunchIntegrationFixture } from './fixtures/extensionLaunchIntegration.js';
after(closeConnection);

test('the issue workflow captures the enforced policy before extension preparation', async t => {
  const fixture = await extensionLaunchIntegrationFixture(); t.after(fixture.cleanup);
  const result = await runRepositoryWorkflow({ taskId: 'issue-extension-policy', repoOwner: 'acme', repoName: 'web', redisClient: {} as any, stateManager: { getTaskState: async () => ({ state: 'claude_execution' }) } as any, correlatedLogger: { warn() {} } as any },
    () => fixture.execute({ extensions: { autoApply: false, ...fixture.extensions }, taskId: 'issue-extension-policy', issueRef: { repoOwner: 'acme', repoName: 'web', number: 1 }, worktreePath: '/unused', prompt: 'Check documentation', githubToken: '' }));
  assert.equal(result.success, true);
  assert.equal(fixture.captures(), 1);
});


test('a queued legacy submission resumes with its migrated extension items at worker pickup before and after queue acknowledgement', async t => {
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
      const extensions = await submissionExtensionsForRun(saved, { taskId, agentAlias: 'claude', model: 'synthetic', repository: 'acme/web', issueNumber: number }, environment, database);
      assert.deepEqual(extensions.extensions, { autoApply: false, servers: ['docs'], skills: [], repositories: ['acme/web'], allowWrite: false });
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

test('extension preparation keeps the ProPR MCP network through to the Claude and Codex containers', async t => {
  const fixture = await extensionLaunchIntegrationFixture(); t.after(fixture.cleanup);
  const previousContainerized = process.env.PROPR_CONTAINERIZED; process.env.PROPR_CONTAINERIZED = '0';
  const codexConfigPath = mkdtempSync(join(tmpdir(), 'propr-extension-network-codex-'));
  t.after(() => { rmSync(codexConfigPath, { recursive: true, force: true }); if (previousContainerized === undefined) delete process.env.PROPR_CONTAINERIZED; else process.env.PROPR_CONTAINERIZED = previousContainerized; });
  const agent = { enabled: true, dockerImage: 'propr/agent:latest', supportedModels: ['synthetic'], defaultModel: 'synthetic' };
  const claudeConfig = { ...agent, id: 'claude', type: 'claude', alias: 'claude', configPath: '~/.claude' } as AgentConfig;
  const codexConfig = { ...agent, id: 'codex', type: 'codex', alias: 'codex', configPath: codexConfigPath } as AgentConfig;
  const toolPolicy = { allowWeb: false, dockerNetwork: 'propr_propr-agent-mcp', mcpServers: [{ name: PROPR_MCP_SERVER_NAME, url: 'http://api:4000/api/mcp', bearerTokenEnv: PROPR_MCP_BEARER_TOKEN_ENV, bearerToken: 'propr_mcp_run_token_abcdef0123456789' }] };
  let prepared: AgentTaskOptions | undefined;
  const result = await fixture.execute({ extensions: { autoApply: true, ...fixture.extensions }, taskId: 'agent-run-extension-network', issueRef: { repoOwner: 'acme', repoName: 'web', number: 1 }, worktreePath: '/unused', prompt: 'Check documentation', githubToken: '', toolPolicy }, { networkMode: 'open', inspect: options => { prepared = options; } });
  assert.equal(result.success, true);
  assert.equal(prepared!.toolPolicy!.dockerNetwork, 'propr_propr-agent-mcp');
  assert.ok(prepared!.toolPolicy!.mcpServers!.some(s => s.name === PROPR_MCP_SERVER_NAME && s.url === 'http://api:4000/api/mcp'));
  const params = { worktreePath: '/tmp/worktree', githubToken: '', issueNumber: 1, taskId: 'agent-run-extension-network', toolPolicy: prepared!.toolPolicy };
  for (const args of [buildClaudeDockerArgs(claudeConfig, 100, params), buildCodexDockerArgs(codexConfig, params)]) {
    assert.equal(args[args.indexOf('--network') + 1], 'propr_propr-agent-mcp');
    assert.ok(!args.includes('bridge'));
  }
});

test('a label-started issue task and a pull request follow-up resolve auto-applied library items at launch', async t => {
  const fixture = await extensionLaunchIntegrationFixture(); t.after(fixture.cleanup);
  const { taskRunExtensionRequest } = await import('../packages/core/src/extensions/extensionRunResolution.js');
  // Queued before the item applies automatically; the launch uses the library as it is then.
  const queued = [taskRunExtensionRequest({ kind: 'issue', repository: 'acme/web', labels: [{ name: 'AI' }] }), taskRunExtensionRequest({ kind: 'pull_request', repository: 'acme/web', labels: ['AI'] })];
  const { enable } = await fixture.lateEnabledAutoApply();
  await enable();
  for (const [index, extensions] of queued.entries()) {
    const taskId = `auto-apply-${index}`;
    let prepared: AgentTaskOptions | undefined;
    const result = await runRepositoryWorkflow({ taskId, repoOwner: 'acme', repoName: 'web', redisClient: {} as any, stateManager: { getTaskState: async () => ({ state: 'claude_execution' }) } as any, correlatedLogger: { warn() {} } as any },
      () => fixture.execute({ extensions, taskId, issueRef: { repoOwner: 'acme', repoName: 'web', number: 1 }, worktreePath: '/unused', prompt: 'Check documentation', githubToken: '' }, { inspect: options => { prepared = options; } }));
    assert.equal(result.success, true);
    assert.deepEqual(prepared!.toolPolicy!.mcpServers!.map(s => s.name), ['docs']);
  }
  assert.equal(fixture.captures(), 2);
});
