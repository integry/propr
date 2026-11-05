import { expect, test, type Locator, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { user } from './dashboard-sections.fixture';

const now = Date.parse('2026-10-17T21:00:00.000Z');
const minutes = (count: number) => count * 60_000;

const definition = {
  id: 'def-long', ownerId: user.id, name: 'Linux final 25c report validation 20261017', description: '',
  repositories: ['integry/propr'], prompt: 'Validate the final report.', attachments: [], agentAlias: 'codex-main',
  modelName: 'gpt-5.6-sol', capabilities: ['repository_read'], includePreviousReports: false, previousReportsLimit: 0,
  scheduleCron: null, scheduleTimezone: 'UTC', scheduleEnabled: false, nextRunAt: null, autonomyMode: 'dry_run',
  enabled: true, revision: 1, createdAt: now - 86_400_000, updatedAt: now - 86_400_000,
};

const baseRun = {
  definitionId: definition.id, ownerId: user.id, triggerSource: 'user:829273', idempotencyKey: null, autonomyMode: 'dry_run',
  definitionSnapshot: null, reportTaskId: null, actionTaskId: null, report: null, reportTruncated: false, actionSummary: null,
  skipReason: null, failureReason: null, approvedBy: null, operatorNote: null, deferredUntil: null, deferrals: 0,
};

const completed = {
  ...baseRun, id: 'c0a1d2e3-0000-4000-8000-000000000001', trigger: 'schedule', state: 'completed',
  report: '## Validation passed on every Linux target with no regressions in the final report',
  createdAt: now - minutes(95), startedAt: now - minutes(94), reportedAt: now - minutes(80), finishedAt: now - minutes(80), updatedAt: now - minutes(80),
};
const cancelled = {
  ...baseRun, id: 'ca11ce1d-0000-4000-8000-000000000002', trigger: 'manual', state: 'cancelled',
  createdAt: now - minutes(60), startedAt: now - minutes(59), reportedAt: null, finishedAt: now - minutes(57), updatedAt: now - minutes(57),
};
const running = {
  ...baseRun, id: 'a7c71e00-0000-4000-8000-000000000003', trigger: 'api', state: 'running',
  createdAt: now - minutes(5), startedAt: now - minutes(4), reportedAt: null, finishedAt: null, updatedAt: now - minutes(1),
};
const older = {
  ...baseRun, id: '01de7000-0000-4000-8000-000000000004', trigger: 'cli', state: 'completed', report: 'Older report line',
  createdAt: now - minutes(600), startedAt: now - minutes(599), reportedAt: now - minutes(590), finishedAt: now - minutes(590), updatedAt: now - minutes(590),
};
const firstPage = [running, cancelled, completed];
const runs = [...firstPage, older];

async function runsFixture(page: Page) {
  await page.clock.install({ time: now });
  await page.routeWebSocket('**/socket.io/**', socket => socket.close());
  await page.route('**/api/**', route => {
    const url = new URL(route.request().url());
    const { pathname } = url;
    if (pathname === `/api/automation-definitions/${definition.id}/runs`) {
      const offset = Number(url.searchParams.get('offset') ?? 0);
      const pageRuns = offset === 0 ? firstPage : [older];
      return route.fulfill({ json: { runs: pageRuns, total: runs.length, limit: 20, offset } });
    }
    const run = runs.find(candidate => pathname === `/api/automation-runs/${candidate.id}`);
    if (run) return route.fulfill({ json: { run } });
    const responses: Record<string, unknown> = {
      '/api/auth/demo-mode': { demoMode: false },
      '/api/auth/user': user,
      '/api/instance/catalog': {
        agents: [{ alias: 'codex-main', type: 'codex', enabled: true, supportedModels: ['gpt-5.6-sol'], defaultModel: 'gpt-5.6-sol' }],
        defaultAgentAlias: 'codex-main',
        repositories: [{ name: 'integry/propr', enabled: true }],
      },
      '/api/automation-definitions': { definitions: [definition], total: 1, limit: 200, offset: 0 },
      [`/api/automation-definitions/${definition.id}`]: { definition },
      [`/api/automation-definitions/${definition.id}/capacity`]: { capacity: { status: 'ok', sessionPercent: 20, provider: 'codex' }, threshold: 90 },
      '/api/tasks': { tasks: [], total: 0 },
      '/api/notifications/unread-count': { unreadCount: 0 },
      '/api/notifications/preferences': { preferences: {}, quietHours: {}, badgeEnabled: false },
    };
    return route.fulfill(pathname in responses ? { json: responses[pathname] } : { status: 503, json: { error: 'Unavailable in runs fixture' } });
  });
}

async function capture(target: Page | Locator, name: string) {
  if (!process.env.PROPR_CAPTURE_PREVIEWS) return;
  const directory = path.resolve('../.propr/previews');
  await mkdir(directory, { recursive: true });
  await target.screenshot({ animations: 'disabled', path: path.join(directory, `${name}.png`) });
}

interface Box { left: number; right: number; top: number; bottom: number }

/** The painted extent of an element's text: its glyph boxes, clipped to the element when it clips its overflow. */
const textBox = (locator: Locator): Promise<Box> => locator.evaluate(element => {
  const range = document.createRange();
  range.selectNodeContents(element);
  const glyphs = range.getBoundingClientRect();
  const own = element.getBoundingClientRect();
  const clips = getComputedStyle(element).overflowX !== 'visible';
  return clips
    ? { left: Math.max(glyphs.left, own.left), right: Math.min(glyphs.right, own.right), top: glyphs.top, bottom: glyphs.bottom }
    : { left: glyphs.left, right: glyphs.right, top: glyphs.top, bottom: glyphs.bottom };
});

const elementBox = (locator: Locator): Promise<Box> => locator.evaluate(element => {
  const { left, right, top, bottom } = element.getBoundingClientRect();
  return { left, right, top, bottom };
});

const overlaps = (a: Box, b: Box) => a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5;

/**
 * Neither the element nor any scroll container inside it is wider than its box:
 * the document can stay within the viewport while an inner pane pans sideways.
 */
const expectNoInnerHorizontalScroll = async (locator: Locator) => {
  const scrolling = await locator.evaluate(root => [root, ...Array.from(root.querySelectorAll('*'))]
    .filter(element => {
      const overflow = getComputedStyle(element).overflowX;
      const scrolls = element === root || overflow === 'auto' || overflow === 'scroll';
      return scrolls && element.clientWidth > 0 && element.scrollWidth > element.clientWidth + 1;
    })
    .map(element => `${element.tagName.toLowerCase()}[data-testid=${element.getAttribute('data-testid')}] ${element.scrollWidth}>${element.clientWidth}`));
  expect(scrolling).toEqual([]);
};

test.describe('automation runs on a phone', () => {
  test.use({ hasTouch: true, isMobile: true });

  for (const width of [320, 390]) {
    const height = width === 320 ? 640 : 844;

    test(`the run breadcrumb keeps the name, Runs and the run apart at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await runsFixture(page);
      await page.goto(`/automations/${definition.id}/runs/${completed.id}`);

      const breadcrumb = page.getByRole('navigation', { name: 'Breadcrumb' });
      await expect(breadcrumb).toBeVisible();
      const name = breadcrumb.getByRole('link', { name: definition.name, exact: true });
      const runsLink = breadcrumb.getByRole('link', { name: 'Runs', exact: true });
      const current = breadcrumb.locator('[aria-current="page"]');
      await expect(name).toBeVisible();
      await expect(name).toHaveAttribute('title', definition.name);
      await expect(runsLink).toBeVisible();
      await expect(current).toHaveText('Run c0a1d2e3');
      await expect(current).toHaveAttribute('aria-current', 'page');
      await expect(current).toHaveAttribute('title', completed.id);

      // The long name is clipped with an ellipsis inside its own box, short of the separator before Runs.
      const nameStyle = await name.evaluate(element => {
        const style = getComputedStyle(element);
        return { clipped: element.scrollWidth > element.clientWidth, overflow: style.overflowX, ellipsis: style.textOverflow };
      });
      expect(nameStyle).toEqual({ clipped: true, overflow: 'hidden', ellipsis: 'ellipsis' });
      const nav = await elementBox(breadcrumb);
      const boxes = { name: await elementBox(name), runs: await elementBox(runsLink), current: await elementBox(current) };
      const glyphs = { name: await textBox(name), runs: await textBox(runsLink), current: await textBox(current) };
      expect(boxes.name.right).toBeLessThanOrEqual(boxes.runs.left);
      expect(boxes.runs.right).toBeLessThanOrEqual(boxes.current.left);
      expect(overlaps(glyphs.name, glyphs.runs)).toBe(false);
      expect(overlaps(glyphs.name, glyphs.current)).toBe(false);
      expect(overlaps(glyphs.runs, glyphs.current)).toBe(false);
      for (const [label, box] of Object.entries(glyphs)) {
        expect(box.left, `${label} text left`).toBeGreaterThanOrEqual(nav.left);
        expect(box.right, `${label} text right`).toBeLessThanOrEqual(nav.right);
      }
      // The Runs and current labels are never clipped.
      for (const locator of [runsLink, current]) {
        expect(await locator.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
      }
      // Each destination is a comfortable touch target.
      for (const box of [boxes.name, boxes.runs]) {
        expect(box.bottom - box.top).toBeGreaterThanOrEqual(44);
        expect(box.right - box.left).toBeGreaterThanOrEqual(24);
      }
      await expectNoInnerHorizontalScroll(breadcrumb);
      await capture(page, `automation-run-breadcrumb-${width}`);

      // Touch: Runs opens the history; keyboard: Enter on the name opens the settings.
      await runsLink.tap();
      await expect(page).toHaveURL(new RegExp(`/automations/${definition.id}/runs$`));
      await expect(page.getByTestId('agent-run-history')).toBeVisible();
      await page.goBack();
      await expect(page).toHaveURL(new RegExp(`/runs/${completed.id}$`));
      await breadcrumb.getByRole('link', { name: definition.name, exact: true }).focus();
      await page.keyboard.press('Enter');
      await expect(page).toHaveURL(new RegExp(`/automations/${definition.id}$`));
      await expect(page.getByRole('navigation', { name: 'Automation sections' })).toBeVisible();
    });

    test(`the run history fits without panning at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await runsFixture(page);
      await page.goto(`/automations/${definition.id}/runs`);

      const history = page.getByTestId('agent-run-history');
      const rows = history.getByTestId('agent-run-row');
      await expect(rows).toHaveCount(3);
      await expect(rows.nth(0).getByText('Running', { exact: true })).toBeVisible();
      await expect(rows.nth(1).getByText('Cancelled', { exact: true })).toBeVisible();
      await expect(rows.nth(2).getByText('Completed', { exact: true })).toBeVisible();
      await expect(rows.nth(2).getByTestId('agent-run-preview')).toHaveText('Hover to preview the report');

      // Focusing a row (as a keyboard or switch user does) reads its report preview.
      await rows.nth(2).focus();
      await expect(rows.nth(2).getByTestId('agent-run-preview')).toHaveText(/^Validation passed on every Linux target/);

      const pane = page.getByTestId('agent-runs-pane');
      await expectNoInnerHorizontalScroll(pane);
      const paneBox = await elementBox(pane);
      for (let index = 0; index < 3; index += 1) {
        const row = rows.nth(index);
        const rowBox = await elementBox(row);
        expect(rowBox.left).toBeGreaterThanOrEqual(paneBox.left);
        expect(rowBox.right).toBeLessThanOrEqual(paneBox.right + 0.5);
        const cells = row.locator(':scope > *');
        const glyphs: Box[] = [];
        for (let cell = 0; cell < await cells.count(); cell += 1) {
          const text = (await cells.nth(cell).textContent())?.trim();
          if (!text) continue;
          const box = await textBox(cells.nth(cell));
          // Started, trigger, state, duration and preview are all on screen, inside the row.
          expect(box.left, `row ${index} cell ${cell} left`).toBeGreaterThanOrEqual(rowBox.left);
          expect(box.right, `row ${index} cell ${cell} right`).toBeLessThanOrEqual(rowBox.right);
          expect(box.right).toBeLessThanOrEqual(width);
          for (const other of glyphs) expect(overlaps(box, other), `row ${index} cell ${cell} overlaps`).toBe(false);
          glyphs.push(box);
        }
        await expect(row.getByTestId('agent-run-duration')).toBeInViewport();
      }
      await expect(rows.nth(0).getByTestId('agent-run-duration')).toHaveText('4m');
      await expect(rows.nth(1).getByTestId('agent-run-duration')).toHaveText('2m');
      await capture(page, `automation-run-history-${width}`);

      // Pagination keeps working, and a tapped row opens its run.
      await history.getByRole('button', { name: 'Load more' }).tap();
      await expect(rows).toHaveCount(4);
      await expectNoInnerHorizontalScroll(pane);
      await rows.nth(1).tap();
      await expect(page).toHaveURL(new RegExp(`/runs/${cancelled.id}$`));
      await expect(page.getByRole('navigation', { name: 'Breadcrumb' }).locator('[aria-current="page"]')).toHaveText('Run ca11ce1d');
    });
  }
});

