import { expect, test, type Page } from '@playwright/test';
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
const agentPlan = agentTasks(agentTitles);

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
    status: 'generating', plan_json: [], context_config: { baseBranch: 'main', contextLevel: 100, granularity: 'granular' }, created_at: ago(5), updated_at: ago(0),
    generation_trace: { runId: 'run-gathering', steps: [
      { name: 'relevance', status: 'completed', data: runningFor(20_000, 18) },
      { name: 'context', status: 'in_progress', data: runningFor(30_000, 11) },
      { name: 'llm', status: 'pending' },
    ] },
  },
  'plan-generating': {
    draft_id: 'plan-generating', repository, name: 'Add an "Agents" feature to ProPR, scoped to a deliberately small v1', initial_prompt: 'Add an "Agents" feature to ProPR.',
    status: 'generating', plan_json: [], context_config: { baseBranch: 'main', contextLevel: 100, granularity: 'granular' }, created_at: ago(5), updated_at: ago(0),
    generation_trace: { runId: 'run-generating', steps: [
      { name: 'relevance', status: 'completed', data: runningFor(60_000, 55) },
      { name: 'context', status: 'completed', data: runningFor(60_000, 45) },
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

const implementRequests: string[] = [];
const queueRequests: string[] = [];
const executionQueues: Record<string, unknown> = {};

async function fixture(page: Page) {
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
      const [, draftId, suffix] = draftMatch;
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
      const issueMatch = suffix?.match(/^\/issues\/(\d+)$/);
      if (issueMatch && route.request().method() === 'PATCH') {
        const stored = ((planIssues[draftId] ?? []) as Array<{ issue_number: number }>).find(issue => issue.issue_number === Number(issueMatch[1]));
        return route.fulfill({ json: { ...stored, ...route.request().postDataJSON() } });
      }
      if (suffix === '/repository-info') return route.fulfill({ json: { defaultBranch: 'main', branches: ['main'] } });
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
async function liveDraftUpdates(page: Page, updates: Record<string, Array<Record<string, unknown>>>) {
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

async function capture(page: Page, name: string) {
  if (!process.env.PROPR_CAPTURE_PREVIEWS) return;
  await mkdir('../.propr/previews', { recursive: true });
  await page.screenshot({ animations: 'disabled', path: `../.propr/previews/${name}.png` });
}

test.beforeEach(async ({ page }) => {
  await fixture(page);
  await page.setViewportSize({ width: 1440, height: 900 });
});

test('plans index keeps every row to one plain-text line with quiet status and unboxed repo', async ({ page }) => {
  await page.goto('/plans');
  const title = page.getByText(/^Expose the repository retrieval/);
  await expect(title).toBeVisible();
  await expect(page.getByText(/##/)).toHaveCount(0);
  const lineHeight = await title.evaluate(element => parseFloat(getComputedStyle(element).lineHeight));
  expect((await title.boundingBox())!.height).toBeLessThanOrEqual(lineHeight + 1);
  await expect(page.locator('span.rounded-full', { hasText: 'In Review' }).first()).toHaveClass(/bg-slate-100/);
  await expect(page.locator('span.rounded-full', { hasText: 'Merged' }).first()).toHaveClass(/bg-purple-50/);
  await expect(page.locator('span.rounded-full', { hasText: 'Failed' }).first()).toHaveClass(/bg-red-50/);
  await expect(page.getByText('3 issues • 1 running • 2 merged')).toBeVisible();
  await expect(page.locator('a.font-mono', { hasText: /^propr$/ }).first()).not.toHaveClass(/bg-/);
  await expect(page.locator('a.font-mono', { hasText: 'integry/' })).toHaveCount(0);
  await capture(page, 'plans-index');
});

test('review step lists the plan outline with titles instead of a blind numbered rail', async ({ page }) => {
  await page.goto('/studio/plan-agents');
  const outline = page.getByRole('navigation', { name: 'Plan outline' });
  await expect(outline).toBeVisible();
  await expect(outline.getByRole('button', { name: /Shared contracts for agent definitions/ })).toHaveAttribute('aria-current', 'step');
  const longStep = outline.getByRole('button', { name: /Shared contracts for agent definitions/ }).locator('span').last();
  expect(await longStep.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await expect(page.getByTitle('Undo').locator('..')).toHaveClass(/border-slate-200/);
  await expect(page.getByTitle('Delete Plan')).toHaveCount(0);
  await capture(page, 'review-plan-outline');
  await expect(outline.getByRole('listitem')).toHaveCount(17);
  // The Assistant is a fixed 340px companion column; the specification takes the rest.
  expect((await page.getByTestId('plan-assistant').boundingBox())!.width).toBe(340);
  expect((await page.locator('[data-task-list]').boundingBox())!.width).toBeGreaterThan(540);
  await outline.getByRole('button', { name: /Database migration and definition store/ }).click();
  await expect(outline.getByRole('button', { name: /Database migration and definition store/ })).toHaveAttribute('aria-current', 'step');
  // Each step renders its own requirements.
  await expect(page.locator('[data-task-index="1"]')).toContainText('migrations/0042_agent_definitions.sql');
  await expect(page.locator('[data-task-index="1"]')).not.toContainText('agentDefinitions.ts');
  // The drag handle sits inside the row, past the active border and left of the step number.
  const cronStep = outline.getByRole('button', { name: /Cron schedule sweep/ });
  await cronStep.click();
  await expect(cronStep).toHaveAttribute('aria-current', 'step');
  await expect(page.locator('[data-task-index="11"]')).toContainText('agentScheduleSweep.ts');
  // The outline click scrolls the specification to step 12.
  await expect.poll(() => page.locator('[data-task-index="11"]').evaluate(card => Math.round(card.getBoundingClientRect().top - card.closest('[data-task-list]')!.getBoundingClientRect().top))).toBe(0);
  await cronStep.hover();
  const handle = (await outline.getByLabel('Reorder step 12').boundingBox())!;
  const row = (await cronStep.boundingBox())!;
  const number = (await cronStep.locator('span').first().boundingBox())!;
  expect(handle.x).toBeGreaterThanOrEqual(row.x + 2);
  expect(handle.x + handle.width).toBeLessThanOrEqual(number.x + number.width - 12);
  await page.waitForTimeout(300);
  await capture(page, 'review-plan-outline-drag-handle');

  const specBefore = (await page.locator('[data-task-list]').boundingBox())!.width;
  await page.getByRole('button', { name: 'Collapse outline' }).click();
  await page.getByRole('button', { name: 'Assistant' }).click();
  await expect(outline).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Assistant' })).toHaveAttribute('aria-pressed', 'false');
  expect((await page.locator('[data-task-list]').boundingBox())!.width).toBeGreaterThan(specBefore + 500);
  await capture(page, 'review-plan-full-width');
  await page.getByRole('button', { name: 'Show outline' }).click();
  await expect(outline).toBeVisible();
});

test('review step uses a tab bar instead of the outline rail for short plans', async ({ page }) => {
  await page.goto('/studio/plan-short');
  const tabs = page.getByRole('navigation', { name: 'Plan steps' });
  await expect(tabs).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Plan outline' })).toHaveCount(0);
  // Step tabs, not the reorder handles beside them.
  const stepTabs = tabs.getByRole('button', { name: /^\d+\. / });
  await expect(stepTabs).toHaveCount(3);
  await expect(tabs.getByRole('button', { name: '1. Shared Contracts' })).toHaveAttribute('aria-current', 'step');
  await expect(tabs.getByRole('button', { name: '3. Agent Run Store' })).toBeVisible();
  // With room to spare, tabs size to their labels on one line instead of truncating beside empty space.
  const clipped = await stepTabs.evaluateAll(buttons => buttons.flatMap(button => [...button.querySelectorAll('span')])
    .filter(label => label.scrollWidth > label.clientWidth + 1).map(label => label.textContent));
  expect(clipped).toEqual([]);
  const tabHeights = await stepTabs.evaluateAll(buttons => buttons.map(button => Math.round(button.getBoundingClientRect().height)));
  expect(new Set(tabHeights).size).toBe(1);
  // The phase pill keeps clear of the header's icon cluster.
  const pill = (await page.getByRole('navigation', { name: 'Plan phase' }).boundingBox())!;
  const nextControl = await page.getByRole('navigation', { name: 'Plan phase' }).evaluate(nav => {
    const right = nav.getBoundingClientRect().right;
    const header = nav.closest('header') ?? document.body;
    const lefts = [...header.querySelectorAll('button, a')].map(control => control.getBoundingClientRect())
      .filter(box => box.width > 0 && box.left >= right - 1).map(box => box.left);
    return Math.min(...lefts);
  });
  expect(nextControl - (pill.x + pill.width)).toBeGreaterThanOrEqual(12);
  const notes = page.getByText('User Notes').first().locator('xpath=ancestor::div[contains(@class, "rounded-md")][1]');
  await expect(notes).toHaveCSS('border-top-style', 'solid');
  await expect(notes.locator('.border-dashed')).toHaveCount(0);
  expect((await page.locator('[data-task-list]').boundingBox())!.width).toBeGreaterThan(700);
  await expect(tabs).toHaveCSS('background-color', 'rgb(255, 255, 255)');
  await expect(tabs).toHaveCSS('z-index', '10');
  // The tab bar is a fixed row above the scroll container, not sticky inside it.
  await expect(tabs).not.toHaveCSS('position', 'sticky');
  expect(await page.locator('[data-task-list]').evaluate(list => list.contains(document.querySelector('nav[aria-label="Plan steps"]')))).toBe(false);
  // Tabs show a short feature label on one line, with no ellipsis.
  for (const label of await tabs.getByRole('listitem').locator('span:last-child').all()) {
    expect(await label.evaluate(element => element.scrollWidth <= element.clientWidth && element.clientHeight <= parseFloat(getComputedStyle(element).lineHeight) + 1)).toBe(true);
  }
  // Each task has its own requirements, not task 1's copied.
  await expect(page.locator('[data-task-index="2"]')).toContainText('packages/server/src/runStore.ts');
  await expect(page.locator('[data-task-index="2"]')).not.toContainText('agentDefinitions.ts');
  // Headings drop the stored "Agents v1 (n/m):" prefix and let the leading number carry the order.
  await expect(page.locator('[data-task-index="0"]').getByRole('heading').first()).toContainText('Shared contracts for agent definitions');
  await expect(page.locator('[data-task-index="0"]').getByRole('heading').first()).not.toContainText('(1/3)');
  await expect(page.getByText(/\(\d+\/17\)/)).toHaveCount(0);
  // Phases sit on the title row and the primary action sits in the header: no stepper band, no footer bar.
  const header = page.getByRole('heading', { level: 1 }).locator('xpath=ancestor::div[contains(@class, "justify-between")][1]');
  await expect(header.getByRole('navigation', { name: 'Plan phase' })).toContainText('Review(3)');
  await expect(page.getByRole('navigation', { name: 'Progress' })).toBeHidden();
  await expect(header.getByRole('button', { name: 'Create 3 GitHub Issues' })).toBeVisible();
  await expect(page.getByText('3 tasks in plan')).toHaveCount(0);
  expect((await tabs.boundingBox())!.y).toBeLessThan(150);
  await page.getByRole('button', { name: 'More plan actions' }).click();
  await expect(page.getByRole('menuitem', { name: 'Delete plan' })).toBeVisible();
  await page.mouse.click(5, 5);
  await capture(page, 'review-plan-tabs');
  // Scrolled specification text stays below the tabs instead of showing through them.
  await page.locator('[data-task-list]').evaluate(element => { element.scrollTop = 330; });
  const tabBox = (await tabs.boundingBox())!;
  for (const x of [0.2, 0.5, 0.8]) {
    const hit = await page.evaluate(([px, py]) => !!document.elementFromPoint(px, py)?.closest('nav[aria-label="Plan steps"]'), [tabBox.x + tabBox.width * x, tabBox.y + tabBox.height - 2]);
    expect(hit).toBe(true);
  }
  // Wheel-scrolling and tab clicks move only the specification: nothing renders above the tabs.
  const tabTop = tabBox.y;
  await page.mouse.move(tabBox.x + 200, tabBox.y + 300);
  await page.mouse.wheel(0, 600);
  await stepTabs.nth(2).click();
  await expect(stepTabs.nth(2)).toHaveAttribute('aria-current', 'step');
  await page.waitForTimeout(800);
  expect((await tabs.boundingBox())!.y).toBe(tabTop);
  const listTop = (await page.locator('[data-task-list]').boundingBox())!.y;
  expect(listTop).toBeGreaterThanOrEqual(tabTop + tabBox.height - 1);
  await capture(page, 'review-plan-tabs-scrolled');
  // Scroll-spy: the specification is one continuous document, so scrolling moves the active tab.
  const list = page.locator('[data-task-list]');
  const task2Top = await page.locator('[data-task-index="1"]').evaluate(card => {
    const container = card.closest('[data-task-list]')!;
    return container.scrollTop + card.getBoundingClientRect().top - container.getBoundingClientRect().top;
  });
  await list.evaluate((element, top) => { element.scrollTop = top; }, task2Top);
  await expect(stepTabs.nth(1)).toHaveAttribute('aria-current', 'step');
  await capture(page, 'review-plan-tabs-scroll-spy');
  await list.evaluate(element => { element.scrollTop = 0; });
  await expect(stepTabs.nth(0)).toHaveAttribute('aria-current', 'step');
  await page.locator('[data-task-list]').evaluate(element => { element.scrollTop = 0; });
  await notes.scrollIntoViewIfNeeded();
  await capture(page, 'review-plan-user-notes');
});

test('execution step renders one matrix with batch controls and labelled ultrafix inputs', async ({ page }) => {
  await page.goto('/studio/plan-mcp-exec');
  await expect(page.getByRole('radio', { name: 'Execute as Individual Tasks' })).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByTestId('plan-execution-matrix').getByTestId('plan-execution-row')).toHaveCount(3);
  await expect(page.getByTestId('plan-execution-matrix').getByTestId('agent-chip')).toHaveText('Opus 5.5');
  for (const button of await page.getByRole('button', { name: 'Implement' }).all()) await expect(button).not.toHaveClass(/amber/);
  const configButton = page.getByTestId('execution-config-button');
  await expect(configButton).toContainText('Opus 5.5 · Ultrafix (8/10) · Auto-merge');
  await expect(page.getByText('PR Options')).toHaveCount(0);
  expect((await page.getByTestId('execution-options-bar').boundingBox())!.height).toBeLessThanOrEqual(56);
  // Agent and action columns line up across running and pending rows.
  const rows = page.getByTestId('plan-execution-matrix').getByTestId('plan-execution-row');
  const agentX = await rows.getByTestId('agent-column').evaluateAll(cells => cells.map(cell => Math.round(cell.getBoundingClientRect().x)));
  const actionX = await rows.getByTestId('action-column').evaluateAll(cells => cells.map(cell => Math.round(cell.getBoundingClientRect().x)));
  expect(new Set(agentX).size).toBe(1);
  expect(new Set(actionX).size).toBe(1);
  expect(actionX[0]).toBeGreaterThan(agentX[0]);
  await expect(rows.nth(0).getByTestId('action-column')).toContainText('View Progress');
  await expect(rows.nth(1).getByTestId('action-column')).toContainText('Implement');
  await expect(page.getByRole('navigation', { name: 'Plan phase' })).toBeVisible();
  await page.waitForTimeout(500);
  await capture(page, 'execution-matrix');
  await configButton.click();
  await expect(page.getByRole('dialog', { name: 'Execution config' })).toBeVisible();
  await expect(page.getByLabel('Max Loops')).toHaveValue('5');
  await expect(page.getByLabel('Min Review Score').locator('option:checked')).toHaveText('◆ 8/10 (Standard)');
  await expect(page.getByTestId('ultrafix-nested-settings')).toBeVisible();
  const matrix = page.getByTestId('plan-execution-matrix');
  await expect(matrix.getByRole('combobox')).toHaveCount(0);
  await expect(matrix.getByTestId('agent-override-chip').first()).toHaveText('Opus 5.5');
  // #2798 is running; the batch stays available and queues its successors behind it.
  await expect(page.getByRole('button', { name: 'Queue Remaining (2 tasks)' })).toBeEnabled();
  await capture(page, 'execution-config-popover');
  await page.keyboard.press('Escape');
  await matrix.getByTestId('agent-override-chip').first().click();
  const override = page.getByRole('dialog', { name: /Agent override for #2799/ });
  await expect(override).toBeVisible();
  await expect(override.getByRole('button', { name: 'Reset to default' })).toHaveCount(0);
  // A per-issue override offers a way back to the plan default.
  await override.getByRole('combobox').nth(1).selectOption('claude-sonnet-5-5');
  await expect(matrix.getByTestId('agent-override-chip').first()).toHaveText('Sonnet 5.5');
  await expect(override.getByRole('button', { name: 'Reset to default' })).toBeVisible();
  await capture(page, 'execution-agent-override');
  await override.getByRole('button', { name: 'Reset to default' }).click();
  await expect(override).toHaveCount(0);
  await expect(matrix.getByTestId('agent-override-chip').first()).toHaveText('Opus 5.5');
  // Clicking anywhere else dismisses the popover.
  await matrix.getByTestId('agent-override-chip').first().click();
  await expect(override).toBeVisible();
  await page.mouse.click(700, 700);
  await expect(override).toHaveCount(0);
});

test('execution step for a 17-issue plan keeps the title readable and queues the backlog while others run', async ({ page }) => {
  await page.goto('/studio/plan-agents-exec');
  const matrix = page.getByTestId('plan-execution-matrix');
  await expect(matrix.getByTestId('plan-execution-row')).toHaveCount(12);
  // The title keeps at least 320px next to the grouped header controls.
  const title = page.getByRole('heading', { level: 1 });
  expect((await title.boundingBox())!.width).toBeGreaterThanOrEqual(320);
  // A compact repository chip leads the title so the git context is never lost.
  const repoChip = page.getByTestId('plan-repo-chip');
  await expect(repoChip).toHaveText('propr');
  await expect(repoChip).toHaveAttribute('title', 'integry/propr / main');
  expect((await repoChip.boundingBox())!.x).toBeLessThan((await title.boundingBox())!.x);
  await expect(page.getByRole('link', { name: 'View issues on GitHub' })).toHaveText('GitHub');
  await expect(page.getByTitle('Delete Plan')).toHaveCount(0);
  await page.getByRole('button', { name: 'More plan actions' }).click();
  await expect(page.getByRole('menuitem', { name: 'Delete plan' })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.mouse.click(5, 5);
  // Rows lead with the step, not "Agents v1 (6/17):".
  await expect(matrix.getByText('Report-run prompt builder with previous reports and input files', { exact: true })).toBeVisible();
  await expect(matrix.getByText(/Agents v1 \(/)).toHaveCount(0);
  // Running issues do not hold the backlog: the batch queues the rest behind them without starting any now.
  const queue = page.getByRole('button', { name: 'Queue Remaining (10 tasks)' });
  await expect(queue).toBeEnabled();
  await expect(page.getByTestId('execute-all-hint')).toContainText('Queues 10 tasks behind the running work');
  await page.waitForTimeout(500);
  await capture(page, 'execution-17-issues');
  await queue.scrollIntoViewIfNeeded();
  await capture(page, 'execution-17-issues-queue');
  await queue.click();
  await expect(page.getByTestId('execute-all-hint')).toContainText('10 tasks queued. Each starts automatically');
  await expect(page.getByRole('button', { name: /Queue Remaining/ })).toHaveCount(0);
  await expect(matrix.getByText('Queued', { exact: true })).toHaveCount(10);
  expect(queueRequests).toEqual(['plan-agents-exec']);
  expect(implementRequests).toEqual([]);
  await page.getByTestId('execute-all-hint').scrollIntoViewIfNeeded();
  await capture(page, 'execution-17-issues-queued');
});

test('define step shows technical scope estimates and consistent token units', async ({ page }) => {
  await page.goto('/studio/plan-setup');
  await expect(page.getByTestId('context-scope-descriptor')).toContainText('Full Repository Scan');
  await expect(page.getByText(/Slower|\$\$\$/)).toHaveCount(0);
  const generate = page.getByRole('button', { name: /Generate Plan/ });
  const breakPlan = page.getByText('Break plan:');
  expect(Math.abs((await generate.boundingBox())!.y + (await generate.boundingBox())!.height / 2 - ((await breakPlan.boundingBox())!.y + (await breakPlan.boundingBox())!.height / 2))).toBeLessThan(8);
  await expect(page.getByTestId('branch-chip')).toContainText('main');
  // Generation settings are docked to the prompt box, not pinned to a page-wide footer.
  const composerFooter = page.getByTestId('composer-footer');
  await expect(composerFooter.getByRole('button', { name: /Generate Plan/ })).toBeVisible();
  await expect(composerFooter.getByText('Break plan:')).toBeVisible();
  expect((await composerFooter.boundingBox())!.y + (await composerFooter.boundingBox())!.height).toBeLessThan(700);
  await expect(page.getByRole('navigation', { name: 'Plan phase' })).toContainText('Define');
  await capture(page, 'define-context-scope');
});

test('model selectors name the default model instead of a bare "Default"', async ({ page }) => {
  await page.goto('/studio/plan-setup');
  const defineModel = page.getByTestId('composer-footer').getByTestId('planner-model-selector');
  await expect(defineModel).toHaveText('Claude Opus 5.5 (Default)');
  // The docked row leaves the full label readable rather than truncating it to "Cla…".
  expect(await defineModel.locator('span').last().evaluate(label => label.scrollWidth <= label.clientWidth)).toBe(true);
  await defineModel.click();
  const menu = page.getByRole('listbox', { name: 'Plan model' });
  await expect(menu.getByRole('option', { selected: true })).toContainText('Claude Opus 5.5 (Configured Default)');
  await expect(menu.getByRole('option')).toHaveCount(3);
  await capture(page, 'define-model-default-menu');
  await menu.getByRole('option', { name: /Claude Sonnet 5\.5/ }).click();
  await expect(defineModel).toHaveText('Claude Sonnet 5.5');

  await page.goto('/studio/plan-agents');
  const assistant = page.getByTestId('plan-assistant');
  await expect(assistant.getByText('Refine with')).toHaveCount(0);
  await expect(assistant.getByText('Model:')).toBeVisible();
  const refineModel = assistant.getByTestId('planner-model-selector');
  await expect(refineModel).toHaveText('Claude Opus 5.5 (Default)');
  await refineModel.click();
  await expect(page.getByRole('listbox', { name: 'Plan model' }).getByRole('option', { selected: true })).toContainText('Claude Opus 5.5 (Configured Default)');
  await capture(page, 'review-assistant-model-menu');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('listbox', { name: 'Plan model' })).toHaveCount(0);
});

test('short plans can still be reordered from the tab bar', async ({ page }) => {
  await page.goto('/studio/plan-short');
  const tabs = page.getByRole('navigation', { name: 'Plan steps' });
  const stepTabs = tabs.getByRole('button', { name: /^\d+\. / });
  await expect(stepTabs.first()).toHaveAccessibleName('1. Shared Contracts');
  await tabs.getByRole('listitem').nth(2).hover();
  const handle = (await tabs.getByLabel('Reorder step 3').boundingBox())!;
  const firstTab = (await tabs.getByRole('listitem').first().boundingBox())!;
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(handle.x - 40, handle.y + handle.height / 2, { steps: 5 });
  await page.mouse.move(firstTab.x + 20, firstTab.y + firstTab.height / 2, { steps: 15 });
  await page.mouse.up();
  await expect(stepTabs.first()).toHaveAccessibleName('1. Agent Run Store');
  await expect(stepTabs.nth(1)).toHaveAccessibleName('2. Shared Contracts');
  await expect(page.locator('[data-task-index="0"]')).toContainText('Agent run store');
  // Let the reordered cards finish their layout animation before capturing.
  await page.waitForTimeout(600);
  await capture(page, 'review-plan-tabs-reordered');
});

test('execution popovers stay inside the viewport near its bottom edge', async ({ page }) => {
  // A laptop-height window, so the matrix scrolls and a pending row can sit at the bottom edge.
  await page.setViewportSize({ width: 1440, height: 600 });
  await page.goto('/studio/plan-agents-exec');
  const matrix = page.getByTestId('plan-execution-matrix');
  // The fifth pending row sits at the bottom of the scrolled matrix, with too little room below for the popover.
  const chip = matrix.getByTestId('agent-override-chip').nth(4);
  const chipBox = (await chip.boundingBox())!;
  expect(chipBox.y + chipBox.height).toBeGreaterThan(600 - 70);
  await chip.click();
  const dialog = page.getByRole('dialog', { name: /Agent override for #\d+/ });
  await expect(dialog).toBeVisible();
  const box = (await dialog.boundingBox())!;
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.y + box.height).toBeLessThanOrEqual(600);
  // Flipped above the chip rather than running off the bottom of the screen.
  expect(box.y + box.height).toBeLessThanOrEqual(chipBox.y);
  await expect(dialog.getByRole('combobox').first()).toBeInViewport();
  await capture(page, 'execution-agent-override-flipped');
  await page.keyboard.press('Escape');

  // On a short viewport the config popover scrolls internally instead of overflowing.
  await page.setViewportSize({ width: 1440, height: 420 });
  await page.getByTestId('execution-config-button').scrollIntoViewIfNeeded();
  await page.getByTestId('execution-config-button').click();
  const config = page.getByRole('dialog', { name: 'Execution config' });
  await expect(config).toBeVisible();
  const configBox = (await config.boundingBox())!;
  expect(configBox.y).toBeGreaterThanOrEqual(0);
  expect(configBox.y + configBox.height).toBeLessThanOrEqual(420);
  await expect(config).toHaveCSS('overflow-y', 'auto');
  await config.getByLabel('Max Loops').scrollIntoViewIfNeeded();
  await expect(config.getByLabel('Max Loops')).toBeInViewport();
  await capture(page, 'execution-config-short-viewport');
});

for (const viewport of [{ name: 'mobile', width: 390, height: 844 }, { name: 'laptop', width: 1024, height: 768 }]) {
  test(`planner screens fit a ${viewport.name} viewport without horizontal overflow`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

    await page.goto('/studio/plan-short');
    await expect(page.locator('[data-task-index="0"]')).toBeVisible();
    expect(await overflow()).toBeLessThanOrEqual(0);
    await capture(page, `review-plan-${viewport.name}`);

    await page.goto('/studio/plan-agents-exec');
    const matrix = page.getByTestId('plan-execution-matrix');
    await expect(matrix.getByTestId('plan-execution-row')).toHaveCount(12);
    expect(await overflow()).toBeLessThanOrEqual(0);
    await expect(page.getByTestId('execution-config-button')).toBeInViewport();
    // Each row keeps its title and action visible inside the matrix.
    const matrixBox = (await matrix.boundingBox())!;
    const action = (await matrix.getByTestId('action-column').first().boundingBox())!;
    expect(action.x + action.width).toBeLessThanOrEqual(matrixBox.x + matrixBox.width + 1);
    await capture(page, `execution-${viewport.name}`);
  });
}

const creatingIssueUpdate = {
  step: 'execution', status: 'in_progress',
  data: { createdCount: 6, totalCount: 17, failedCount: 0, lastCreatedIssue: { number: 2905, url: 'https://github.com/integry/propr/issues/2905', title: agentPlan[5].title } },
};

// The live trace the server pushes while a plan generates; the page starts from a placeholder trace until it arrives.
const generationUpdate = (draftId: string) => {
  const trace = studioDrafts[draftId].generation_trace as { runId: string; steps: Array<{ name: string; status: string }> };
  return { step: trace.steps.find(step => step.status === 'in_progress')!.name, status: 'in_progress', runId: trace.runId, draftStatus: 'generating', generationTrace: trace };
};

for (const viewport of [{ name: 'desktop', width: 1440, height: 900 }, { name: 'mobile', width: 390, height: 844 }]) {
  test(`active planner states render their live progress on ${viewport.name}`, async ({ page }) => {
    await liveDraftUpdates(page, { 'plan-gathering': [generationUpdate('plan-gathering')], 'plan-generating': [generationUpdate('plan-generating')], 'plan-creating': [creatingIssueUpdate] });
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

    await page.goto('/studio/plan-gathering');
    await expect(page.getByText('Gathering Context')).toBeVisible();
    await expect(page.getByText(/remaining$/)).toHaveCount(1);
    await expect(page.getByText('In Progress')).toHaveCount(1);
    await expect(page.getByText('Will analyze context and generate implementation plan')).toBeVisible();
    expect(await overflow()).toBeLessThanOrEqual(0);
    await page.waitForTimeout(600);
    await capture(page, `active-gathering-context-${viewport.name}`);

    await page.goto('/studio/plan-generating');
    await expect(page.getByText('Generating Plan')).toBeVisible();
    await expect(page.getByText(/remaining$/)).toHaveCount(1);
    await expect(page.getByText(/^Will /)).toHaveCount(0);
    expect(await overflow()).toBeLessThanOrEqual(0);
    await page.waitForTimeout(600);
    await capture(page, `active-generating-plan-${viewport.name}`);

    await page.goto('/studio/plan-creating');
    await expect(page.getByText('6/17', { exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: '#2905' })).toBeVisible();
    expect(await overflow()).toBeLessThanOrEqual(0);
    await page.waitForTimeout(600);
    await capture(page, `active-creating-issues-${viewport.name}`);
  });
}

test('planner screens on a mobile viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

  await page.goto('/plans');
  await expect(page.getByText(/^Expose the repository retrieval/)).toBeVisible();
  expect(await overflow()).toBeLessThanOrEqual(0);
  await capture(page, 'mobile-plans-index');

  await page.goto('/studio/plan-setup');
  await expect(page.getByRole('button', { name: /Generate Plan/ })).toBeVisible();
  expect(await overflow()).toBeLessThanOrEqual(0);
  await capture(page, 'mobile-define');

  await page.goto('/studio/plan-agents');
  await expect(page.locator('[data-task-index="0"]')).toBeVisible();
  expect(await overflow()).toBeLessThanOrEqual(0);
  await capture(page, 'mobile-review-17-steps');

  await page.goto('/studio/plan-mcp-exec');
  await expect(page.getByTestId('plan-execution-matrix').getByTestId('plan-execution-row')).toHaveCount(3);
  expect(await overflow()).toBeLessThanOrEqual(0);
  await page.waitForTimeout(500);
  await capture(page, 'mobile-execution-4-issues');
  await page.getByTestId('execution-config-button').click();
  const config = page.getByRole('dialog', { name: 'Execution config' });
  await expect(config).toBeVisible();
  const box = (await config.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(390);
  await capture(page, 'mobile-execution-config');
  await page.keyboard.press('Escape');

  await page.goto('/studio/plan-agents-exec');
  const queue = page.getByRole('button', { name: 'Queue Remaining (10 tasks)' });
  await queue.scrollIntoViewIfNeeded();
  await capture(page, 'mobile-execution-17-issues-queue');
});
