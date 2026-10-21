import { expect, test, type Locator, type Page } from '@playwright/test';
import { ago, capture, fixture } from './task-list-desktop.fixture';

// A completed multi-run PR with a linked issue and a realistic long repository name. Its newest
// run is a follow-up, so the header offers /review and /ultrafix beside Follow Up and the overflow.
const owner = 'propr-ultrafix';
const repo = 'propr-desktop-acceptance-20260909';
const prNumber = 28;
const issueNumber = 27;
const topic = 'Keep the desktop acceptance checklist in sync with the release notes';
const followupRun = 'acceptance-pr-28-run-1';
const implementationRun = 'acceptance-pr-28-run-0';

const run = (id: string, title: string, minutes: number) => ({
  id, repository: `${owner}/${repo}`, repositoryOwner: owner, repositoryName: repo,
  issueNumber: prNumber, prNumber, linkedIssueNumber: issueNumber, title, subtitle: null, status: 'completed',
  createdAt: ago(minutes), processedAt: ago(minutes), completedAt: ago(minutes - 6),
  llmProvider: 'claude', model: 'claude-opus-5-5', score: null, commitHash: null,
});
const runs = [
  run(followupRun, `Follow-up PR #${prNumber}: [${issueNumber} by Claude Opus 5.5] ${topic}`, 20),
  run(implementationRun, `New Issue: [${issueNumber} by Claude Opus 5.5] ${topic}`, 60),
];

async function completedPullRequest(page: Page) {
  await fixture(page);
  await page.route(url => url.pathname === '/api/tasks', route => route.fulfill({ json: { tasks: runs, total: 1, totalRuns: 2 } }));
  // An open, unmerged PR: the header offers its follow-up commands.
  await page.route(`**/api/pull-requests/${prNumber}/scores**`, route => route.fulfill({ json: {
    repository: `${owner}/${repo}`, pr_number: prNumber, outcome: null, merged_at: null, closed_at: null, scores: [],
  } }));
  const responses: Record<string, unknown> = {
    [`/api/task/${followupRun}/history`]: {
      history: [
        { state: 'PENDING', timestamp: ago(20), metadata: { model: 'claude-opus-5-5' } },
        { state: 'CLAUDE_EXECUTION', timestamp: ago(19.8), metadata: { model: 'claude-opus-5-5', description: 'Update the checklist' } },
        { state: 'COMPLETED', timestamp: ago(14), metadata: { model: 'claude-opus-5-5' } },
      ],
      taskInfo: {
        title: `Follow-up PR #${prNumber}: [${issueNumber} by Claude Opus 5.5] ${topic}`, subtitle: null,
        type: 'pr-comment', number: prNumber, issueNumber, repoOwner: owner, repoName: repo, modelName: 'claude-opus-5-5',
      },
    },
    [`/api/task/${followupRun}/live-details`]: { events: [], todos: [], currentTask: null },
    [`/api/task/${followupRun}/file-changes`]: { taskId: followupRun, files: [] },
  };
  await page.route(url => url.pathname in responses, route => route.fulfill({ json: responses[new URL(route.request().url()).pathname] }));
}

/** The element under each probe point inside the control belongs to the control: nothing else paints or takes taps there. */
const hitTargetMisses = (control: Locator) => control.evaluate(element => {
  const rect = element.getBoundingClientRect();
  const misses: string[] = [];
  for (const [fx, fy] of [[0.5, 0.5], [0.15, 0.5], [0.85, 0.5]]) {
    const x = rect.x + rect.width * fx;
    const y = rect.y + rect.height * fy;
    const hit = document.elementFromPoint(x, y);
    if (!hit || !element.contains(hit)) misses.push(`${Math.round(x)},${Math.round(y)} → ${hit?.outerHTML.slice(0, 80) ?? 'nothing'}`);
  }
  return misses;
});

/** Every descendant of the control, text and glyphs included, lies inside the control's own box. */
const escapingDescendants = (control: Locator) => control.evaluate(element => {
  const outer = element.getBoundingClientRect();
  return Array.from(element.querySelectorAll('*')).flatMap(child => {
    const box = child.getBoundingClientRect();
    if (box.width === 0 && box.height === 0) return [];
    const inside = box.left >= outer.left - 0.5 && box.right <= outer.right + 0.5 && box.top >= outer.top - 0.5 && box.bottom <= outer.bottom + 0.5;
    return inside ? [] : [`${child.tagName.toLowerCase()} ${Math.round(box.left)}–${Math.round(box.right)} outside ${Math.round(outer.left)}–${Math.round(outer.right)}`];
  });
});

const overlaps = (a: { x: number; y: number; width: number; height: number }, b: typeof a) =>
  a.x < b.x + b.width - 0.5 && b.x < a.x + a.width - 0.5 && a.y < b.y + b.height - 0.5 && b.y < a.y + a.height - 0.5;

