import type { Page, Route } from '@playwright/test';
import { mkdir } from 'node:fs/promises';

const now = Date.now();
const ago = (hours: number) => new Date(now - hours * 3_600_000).toISOString();
const repository = 'integry/propr';
const longPrompt = 'Expose the repository retrieval that the planner already uses as direct, composable MCP tools, giving an MCP client (an agent) maximum flexibility to search and read repository code without pulling the repo locally.\n\n## Background / what already exists\nThe planner already does repository retrieval today: it takes the user\'s prompt, matches it against the repository\'s file list and pulls the relevant files in as context.';

const drafts = [
  { draft_id: 'plan-ultrafix', name: 'Ultrafix Re-arming, Event Intake, and Recovery Testing', status: 'pr_created', updated_at: ago(1), issue_summary: { total: 3, pending: 0, processing: 1, merged: 2, closed: 0 } },
  { draft_id: 'plan-agents', name: 'Add an "Agents" feature to ProPR, scoped to a deliberately small v1', status: 'review', updated_at: ago(1), issue_summary: null },
  { draft_id: 'plan-conflicts', name: 'Fix Merge Conflict Auto-Resolution With Per-Repository Settings', status: 'executed', updated_at: ago(2), issue_summary: { total: 1, pending: 0, processing: 1, merged: 0, closed: 0 } },
  { draft_id: 'plan-retrieval', initial_prompt: longPrompt, status: 'review', updated_at: ago(48), issue_summary: null },
  { draft_id: 'plan-triage', name: 'Master-Detail Tasks Triage Console with Inline Details', status: 'executed', updated_at: ago(21), issue_summary: { total: 1, pending: 0, processing: 0, merged: 1, closed: 0 } },
  { draft_id: 'plan-timeframe', name: 'Synchronized Timeframe Selector for Analytics Page', repository: 'integry/digvin', status: 'draft', updated_at: ago(96), issue_summary: null },
  { draft_id: 'plan-mcp', name: 'Repository Search and Read MCP Tools Implementation', status: 'generating', updated_at: ago(0.2), issue_summary: null },
  { draft_id: 'plan-failed', name: 'Migrate Webhook Intake to the Durable Queue', status: 'failed', updated_at: ago(30), issue_summary: null },
].map(draft => ({ repository, initial_prompt: draft.name ?? '', created_at: ago(200), ...draft }));

