import { expect, test, type Locator, type Page } from '@playwright/test';
import { capture, fixture } from './planner-studio.fixture';

// #3253: a failed branch lookup's recovery instruction ran across the phase switcher and widened the canvas.
const wordyError = 'GitHub authorization is required. Sign in with the same GitHub account in your instance’s browser login, then retry your original action in Desktop. Desktop pairing does not renew GitHub authorization.';
const unbrokenError = `GitHub authorization is required: https://github.com/login/oauth/authorize?client_id=Iv1.${'a1b2c3d4e5'.repeat(12)}&scope=repo`;
const repository = 'integry/propr';
const repoBranchesPath = `/api/github/repos/${repository}/branches`;

// The edit-mode draft has no configured branch, so opening it asks GitHub for the default branch like a new plan does.
const unconfiguredDraft = {
  draft_id: 'plan-auth', repository, name: 'Implement the ProPR fleet orchestration', initial_prompt: 'Implement the ProPR fleet orchestration.',
  status: 'draft', plan_json: [], context_config: { contextLevel: 100, granularity: 'granular' }, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
};

type Branches = { error: string } | { defaultBranch: string } | 'pending';

async function routeScope(page: Page, branches: Branches) {
  await fixture(page);
  // Registered after the shared fixture, so these win: a repository entry without a configured branch, and the lookup's answer.
  await page.route('**/api/instance/catalog', route => route.fulfill({ json: { agents: [{ alias: 'claude', enabled: true, supportedModels: ['claude-opus-5-5'], defaultModel: 'claude-opus-5-5' }], repositories: [{ name: repository, enabled: true }], defaultAgentAlias: 'claude' } }));
  await page.route('**/api/planner/drafts/plan-auth', route => route.fulfill({ json: unconfiguredDraft }));
  await page.route(`**${repoBranchesPath}`, route => {
    if (branches === 'pending') return;
    if ('error' in branches) return route.fulfill({ status: 403, json: { error: branches.error, code: 'GITHUB_AUTHORIZATION_REQUIRED' } });
    return route.fulfill({ json: { defaultBranch: branches.defaultBranch, branches: [branches.defaultBranch] } });
  });
  const writes: string[] = [];
  page.on('request', request => { if (request.method() !== 'GET' && new URL(request.url()).pathname.startsWith('/api/')) writes.push(`${request.method()} ${request.url()}`); });
  return writes;
}

type Box = { x: number; y: number; width: number; height: number };
const overlaps = (left: Box, right: Box) => left.x < right.x + right.width && right.x < left.x + left.width && left.y < right.y + right.height && right.y < left.y + left.height;

// Every box the header draws: the scope pill, the branch chip from md up, and the phase indicator.
async function headerControls(page: Page, width: number) {
  const controls: Locator[] = [page.getByTestId('scope-pill'), page.getByRole('navigation', { name: 'Plan phase' })];
  if (width >= 768) controls.push(page.getByTestId('branch-chip'));
  return controls;
}

// Nothing the header draws reaches past the header, the header stays inside the canvas, and the page never
// scrolls sideways. (The right pane's scope estimate can widen the canvas at md widths on its own; that is not the header.)
const headerOverflow = (error: Locator) => error.evaluate(element => {
  const header = element.parentElement!;
  const right = header.getBoundingClientRect().right + 0.5;
  const overflowing = Array.from(header.querySelectorAll('*')).filter(node => node.getBoundingClientRect().right > right)
    .map(node => `${node.tagName.toLowerCase()}.${node.getAttribute('class')} right ${node.getBoundingClientRect().right}`);
  const canvas = header.closest('.overflow-auto');
  if (canvas && right > canvas.getBoundingClientRect().left + canvas.clientWidth + 0.5) overflowing.push(`header right ${right} past canvas ${canvas.clientWidth}`);
  const page = document.documentElement;
  if (page.scrollWidth > page.clientWidth) overflowing.push(`page ${page.clientWidth}/${page.scrollWidth}`);
  return overflowing;
});

