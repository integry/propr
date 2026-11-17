import { expect, test, type Locator, type Page } from '@playwright/test';
import { capture, fixture } from './planner-studio.fixture';

// A 20-issue graph epic mid-run: 13 merged, 1 running, 1 in review, 1 blocked, 1 skipped and 3 queued.
// Every title starts with the same "Official plugin: Linear (" prefix, so rows only differ past it.
const now = Date.now();
const ago = (hours: number) => new Date(now - hours * 3_600_000).toISOString();
const repository = 'integry/propr';
const draftId = 'plan-linear';
const planName = 'Official plugins for Linear, Jira and Slack';
const subjects = [
  'manifest and capability contract', 'OAuth app registration and token storage', 'workspace and team discovery',
  'issue import with label mapping', 'state sync in both directions', 'comment mirroring with author attribution',
  'webhook intake and signature checks', 'rate-limit aware retry queue', 'attachment links and previews',
  'priority and estimate mapping', 'cycle and project mapping', 'settings page and connection health',
  'audit log entries for every sync', 'conflict resolution when both sides change', 'docs and setup guide for administrators',
  'two-way assignee sync with unmatched users kept as a note', 'backfill of existing issues in batches', 'deleted and archived issue handling',
  'end-to-end tests against the Linear sandbox workspace', 'release notes and migration of the beta connector',
];
const first = 3541;
const titles = subjects.map(subject => `Official plugin: Linear (${subject})`);
const numbers = titles.map((_, index) => first + index);
// Graph prerequisites: the running issue is ahead of the blocked one; the queued issues wait on the blocked and skipped ones.
const dependsOn: Record<number, number[]> = { 3554: [3553], 3555: [3553], 3556: [3554], 3557: [3554], 3558: [3557], 3559: [3556], 3560: [3556, 3555] };
const statusOf = (number: number) => (number <= 3553 ? 'merged' : number === 3554 ? 'processing' : number === 3555 ? 'under_review' : 'pending');

const plan = titles.map((title, index) => ({ id: `linear-${index}`, title, issue_number: numbers[index],
  body: `Context for ${subjects[index]}.`, implementation: 'Implementation details.' }));
const issues = numbers.map((number, index) => ({
  id: index + 1, draft_id: draftId, repository, issue_number: number, status: statusOf(number),
  pr_number: number <= 3553 ? 3570 + index : number === 3555 ? 3601 : null,
  followup_count: number === 3555 ? 3 : 0, review_scores: number === 3555 ? [6, 6, 9] : [],
  agent_alias: 'claude', model_name: 'claude-opus-5-5', task_id: number === 3554 ? 'task-3554' : null,
  depends_on_issues: dependsOn[number] ?? [], created_at: ago(30), updated_at: ago(1),
}));
const queueState = (issue: number, state: string, extra: Record<string, unknown> = {}) => ({
  issue, state, blockedKind: null, blockedReason: null, dependsOn: dependsOn[issue] ?? [], waitingOn: [], ...extra,
});
const queue = {
  executionId: 'exec-linear', issues: numbers.filter(number => number >= 3554), cursor: 0, head: 3554, status: 'active',
  blockedReason: null, executionMode: 'graph', maxParallel: 2, advanceOn: 'merged',
  issueStates: [
    queueState(3554, 'dispatched', { schedule: 'in_flight' }),
    queueState(3555, 'dispatched', { schedule: 'in_flight' }),
    queueState(3556, 'blocked', { schedule: 'blocked', blockedKind: 'dispatch_failed', blockedReason: 'Could not add the model label to issue #3556: GitHub returned 502.' }),
    queueState(3557, 'skipped', { schedule: 'skipped', skipSatisfiesDependents: false }),
    queueState(3558, 'pending', { schedule: 'waiting', waitingOn: [3557], waitingOnSkipped: [3557] }),
    queueState(3559, 'pending', { schedule: 'waiting', waitingOn: [3556] }),
    queueState(3560, 'pending', { schedule: 'waiting', waitingOn: [3556, 3555] }),
  ],
};
const draft = {
  draft_id: draftId, repository, name: planName, initial_prompt: planName, status: 'pr_created', plan_json: plan,
  context_config: { baseBranch: 'main', useEpic: true, autoMerge: true }, created_at: ago(30), updated_at: ago(1),
};
const listDraft = { ...draft, plan_json: undefined, issue_summary: { total: 20, pending: 5, processing: 1, in_review: 1, merged: 13, closed: 0 } };