// Each step carries its own requirements so the specification is checked against varying lengths, not one repeated body.
const agentSteps: Array<{ title: string; context: string; requirements: string[] }> = [
  { title: 'Shared contracts for agent definitions, runs, capabilities, autonomy and cron schedules', context: 'Every other step imports these types, so they land first.', requirements: ['Add `packages/shared/src/agentDefinitions.ts` exporting the shared contracts.', 'Unit tests in `test/agentDefinitionsContract.test.ts`.'] },
  { title: 'Database migration and definition store for agent definitions and runs', context: 'Definitions and runs need durable storage before the run store and API can use them.', requirements: ['Add migration `migrations/0042_agent_definitions.sql` creating `agent_definitions` and `agent_runs`.', 'Add `packages/core/src/agents/definitionStore.ts` with create, update, list and soft delete.', 'Index `agent_runs (definition_id, created_at)` for run history queries.', 'Tests in `test/agentDefinitionStore.test.ts`.'] },
  { title: 'Agent run store with guarded state machine and idempotent creation', context: 'Runs move through `queued → running → succeeded | failed | cancelled`; every other transition is rejected.', requirements: ['Add `packages/server/src/runStore.ts` with `createRun(idempotencyKey)` returning the existing run on retry.', 'Guard transitions in `packages/server/src/runStateMachine.ts`.', 'Tests in `test/stateMachine.test.ts` covering every illegal transition.'] },
  { title: 'Trigger primitive service and agent-run queue jobs', context: 'Manual, scheduled and API triggers all enqueue the same job.', requirements: ['Add `packages/core/src/agents/triggerService.ts`.', 'Register the `agent-run` job in `packages/worker/src/jobs/index.ts`.'] },
  { title: 'REST API for agent definitions, runs, attachments and run-now', context: 'The web UI and CLI share these endpoints.', requirements: ['Add `packages/api/routes/agentRoutes.ts` with CRUD for definitions.', 'Add `POST /api/agents/:id/run` that calls the trigger service.', 'Accept input files through the existing attachment upload.', 'Route tests in `test/agentRoutes.test.ts`.'] },
  { title: 'Report-run prompt builder with previous reports and input files', context: 'Report runs see the last three reports so they can describe what changed.', requirements: ['Add `packages/core/src/agents/reportPrompt.ts`.', 'Snapshot tests in `test/reportPrompt.test.ts`.'] },
  { title: 'Report-run executor: spawn an isolated task run from a definition', context: 'Each run gets a fresh container and its own task record.', requirements: ['Add `packages/worker/src/agents/reportExecutor.ts`.', 'Store the report on the run when the task finishes.', 'Tests in `test/reportExecutor.test.ts` with a stubbed container.'] },
  { title: 'Capability enforcement: per-run tool policy for web access and MCP', context: 'A definition can only use the tools it declares.', requirements: ['Add `packages/core/src/agents/capabilityPolicy.ts`.', 'Deny undeclared web and MCP calls in `packages/worker/src/toolGate.ts`.'] },
  { title: 'Run-scoped, short-lived ProPR MCP grants for agent containers', context: 'Grants expire with the run and cannot outlive it.', requirements: ['Add `packages/core/src/agents/mcpGrants.ts` issuing 15-minute tokens.', 'Revoke the grant when the run reaches a terminal state.', 'Tests in `test/mcpGrants.test.ts`.'] },
  { title: 'Separate report-to-actions agent step with dry-run and approve', context: 'Actions proposed by a report never run without approval.', requirements: ['Add `packages/core/src/agents/actionPlanner.ts` with a dry-run mode.', 'Add `POST /api/agents/runs/:id/approve`.'] },
  { title: 'Agent Tank usage / cost gate for scheduled and unattended runs', context: 'Unattended runs stop before they exceed the configured budget.', requirements: ['Check the Agent Tank balance in `packages/worker/src/agents/costGate.ts` before each run.', 'Record skipped runs with reason `budget_exhausted`.'] },
  { title: 'Cron schedule sweep in the daemon and deferred-run retry', context: 'The daemon sweeps every minute and retries runs deferred by the cost gate.', requirements: ['Add `packages/daemon/src/agentScheduleSweep.ts`.', 'Parse schedules with the existing cron helper in `packages/shared/src/cron.ts`.', 'Retry deferred runs with exponential backoff, capped at one hour.', 'Tests in `test/agentScheduleSweep.test.ts` using fake timers.'] },
  { title: 'ProPR MCP tools: list/read agents and runs, trigger primitive', context: 'Agents become scriptable from any MCP client.', requirements: ['Add `list_agents`, `get_agent`, `list_agent_runs` and `run_agent` in `packages/api/mcp/agentTools.ts`.'] },
  { title: 'CLI: propr automation command group with the run trigger', context: 'Operators can run an agent from a terminal or CI job.', requirements: ['Add `packages/cli/src/commands/automation.ts` with `list`, `show` and `run`.', 'Print the run URL and exit non-zero on failure.'] },
  { title: 'Web UI: Agents list and agent detail/edit view', context: 'Agents get their own page in the sidebar.', requirements: ['Add `propr-ui/src/pages/AgentsPage.tsx`.', 'Add `propr-ui/src/components/Agents/AgentDefinitionForm.tsx`.', 'Unit tests next to each component.'] },
  { title: 'Web UI: run history, run detail, report view and approvals', context: 'Reports render as markdown with the proposed actions underneath.', requirements: ['Add `propr-ui/src/pages/AgentRunPage.tsx`.', 'Add approve and reject buttons wired to the approve endpoint.'] },
  { title: 'Documentation: feature guide, API/MCP/CLI reference', context: 'Ships with the feature.', requirements: ['Add `docs/agents.md`.', 'Extend `docs/api.md`, `docs/mcp.md` and `docs/cli.md`.'] },
];
const agentTitles = agentSteps.map(step => step.title);
// Step counters follow the plan they belong to: (n/17) in the full plan, (n/3) in the short one.
const agentTasks = (titles: string[]) => titles.map((title, index) => {
  const step = agentSteps.find(candidate => candidate.title === title)!;
  return {
    id: `agent-task-${index + 1}`,
    title: `Agents v1 (${index + 1}/${titles.length}): ${title}`,
    body: `## Context\n${step.context}\n\n## Requirements\n${step.requirements.map((requirement, n) => `${n + 1}. ${requirement}`).join('\n')}`,
    implementation: '',
  };
});
export const agentPlan = agentTasks(agentTitles);

