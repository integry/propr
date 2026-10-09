import { expect, test, type Page } from '@playwright/test';
import { shot } from '../lib/shot';
import { installWorld } from '../lib/world';
import { NOW, base } from '../world/base';
import { DELIVERY, PHOTOS_RUN, SBOM_RUN, tasks } from '../world/tasks';

const open = async (page: Page, url: string) => {
  await page.clock.install({ time: NOW });
  const log = await installWorld(page, base, tasks);
  await page.goto(url);
  return log;
};

const deliveryRow = (page: Page) => page.getByRole('table', { name: 'Tasks' }).getByTestId('task-row').filter({ hasText: DELIVERY.subject });

test('tasks console', async ({ page }, info) => {
  const log = await open(page, '/tasks');
  const table = page.getByRole('table', { name: 'Tasks' });
  await expect(table.getByTestId('task-row')).toHaveCount(8);
  await shot(page, table, {
    id: 'tasks-console',
    alt: 'The Tasks console: one row per pull request with repository, status, agent, duration and latest review score',
    usedOn: ['/control/', '/whats-new/0.9.0/'],
    padding: 0,
  }, info, log);
});

test('one task row', async ({ page }, info) => {
  const log = await open(page, '/tasks');
  await shot(page, deliveryRow(page), {
    id: 'tasks-row-ultrafix',
    alt: 'A task row: Ultrafix is running on storefront-web with Claude Opus 5.5, and the run track shows review scores of 5 and 7',
    usedOn: ['/control/', '/review/'],
    padding: 4,
  }, info, log);
});

test('run track', async ({ page }, info) => {
  const log = await open(page, '/tasks');
  const row = deliveryRow(page);
  await shot(page, row.getByTestId('run-count'), {
    id: 'tasks-run-track',
    alt: 'Run track: review, fix, review, then an Ultrafix run in progress',
    usedOn: ['/control/'],
    padding: 4,
  }, info, log);
});

test('split view details', async ({ page }, info) => {
  await page.setViewportSize({ width: 1440, height: 1500 });
  const log = await open(page, '/tasks');
  await deliveryRow(page).getByRole('link', { name: DELIVERY.subject }).click();
  const details = page.getByTestId('task-split-details');
  await expect(details.getByTestId('task-details')).toBeVisible();
  await shot(page, details.getByTestId('task-header-tiers'), {
    id: 'tasks-run-header',
    alt: 'Task header: repository and pull request, Implementing status, the run in progress, its model and runtime, and token consumption',
    usedOn: ['/control/'],
    padding: 0,
  }, info, log);
  await shot(page, details.getByRole('list', { name: 'Runs' }), {
    id: 'tasks-run-timeline',
    alt: 'Every run of one pull request on one timeline: implement, review scored 5, fix, review scored 7, and the Ultrafix run in progress with its live steps',
    usedOn: ['/control/', '/whats-new/0.9.0/'],
  }, info, log);
  await shot(page, details.getByRole('region', { name: 'Task implementation log' }), {
    id: 'tasks-live-log',
    alt: 'The execution trace of a live run in plain language: why the time-zone fix is needed, the new DST test cases, and all 14 checkout tests passing',
    usedOn: ['/implement/'],
    padding: 0,
    maxHeight: 420,
  }, info, log);
});

test('restricted network on the timeline', async ({ page }, info) => {
  const log = await open(page, `/tasks/${SBOM_RUN}`);
  const network = page.getByTestId('network-egress').first();
  await expect(network).toContainText('telemetry.nextjs.org × 5');
  // The steps from queued to completed: the date label sets the left edge, the step durations the right.
  const timeline = page.getByRole('region', { name: 'Task timeline' });
  await shot(page, network, {
    include: [timeline.getByText('Oct 8, 2026'), timeline.getByText('Task Queued'), timeline.getByText('17m 30s'), timeline.getByText('Task Completed')],
    id: 'tasks-network-egress',
    alt: 'Timeline step for a restricted-network run: the allow list comes from .propr/workflow.yml and three hosts were denied',
    usedOn: ['/trust/', '/whats-new/0.9.0/'],
  }, info, log);
});

test('visual evidence', async ({ page }, info) => {
  // The PR's evidence: the courier app's stop card, drawn here because the app itself is fictional.
  await page.setViewportSize({ width: 640, height: 400 });
  await page.setContent(`<body style="margin:0;font:15px system-ui;background:#eef2f5">
    <div style="margin:20px;padding:18px;border-radius:14px;background:#fff;box-shadow:0 1px 3px #0002;display:flex;gap:18px;align-items:center">
      <div style="flex:1">
        <div style="color:#64748b;font-size:12px">STOP 14 OF 22 · ETA 15:05</div>
        <div style="margin:6px 0 2px;font-weight:600;font-size:18px">22 Harbour Street</div>
        <div style="color:#475569">Leave with reception</div>
        <div style="display:inline-block;margin-top:12px;padding:4px 10px;border-radius:999px;background:#fef3c7;color:#92400e;font-size:13px">2 photos waiting to upload · offline</div>
      </div>
      <div style="width:72px;height:72px;border-radius:8px;background:linear-gradient(135deg,#cbd5e1,#94a3b8)"></div>
      <div style="width:72px;height:72px;border-radius:8px;background:linear-gradient(135deg,#d6d3d1,#a8a29e)"></div>
    </div></body>`);
  const image = await page.locator('div').first().screenshot();
  await page.clock.install({ time: NOW });
  const log = await installWorld(page, base, tasks);
  await page.route('**/api/preview-media/**', route => route.fulfill({ contentType: 'image/png', body: image }));
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`/tasks/${PHOTOS_RUN}`);
  const section = page.getByRole('region', { name: /Visual evidence/ });
  await expect(section.getByRole('img').first()).toBeVisible();
  await shot(page, section, {
    id: 'tasks-visual-evidence',
    alt: 'Visual evidence on a task: the agent’s capture of the changed screen with its description, one of two captures',
    usedOn: ['/implement/', '/whats-new/0.9.0/'],
    padding: 2,
  }, info, log);
});

test('mobile task cards', async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const log = await open(page, '/tasks');
  const cards = page.locator('[data-testid="task-card"]');
  await expect(cards.first()).toBeVisible();
  await shot(page, cards.nth(0), {
    id: 'tasks-mobile-cards',
    alt: 'Tasks on a phone: each pull request is a card with status, run track, agent and repository',
    usedOn: ['/mobile/'],
    include: [cards.nth(2)],
    padding: 0,
  }, info, log);
});

test('new task: agent and model', async ({ page }, info) => {
  const log = await open(page, '/tasks');
  await page.getByRole('button', { name: 'New Task', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'New task' });
  await expect(dialog).toBeVisible();
  await dialog.getByText('Select a repository', { exact: true }).click();
  await page.getByRole('button', { name: /storefront-web/ }).first().click();
  await dialog.getByLabel('Prompt', { exact: true }).fill('Show delivery windows at checkout. Hide windows that close before the cart cutoff and use the store’s time zone.');
  await dialog.getByText('Advanced Options').click();
  await dialog.getByLabel('Agent', { exact: true }).selectOption('codex');
  await dialog.getByLabel('Model', { exact: true }).selectOption('gpt-6-astra');
  await shot(page, dialog, {
    id: 'tasks-new-task',
    alt: 'New task dialog: repository, prompt, agent and model, then Run task or Plan first',
    usedOn: ['/implement/', '/whats-new/0.9.0/'],
    padding: 0,
  }, info, log);
});