async function expectContainedError(page: Page, width: number, message: string) {
  const error = page.getByTestId('scope-error');
  await expect(error).toHaveText(message);
  await expect(page.getByText(message, { exact: true })).toBeVisible();
  const errorBox = (await error.boundingBox())!;
  const header = (await error.locator('..').boundingBox())!;
  expect(errorBox.x).toBeGreaterThanOrEqual(header.x - 0.5);
  expect(errorBox.x + errorBox.width).toBeLessThanOrEqual(header.x + header.width + 0.5);
  expect(errorBox.x + errorBox.width).toBeLessThanOrEqual(width);
  // Wrapped, not clipped or ellipsised: its text fits its own box, at a readable size.
  expect(await error.evaluate(element => element.scrollWidth <= element.clientWidth && getComputedStyle(element).textOverflow !== 'ellipsis')).toBe(true);
  expect(await error.evaluate(element => parseFloat(getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(12);
  for (const control of await headerControls(page, width)) {
    await expect(control).toBeInViewport({ ratio: 1 });
    expect(overlaps(errorBox, (await control.boundingBox())!)).toBe(false);
  }
  expect(await headerOverflow(error)).toEqual([]);
}

const modes = [
  { name: 'new', path: '/studio/new' },
  { name: 'edit', path: '/studio/plan-auth' },
];
const viewports = [
  { width: 320, height: 640 }, { width: 390, height: 844 }, { width: 768, height: 900 },
  { width: 880, height: 620 }, { width: 1280, height: 800 }, { width: 1390, height: 864 },
];

for (const mode of modes) {
  for (const [kind, message] of [['wordy', wordyError], ['unbroken', unbrokenError]] as const) {
    test(`a long ${kind} branch-lookup error stays inside the ${mode.name}-plan header at every width`, async ({ page }) => {
      const writes = await routeScope(page, { error: message });
      await page.setViewportSize(viewports[0]);
      await page.goto(mode.path);
      await expect(page.getByTestId('scope-error')).toHaveText(message);
      for (const viewport of viewports) {
        await page.setViewportSize(viewport);
        await expectContainedError(page, viewport.width, message);
        if (kind === 'wordy' && (viewport.width === 390 || viewport.width === 880)) await capture(page, `planner-scope-error-${mode.name}-${viewport.width}`);
      }
      // The repository picker still opens with the error showing.
      await page.getByTestId('scope-pill').getByRole('button').first().click();
      await expect(page.getByTestId('repo-item').first()).toBeVisible();
      await page.keyboard.press('Escape');
      expect(writes).toEqual([]);
    });
  }

  test(`the ${mode.name}-plan header error stays contained with enlarged text`, async ({ page }) => {
    await routeScope(page, { error: wordyError });
    await page.setViewportSize(viewports[0]);
    await page.goto(mode.path);
    await page.addStyleTag({ content: 'html { font-size: 150% !important; }' });
    for (const viewport of [viewports[1], viewports[3], viewports[4]]) {
      await page.setViewportSize(viewport);
      await expectContainedError(page, viewport.width, wordyError);
    }
  });

  test(`the ${mode.name}-plan header stays usable while the branch loads and once it resolves`, async ({ page }) => {
    await routeScope(page, 'pending');
    await page.setViewportSize(viewports[4]);
    await page.goto(mode.path);
    await expect(page.getByText('Loading...').first()).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Plan phase' })).toBeInViewport({ ratio: 1 });
    await expect(page.getByTestId('scope-error')).toHaveCount(0);

    await page.unroute(`**${repoBranchesPath}`);
    await page.route(`**${repoBranchesPath}`, route => route.fulfill({ json: { defaultBranch: 'main', branches: ['main'] } }));
    await page.reload();
    await expect(page.getByTestId('branch-chip')).toHaveAttribute('data-status', 'resolved');
    await expect(page.getByTestId('branch-chip')).toContainText('main');
    await expect(page.getByTestId('scope-error')).toHaveCount(0);
    await expect(page.getByRole('navigation', { name: 'Plan phase' })).toBeInViewport({ ratio: 1 });
  });
}
