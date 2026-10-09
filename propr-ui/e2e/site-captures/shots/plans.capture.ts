import { expect, test, type Page } from '@playwright/test';
import { shot } from '../lib/shot';
import { area, installWorld, type Area } from '../lib/world';
import { AGENTS, REPOS, base, NOW } from '../world/base';
import { DRAFTS, plans } from '../world/plans';

async function open(page: Page, route?: string, ...extra: Area[]) {
  await page.clock.setFixedTime(NOW);
  const log = await installWorld(page, base, plans, ...extra);
  if (route) await page.goto(route);
  return log;
}

/** Answers the studio's `subscribe:draft` with a live `draft:update`, as the server pushes during generation. */
async function liveDraft(page: Page, draftId: string, payload: Record<string, unknown>) {
  await page.routeWebSocket('**/socket.io/**', socket => {
    socket.send(`0${JSON.stringify({ sid: 'capture', upgrades: [], pingInterval: 300_000, pingTimeout: 300_000, maxPayload: 1_000_000 })}`);
    socket.onMessage(message => {
      const text = String(message);
      if (text.startsWith('40')) socket.send('40{"sid":"capture-socket"}');
      if (!text.startsWith('42')) return;
      const [event, id] = JSON.parse(text.slice(2)) as [string, string];
      if (event === 'subscribe:draft' && id === draftId) {
        socket.send(`42${JSON.stringify(['draft:update', { eventType: 'draft:update', draftId, timestamp: new Date().toISOString(), ...payload }])}`);
      }
    });
  });
}

/** The innermost element that holds `text` and also contains `inner` (a row, a card). */
const containerOf = (page: Page, text: string | RegExp, inner = page.locator('a, button')) =>
  page.getByRole('main').locator('div').filter({ hasText: text }).filter({ has: inner }).last();

test('plans list statuses', async ({ page }, info) => {
  await page.setViewportSize({ width: 1240, height: 900 });
  const log = await open(page, '/plans');
  const row = (title: string) => containerOf(page, title, page.getByRole('link', { name: /^(Manage|Resume|View)$/ }));
  await shot(page, row('Quarterly order exports for finance'), {
    id: 'plans-list',
    alt: 'The Plans list: an order-export plan with 6 issues (3 merged, 1 running), a checkout plan in review, a draft, and a plan still generating',
    usedOn: ['/planning/'],
    include: [row('Move staging to the shared Terraform modules')],
    padding: 0,
  }, info, log);
});

/**
 * Workaround for a Planner Studio bug: on an existing draft, the new-task
 * branch loader re-runs once the repository catalog resolves a base branch,
 * clears the draft's base branch and saves it back empty, which disables
 * Generate Plan. A catalog without base branches keeps the draft's own.
 */
const catalogWithoutBranches = area('catalog-without-branches', {
  '/api/instance/catalog': {
    agents: AGENTS.map(({ id, type, alias, supportedModels, defaultModel }) => ({ id, kind: 'direct', type, alias, enabled: true, supportedModels, defaultModel })),
    repositories: Object.values(REPOS).map(name => ({ name, enabled: true })),
    defaultAgentAlias: 'claude',
  },
});

test('define: prompt composer', async ({ page }, info) => {
  const log = await open(page, '/studio/plan-define', catalogWithoutBranches);
  await expect(page.getByRole('button', { name: /Generate Plan/ })).toBeEnabled();
  const footer = page.getByTestId('composer-footer');
  const composer = page.getByRole('main').locator('div').filter({ has: footer }).filter({ has: page.getByRole('textbox') }).last();
  await shot(page, composer, {
    id: 'plans-define-composer',
    alt: 'Starting a plan: the request in plain words, with plan granularity, the planning model and Generate Plan',
    usedOn: ['/planning/'],
  }, info, log);
});

test('generation: ranked context', async ({ page }, info) => {
  // The Discovery log fills the remaining height; this height ends the panel just under its content.
  await page.setViewportSize({ width: 1100, height: 760 });
  const log = await open(page);
  const trace = DRAFTS['plan-generating'].generation_trace as { runId: string };
  await liveDraft(page, 'plan-generating', { step: 'llm', status: 'in_progress', runId: trace.runId, draftStatus: 'generating', generationTrace: trace });
  await page.goto('/studio/plan-generating');
  const discovery = page.getByText('Discovery', { exact: true });
  await page.getByText('src/sync/uploadQueue.ts').first().waitFor();
  const panel = containerOf(page, 'Generation Progress', discovery);
  await shot(page, panel, {
    id: 'plans-generation-context',
    alt: 'Plan generation in progress: relevance ranked and context gathered from 8 files (about 94k tokens), the planner model now writing the plan',
    usedOn: ['/planning/'],
    padding: 0,
  }, info, log);
});