const executionTitles = [
  'Implement Core Repository Retrieval Engine for Semantic and Literal File Matching',
  'Expose Repository Search and Read as Composable MCP Tools with Policy Authorization',
  'Add MCP Integration Tests and Update Documentation for Repository Search and Read Tools',
  'Add Rate Limits and Audit Logging for Repository Retrieval Tools',
];
const executionPlan = executionTitles.map((title, index) => ({ id: `exec-${index}`, title, body: 'Implementation details.', implementation: '', issue_number: 2797 + index }));
const issue = (index: number, status: string, extra: Record<string, unknown> = {}) => ({
  id: index + 1, draft_id: 'plan-mcp-exec', repository, issue_number: 2797 + index, pr_number: null, status,
  agent_alias: 'claude', model_name: 'claude-opus-5-5', followup_count: 0, task_id: null,
  created_at: ago(2), updated_at: ago(1), ...extra,
});
const executionIssues = [
  issue(0, 'merged', { pr_number: 2801 }),
  issue(1, 'processing', { task_id: 'task-2798' }),
  issue(2, 'pending'),
  issue(3, 'pending'),
];

// A 17-issue plan mid-execution: 5 merged, 2 running, 10 waiting to be queued.
const agentExecutionPlan = agentPlan.map((task, index) => ({ ...task, issue_number: 2900 + index }));
const agentExecutionIssues = agentExecutionPlan.map((task, index) => issue(index, index < 5 ? 'merged' : index < 7 ? 'processing' : 'pending', {
  draft_id: 'plan-agents-exec', issue_number: task.issue_number, pr_number: index < 5 ? 2950 + index : null, task_id: index >= 5 && index < 7 ? `task-${task.issue_number}` : null,
}));
const planIssues: Record<string, unknown[]> = { 'plan-mcp-exec': executionIssues, 'plan-agents-exec': agentExecutionIssues };

// Step timing for a generation trace. `startedAt` is read when the fixture is served, so a step
// stays partway through its estimate however long the suite has been running. Completed steps
// finish inside their estimate, or their bar turns amber as an overrun.
const runningFor = (estimatedDuration: number, elapsedSeconds: number) => ({
  estimatedDuration,
  get startedAt() { return new Date(Date.now() - elapsedSeconds * 1_000).toISOString(); },
});