async function linearPlan(page: Page, viewport: { width: number; height: number }, data: { issues: unknown[]; queue: unknown } = { issues, queue }) {
  await fixture(page);
  await page.setViewportSize(viewport);
  await page.route(`**/api/planner/drafts/${draftId}**`, route => {
    const suffix = new URL(route.request().url()).pathname.replace(`/api/planner/drafts/${draftId}`, '');
    if (suffix === '') return route.fulfill({ json: draft });
    if (suffix === '/issues') return route.fulfill({ json: data.issues });
    if (suffix === '/execution-queue') return route.fulfill({ json: { queue: data.queue } });
    return route.fallback();
  });
  await page.route('**/api/planner/drafts?**', route => route.fulfill({ json: { drafts: [listDraft], total: 1, page: 1, limit: 20, hasMore: false } }));
}

type Box = { x: number; y: number; width: number; height: number };
const overlaps = (a: Box, b: Box) => a.x < b.x + b.width - 0.5 && b.x < a.x + a.width - 0.5 && a.y < b.y + b.height - 0.5 && b.y < a.y + a.height - 0.5;

/** The row's own pieces (number, status, title, metadata items, agent and action) never overlap; the title keeps two lines at most. */
async function expectReadableRow(row: Locator, { ownLine }: { ownLine: boolean }) {
  const geometry = await row.evaluate(element => {
    const header = element.firstElementChild!.firstElementChild as HTMLElement;
    const rect = (node: Element) => { const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; };
    const title = header.querySelector('[data-testid="plan-issue-title"]')!;
    const pieces = [
      header.querySelector('a')!, header.querySelector('[data-testid="plan-issue-status"]')!,
      ...header.querySelectorAll('[data-testid="plan-issue-prerequisites"], a[href*="/pull/"], [data-testid="review-score-trace"], [data-testid="agent-chip"], [data-testid="agent-override-chip"]'),
    ].filter(node => node.getBoundingClientRect().width > 0);
    const style = getComputedStyle(element.firstElementChild!);
    return {
      title: rect(title), pieces: pieces.map(rect), header: rect(header),
      innerWidth: (element.firstElementChild as HTMLElement).clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
      lineHeight: parseFloat(getComputedStyle(title).lineHeight),
    };
  });
  for (const piece of geometry.pieces) expect(overlaps(geometry.title, piece), 'title overlaps a row piece').toBe(false);
  for (let i = 0; i < geometry.pieces.length; i++) {
    for (let j = i + 1; j < geometry.pieces.length; j++) expect(overlaps(geometry.pieces[i], geometry.pieces[j]), 'row pieces overlap').toBe(false);
  }
  expect(geometry.title.height).toBeLessThanOrEqual(geometry.lineHeight * 2 + 1);
  expect(geometry.header.x + geometry.header.width).toBeLessThanOrEqual(geometry.header.x + geometry.innerWidth + 1);
  if (ownLine) expect(geometry.title.width).toBeGreaterThanOrEqual(geometry.innerWidth - 1);
  else expect(geometry.title.width).toBeGreaterThanOrEqual(288 - 1);
}

const expectNoSidewaysScroll = async (page: Page) => expect(await page.evaluate(() => {
  const scrollers = [document.documentElement, ...document.querySelectorAll<HTMLElement>('*')]
    .filter(element => element.scrollWidth > element.clientWidth + 1 && ['auto', 'scroll'].includes(getComputedStyle(element).overflowX));
  return document.documentElement.scrollWidth <= window.innerWidth && scrollers.length === 0;
})).toBe(true);

async function openExecution(page: Page) {
  await page.goto(`/studio/${draftId}`);
  const rows = page.getByTestId('plan-execution-matrix').getByTestId('plan-execution-row');
  await expect(rows).toHaveCount(7);
  return rows;
}

const rowFor = (rows: Locator, number: number) => rows.filter({ has: rows.page().getByRole('link', { name: `#${number}`, exact: true }) });