async function expectSeparateGitAndActions(page: Page, width: number) {
  const metadata = page.getByTestId('task-mobile-metadata');
  const git = metadata.getByRole('group', { name: 'Git context' });
  const pr = git.getByRole('link', { name: new RegExp(`#${prNumber}\\b`) });
  const issue = git.getByRole('link', { name: `#${issueNumber}` });
  const review = metadata.getByRole('button', { name: '/review' });
  const actions = [review, metadata.getByRole('button', { name: `More commands for PR #${prNumber}` }), metadata.getByRole('button', { name: /Follow Up/ }), metadata.getByRole('button', { name: 'More task actions' })];
  await expect(pr).toBeVisible();
  await expect(issue).toBeVisible();
  for (const action of actions) await expect(action).toBeVisible();

  // The PR keeps its number, which reads in full inside its link.
  const number = pr.getByText(`#${prNumber}`, { exact: true });
  const numberBox = (await number.boundingBox())!;
  const prBox = (await pr.boundingBox())!;
  expect(numberBox.width).toBeGreaterThan(0);
  expect(numberBox.x).toBeGreaterThanOrEqual(prBox.x);
  expect(numberBox.x + numberBox.width).toBeLessThanOrEqual(prBox.x + prBox.width + 0.5);

  // Neither Git link nor any action shares space with another, and every one is on screen.
  const controls = [pr, issue, ...actions];
  const boxes = await Promise.all(controls.map(async control => ({ control, box: (await control.boundingBox())! })));
  for (const [index, { control, box }] of boxes.entries()) {
    expect(box.x, String(control)).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width, String(control)).toBeLessThanOrEqual(width + 0.5);
    for (const other of boxes.slice(index + 1)) expect(overlaps(box, other.box), `${control} overlaps ${other.control}`).toBe(false);
  }
  for (const link of [pr, issue]) {
    expect(await escapingDescendants(link), String(link)).toEqual([]);
    expect(await hitTargetMisses(link), String(link)).toEqual([]);
  }
  expect(await hitTargetMisses(number)).toEqual([]);
  for (const action of actions) expect(await hitTargetMisses(action), String(action)).toEqual([]);

  // Each link still goes where it says.
  await expect(pr).toHaveAttribute('href', `https://github.com/${owner}/${repo}/pull/${prNumber}`);
  await expect(issue).toHaveAttribute('href', `https://github.com/${owner}/${repo}/issues/${issueNumber}`);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(await page.getByTestId('task-details').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
}

const phoneLayouts = [
  { name: '320', width: 320, height: 844 },
  { name: '390', width: 390, height: 844 },
  { name: 'short portrait 320', width: 320, height: 568 },
  { name: 'landscape 568', width: 568, height: 320 },
];

for (const layout of phoneLayouts) {
  test(`${layout.name}: the PR and issue badges keep their own space beside the review actions`, async ({ page }) => {
    await page.setViewportSize({ width: layout.width, height: layout.height });
    await completedPullRequest(page);
    await page.goto(`/tasks/${followupRun}`);

    // The owner-above-name repository identity still leads the header in full.
    const identity = page.getByTestId('task-repository').filter({ visible: true });
    await expect(identity.getByTestId('task-repository-owner')).toHaveText(`${owner}/`);
    await expect(identity.getByTestId('task-repository-name')).toHaveText(repo);
    await expect(identity).toHaveAttribute('href', `https://github.com/${owner}/${repo}`);
    await expectSeparateGitAndActions(page, layout.width);
    await capture(page, `task-header-git-actions-${layout.name.replace(/\s+/g, '-')}`);

    // Keyboard order runs from the Git links to the actions, and the PR's link takes focus where it is drawn.
    const metadata = page.getByTestId('task-mobile-metadata');
    const pr = metadata.getByRole('group', { name: 'Git context' }).getByRole('link', { name: new RegExp(`#${prNumber}\\b`) });
    await pr.focus();
    await expect(pr).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(metadata.getByRole('group', { name: 'Git context' }).getByRole('link', { name: `#${issueNumber}` })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(metadata.getByRole('button', { name: '/review' })).toBeFocused();
  });
}

test('enlarged text and native zoom: the PR and issue badges still clear the review actions', async ({ browser }) => {
  // 200% native zoom of a 640px window is CSS 320px; the user's text size doubles on top.
  const context = await browser.newContext({ viewport: { width: 320, height: 640 }, deviceScaleFactor: 4 });
  const page = await context.newPage();
  await completedPullRequest(page);
  await page.addInitScript(() => document.addEventListener('DOMContentLoaded', () => { document.documentElement.style.fontSize = '125%'; }));
  await page.goto(`/tasks/${followupRun}`);
  await expect(page.getByTestId('task-repository-name').filter({ visible: true })).toHaveText(repo);
  await expectSeparateGitAndActions(page, 320);
  await capture(page, 'task-header-git-actions-enlarged-text');
  await context.close();
});

test('desktop: the header keeps the repository, PR and issue beside the review actions', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 820 });
  await completedPullRequest(page);
  await page.goto(`/tasks/${followupRun}`);
  await expect(page.getByTestId('task-mobile-metadata')).toBeHidden();
  const header = page.getByTestId('task-header-tiers');
  await expect(header.getByTestId('task-repository-name')).toHaveText(repo);
  const review = header.getByRole('button', { name: '/review' });
  await expect(review).toBeVisible();
  const links = [header.getByRole('link', { name: new RegExp(`#${issueNumber}\\b`) }), header.getByRole('link', { name: new RegExp(`PR\\s*${prNumber}\\b`) })];
  for (const link of links) {
    await expect(link).toBeVisible();
    expect(overlaps((await link.boundingBox())!, (await review.boundingBox())!), String(link)).toBe(false);
    expect(await hitTargetMisses(link), String(link)).toEqual([]);
  }
  expect(await hitTargetMisses(review)).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
