/* eslint-disable max-lines -- both MCP SDK eras share one end-to-end workflow fixture */
import assert from 'node:assert/strict';
import { test, mock } from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { Client as LegacyClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport as LegacyTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import type { McpPrincipal } from '../mcp/policy.js';
import type { CommentJobData, StopTaskExecutionOptions, UnprocessedComment } from '@propr/core';
import type { ToolDeps } from '../mcp/tools.js';
import { withLiveOutputReads } from './liveOutputRedisFake.js';

test('both SDK eras drive persisted goal, TODO, notification, settings and guarded PR workflows', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'propr-mcp-workflows-'));
  process.env.DATA_DIR = root;
  process.env.DB_FILENAME = path.join(root, 'propr.sqlite');
  process.env.NODE_ENV = 'test';
  const core = await import('@propr/core');
  const issueJobs: Array<{ name: string; data: Record<string, unknown> }> = [];
  let queueFailure = false;
  const queueStates = new Map<string, string>();
  const issueQueue = { getJobs: async () => [], getJob: async (id: string) => queueStates.has(id) ? { getState: async () => queueStates.get(id) } : undefined, add: async (name: string, data: Record<string, unknown>, options?: { jobId?: string }) => { if (queueFailure) throw new Error('Queue connection lost after write'); issueJobs.push({ name, data }); if (options?.jobId) queueStates.set(options.jobId, 'waiting'); return { id: options?.jobId || String(issueJobs.length) }; } };
  const cacheReads: string[] = [];
  const cancellationRequests = new Map<string, { requestedBy: string; reason: unknown }>();
  let githubBoundary: unknown;
  // Only outbound GitHub, Git transport, queue and Redis boundaries are fixtures. Catalog, handlers,
  // label orchestration, authorization and SQLite persistence remain the real code.
  const boundary = await mock.module('@propr/core', { namedExports: { ...core,
    getAuthenticatedOctokit: async () => githubBoundary,
    getIssueQueue: async () => issueQueue, getIndexingQueue: async () => issueQueue, issueQueue,
    stopTaskExecution: (taskId: string, options: StopTaskExecutionOptions) => core.stopTaskExecution(taskId, {
      ...options,
      // The shared helper imports these dependencies internally, bypassing the barrel mock.
      getQueue: async () => issueQueue,
      markCancelled: async (id, requestedBy, metadata) => {
        cancellationRequests.set(id, { requestedBy, reason: metadata.historyMetadata?.cancellationReason });
        // Exercise the abort-signal fallback. The cancellation fixture supplies the
        // worker's eventual terminal outcome, including completion/failure races.
        throw new Error('Fixture cancellation state store unavailable');
      },
    }),
    ensureRepoCloned: async () => root, fetchLatestChanges: async () => ({ success: true }), publishIndexingStatus: async () => {},
    getStoredFileChanges: async (taskId: string) => { cacheReads.push(taskId); return { taskId, lastUpdated: new Date().toISOString(), files: [{ path: 'src/retry.ts', linesAdded: 1, linesRemoved: 0, status: 'modified', diff: '+Handle transient failures\n' }] }; },
  } });
  const plannerSignals = new Map<string, string>();
  const abortHandlers = await import('../routes/plannerAbortHandlers.js');
  const signals = {
    setAbortSignal: async (draftId: string, runId?: string) => { plannerSignals.set(core.buildPlannerAbortSignalKey(draftId, runId), '1'); },
    clearAbortSignal: async (draftId: string, runId?: string) => { plannerSignals.delete(core.buildPlannerAbortSignalKey(draftId, runId)); },
  };
  const redisBoundary = await mock.module('../routes/plannerAbortHandlers.js', { namedExports: { ...abortHandlers,
    createAbortGenerationHandler: (db: ToolDeps['db']) => abortHandlers.createAbortGenerationHandler(db, signals),
    createAbortRefinementHandler: (db: ToolDeps['db']) => abortHandlers.createAbortRefinementHandler(db, signals),
  } });
  const { verifyCancellation } = await import('./fixtures/mcpCancellation.js');
  const { verifyInboxNotifications } = await import('./fixtures/mcpNotifications.js');
  const { McpStore } = await import('../mcp/store.js');
  const { McpOAuthProvider } = await import('../mcp/oauth.js');
  const { McpPolicy } = await import('../mcp/policy.js');
  const { createToolCatalog } = await import('../mcp/tools.js');
  const { buildMcpServer } = await import('../mcp/server.js');
  const { db } = core;
  let server: ReturnType<typeof createServer> | undefined;
  const attachmentDirectories: string[] = [];
  const registry = core.AgentRegistry.getInstance();
  const agent = { config: { id: 'fixture-agent', alias: 'claude', type: 'claude', enabled: true, supportedModels: ['fixture-model'], defaultModel: 'fixture-model' } };
  const stubs = [mock.method(registry, 'ensureInitialized', async () => {}), mock.method(registry, 'getAgentById', () => agent as never), mock.method(registry, 'getAgentByAlias', () => agent as never)];
  try {
    await core.runMigrations();
    await core.saveAgents([agent.config as never]);
    await core.saveSettings({ default_agent_alias: 'claude' });
    await core.saveMonitoredRepos([{ id: randomUUID(), name: 'acme/repo', enabled: true, baseBranch: 'main' }]);
    const config = { origin: 'https://instance.example', resource: 'https://instance.example/api/mcp', instanceId: 'fixture-instance', encryptionKey: randomBytes(32) };
    const policy = new McpPolicy(new McpOAuthProvider(new McpStore(db, config.encryptionKey), config), config);
    let head = 'a'.repeat(40), checks = 'SUCCESS', mergeState = 'CLEAN', merged = false;
    const comments: string[] = [];
    const discussion: Array<{ id: number; body: string; html_url: string; issue_url: string; created_at: string; user: { login: string } }> = [];
    const issues: Array<{ number: number; title: string; labels: string[] }> = [];
    const github = {
      auth: async () => ({ token: 'fixture-installation' }),
      request: async (route: string, args: Record<string, unknown>) => {
        if (route === 'POST /repos/{owner}/{repo}/issues') { const issue = { number: issues.length + 1, title: String(args.title), labels: args.labels as string[] }; issues.push(issue); return { data: { ...issue, html_url: `https://github.com/acme/repo/issues/${issue.number}` } }; }
        if (route.includes('/labels')) {
          const issue = issues.find(issue => issue.number === args.issue_number)!;
          if (route.startsWith('DELETE')) issue.labels = issue.labels.filter(label => label !== args.name);
          else issue.labels.push(...args.labels as string[]);
          return { data: issue.labels };
        }
        if (route === 'GET /repos/{owner}/{repo}') return { data: { permissions: { push: true } } };
        if (route === 'GET /repos/{owner}/{repo}/pulls/{pull_number}') return { data: { number: args.pull_number, title: 'Fixture PR', body: 'Improve reliability', state: 'open', draft: false, merged, head: { sha: head }, base: { ref: 'main' }, html_url: 'https://github.com/acme/repo/pull/42' } };
        if (route.endsWith('/reviews')) return { data: [{ id: 1, state: 'APPROVED', body: 'Reviewed', commit_id: head }] };
        if (route.endsWith('/check-runs')) return { data: { check_runs: [{ name: 'tests', status: 'completed', conclusion: checks.toLowerCase() }] } };
        if (route === 'GET /repos/{owner}/{repo}/issues/{issue_number}/comments') return { data: discussion.slice((Number(args.page) - 1) * Number(args.per_page), Number(args.page) * Number(args.per_page)) };
        if (route === 'GET /repos/{owner}/{repo}/issues/comments/{comment_id}') return { data: discussion.find(comment => comment.id === args.comment_id)! };
        if (route === 'POST /repos/{owner}/{repo}/issues/{issue_number}/comments') { comments.push(String(args.body)); return { data: { id: comments.length, html_url: 'https://github.com/acme/repo/pull/42#issuecomment-1' } }; }
        if (route.endsWith('/update-branch')) { assert.equal(args.expected_head_sha, head); head = 'b'.repeat(40); return { data: { message: 'Updated branch', url: 'https://github.com/acme/repo/pull/42' } }; }
        if (route.endsWith('/merge')) { assert.equal(args.sha, head); assert.equal(checks, 'SUCCESS'); assert.equal(mergeState, 'CLEAN'); merged = true; return { data: { merged, sha: head } }; }
        throw new Error(`Unexpected GitHub fixture request: ${route}`);
      },
      graphql: async () => ({ repository: { pullRequest: { headRefOid: head, mergeStateStatus: mergeState, reviewDecision: 'APPROVED', commits: { nodes: [{ commit: { statusCheckRollup: { state: checks } } }] } } } }),
    };
    githubBoundary = github;
    const permissions = ['instance.manage_settings', 'instance.manage_agents', 'instance.manage_runtime', 'instance.manage_members'] as const;
    const scopes = ['read', 'plan', 'publish', 'execute', 'review', 'merge', 'manage'] as const;
    const principal = { user: { id: '123', username: 'fixture-user', login: 'fixture-user', displayName: 'Fixture user', email: null, avatarUrl: null, accessToken: 'fixture-github' }, authorization: { role: 'admin', source: 'local', permissions: [...permissions] },
      scopes: [...scopes], github, grant: { id: 'workflow-grant', ownerId: '123', clientId: 'fixture-client', clientName: 'Fixture', instanceId: config.instanceId, resource: config.resource, scopes: [...scopes], repositories: ['acme/repo'], createdAt: Date.now(), expiresAt: Date.now() + 60000, revoked: false, membershipSource: 'local' } } as McpPrincipal;
    let stopGoalImmediately = true;
    const jobs: Array<Record<string, unknown>> = [];
    const redisValues = new Map<string, string>();
    const pendingComments = new Map<string, string[]>();
    const liveOutputRedis = withLiveOutputReads({ get: async (key: string) => redisValues.get(key) ?? null });
    const evalRedis = async (script: string, options: number | { keys: string[]; arguments: string[] }, key = '') => {
      // Live-output reads use node-redis options; pending-comment claims use ioredis arguments.
      if (typeof options !== 'number' && options.keys[0].startsWith('agent:output:')) {
        return liveOutputRedis.eval(script, options);
      }
      if (script.includes('return comments')) {
        const claimed = pendingComments.get(key) ?? [];
        if (claimed.length > 0) pendingComments.delete(key);
        return claimed;
      }
      return 1;
    };
    const { cleanupJob } = await import('../../../src/jobs/prCommentJobUtils.js');
    const { pickUpPendingCommentsWithClaim, applyPendingCommentCommandContext } = await import('../../../src/jobs/prPendingComments.js');
    const { updateTaskTitleForPR } = await import('../../../src/jobs/prCommentJobHelpers.js');
    const correlatedLogger = core.logger.withCorrelation('mcp-pending-regression');
    const stateManager = { updateIssueRef: async () => {}, getTaskState: async () => null } as unknown as InstanceType<typeof core.WorkerStateManager>;
    const deps: ToolDeps = { db, policy, taskQueue: { add: async (_name: string, data: Record<string, unknown>) => { jobs.push(data); return { id: String(jobs.length) }; }, getJobs: async () => [] } as never,
      redisClient: { rPush: async () => 1, lPush: async () => 1, lTrim: async () => 'OK', sMembers: async () => [], get: async (key: string) => redisValues.get(key) || null, llen: async (key: string) => pendingComments.get(key)?.length || 0, lrange: async (key: string) => pendingComments.get(key) || [], del: async (key: string) => { pendingComments.delete(key); return 1; }, publish: async () => 1, set: async (key: string, value: string) => { redisValues.set(key, value); return 'OK'; }, eval: evalRedis } as never, runtimeBuildQueue: {} as never,
      goalServices: { generateTitle: async () => 'Fixture goal', loadVisualPreviewSettings: async () => ({ enabled: false, types: ['image'] }), getOctokit: async () => github as never,
        stopExecution: async () => ({ success: true, containerStopped: stopGoalImmediately, removedQueuedJobs: stopGoalImmediately ? 1 : 0 }) as never,
        getCapabilities: async () => [{ agentId: agent.config.id, agentAlias: 'claude', agentType: 'claude', goalCapable: true, lifecycle: { launch: 'goal-prompt', resume: 'whole-session', runningInput: 'safe-boundary-resume' }, controls: { liveInput: false, inputAtBoundary: true, modelAtBoundary: true, pauseAtBoundary: true } }] } };
    // Exercise the worker's Redis pickup, command normalization and durable title update.
    // Only Redis/queue transport and the Redis state-manager calls are fixtures.
    const persistCommentTask = async (taskId: string, jobData: CommentJobData, pending: UnprocessedComment[] = []) => {
      const key = core.getPendingPrCommentsKey(jobData.repoOwner, jobData.repoName, jobData.pullRequestNumber);
      pendingComments.set(key, pending.map(comment => JSON.stringify(comment)));
      const initial = jobData.comments ? [...jobData.comments] : [{ id: jobData.commentId!, body: jobData.commentBody!, author: jobData.commentAuthor!, type: 'issue' as const }];
      jobData.commandMode ??= 'default';
      const { commentsToProcess } = await pickUpPendingCommentsWithClaim(initial, {
        ...jobData, correlatedLogger, redisClient: deps.redisClient as never,
      });
      applyPendingCommentCommandContext(jobData, commentsToProcess, correlatedLogger);
      await db('tasks').insert({ task_id: taskId, repository: `${jobData.repoOwner}/${jobData.repoName}`, issue_number: jobData.pullRequestNumber, task_type: 'pr-comment' });
      await updateTaskTitleForPR({ taskId, jobData, stateManager, correlatedLogger });
      const stored = JSON.parse((await db('tasks').where({ task_id: taskId }).first()).initial_job_data);
      assert.deepEqual(stored, JSON.parse(JSON.stringify(jobData)));
      assert.equal(pendingComments.has(key), pending.length === 0);
      return stored;
    };
    const pendingTask = async (taskId: string, commentId: number, commandMode: 'review' | 'fix', workEpoch?: number) => {
      const key = core.getPendingPrCommentsKey('acme', 'repo', 42);
      const comment: UnprocessedComment = { id: commentId, body: `/${commandMode}`, author: 'fixture-user', type: 'issue',
        commandMode, ...(workEpoch === undefined ? {} : { ultrafixMeta: { workEpoch } as UnprocessedComment['ultrafixMeta'] }) };
      pendingComments.set(key, [JSON.stringify(comment)]);
      await cleanupJob({ stateManager, taskId, lockKey: 'lock:pr:acme:repo:42', lockToken: 'fixture-lock',
        localRepoPath: undefined, worktreeInfo: undefined, repoOwner: 'acme', repoName: 'repo', pullRequestNumber: 42,
        jobBranchName: 'fixture', jobLlm: undefined, correlatedLogger, redisClient: deps.redisClient as never });
      const queued = issueJobs.at(-1)!;
      assert.equal(queued.name, 'processPullRequestComment');
      assert.deepEqual(queued.data.comments, []);
      const stored = await persistCommentTask(taskId, queued.data as unknown as CommentJobData, [comment]);
      assert.deepEqual(stored.comments, []);
      assert.equal(stored.commandCommentId, commentId);
      return stored;
    };
    const catalog = createToolCatalog(deps);
    const app = express(); app.use(express.json());
    app.all('/api/mcp', async (req, res) => {
      const handler = createMcpHandler(() => buildMcpServer(principal, deps, catalog), { legacy: 'stateless' });
      try { await toNodeHandler(handler)(req, res, req.body); } finally { await handler.close(); }
    });
    server = createServer(app); await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
    const url = new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/mcp`);
    for (const modern of [true, false]) {
      head = 'a'.repeat(40); merged = false;
      const client = modern ? new Client({ name: 'workflow-modern', version: '1' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } }) : new LegacyClient({ name: 'workflow-legacy', version: '1' });
      await client.connect((modern ? new StreamableHTTPClientTransport(url) : new LegacyTransport(url)) as never);
      let sequence = 0;
      const call = async (name: string, args: Record<string, unknown>, mutation = false) => {
        const result = await client.callTool({ name, arguments: { ...args, ...(mutation ? { idempotencyKey: `workflow-${modern}-${sequence++}` } : {}) } });
        assert.notEqual(result.isError, true, JSON.stringify(result));
        return (result.structuredContent as { data: Record<string, any> }).data; // eslint-disable-line @typescript-eslint/no-explicit-any
      };
      try {
        const repository = 'acme/repo';
        await core.saveSummarizationSettings({ enabled: true, agent_alias: 'claude:fixture-model' });
        const index = await call('index_repository', { repository, baseBranch: 'main', ignoreCooldown: true }, true);
        assert.equal(index.state, 'queued', JSON.stringify(index));
        const indexJob = index.result.jobId;
        assert.equal(index.result.continuation.jobId, indexJob);
        assert.equal(index.result.continuation.taskId, undefined);
        assert.equal((await call('get_operation', { operationId: index.operationId })).state, 'queued');
        queueStates.set(indexJob, 'active');
        assert.equal((await call('get_operation', { operationId: index.operationId })).state, 'running');
        await core.updateRepositoryStatus(repository, 'completed', 'main', { hash: head });
        queueStates.set(indexJob, 'completed');
        assert.equal((await call('get_operation', { operationId: index.operationId })).state, 'completed');
        assert.equal((await call('get_repository_context', { repository, branch: 'main' })).freshness.revision, head);
        const plan = await call('create_plan', { repository, name: 'Reliability', prompt: 'Improve reliability', plan: [{ title: 'Handle failures', body: 'Persist results', implementation: 'Use the state machine' }] }, true);
        const planId = plan.result.planId;
        attachmentDirectories.push(path.join(process.cwd(), 'storage', 'drafts', planId));
        const upload = await call('upload_attachment', { repository, parentKind: 'plan', parentId: planId, filename: 'notes.txt', mimeType: 'text/plain', data: Buffer.from('Bounded fixture context').toString('base64') }, true);
        assert.equal(upload.state, 'completed', JSON.stringify(upload));
        const artifact = await call('get_artifact', { artifactId: upload.result.artifactId, length: 8 }); assert.equal(Buffer.from(artifact.data, 'base64').toString(), 'Bounded '); assert.equal(artifact.nextOffset, 8);
        const draft = await call('get_plan', { repository, planId });
        const attachment = await call('get_attachment', { repository, parentKind: 'plan', parentId: planId, attachmentId: draft.attachments[0].id });
        assert.equal(Buffer.from(attachment.data, 'base64').toString(), 'Bounded fixture context');
        assert.ok(!JSON.stringify(draft).includes('storedPath'));
        const publication = await call('publish_plan', { repository, planId, expectedRevision: draft.mcp_revision }, true); assert.equal(publication.state, 'completed');
        const issueNumber = publication.result.issues[0].number;
        issues.find(issue => issue.number === issueNumber)!.labels.push('auto-merge');
        const implementation = { repository, planId, issues: [issueNumber], models: [{ agent_alias: 'claude', model_name: 'fixture-model' }], autoMerge: false };
        const starts = await Promise.all([call('implement_plan', implementation, true), call('implement_plan', implementation, true)]);
        assert.equal(starts.filter(result => result.state === 'accepted').length, 1, JSON.stringify(starts));
        assert.equal((await db('plan_issues').where({ draft_id: planId, issue_number: issueNumber }).first()).status, 'processing');
        assert.equal(issueJobs.filter(job => job.name === 'processGitHubIssue' && job.data.number === issueNumber).length, 1);
        assert.ok(!issues.find(issue => issue.number === issueNumber)!.labels.includes('auto-merge'));
        // Worker boundary: a queued job creates the task; read/followup then use
        // the real handlers against its persisted row and history.
        const taskId = `issue-fixture-implementation-${modern}`;
        await db('tasks').insert({ task_id: taskId, repository, issue_number: issueNumber, task_type: 'issue' });
        await db('task_history').insert({ task_id: taskId, state: 'completed' });
        const changes = await call('get_task_changes', { repository, taskId, detail: 'diff', path: 'src/retry.ts' });
        assert.equal(changes.files[0].diff, '+Handle transient failures\n'); assert.equal(cacheReads.at(-1), taskId);
        const followup = await call('send_task_followup', { repository, taskId, message: 'Please cover transient errors' }, true); assert.equal(followup.state, 'queued', JSON.stringify(followup));
        assert.equal((await call('get_operation', { operationId: followup.operationId })).state, 'queued');
        const nextTask = followup.result.jobId;
        assert.equal(followup.result.continuation.taskId, nextTask);
        assert.equal(followup.result.continuation.sourceTaskId, taskId);
        assert.notEqual(nextTask, taskId);
        await db('tasks').insert({ task_id: nextTask, repository, issue_number: issueNumber, task_type: 'pr-comment' });
        await db('task_history').insert({ task_id: nextTask, state: 'processing' });
        assert.equal((await call('get_operation', { operationId: followup.operationId })).state, 'running');
        await db('task_history').insert({ task_id: nextTask, state: 'completed' });
        assert.equal((await call('get_operation', { operationId: followup.operationId })).state, 'completed');
        assert.equal((await db('task_history').where({ task_id: taskId }).first()).state, 'completed');
        queueFailure = true;
        const uncertain = await call('send_task_followup', { repository, taskId, message: 'Queue transport fails' }, true);
        assert.equal(uncertain.state, 'unknown'); assert.equal(uncertain.result.posted, true); assert.equal(uncertain.result.success, false);
        assert.equal((await call('get_operation', { operationId: uncertain.operationId })).state, 'unknown');
        queueStates.set(uncertain.result.jobId, 'failed');
        assert.equal((await call('get_operation', { operationId: uncertain.operationId })).state, 'failed');
        queueFailure = false;
        // A lost queue acknowledgement may still result in a durable worker task.
        await db('tasks').insert({ task_id: uncertain.result.jobId, repository, issue_number: issueNumber, task_type: 'pr-comment' });
        await db('task_history').insert({ task_id: uncertain.result.jobId, state: 'failed' });
        assert.equal((await call('get_operation', { operationId: uncertain.operationId })).state, 'failed');
        assert.ok(issueJobs.some(job => job.name === 'processPullRequestComment'));
        const created = await call('create_goal', { repository, objective: 'Improve reliability', agentId: agent.config.id, model: 'fixture-model', launchStrategy: 'direct' }, true);
        assert.equal(created.state, 'accepted', JSON.stringify(created));
        const goalId = created.result.continuation.goalId;
        const createdGoal = await db('goals').where({ goal_id: goalId }).first();
        assert.equal(createdGoal.desired_state, 'running');
        assert.ok(jobs.some(job => job.goalId === goalId));
        await db('tasks').insert({ task_id: createdGoal.current_task_id, repository, task_type: 'goal' });
        await db('task_history').insert({ task_id: createdGoal.current_task_id, state: 'processing' });
        await db('task_history').insert({ task_id: createdGoal.current_task_id, state: 'completed', reason: 'Goal task completed successfully' });
        const runningGoal = await call('get_operation', { operationId: created.operationId });
        assert.equal(runningGoal.lifecycle.state, 'running');
        assert.ok(runningGoal.lifecycle.startedAt);
        const runningOperations = await call('list_operations', { lifecycle: 'running' });
        assert.ok(runningOperations.operations.some((operation: { operationId: string }) => operation.operationId === created.operationId));
        const input = await call('send_goal_input', { repository, goalId, message: 'Add error handling' }, true); assert.equal(input.state, 'completed', JSON.stringify(input));
        assert.ok(await db('goal_inputs').where({ goal_id: goalId, message: 'Add error handling' }).first());
        await call('pause_goal', { repository, goalId }, true); assert.equal((await db('goals').where({ goal_id: goalId }).first()).desired_state, 'paused');
        const resume = await call('resume_goal', { repository, goalId }, true); assert.equal(resume.state, 'completed', JSON.stringify(resume));
        assert.equal((await db('goals').where({ goal_id: goalId }).first()).desired_state, 'running');
        await verifyCancellation({ call, client, principal, deps, agentId: agent.config.id, modern, root, taskId, issueNumber, redisValues, plannerSignals, setStopGoalImmediately: value => { stopGoalImmediately = value; } });
        assert.equal(cancellationRequests.size, modern ? 3 : 6, 'each task stop attempts to record cancellation');
        for (const [id, request] of cancellationRequests) {
          assert.deepEqual(request, { requestedBy: 'fixture-user', reason: 'cancelled_by_user' });
          const abort = JSON.parse(redisValues.get(`worker:abort:${id}`)!);
          assert.equal(abort.requestedBy, request.requestedBy);
          assert.equal(abort.reason, request.reason);
        }
        const cancel = await call('cancel_goal', { repository, goalId }, true); assert.equal(cancel.state, 'accepted');
        assert.equal((await db('goals').where({ goal_id: goalId }).first()).desired_state, 'cancelled');
        assert.equal((await call('get_operation', { operationId: cancel.operationId })).result.cancellation, 'confirmed');
        await verifyGoalCreationOptions({ client, call, db, jobs, repository, agentId: agent.config.id, modern });

        const category = await call('create_todo_category', { repository, name: 'Reliability' }, true); assert.equal(category.state, 'completed', JSON.stringify(category));
        const todo = await call('create_todo', { repository, content: 'Handle transient errors' }, true); assert.equal(todo.state, 'completed', JSON.stringify(todo));
        const todoId = todo.result.todoId, categoryId = category.result.categoryId;
        await call('move_todo', { repository, todoId, categoryId }, true);
        await call('update_todo', { repository, todoId, isCompleted: true }, true);
        assert.equal((await db('repo_todos').where({ todo_id: todoId }).first()).is_completed, 1);
        const deletion = { repository, todoId, idempotencyKey: `delete-todo-${modern}` };
        const deleted = await call('delete_todo', deletion); assert.equal(deleted.state, 'completed');
        assert.equal((await call('delete_todo', deletion)).operationId, deleted.operationId);
        const event = await core.createNotificationEvent({ kind: 'task', deduplicationKey: `fixture-event-${modern}`, title: 'Task complete', body: 'Ready for review', target: { type: 'task', repository, taskId: `fixture-task-${modern}` }, recipients: ['123'] });
        const notifications = await call('list_notifications', { repository }); assert.ok(notifications.notifications.some((item: { id: string }) => item.id === event.id));
        await call('mark_notification_read', { repository, notificationId: event.id }, true);
        await call('dismiss_notification', { repository, notificationId: event.id }, true);
        assert.ok(!(await call('list_notifications', { repository })).notifications.some((item: { id: string }) => item.id === event.id));
        await verifyInboxNotifications({ call, client, modern, repository, instanceId: config.instanceId });
        const settings = await call('update_execution_settings', { settings: { ultrafix_max_cycles: 3 } }, true); assert.equal(settings.state, 'completed', JSON.stringify(settings));
        assert.equal((await call('get_execution_settings', {})).ultrafix_max_cycles, 3);
        await call('update_repository_preferences', { repository, starred: true }, true);
        assert.equal((await call('get_repository_preferences', { repository })).preferences.starred, true);
        assert.equal((await call('resolve_reference', { kind: 'repository', query: 'acme/repo' })).match, 'exact');
        const pr = { repository, pullRequest: 42, expectedHead: head };
        const reviewRequest = await call('review_pull_request', pr, true);
        assert.equal(reviewRequest.state, 'posted');
        const reviewTaskId = `review-task-${modern}`;
        await pendingTask(reviewTaskId, reviewRequest.result.commentId, 'review');
        assert.equal((await call('get_operation', { operationId: reviewRequest.operationId })).state, 'running');
        await db('task_history').insert({ task_id: reviewTaskId, state: 'processing' });
        assert.equal((await call('get_operation', { operationId: reviewRequest.operationId })).state, 'running');
        const { buildReviewComment } = await import('../../../src/jobs/reviewCommentFormatter.js');
        const reviewBody = buildReviewComment({ agentAlias: 'claude', model: 'fixture-model', label: 'Fixture' }, {
          success: true, executionTimeMs: 10, response: `## Overall Evaluation\nNeeds correction.\n\n## Actionable Findings\n### F1: Preserve concurrent updates\n- violatedRequirement: Preserve unrelated changes\n- evidence: src/config.ts replaces the stale list\n- introducedByPR: true — new adapter writes the snapshot\n- requiredForMerge: true\n- minimumCorrection: Reject stale revisions\n\n## Suggestions and Follow-ups\nNo suggestions.\n\n## Score\nScore: 7/10`,
        }, undefined, { reviewedHead: head, taskId: reviewTaskId, prDiffTruncated: true });
        const reviewCommentId = 1000 + discussion.length;
        discussion.push({ id: reviewCommentId, body: reviewBody, html_url: `https://github.com/acme/repo/pull/42#issuecomment-${reviewCommentId}`, issue_url: 'https://api.github.com/repos/acme/repo/issues/42', created_at: new Date().toISOString(), user: { login: 'propr-dev[bot]' } });
        await db('task_history').insert({ task_id: reviewTaskId, state: 'completed', metadata: JSON.stringify({ reviewResults: [{ success: true, commentId: reviewCommentId, commentUrl: discussion.at(-1)!.html_url }] }) });
        const completedReview = await call('get_operation', { operationId: reviewRequest.operationId });
        assert.equal(completedReview.result.reviewResults[0].commentId, reviewCommentId); assert.equal(completedReview.state, 'completed'); assert.equal(completedReview.result.continuation.taskId, reviewTaskId);
        const inspected = await call('get_pull_request_discussion', { repository, pullRequest: 42, commentId: reviewCommentId });
        assert.equal(inspected.comments[0].review.reviewedHead, head);
        assert.equal(inspected.comments[0].review.partial, true);
        assert.deepEqual(inspected.comments[0].review.currentFindingIds, ['F1']);
        assert.equal((await call('get_pull_request_discussion', { repository, pullRequest: 42, limit: 1 })).nextPage, 2);
        const fix = await call('fix_review_findings', { ...pr, reviewCommentId, findingIds: ['F1'] }, true);
        assert.equal(fix.state, 'posted'); assert.ok(comments.at(-1)!.startsWith('/fix F1'));
        const fixTaskId = `fix-task-${modern}`;
        await pendingTask(fixTaskId, fix.result.commentId, 'fix');
        assert.equal((await call('get_operation', { operationId: fix.operationId })).state, 'running');
        await db('task_history').insert({ task_id: fixTaskId, state: 'processing' });
        assert.equal((await call('get_operation', { operationId: fix.operationId })).state, 'running');
        head = 'c'.repeat(40);
        await db('task_history').insert({ task_id: fixTaskId, state: 'completed' });
        const fixed = await call('get_operation', { operationId: fix.operationId });
        assert.equal(fixed.state, 'completed'); assert.equal(fixed.result.currentHead, head); assert.equal(fixed.result.continuation.taskId, fixTaskId);
        // A moved head no longer blocks the fix by default; a caller-pinned stale head still does.
        const pinnedStale = await call('fix_review_findings', { ...pr, reviewCommentId, findingIds: ['F1'] }, true);
        assert.equal(pinnedStale.state, 'failed'); assert.equal(pinnedStale.result.error.code, 'STALE_HEAD');
        pr.expectedHead = head;
        const ultrafix = await call('run_ultrafix', pr, true); assert.equal(ultrafix.state, 'posted');
        const loopTask = `ultrafix-start-${modern}`, workEpoch = modern ? 1 : 2;
        await pendingTask(loopTask, ultrafix.result.commentId, modern ? 'review' : 'fix', workEpoch);
        await db('task_history').insert({ task_id: loopTask, state: 'completed', reason: 'Task completed successfully' });
        const loop = { active: true, workEpoch, cycleCount: 0, completionStatus: null as string | null, completionReason: null as string | null };
        redisValues.set('ultrafix:state:acme:repo:42', JSON.stringify(loop));
        assert.equal((await call('get_operation', { operationId: ultrafix.operationId })).state, 'running');
        loop.active = false; loop.completionStatus = modern ? 'succeeded' : 'failed';
        loop.completionReason = modern ? 'Goal reached' : 'Maximum cycles reached without resolving the findings.';
        redisValues.set('ultrafix:state:acme:repo:42', JSON.stringify(loop));
        const completedLoop = await call('get_operation', { operationId: ultrafix.operationId });
        assert.equal(completedLoop.state, modern ? 'completed' : 'failed');
        assert.equal(completedLoop.result.loop.workEpoch, workEpoch); assert.equal(completedLoop.result.loop.completionStatus, loop.completionStatus);
        if (!modern) assert.equal(completedLoop.lifecycle.failure.message, loop.completionReason);
        assert.equal(completedLoop.result.continuation.sourceTaskId, loopTask);
        redisValues.set('ultrafix:state:acme:repo:42', JSON.stringify({ ...loop, workEpoch: workEpoch + 1, active: true, completionStatus: null }));
        assert.equal((await call('get_operation', { operationId: ultrafix.operationId })).state, modern ? 'completed' : 'failed');
        const lostIntake = await call('review_pull_request', pr, true);
        await db('mcp_operations').where({ id: lostIntake.operationId }).update({ created_at: Date.now() - 11 * 60_000 });
        assert.equal((await call('get_operation', { operationId: lostIntake.operationId })).state, 'unknown');
        await pendingTask(`late-review-${modern}`, lostIntake.result.commentId, 'review');
        assert.equal((await call('get_operation', { operationId: lostIntake.operationId })).state, 'running');
        await db('task_history').insert({ task_id: `late-review-${modern}`, state: 'processing' });
        assert.equal((await call('get_operation', { operationId: lostIntake.operationId })).state, 'running');
        await db('task_history').insert({ task_id: `late-review-${modern}`, state: 'cancelled' });
        assert.equal((await call('get_operation', { operationId: lostIntake.operationId })).state, 'cancelled');
        // Legacy direct and populated batch jobs use the same normalization/persistence path.
        const baseJob = { repoOwner: 'acme', repoName: 'repo', pullRequestNumber: 42, correlationId: 'fixture' };
        for (const shape of ['direct', 'batch'] as const) {
          const request = await call('review_pull_request', pr, true);
          const comment: UnprocessedComment = { id: request.result.commentId, body: '/review', author: 'fixture-user', type: 'issue' };
          const execution = `review-${shape}-${modern}`;
          await persistCommentTask(execution, { ...baseJob, commandMode: 'review',
            ...(shape === 'direct' ? { commentId: comment.id, commentBody: comment.body, commentAuthor: comment.author } : { comments: [comment] }) });
          assert.equal((await call('get_operation', { operationId: request.operationId })).state, 'running');
          await db('task_history').insert({ task_id: execution, state: 'processing' });
          assert.equal((await call('get_operation', { operationId: request.operationId })).state, 'running');
          await db('task_history').insert({ task_id: execution, state: 'completed', metadata: JSON.stringify({ reviewResults: [{ success: false }] }) });
          assert.equal((await call('get_operation', { operationId: request.operationId })).state, 'failed');
        }
        // A selected newer command supersedes the original even when it remains in
        // comments[] or commentId, including when both commands request a review.
        for (const shape of ['direct', 'batch'] as const) {
          const superseded = await call('review_pull_request', pr, true);
          const selected = await call('review_pull_request', pr, true);
          const previous: UnprocessedComment = { id: superseded.result.commentId, body: '/review', author: 'fixture-user', type: 'issue' };
          const latest: UnprocessedComment = { ...previous, id: selected.result.commentId, commandMode: 'review' };
          const execution = `superseded-${shape}-${modern}`;
          const stored = await persistCommentTask(execution, { ...baseJob, commandMode: 'review',
            ...(shape === 'direct' ? { commentId: previous.id } : { comments: [previous] }) }, [latest]);
          assert.equal(stored.commandCommentId, latest.id);
          await db('task_history').insert({ task_id: execution, state: 'completed' });
          assert.equal((await call('get_operation', { operationId: selected.operationId })).state, 'completed');
          assert.equal((await call('get_operation', { operationId: superseded.operationId })).state, 'posted');
          await db('mcp_operations').where({ id: superseded.operationId }).update({ created_at: Date.now() - 11 * 60_000 });
          assert.equal((await call('get_operation', { operationId: superseded.operationId })).state, 'unknown');
        }
        const unexecuted = await call('review_pull_request', pr, true);
        const unexecutedComment: UnprocessedComment = { id: unexecuted.result.commentId, body: '/review', author: 'fixture-user', type: 'issue', commandMode: 'review' };
        for (const [suffix, overrides, comment] of [
          ['repository', { repoName: 'other' }, unexecutedComment],
          ['pr', { pullRequestNumber: 43 }, unexecutedComment],
          ['type', {}, { ...unexecutedComment, type: 'review' as const }],
          ['mode', {}, { ...unexecutedComment, commandMode: 'fix' as const }],
        ] as const) {
          const execution = `unrelated-${suffix}-${modern}`;
          await persistCommentTask(execution, { ...baseJob, ...overrides, comments: [] }, [comment]);
          await db('task_history').insert({ task_id: execution, state: 'completed' });
        }
        assert.equal((await call('get_operation', { operationId: unexecuted.operationId })).state, 'posted');
        await db('mcp_operations').where({ id: unexecuted.operationId }).update({ created_at: Date.now() - 11 * 60_000 });
        assert.equal((await call('get_operation', { operationId: unexecuted.operationId })).state, 'unknown');
        // A loop without a matching durable epoch cannot borrow a later loop's result.
        const staleLoop = await call('run_ultrafix', pr, true);
        await pendingTask(`stale-loop-${modern}`, staleLoop.result.commentId, 'review', workEpoch);
        assert.equal((await call('get_operation', { operationId: staleLoop.operationId })).state, 'unknown');
        // run_ultrafix without a goal posts the instance rating goal, not a literal of its own.
        const instanceGoal = await core.loadUltrafixRatingGoal();
        assert.ok(comments.some(comment => comment.startsWith(`/ultrafix goal=${instanceGoal} max=3`)));
        checks = 'FAILURE'; assert.equal((await call('merge_pull_request', pr, true)).result.error.code, 'CHECKS_FAILING'); assert.equal(merged, false);
        checks = 'SUCCESS'; mergeState = 'BLOCKED'; assert.equal((await call('merge_pull_request', pr, true)).result.error.code, 'BRANCH_PROTECTION_BLOCKED'); assert.equal(merged, false);
        mergeState = 'CLEAN'; await call('update_pull_request_branch', pr, true); assert.equal(merged, false);
        assert.equal((await call('merge_pull_request', pr, true)).result.error.code, 'STALE_HEAD');
        assert.equal((await call('merge_pull_request', { ...pr, expectedHead: head }, true)).state, 'completed'); assert.equal(merged, true);
      } finally { await client.close(); }
    }
  } finally {
    stubs.forEach(stub => stub.mock.restore());
    redisBoundary.restore(); boundary.restore();
    if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve())); }
    await Promise.all(attachmentDirectories.map(directory => rm(directory, { recursive: true, force: true })));
    await core.closeConnection(); await core.closeEventPublisher(); await rm(root, { recursive: true, force: true });
  }
});