test('review: outline', async ({ page }, info) => {
  const log = await open(page, '/studio/plan-checkout');
  await shot(page, page.getByRole('navigation', { name: 'Plan outline' }), {
    id: 'plans-outline',
    alt: 'A generated plan broken into five ordered tasks, each a future GitHub issue, with drag handles to reorder them',
    usedOn: ['/planning/'],
    maxHeight: 310,
    padding: 0,
  }, info, log);
});

test('review: task specification', async ({ page }, info) => {
  const log = await open(page, '/studio/plan-checkout');
  await page.getByRole('navigation', { name: 'Plan outline' }).getByRole('button', { name: /^2\. Address step/ }).click();
  const card = page.locator('[data-task-index="1"]');
  await page.waitForTimeout(600);
  const last = card.getByText('Invalid postcodes show an inline error');
  const cardBox = (await card.boundingBox())!;
  const lastBox = (await last.boundingBox())!;
  await shot(page, card, {
    id: 'plans-task-spec',
    alt: 'One planned task: context, numbered requirements naming the files to touch, and acceptance criteria',
    usedOn: ['/planning/'],
    maxHeight: Math.ceil(lastBox.y + lastBox.height - cardBox.y) + 16,
    // The sticky toolbar sits right above the card, so pad the sides only.
    padding: { left: 16, right: 16 },
  }, info, log);
});

test('review: refinement chat', async ({ page }, info) => {
  await page.setViewportSize({ width: 1440, height: 880 });
  const log = await open(page, '/studio/plan-checkout');
  await shot(page, page.getByTestId('plan-assistant'), {
    id: 'plans-refinement-chat',
    alt: 'Refining a plan in chat: asked to merge payment and review and to ship behind a flag, the assistant changes those steps and leaves the rest alone',
    usedOn: ['/planning/', '/whats-new/0.9.0/'],
    padding: 0,
  }, info, log);
});

test('review: plan history', async ({ page }, info) => {
  const log = await open(page, '/studio/plan-checkout');
  await page.getByRole('button', { name: 'Plan history' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByText('Refined').nth(1).click();
  await dialog.getByText('Payment step').waitFor();
  await shot(page, dialog, {
    id: 'plans-history',
    alt: 'Plan history: the versions saved before each refinement and the first generation, with a preview and Restore this version',
    usedOn: ['/planning/', '/whats-new/0.9.0/'],
    padding: 0,
  }, info, log);
});

test('review: phase and create issues', async ({ page }, info) => {
  const log = await open(page, '/studio/plan-checkout');
  await shot(page, page.getByRole('navigation', { name: 'Plan phase' }), {
    id: 'plans-create-issues',
    alt: 'Define, Review and Execute phases, with Create 5 GitHub Issues as the step from plan to work',
    usedOn: ['/planning/'],
    include: [page.getByRole('button', { name: 'Create 5 GitHub Issues' })],
    padding: 6,
  }, info, log);
});

test('execute: issue matrix', async ({ page }, info) => {
  const log = await open(page, '/studio/plan-exports');
  await shot(page, page.getByTestId('plan-execution-matrix'), {
    id: 'plans-execution',
    alt: 'Executing a plan as individual tasks: one issue running with its pull request, two waiting, and Queue Remaining to start them in order',
    usedOn: ['/planning/'],
    include: [page.getByRole('button', { name: /Queue Remaining/ }), page.getByRole('radio', { name: 'Execute as Epic PR' })],
  }, info, log);
});

test('execute: config', async ({ page }, info) => {
  const log = await open(page, '/studio/plan-exports');
  await page.getByTestId('execution-config-button').click();
  const dialog = page.getByRole('dialog', { name: 'Execution config' });
  await shot(page, dialog, {
    id: 'plans-execution-config',
    alt: 'Execution settings for every task in the plan: agent and model, Ultrafix with a minimum review score of 8/10 and a loop limit, and auto-merge',
    usedOn: ['/planning/'],
    padding: 0,
  }, info, log);
});

test('mobile: plan review', async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const log = await open(page, '/studio/plan-checkout');
  await page.locator('[data-task-index="0"]').getByRole('heading').first().waitFor();
  await shot(page, page.locator('body'), {
    id: 'plans-mobile',
    alt: 'Reviewing a plan on a phone: step tabs, the current task and its requirements',
    usedOn: ['/mobile/', '/planning/'],
    padding: 0,
  }, info, log);
});
