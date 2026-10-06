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
  'plan-setup': {
    draft_id: 'plan-setup', repository, name: 'Implement the ProPR fleet orchestration', initial_prompt: 'Implement the entire ProPR fleet orchestration as described in the plan documents. Prefer the same stack as ProPR whenever applicable.',
    status: 'draft', plan_json: [], context_config: { baseBranch: 'main', contextLevel: 100, granularity: 'granular' },
    created_at: ago(5), updated_at: ago(1),
  },
};

async function fixture(page: Page) {
  await page.routeWebSocket('**/socket.io/**', socket => socket.close());
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const draftMatch = path.match(/^\/api\/planner\/drafts\/([^/]+)(\/.*)?$/);
    if (path === '/api/planner/drafts') return route.fulfill({ json: { drafts, total: drafts.length, page: 1, limit: 20, hasMore: false } });
    if (path === '/api/planner/drafts/repositories') return route.fulfill({ json: { repositories: [{ repo: repository, count: 6 }, { repo: 'integry/digvin', count: 1 }], total: 7 } });
    if (draftMatch && studioDrafts[draftMatch[1]]) {
      const [, draftId, suffix] = draftMatch;
      if (!suffix) return route.fulfill({ json: studioDrafts[draftId] });
      if (suffix === '/issues') return route.fulfill({ json: planIssues[draftId] ?? [] });
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
  await expect(tabs.getByRole('button')).toHaveCount(3);
  await expect(tabs.getByRole('button', { name: '1. Shared Contracts' })).toHaveAttribute('aria-current', 'step');
  await expect(tabs.getByRole('button', { name: '3. Agent Run Store' })).toBeVisible();
  // Tabs share the bar instead of stopping at a fixed width and leaving the right side empty.
  const tabList = (await tabs.locator('ol').boundingBox())!;
  const lastTab = (await tabs.getByRole('listitem').last().boundingBox())!;
  expect(tabList.x + tabList.width - (lastTab.x + lastTab.width)).toBeLessThan(8);
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
  // Step counters match the 3-step plan.
  await expect(page.getByText('Agents v1 (1/3): Shared contracts for agent definitions')).toBeVisible();
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
  await tabs.getByRole('button').nth(2).click();
  await expect(tabs.getByRole('button').nth(2)).toHaveAttribute('aria-current', 'step');
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
  await expect(tabs.getByRole('button').nth(1)).toHaveAttribute('aria-current', 'step');
  await capture(page, 'review-plan-tabs-scroll-spy');
  await list.evaluate(element => { element.scrollTop = 0; });
  await expect(tabs.getByRole('button').nth(0)).toHaveAttribute('aria-current', 'step');
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
  await expect(page.getByRole('button', { name: 'Queue Remaining (2 tasks)' })).toBeEnabled();
  await capture(page, 'execution-config-popover');
  await page.keyboard.press('Escape');
  await matrix.getByTestId('agent-override-chip').first().click();
  await expect(page.getByRole('dialog', { name: /Agent override for #2799/ })).toBeVisible();
  await capture(page, 'execution-agent-override');
});

test('execution step for a 17-issue plan keeps the title readable and queues remaining tasks while others run', async ({ page }) => {
  await page.goto('/studio/plan-agents-exec');
  const matrix = page.getByTestId('plan-execution-matrix');
  await expect(matrix.getByTestId('plan-execution-row')).toHaveCount(12);
  // The title keeps at least 320px next to the grouped header controls.
  const title = page.getByRole('heading', { level: 1 });
  expect((await title.boundingBox())!.width).toBeGreaterThanOrEqual(320);
  await expect(page.getByRole('link', { name: 'View issues on GitHub' })).toHaveText('GitHub');
  await expect(page.getByTitle('Delete Plan')).toHaveCount(0);
  await page.getByRole('button', { name: 'More plan actions' }).click();
  await expect(page.getByRole('menuitem', { name: 'Delete plan' })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.mouse.click(5, 5);
  // Rows lead with the step, not "Agents v1 (6/17):".
  await expect(matrix.getByText('Report-run prompt builder with previous reports and input files', { exact: true })).toBeVisible();
  await expect(matrix.getByText(/Agents v1 \(/)).toHaveCount(0);
  // Running issues don't block queueing the rest.
  const queue = page.getByRole('button', { name: 'Queue Remaining (10 tasks)' });
  await expect(queue).toBeEnabled();
  await expect(page.getByTestId('execute-all-hint')).toHaveText('10 tasks will be dispatched automatically as concurrency slots become available.');
  await page.waitForTimeout(500);
  await capture(page, 'execution-17-issues');
  await queue.scrollIntoViewIfNeeded();
  await capture(page, 'execution-17-issues-queue');
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