// The last context preview a generating draft carries: the ranked files and the context size the run reuses.
const discoveredFiles = [
  'packages/core/src/services/taskPlanningService.ts', 'packages/core/src/services/planning/previewService.ts', 'packages/core/src/agents/AgentRegistry.ts',
  'packages/api/routes/plannerRoutes.ts', 'packages/shared/src/events.ts', 'packages/worker/src/jobs/index.ts', 'packages/daemon/src/scheduler.ts',
  'packages/core/src/db/migrations/0041_task_drafts.sql', 'packages/api/mcp/plannerTools.ts', 'packages/cli/src/commands/plan.ts',
  'propr-ui/src/pages/PlanStudioPage.tsx', 'propr-ui/src/components/TaskPlanner/SetupWizard.tsx', 'packages/core/src/services/relevanceService.ts',
  'packages/core/src/utils/eventPublisher.ts', 'packages/worker/src/toolGate.ts', 'packages/shared/src/cron.ts', 'docs/planner.md', 'docs/api.md',
];
const lastPreview = {
  success: true, warnings: [],
  stats: { totalTokens: 842_496, costEstimate: 2.4, contextLength: 3_100_000, fileCount: discoveredFiles.length, modelMaxContextTokens: 1_000_000 },
  smartSelection: discoveredFiles.map((path, index) => ({ path, reason: 'Matched prompt keywords', source: 'auto', score: 94 - index * 4 })),
};

const studioDrafts: Record<string, Record<string, unknown>> = {
  'plan-agents-exec': {
    draft_id: 'plan-agents-exec', repository, name: 'Add an "Agents" feature to ProPR, scoped to a deliberately small v1', initial_prompt: 'Add an "Agents" feature to ProPR.',
    status: 'executed', plan_json: agentExecutionPlan, context_config: { baseBranch: 'main', useEpic: false, autoMerge: true, runUltrafix: true, ultrafixGoal: 8, ultrafixMaxCycles: 5 },
    created_at: ago(5), updated_at: ago(1),
  },
  'plan-agents': {
    draft_id: 'plan-agents', repository, name: 'Add an "Agents" feature to ProPR, scoped to a deliberately small v1', initial_prompt: 'Add an "Agents" feature to ProPR.',
    status: 'review', plan_json: agentPlan, chat_history: [], context_config: { baseBranch: 'main' }, created_at: ago(5), updated_at: ago(1),
  },
  'plan-short': {
    draft_id: 'plan-short', repository, name: 'Add an "Agents" feature to ProPR, scoped to a deliberately small v1', initial_prompt: 'Add an "Agents" feature to ProPR.',
    status: 'review', plan_json: agentTasks(agentTitles.slice(0, 3)), chat_history: [], context_config: { baseBranch: 'main' }, created_at: ago(5), updated_at: ago(1),
  },
  'plan-mcp-exec': {
    draft_id: 'plan-mcp-exec', repository, name: 'Repository Search and Read MCP Tools Implementation', initial_prompt: longPrompt,
    status: 'executed', plan_json: executionPlan, context_config: { baseBranch: 'main', useEpic: false, autoMerge: true, runUltrafix: true, ultrafixGoal: 8, ultrafixMaxCycles: 5 },
    created_at: ago(5), updated_at: ago(1),
  },
  // Active states: generation underway (gathering context, then the LLM call) and GitHub issues being created.
  'plan-gathering': {
    draft_id: 'plan-gathering', repository, name: 'Add an "Agents" feature to ProPR, scoped to a deliberately small v1', initial_prompt: 'Add an "Agents" feature to ProPR.',
    status: 'generating', plan_json: [], context_config: { baseBranch: 'main', contextLevel: 100, granularity: 'granular', lastPreview }, created_at: ago(5), updated_at: ago(0),
    generation_trace: { runId: 'run-gathering', steps: [
      { name: 'relevance', status: 'completed', data: runningFor(20_000, 18) },
      { name: 'context', status: 'in_progress', data: runningFor(30_000, 11) },
      { name: 'llm', status: 'pending' },
    ] },
  },
  'plan-generating': {
    draft_id: 'plan-generating', repository, name: 'Add an "Agents" feature to ProPR, scoped to a deliberately small v1', initial_prompt: 'Add an "Agents" feature to ProPR.',
    status: 'generating', plan_json: [], context_config: { baseBranch: 'main', contextLevel: 100, granularity: 'granular', lastPreview }, created_at: ago(5), updated_at: ago(0),
    generation_trace: { runId: 'run-generating', steps: [
      { name: 'relevance', status: 'completed', data: runningFor(60_000, 55) },
      { name: 'context', status: 'completed', data: { ...runningFor(60_000, 45), includedFiles: discoveredFiles, tokenCount: 842_496 } },
      { name: 'llm', status: 'in_progress', data: runningFor(180_000, 40) },
    ] },
  },
  'plan-creating': {
    draft_id: 'plan-creating', repository, name: 'Add an "Agents" feature to ProPR, scoped to a deliberately small v1', initial_prompt: 'Add an "Agents" feature to ProPR.',
    status: 'executing', plan_json: agentPlan, context_config: { baseBranch: 'main', useEpic: false, autoMerge: true, runUltrafix: true, ultrafixGoal: 8, ultrafixMaxCycles: 5 },
    created_at: ago(5), updated_at: ago(0),
  },
  'plan-setup': {
    draft_id: 'plan-setup', repository, name: 'Implement the ProPR fleet orchestration', initial_prompt: 'Implement the entire ProPR fleet orchestration as described in the plan documents. Prefer the same stack as ProPR whenever applicable.',
    status: 'draft', plan_json: [], context_config: { baseBranch: 'main', contextLevel: 100, granularity: 'granular' },
    created_at: ago(5), updated_at: ago(1),
  },
};