for (const viewport of [{ width: 1440, height: 1000 }, { width: 1024, height: 900 }, { width: 390, height: 844 }, { width: 320, height: 720 }]) {
  test(`execution rows stay readable and count every state at ${viewport.width}px`, async ({ page }) => {
    await linearPlan(page, viewport);
    const rows = await openExecution(page);
    const phone = viewport.width < 768;

    // A skipped issue reads Skipped, not Queued; blocked and queued keep their own pills.
    await expect(rowFor(rows, 3557).getByTestId('plan-issue-status')).toHaveText('Skipped');
    await expect(rowFor(rows, 3556).getByTestId('plan-issue-status')).toHaveText('Blocked');
    for (const number of [3558, 3559, 3560]) await expect(rowFor(rows, number).getByTestId('plan-issue-status')).toHaveText('Queued');
    await expect(rowFor(rows, 3555).getByTestId('plan-issue-status')).toHaveText('In Review');

    // Prerequisites, and which unmerged one a queued issue waits on.
    await expect(rowFor(rows, 3560).getByTestId('plan-issue-prerequisites')).toHaveText('After #3556, #3555 · waiting on #3556, #3555');
    await expect(rowFor(rows, 3554).getByTestId('plan-issue-prerequisites')).toHaveText('After #3553');
    // The skipped prerequisite has its own notice instead of a second "waiting on".
    await expect(rowFor(rows, 3558).getByTestId('plan-issue-waiting-on')).toHaveCount(0);
    await expect(rowFor(rows, 3558).getByTestId('plan-queue-waiting-skipped')).toHaveText('Waiting on skipped #3557. Start it from that row.');

    // Queue actions.
    const blocked = rowFor(rows, 3556);
    await expect(blocked.getByTestId('plan-queue-blocked')).toContainText('Blocked · Could not start');
    await expect(blocked.getByTestId('plan-queue-skip')).toHaveText('Skip (keep #3559, #3560 waiting)');
    await expect(blocked.getByTestId('plan-queue-skip_release')).toHaveText('Skip and start #3559, #3560');
    await expect(rowFor(rows, 3557).getByTestId('plan-queue-skipped')).toContainText('Skipped. The queue does not run it again in this execution. #3558 waits on it.');
    await expect(rowFor(rows, 3557).getByTestId('plan-queue-skip_release')).toHaveText('Start #3558');

    // Summary and footer agree with the Plans list's "1 running • 1 in review • 5 pending • 13 merged".
    await expect(page.getByTestId('execute-all-hint')).toHaveText('5 tasks: 3 queued, 1 blocked, 1 skipped. Each queued task starts automatically when the task ahead of it finishes.');
    await expect(page.getByTestId('plan-footer-stats')).toHaveText('20 Issues·1 Running·1 In Review·3 Queued·1 Blocked·1 Skipped·13 Merged');

    // Titles: their own full-width line below lg, never overlapped, two lines at most, full text in the tooltip.
    for (const row of await rows.all()) await expectReadableRow(row, { ownLine: viewport.width < 1024 });
    const title = rowFor(rows, 3559).getByTestId('plan-issue-title');
    await expect(title).toHaveAttribute('title', titles[3559 - first]);
    if (phone) {
      // Rows on a phone tell the shared prefix apart: the distinguishing words are on screen.
      expect(await title.evaluate(element => element.scrollHeight <= element.clientHeight + 1)).toBe(true);
    }
    await expectNoSidewaysScroll(page);

    if (!phone) {
      // The plan title keeps its room: the header stays one line, the buttons give up their labels first,
      // and the full name fits at 1440.
      const header = page.getByTestId('approved-plan-header');
      expect((await header.boundingBox())!.height).toBeLessThanOrEqual(52);
      const heading = page.getByRole('heading', { level: 1, name: planName });
      if (viewport.width >= 1440) expect(await heading.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
      expect((await heading.boundingBox())!.width).toBeGreaterThan(280);
      await expect(header.getByRole('button', { name: 'Revise' })).toBeVisible();
    }

    await page.waitForTimeout(400);
    await capture(page, `studio-queue-states-${viewport.width}`);

    // Expanding a row repeats its title in full.
    await rowFor(rows, 3559).getByTitle('Expand details').click();
    await expect(rowFor(rows, 3559).getByTestId('plan-issue-full-title')).toHaveText(titles[3559 - first]);
  });
}

for (const viewport of [{ width: 390, height: 844 }, { width: 320, height: 720 }, { width: 768, height: 1024 }, { width: 844, height: 390 }]) {
  test(`plans list keeps counts, badge and filters inside the page at ${viewport.width}px`, async ({ page }) => {
    await linearPlan(page, viewport);
    await page.goto('/plans');
    const summary = page.getByTestId('plan-issue-summary');
    await expect(summary).toHaveText('20 issues • 1 running • 1 in review • 5 pending • 13 merged');
    const badge = page.locator('span.rounded-full', { hasText: 'PR Created' });
    const row = page.locator('.group', { has: summary });
    const rowBox = (await row.boundingBox())!;
    const badgeBox = (await badge.boundingBox())!;
    expect(badgeBox.x + badgeBox.width).toBeLessThanOrEqual(rowBox.x + rowBox.width);
    // The filters fit the header: nothing is cut off at the right edge.
    for (const control of [page.getByRole('combobox').first(), page.getByText('All Repos').first()]) {
      const box = (await control.boundingBox())!;
      expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
    }
    // From 390px the repository filter's label is not cut short; at 320 it may end in an ellipsis.
    const repoTrigger = page.getByText('All Repos').first();
    if (viewport.width >= 390) expect(await repoTrigger.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    await expectNoSidewaysScroll(page);
    await capture(page, `plans-list-${viewport.width}`);
  });
}

// Dependency lists are unbounded: six merged prerequisites plus two unmerged ones, and a blocked issue four others wait on.
const manyPrerequisites = [3548, 3549, 3550, 3551, 3552, 3553, 3556, 3555];
const manyDependsOn: Record<number, number[]> = { ...dependsOn, 3557: [3554, 3556], 3558: [3557, 3556], 3560: manyPrerequisites };
const manyEdges = {
  issues: issues.map(entry => ({ ...entry, depends_on_issues: manyDependsOn[entry.issue_number] ?? [] })),
  queue: { ...queue, issueStates: queue.issueStates.map(entry => ({ ...entry, dependsOn: manyDependsOn[entry.issue] ?? [] })) },
};

/** Nothing inside the row is cut off by its hidden overflow: the element fits the row and does not overflow itself. */
async function expectNotClipped(row: Locator, target: Locator) {
  const fit = await target.evaluate((element, rowElement) => {
    const rowBox = rowElement.getBoundingClientRect();
    const box = element.getBoundingClientRect();
    return { inside: box.left >= rowBox.left - 0.5 && box.right <= rowBox.right + 0.5, fits: element.scrollWidth <= element.clientWidth + 1 };
  }, await row.elementHandle());
  expect(fit).toEqual({ inside: true, fits: true });
}

for (const viewport of [{ width: 320, height: 720 }, { width: 390, height: 844 }]) {
  test(`long dependency text and queue action labels wrap instead of being clipped at ${viewport.width}px`, async ({ page }) => {
    await linearPlan(page, viewport, manyEdges);
    const rows = await openExecution(page);

    const waiting = rowFor(rows, 3560);
    const prerequisites = waiting.getByTestId('plan-issue-prerequisites');
    await expect(prerequisites).toHaveText(`After ${manyPrerequisites.map(n => `#${n}`).join(', ')} · waiting on #3556, #3555`);
    await expectNotClipped(waiting, prerequisites);
    // It wraps between references, never inside one.
    const lineHeight = await prerequisites.evaluate(element => parseFloat(getComputedStyle(element).lineHeight));
    expect((await prerequisites.boundingBox())!.height).toBeGreaterThan(lineHeight * 1.5);
    for (const reference of await prerequisites.locator('span.whitespace-nowrap').all()) {
      expect((await reference.boundingBox())!.height).toBeLessThanOrEqual(lineHeight + 1);
    }

    const blocked = rowFor(rows, 3556);
    for (const action of ['plan-queue-skip', 'plan-queue-skip_release']) {
      const button = blocked.getByTestId(action);
      await expect(button).toContainText('#3557, #3558, #3559, #3560');
      await expectNotClipped(blocked, button);
    }

    for (const row of await rows.all()) await expectReadableRow(row, { ownLine: true });
    await expectNoSidewaysScroll(page);
    await blocked.scrollIntoViewIfNeeded();
    await capture(page, `studio-long-dependencies-${viewport.width}`);
    await waiting.scrollIntoViewIfNeeded();
    await capture(page, `studio-long-prerequisites-${viewport.width}`);
  });
}
