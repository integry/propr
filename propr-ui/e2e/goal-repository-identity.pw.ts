import { expect, test, type Browser, type Locator, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

// A completed goal's primary repository identity must read in full on the narrowest phones: at 320px
// the one-line chip was wider than its column, clipped by an ancestor while the document reported no
// overflow. On a phone the owner now stacks above the name and both wrap; desktop keeps the compact chip.

const timestamp = '2026-10-22T23:00:00.000Z';
const requester = { id: '583231', login: 'octocat', displayName: 'The Octocat', avatarUrl: null };

const repositories = {
  reported: 'propr-ultrafix/propr-desktop-acceptance-20260909',
  long: 'very-long-organisation-name-for-acceptance/an-extremely-long-repository-name-without-any-natural-breaks',
};

const goal = (repository: string) => ({
  id: 'goal-1', owner: requester.id, createdBy: requester, repository,
  title: 'Add the requested four-line Markdown file',
  objective: 'Add exactly the requested four lines to notes.md and open a draft PR.',
  launchStrategy: 'direct', initialPrompt: '/goal Add notes', attachments: [],
  baseBranch: null, branchName: 'goal/notes', worktreePath: '/tmp/goal-notes',
  agent: { id: 'agent-1', alias: 'codex', type: 'codex' },
  requestedModel: 'gpt-6-astra', effectiveModel: 'gpt-6-astra',
  maxParallelTasks: 3, ultrafix: true, desiredState: 'running', resultState: 'completed',
  failureReason: null, pausePending: false,
  control: { requestGeneration: 0, acknowledgedGeneration: 0, pending: false },
  taskId: 'goal-task-1', sessionId: 'thread-1', conversationId: null,
  finalPr: { number: 8, url: `https://github.com/${repository}/pull/8` },
  checkpoint: null, artifacts: [],
  artifactStats: { issues: 0, openIssues: 0, pullRequests: 1, openPullRequests: 1 },
  liveSummary: { currentTask: null, todos: [], tokenUsage: { input_tokens: 1200, output_tokens: 400 }, nativeGoal: null },
  taskState: 'completed', createdAt: timestamp, updatedAt: timestamp,
  startedAt: timestamp, pausedAt: null, completedAt: timestamp,
  elapsedMs: 66_000, activeMs: 66_000, pausedMs: 0,
});

async function stub(page: Page, repository: string, options: { native?: boolean; rootFontPx?: number } = {}) {
  if (options.native) await page.addInitScript(() => {
    const profile = { id: 'layout-fixture', name: 'Preview workspace', kind: 'remote' as const, baseUrl: 'https://fixture.example.test' };
    window.__PROPR_DESKTOP__ = {
      isDesktop: true, platform: 'linux',
      app: { onDeepLink: () => () => undefined },
      profiles: { list: async () => [profile], getActiveId: async () => profile.id, setActiveId: async () => undefined, save: async () => undefined, remove: async () => undefined },
      connection: { probe: async () => ({ status: 'ready' }) },
      authentication: { authenticate: async () => undefined },
      discovery: { supported: false, discover: async () => [] },
      localSetup: { supported: false, setup: async () => profile },
      externalBrowser: { open: async () => undefined },
    };
  });
  if (options.rootFontPx) await page.addInitScript(px => {
    document.addEventListener('DOMContentLoaded', () => { document.documentElement.style.fontSize = `${px}px`; });
  }, options.rootFontPx);
  await page.clock.install({ time: Date.parse(timestamp) + 120_000 });
  await page.routeWebSocket('**/socket.io/**', socket => socket.close());
  await page.route('**/api/**', route => {
    const { pathname } = new URL(route.request().url());
    const responses: Record<string, unknown> = {
      '/api/auth/demo-mode': { demoMode: false },
      '/api/auth/user': {
        id: 'user-1', login: 'octocat', username: 'octocat', displayName: 'The Octocat',
        email: null, avatarUrl: null, role: 'admin', permissions: [], authorizationSource: 'local',
      },
      '/api/instance/catalog': {
        agents: [{ id: 'agent-1', alias: 'codex', type: 'codex', enabled: true, models: ['gpt-6-astra'], defaultModel: 'gpt-6-astra' }],
        repositories: [{ name: repository, enabled: true }],
      },
      '/api/goals': { goals: [goal(repository)] },
      '/api/goals/goal-1': { goal: goal(repository) },
      '/api/task/goal-task-1/live-details': { events: [], todos: [], currentTask: null, tokenUsage: null },
      '/api/tasks': { tasks: [], total: 0 },
      '/api/notifications/unread-count': { unreadCount: 0 },
      '/api/notifications/preferences': { preferences: {}, quietHours: { start: null, end: null, timezone: 'UTC' }, badgeEnabled: false },
    };
    if (pathname in responses) return route.fulfill({ json: responses[pathname] });
    return route.fulfill({ status: 503, json: { error: 'Unavailable in goal repository identity fixture' } });
  });
}

const capture = async (page: Page, name: string) => {
  if (!process.env.PROPR_CAPTURE_PREVIEWS) return;
  const directory = path.resolve('../.propr/previews');
  await mkdir(directory, { recursive: true });
  await page.locator('header').filter({ has: page.getByRole('link', { name: '← All goals' }) })
    .screenshot({ animations: 'disabled', path: path.join(directory, `${name}.png`) });
};

/** The rendered geometry of every line of the chip's text, and of every ancestor that could clip it. */
const chipGeometry = (chip: Locator) => chip.evaluate(element => {
  const box = (rect: DOMRect) => ({ left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom });
  // Visible text only: each text node's line boxes, skipping the screen-reader-only slash.
  const lines: Array<ReturnType<typeof box>> = [];
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  for (let text = walker.nextNode(); text; text = walker.nextNode()) {
    if (getComputedStyle(text.parentElement!).position === 'absolute') continue;
    const range = document.createRange();
    range.selectNodeContents(text);
    lines.push(...Array.from(range.getClientRects()).filter(rect => rect.width > 0).map(box));
  }
  const clippers: Array<ReturnType<typeof box>> = [];
  for (let node = element.parentElement; node; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (style.overflowX !== 'visible' || style.overflowY !== 'visible') clippers.push(box(node.getBoundingClientRect()));
  }
  const textParts = Array.from(element.querySelectorAll<HTMLElement>('[data-testid^="repository-chip-"]'))
    .map(part => ({ id: part.dataset.testid!, clientWidth: part.clientWidth, scrollWidth: part.scrollWidth, ...box(part.getBoundingClientRect()) }));
  return { chip: box(element.getBoundingClientRect()), lines, clippers, textParts, innerText: (element as HTMLElement).innerText, viewport: window.innerWidth };
});

async function expectReadableIdentity(page: Page, repository: string, { stacked }: { stacked: boolean }) {
  const header = page.locator('header').filter({ has: page.getByRole('link', { name: '← All goals' }) });
  const chip = header.getByTestId('repository-chip');
  await expect(chip).toHaveText(repository);
  const geometry = await chipGeometry(chip);
  const content = (await header.locator('> div').boundingBox())!;
  const inside = (rect: { left: number; right: number }, bounds: { left: number; right: number }) => {
    expect(rect.left).toBeGreaterThanOrEqual(bounds.left - 0.5);
    expect(rect.right).toBeLessThanOrEqual(bounds.right + 0.5);
  };
  // The chip and every line of its text sit inside the header content, the viewport and every clipping ancestor.
  const bounds = [{ left: content.x, right: content.x + content.width }, { left: 0, right: geometry.viewport }, ...geometry.clippers];
  for (const rect of [geometry.chip, ...geometry.lines]) for (const bound of bounds) inside(rect, bound);
  for (const part of geometry.textParts) expect(part.scrollWidth).toBeLessThanOrEqual(part.clientWidth);
  const ownerPart = geometry.textParts.find(part => part.id === 'repository-chip-owner')!;
  const namePart = geometry.textParts.find(part => part.id === 'repository-chip-name')!;
  if (stacked) {
    // Owner above the name, nothing hidden behind an ellipsis: the visible text is the whole slug.
    expect(ownerPart.bottom).toBeLessThanOrEqual(namePart.top + 0.5);
    expect(geometry.innerText.replace(/\s+/g, '')).toBe(repository);
  } else {
    // Desktop keeps the compact one-line `owner/name` chip.
    expect(Math.abs(ownerPart.top - namePart.top)).toBeLessThan(1);
    expect(geometry.innerText).toBe(repository);
    expect(new Set(geometry.lines.map(line => Math.round(line.top))).size).toBe(1);
  }
  return geometry;
}

async function expectHeaderControls(page: Page, repository: string) {
  const viewport = page.viewportSize()!.width;
  await expect(page.getByTitle('Model: GPT-6 Astra')).toBeVisible();
  await expect(page.getByTitle('Elapsed time')).toHaveText('1m 6s');
  await expect(page.getByText('Goal completed. Corrections disabled.')).toBeVisible();
  await expect(page.getByLabel(/octocat/i).first()).toBeVisible();
  const openPr = page.getByRole('link', { name: /Open draft PR/ });
  await expect(openPr).toHaveAttribute('href', `https://github.com/${repository}/pull/8`);
  const menu = page.getByLabel('More goal actions');
  for (const control of [openPr, menu]) {
    const box = (await control.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(viewport);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}

const openGoal = async (page: Page) => {
  await page.goto('/goals/goal-1');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Add the requested four-line Markdown file');
};

for (const [label, repository] of Object.entries(repositories)) {
  for (const width of [320, 390]) {
    test(`${label} repository identity reads in full at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 760 });
      await stub(page, repository);
      await openGoal(page);
      await expectReadableIdentity(page, repository, { stacked: true });
      await expectHeaderControls(page, repository);
      await capture(page, `goal-identity-${label}-${width}`);
    });
  }

  for (const rootFontPx of [24, 32]) {
    test(`${label} repository identity reads in full with ${rootFontPx}px root text at 320px`, async ({ page }) => {
      await page.setViewportSize({ width: 320, height: 760 });
      await stub(page, repository, { rootFontPx });
      await openGoal(page);
      const geometry = await expectReadableIdentity(page, repository, { stacked: true });
      // The slug scales with the reader's text size instead of staying a fixed 12px.
      expect(await page.getByTestId('repository-chip-name').evaluate(node => parseFloat(getComputedStyle(node).fontSize))).toBe(rootFontPx * 0.75);
      expect(geometry.lines.length).toBeGreaterThan(2);
      await expectHeaderControls(page, repository);
      if (rootFontPx === 24) await capture(page, `goal-identity-${label}-320-text-150`);
    });
  }

  test(`${label} repository identity keeps the compact chip on desktop`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await stub(page, repository);
    await openGoal(page);
    await expectReadableIdentity(page, repository, { stacked: false });
    await expectHeaderControls(page, repository);
    await capture(page, `goal-identity-${label}-desktop`);
  });
}

// Native windows: a narrow 320px window and an 880x620 window at 207% zoom, both below `sm`.
const nativeLayouts = [
  { name: 'narrow', width: 320, height: 568, deviceScaleFactor: 2 },
  { name: 'zoomed', width: 406, height: 286, deviceScaleFactor: 2.1708 },
];
const nativePage = async (browser: Browser, layout: typeof nativeLayouts[number]) => {
  const context = await browser.newContext({ viewport: { width: layout.width, height: layout.height }, deviceScaleFactor: layout.deviceScaleFactor });
  return { context, page: await context.newPage() };
};

for (const layout of nativeLayouts) {
  test(`native ${layout.name} window reads the long repository identity in full`, async ({ browser }) => {
    const { context, page } = await nativePage(browser, layout);
    try {
      await stub(page, repositories.long, { native: true });
      await openGoal(page);
      await expectReadableIdentity(page, repositories.long, { stacked: true });
      await expectHeaderControls(page, repositories.long);
      await capture(page, `goal-identity-native-${layout.name}`);
    } finally { await context.close(); }
  });
}

test('goal list keeps its compact one-line repository chip at 320px', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 760 });
  await stub(page, repositories.long);
  await page.goto('/goals');
  const chip = page.getByRole('list', { name: 'Goal work queue' }).getByTestId('repository-chip');
  await expect(chip).toHaveText(repositories.long);
  // The list is intentionally compact: one truncated line, no stacked owner.
  await expect(chip.getByTestId('repository-chip-owner')).toHaveCount(0);
  const geometry = await chipGeometry(chip);
  expect(new Set(geometry.lines.map(line => Math.round(line.top))).size).toBe(1);
  expect(await chip.locator('span.truncate').evaluate(node => node.scrollWidth > node.clientWidth)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