export const implementRequests: string[] = [];
export const queueRequests: string[] = [];
const executionQueues: Record<string, unknown> = {};

// Answers a studio draft's own endpoints; undefined lets the request fall through to the shared responses.
function fulfillDraftRoute(route: Route, draftId: string, suffix: string | undefined) {
  if (!suffix) return route.fulfill({ json: studioDrafts[draftId] });
  if (suffix === '/issues') return route.fulfill({ json: planIssues[draftId] ?? [] });
  if (suffix === '/execution-queue' && route.request().method() === 'POST') {
    // Mirrors the server: in-flight issues head the queue and every pending issue waits behind them.
    queueRequests.push(draftId);
    const issues = ((planIssues[draftId] ?? []) as Array<{ id: number; issue_number: number; status: string }>).filter(issue => !['merged', 'closed'].includes(issue.status))
      .sort((left, right) => Number(left.status === 'pending') - Number(right.status === 'pending') || left.id - right.id);
    executionQueues[draftId] = { issues: issues.map(issue => issue.issue_number), cursor: 0, head: issues[0]?.issue_number ?? null, status: 'active', blockedReason: null };
    const queued = issues.filter(issue => issue.status === 'pending').map(issue => issue.issue_number);
    return route.fulfill({ json: { queued, alreadyQueued: false, queue: executionQueues[draftId] } });
  }
  if (suffix === '/execution-queue') return route.fulfill({ json: { queue: executionQueues[draftId] ?? null } });
  const issueMatch = suffix.match(/^\/issues\/(\d+)$/);
  if (issueMatch && route.request().method() === 'PATCH') {
    const stored = ((planIssues[draftId] ?? []) as Array<{ issue_number: number }>).find(issue => issue.issue_number === Number(issueMatch[1]));
    return route.fulfill({ json: { ...stored, ...route.request().postDataJSON() } });
  }
  if (suffix === '/repository-info') return route.fulfill({ json: { defaultBranch: 'main', branches: ['main'] } });
  return undefined;
}

