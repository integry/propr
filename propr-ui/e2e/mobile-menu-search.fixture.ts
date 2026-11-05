/** A touch-only phone with global search results for long saved plans and a long task. */
import { expect, type Browser, type Locator, type Page } from '@playwright/test';
import { fixture, minutesAgo } from './dashboard-sections.fixture';

export const repository = 'example-organisation/very-long-repository-name-for-search-layout-validation-workspace';
// Titles at the lengths real saved plans reach (~170 and ~500 characters).
export const mediumTitle = 'Make the repository settings page keep unsaved branch protection edits when the operator '
  + 'switches tabs, and show which fields still differ from the saved configuration';
export const longTitle = 'Consolidate the release readiness checklist so that every packaging target (signed Linux '
  + 'RPM and DEB, notarised macOS DMG, Windows MSI) reports the same artefact provenance, verifies the '
  + 'update feed signature against packages/desktop/src/update/verification/release-feed-signature-policy.ts, '
  + 'records the reviewer who approved the build, links the matching changelog entry, and refuses to publish '
  + 'when any target is missing a reproducible build attestation or the smoke suite on clean hosts fails';

const plans = [mediumTitle, longTitle, 'Short plan about search layout'].map((name, index) => ({
  draft_id: `plan-${index}`, repository, name, initial_prompt: `Synthetic plan ${index + 1} for the layout check.`,
  status: 'review', created_at: minutesAgo((index + 1) * 60), updated_at: minutesAgo((index + 1) * 60),
  issue_summary: { total: 3, pending: 1, processing: 1, merged: 1, closed: 0 },
}));
const tasks = [{
  id: 'task-1', title: longTitle, status: 'completed', prNumber: 2480, score: 9, repository,
  issueNumber: 2400, model: 'gpt-6-astra', subtitle: 'Synthetic task.', createdAt: minutesAgo(3 * 24 * 60),
}];

export const viewports = [
  { name: '320', width: 320, height: 640 },
  { name: '390', width: 390, height: 844 },
];

/** `prepare` runs before the first navigation (e.g. to install init scripts). */
export async function openPhone(browser: Browser, viewport: { width: number; height: number }, prepare?: (page: Page) => Promise<void>) {
  const context = await browser.newContext({ viewport, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
  const page = await context.newPage();
  await prepare?.(page);
  await fixture(page, viewport, [], []);
  await page.route('**/api/planner/drafts?**', route => route.fulfill({ json: { drafts: plans, total: plans.length, page: 1, limit: 5, hasMore: false } }));
  await page.route('**/api/tasks?**', route => route.fulfill({ json: { tasks, total: tasks.length } }));
  await page.goto('/');
  await expect(page.getByRole('main')).toBeVisible();
  return { context, page };
}

// Wait out the sheet's rise and the scrim's fade so taps land on settled boxes.
export async function settle(page: Page) {
  await page.evaluate(async () => {
    const running = () => document.getAnimations().filter(animation =>
      animation.playState !== 'finished' && animation.playState !== 'idle' && animation.effect?.getComputedTiming().endTime !== Infinity);
    for (let pending = running(); pending.length; pending = running()) await Promise.allSettled(pending.map(animation => animation.finished));
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
}

export const noDocumentOverflow = (page: Page) => page.evaluate(() =>
  document.documentElement.scrollWidth <= document.documentElement.clientWidth);

/** The element really under the control's centre is the control: nothing covers it. */
export const isHitTarget = (control: Locator) => control.evaluate(element => {
  const { left, top, width, height } = element.getBoundingClientRect();
  const hit = document.elementFromPoint(left + width / 2, top + height / 2);
  return Boolean(hit && element.contains(hit));
});

export async function openSearchFromMenu(page: Page) {
  const moreButton = page.getByRole('navigation', { name: 'Primary navigation' }).getByRole('button', { name: 'More' });
  await moreButton.tap();
  const menu = page.getByRole('dialog', { name: 'ProPR', exact: true });
  await expect(menu).toBeVisible();
  await settle(page);
  await menu.getByRole('button', { name: 'Search', exact: true }).tap();
  await expect(menu).toHaveCount(0);
  const sheet = page.getByRole('dialog', { name: 'Search' });
  await expect(sheet).toBeVisible();
  return { moreButton, sheet, input: sheet.getByRole('combobox', { name: 'Search' }) };
}