type GoalOptionsFixture = {
  client: { callTool: (request: { name: string; arguments: Record<string, unknown> }) => Promise<unknown> };
  call: (name: string, args: Record<string, unknown>, mutation?: boolean) => Promise<Record<string, any>>; // eslint-disable-line @typescript-eslint/no-explicit-any
  db: import('knex').Knex; jobs: Array<Record<string, unknown>>; repository: string; agentId: string; modern: boolean;
};

/** MCP goal creation honors the shared API contract and persists the requested options. */
async function verifyGoalCreationOptions({ client, call, db, jobs, repository, agentId, modern }: GoalOptionsFixture): Promise<void> {
  const goalArgs = { repository, objective: `Ship with Ultrafix ${modern}`, agentId, model: 'fixture-model', launchStrategy: 'direct' };
  const raw = async (args: Record<string, unknown>, idempotencyKey: string) => client.callTool({ name: 'create_goal', arguments: { ...goalArgs, ...args, idempotencyKey } }) as Promise<{ isError?: boolean; structuredContent?: { data?: Record<string, any> } }>; // eslint-disable-line @typescript-eslint/no-explicit-any
  for (const maxParallelTasks of [0, 33]) {
    const before = await db('goals').count({ count: '*' }).first();
    const rejected = await raw({ maxParallelTasks }, `goal-parallel-${modern}-${maxParallelTasks}`);
    assert.equal(rejected.isError, true, `maxParallelTasks ${maxParallelTasks}`);
    assert.deepEqual(await db('goals').count({ count: '*' }).first(), before);
  }
  const orchestratedCadence = await raw({ launchStrategy: 'orchestrate', checkpointIntervalMinutes: 15 }, `goal-cadence-${modern}`);
  assert.equal(orchestratedCadence.isError, true);

  const enabledKey = `goal-ultrafix-${modern}`;
  const enabled = await raw({ ultrafix: true, maxParallelTasks: 32 }, enabledKey);
  assert.notEqual(enabled.isError, true, JSON.stringify(enabled));
  const enabledData = enabled.structuredContent!.data!;
  assert.equal(enabledData.state, 'accepted');
  const enabledGoal = await db('goals').where({ goal_id: enabledData.result.continuation.goalId }).first();
  assert.equal(Boolean(enabledGoal.ultrafix), true);
  assert.equal(enabledGoal.max_parallel_tasks, 32);
  const context = await db('goal_inputs').where({ goal_id: enabledGoal.goal_id, kind: 'context' }).first();
  assert.match(context.message, /Ultrafix policy: Enabled/);
  assert.match(context.message, /Finish with validated implementation files; ProPR publishes and validates the final checkpoint on its draft PR/);
  const jobCount = jobs.filter(job => job.goalId === enabledGoal.goal_id).length;
  assert.equal(jobCount, 1);
  const retry = await raw({ ultrafix: true, maxParallelTasks: 32 }, enabledKey);
  assert.equal(retry.structuredContent!.data!.operationId, enabledData.operationId);
  const changed = await raw({ ultrafix: false, maxParallelTasks: 32 }, enabledKey);
  assert.equal(changed.isError, true);
  assert.match(JSON.stringify(changed), /IDEMPOTENCY_CONFLICT/);
  assert.equal(jobs.filter(job => job.goalId === enabledGoal.goal_id).length, 1);
  assert.equal(await db('goals').where({ repository, objective: goalArgs.objective }).count({ count: '*' }).first().then(row => Number(row?.count)), 1);

  const disabled = await call('create_goal', { ...goalArgs, objective: 'Ship without Ultrafix', maxParallelTasks: 9 }, true);
  const disabledGoal = await db('goals').where({ goal_id: disabled.result.continuation.goalId }).first();
  assert.equal(Boolean(disabledGoal.ultrafix), false);
  assert.equal(disabledGoal.max_parallel_tasks, 9);
  assert.match((await db('goal_inputs').where({ goal_id: disabledGoal.goal_id, kind: 'context' }).first()).message, /Ultrafix policy: Disabled/);
  const capabilities = await call('get_goal_capabilities', {});
  assert.deepEqual(capabilities.creation.maxParallelTasks, { min: 1, max: 32 });
  assert.equal(capabilities.creation.ultrafix.grantsMerge, false);
  for (const goal of [enabledGoal, disabledGoal]) await db('goals').where({ goal_id: goal.goal_id }).update({ desired_state: 'cancelled', result_state: 'cancelled' });
}