export async function fixture(page: Page) {
  implementRequests.length = 0;
  queueRequests.length = 0;
  for (const draftId of Object.keys(executionQueues)) delete executionQueues[draftId];
  await page.routeWebSocket('**/socket.io/**', socket => socket.close());
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (route.request().method() === 'POST' && path.endsWith('/implement')) implementRequests.push(path);
    const draftMatch = path.match(/^\/api\/planner\/drafts\/([^/]+)(\/.*)?$/);
    if (path === '/api/planner/drafts') return route.fulfill({ json: { drafts, total: drafts.length, page: 1, limit: 20, hasMore: false } });
    if (path === '/api/planner/drafts/repositories') return route.fulfill({ json: { repositories: [{ repo: repository, count: 6 }, { repo: 'integry/digvin', count: 1 }], total: 7 } });
    if (draftMatch && studioDrafts[draftMatch[1]]) {
      const handled = fulfillDraftRoute(route, draftMatch[1], draftMatch[2]);
      if (handled) return handled;
    }
    const responses: Record<string, unknown> = {
      '/api/auth/demo-mode': { demoMode: false },
      '/api/auth/user': { id: 'preview-user', login: 'operator', username: 'operator', displayName: 'Operator', email: null, avatarUrl: null, role: 'admin', permissions: ['instance.manage_settings'], authorizationSource: 'local' },
      '/api/repositories/indexing-status': { repositories: [] },
      '/api/user/repo-preferences': { preferences: {} },
      '/api/stats/active-work': { counts: { tasks: 0, plans: 0, goals: 0, total: 0 } },
      '/api/instance/catalog': { agents: [{ alias: 'claude', enabled: true, supportedModels: ['claude-opus-5-5', 'claude-sonnet-5-5'], defaultModel: 'claude-opus-5-5' }], repositories: [{ name: repository, enabled: true, baseBranch: 'main' }], defaultAgentAlias: 'claude' },
      '/api/notifications/unread-count': { unreadCount: 0 },
      '/api/notifications/preferences': { preferences: {}, quietHours: {}, badgeEnabled: false },
    };
    return route.fulfill(path in responses ? { json: responses[path] } : { status: 503, json: { error: 'Unavailable in planner studio fixture' } });
  });
}

/**
 * Stands in for the socket.io server: completes the engine.io handshake and answers each
 * `subscribe:draft` with the given `draft:update` payloads, so live progress renders without a backend.
 */
export async function liveDraftUpdates(page: Page, updates: Record<string, Array<Record<string, unknown>>>) {
  await page.routeWebSocket('**/socket.io/**', socket => {
    const timers: ReturnType<typeof setInterval>[] = [];
    socket.send(`0${JSON.stringify({ sid: 'preview', upgrades: [], pingInterval: 300_000, pingTimeout: 300_000, maxPayload: 1_000_000 })}`);
    socket.onMessage(message => {
      const text = String(message);
      if (text.startsWith('40')) socket.send('40{"sid":"preview-socket"}');
      if (!text.startsWith('42')) return;
      const [event, draftId] = JSON.parse(text.slice(2)) as [string, string];
      if (event !== 'subscribe:draft' || !updates[draftId]) return;
      // Repeat like a live server does, so an update that lands before the page starts listening is not lost.
      const send = () => { for (const payload of updates[draftId]) socket.send(`42${JSON.stringify(['draft:update', { eventType: 'draft:update', draftId, timestamp: new Date().toISOString(), ...payload }])}`); };
      send();
      timers.push(setInterval(send, 1_000));
    });
    socket.onClose(() => timers.forEach(clearInterval));
  });
}

export async function capture(page: Page, name: string) {
  if (!process.env.PROPR_CAPTURE_PREVIEWS) return;
  await mkdir('../.propr/previews', { recursive: true });
  await page.screenshot({ animations: 'disabled', path: `../.propr/previews/${name}.png` });
}

export const creatingIssueUpdate = {
  step: 'execution', status: 'in_progress',
  data: { createdCount: 6, totalCount: 17, failedCount: 0, lastCreatedIssue: { number: 2905, url: 'https://github.com/integry/propr/issues/2905', title: agentPlan[5].title } },
};

// The live trace the server pushes while a plan generates; the page starts from a placeholder trace until it arrives.
export const generationUpdate = (draftId: string) => {
  const trace = studioDrafts[draftId].generation_trace as { runId: string; steps: Array<{ name: string; status: string }> };
  return { step: trace.steps.find(step => step.status === 'in_progress')!.name, status: 'in_progress', runId: trace.runId, draftStatus: 'generating', generationTrace: trace };
};
