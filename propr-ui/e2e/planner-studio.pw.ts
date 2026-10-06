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

const agentTitles = [
  'Shared contracts for agent definitions, runs, capabilities, autonomy and cron schedules',
  'Database migration and definition store for agent definitions and runs',
  'Agent run store with guarded state machine and idempotent creation',
  'Trigger primitive service and agent-run queue jobs',
  'REST API for agent definitions, runs, attachments and run-now',
  'Report-run prompt builder with previous reports and input files',
  'Report-run executor: spawn an isolated task run from a definition',
  'Capability enforcement: per-run tool policy for web access and MCP',
  'Run-scoped, short-lived ProPR MCP grants for agent containers',
  'Separate report-to-actions agent step with dry-run and approve',
  'Agent Tank usage / cost gate for scheduled and unattended runs',
  'Cron schedule sweep in the daemon and deferred-run retry',
  'ProPR MCP tools: list/read agents and runs, trigger primitive',
  'CLI: propr automation command group with the run trigger',
  'Web UI: Agents list and agent detail/edit view',
  'Web UI: run history, run detail, report view and approvals',
  'Documentation: feature guide, API/MCP/CLI reference',
];
const agentPlan = agentTitles.map((title, index) => ({
  id: `agent-task-${index + 1}`,
  title: `Agents v1 (${index + 1}/${agentTitles.length}): ${title}`,
  body: '## Context\nProPR is getting an **Agents** feature: a saved, reusable definition that runs on demand or on a schedule and produces a free-form report.\n\n## Requirements\n1. Add `packages/shared/src/agentDefinitions.ts` exporting the shared contracts.\n2. Unit tests in `test/agentDefinitionsContract.test.ts`.',
  implementation: '',
}));

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

const studioDrafts: Record<string, Record<string, unknown>> = {
  'plan-agents': {
    draft_id: 'plan-agents', repository, name: 'Add an "Agents" feature to ProPR, scoped to a deliberately small v1', initial_prompt: 'Add an "Agents" feature to ProPR.',
    status: 'review', plan_json: agentPlan, chat_history: [], context_config: { baseBranch: 'main' }, created_at: ago(5), updated_at: ago(1),
  },
  'plan-short': {
    draft_id: 'plan-short', repository, name: 'Add an "Agents" feature to ProPR, scoped to a deliberately small v1', initial_prompt: 'Add an "Agents" feature to ProPR.',
    status: 'review', plan_json: agentPlan.slice(0, 3), chat_history: [], context_config: { baseBranch: 'main' }, created_at: ago(5), updated_at: ago(1),
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
      if (suffix === '/issues') return route.fulfill({ json: draftId === 'plan-mcp-exec' ? executionIssues : [] });
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
  await outline.getByRole('button', { name: /Database migration and definition store/ }).click();
  await expect(outline.getByRole('button', { name: /Database migration and definition store/ })).toHaveAttribute('aria-current', 'step');

  const specBefore = (await page.locator('[data-task-list]').boundingBox())!.width;
  await page.getByRole('button', { name: 'Collapse outline' }).click();
  await page.getByRole('button', { name: 'Assistant' }).click();
  await expect(outline).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Assistant' })).toHaveAttribute('aria-pressed', 'false');
  expect((await page.locator('[data-task-list]').boundingBox())!.width).toBeGreaterThan(specBefore + 600);
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
  await expect(tabs.getByRole('button', { name: /Shared contracts for agent definitions/ })).toHaveAttribute('aria-current', 'step');
  expect((await page.locator('[data-task-list]').boundingBox())!.width).toBeGreaterThan(700);
  await page.getByRole('button', { name: 'More plan actions' }).click();
  await expect(page.getByRole('menuitem', { name: 'Delete plan' })).toBeVisible();
  await page.mouse.click(5, 5);
  await capture(page, 'review-plan-tabs');
});

test('execution step renders one matrix with batch controls and labelled ultrafix inputs', async ({ page }) => {
  await page.goto('/studio/plan-mcp-exec');
  await expect(page.getByRole('radio', { name: 'Execute as Individual Tasks' })).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByTestId('plan-execution-matrix').getByTestId('plan-execution-row')).toHaveCount(3);
  const configButton = page.getByTestId('execution-config-button');
  await expect(configButton).toContainText('Opus 5.5 · Ultrafix (8/10) · Auto-merge');
  await expect(page.getByText('PR Options')).toHaveCount(0);
  expect((await page.getByTestId('execution-options-bar').boundingBox())!.height).toBeLessThanOrEqual(56);
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
  await expect(page.getByRole('button', { name: 'Execute All Remaining (2 tasks)' })).toBeVisible();
  await capture(page, 'execution-config-popover');
  await page.keyboard.press('Escape');
  await matrix.getByTestId('agent-override-chip').first().click();
  await expect(page.getByRole('dialog', { name: /Agent override for #2799/ })).toBeVisible();
  await capture(page, 'execution-agent-override');
});

test('define step shows technical scope estimates and consistent token units', async ({ page }) => {
  await page.goto('/studio/plan-setup');
  await expect(page.getByTestId('context-scope-descriptor')).toContainText('Full Repository Scan');
  await expect(page.getByText(/Slower|\$\$\$/)).toHaveCount(0);
  const generate = page.getByRole('button', { name: /Generate Plan/ });
  const breakPlan = page.getByText('Break plan:');
  expect(Math.abs((await generate.boundingBox())!.y + (await generate.boundingBox())!.height / 2 - ((await breakPlan.boundingBox())!.y + (await breakPlan.boundingBox())!.height / 2))).toBeLessThan(8);
  await expect(page.getByTestId('branch-chip')).toContainText('main');
  await capture(page, 'define-context-scope');
});