test('the run history keeps its columns where they fit, and unsaved edits survive a breakpoint change', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await runsFixture(page);
  await page.goto(`/automations/${definition.id}`);
  const nameField = page.getByTestId('agent-editor').getByLabel('Name');
  await nameField.fill('Renamed but not saved');

  await page.getByRole('navigation', { name: 'Automation sections' }).getByRole('link', { name: 'Runs' }).click();
  await expect(page.getByTestId('agent-run-row')).toHaveCount(3);
  await page.setViewportSize({ width: 1440, height: 900 });
  const header = page.getByTestId('agent-run-history').locator('[aria-hidden="true"]').first();
  await expect(header).toBeVisible();
  // Desktop: one line per run, every column header on that line.
  const row = await elementBox(page.getByTestId('agent-run-row').first());
  expect(row.bottom - row.top).toBeLessThan(48);
  const labels = header.locator(':scope > span');
  await expect(labels).toHaveText(['Started', 'Trigger', 'State', 'Duration', 'Report']);
  const tops = await labels.evaluateAll(spans => spans.map(span => Math.round(span.getBoundingClientRect().top)));
  expect(new Set(tops).size).toBe(1);
  await expectNoInnerHorizontalScroll(page.getByTestId('agent-runs-pane'));

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(header).toBeHidden();
  await page.getByRole('navigation', { name: 'Automation sections' }).getByRole('link', { name: 'Settings' }).click();
  await expect(page.getByTestId('agent-editor').getByLabel('Name')).toHaveValue('Renamed but not saved');
});
