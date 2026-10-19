import { expect, test, type Locator, type Page } from '@playwright/test';
import { capture, fixture } from './planner-studio.fixture';

// #3257: the full Context Scope header kept `≤490k tokens · ~1-2m scan` on one line beside the title, so at md
// widths the 35% right pane pushed the setup canvas sideways (833px of content at a 768px viewport, 906px at 880px).
const repository = 'integry/propr';
const preview = {
  success: true, warnings: [],
  stats: { totalTokens: 312_000, costEstimate: 1.2, contextLength: 900_000, fileCount: 2, modelMaxContextTokens: 1_000_000 },
  smartSelection: [
    { path: 'packages/core/src/services/planning/previewService.ts', reason: 'Matched prompt keywords', source: 'auto', score: 92 },
    { path: 'propr-ui/src/components/TaskPlanner/ContextLevelSlider.tsx', reason: 'Matched prompt keywords', source: 'auto', score: 88 },
  ],
};
const estimatePattern = /^≤\d+(\.\d+)?[kM] tokens · (<1m|~1-2m|~3-5m) scan$/;
const prompt = 'Keep the planner scope estimate inside medium-width layouts.';

// A successful branch lookup and preview, so no header error is in play: the only wide content is the scope estimate.
async function routeSetup(page: Page) {
  await fixture(page);
  await page.route(`**/api/github/repos/${repository}/branches`, route => route.fulfill({ json: { defaultBranch: 'main', branches: ['main'] } }));
  await page.route('**/api/planner/preview', route => route.fulfill({ json: preview }));
  const writes: string[] = [];
  page.on('request', request => {
    const path = new URL(request.url()).pathname;
    // The context preview is a read the planner POSTs; anything else that is not a GET would be a write.
    if (request.method() === 'GET' || !path.startsWith('/api/') || path === '/api/planner/preview') return;
    // An existing draft autosaves its typed prompt, and only that: resizing and the slider must add nothing.
    const body = request.postDataJSON() as Record<string, unknown> | null;
    if (request.method() === 'PUT' && path === '/api/planner/drafts/plan-setup' && body?.initial_prompt === prompt && Object.keys(body).every(key => ['initial_prompt', 'name'].includes(key))) return;
    writes.push(`${request.method()} ${path} ${request.postData()}`);
  });
  return writes;
}

// Every scroll container from the slider up to the document, any of which would let the canvas scroll sideways,
// plus every element of the scope block that reaches past the right pane.
const horizontalOverflow = (scope: Locator, wholeCanvas: boolean) => scope.evaluate((element, wholeCanvas) => {
  const problems: string[] = [];
  for (let node: Element | null = element; wholeCanvas && node; node = node.parentElement) {
    const style = getComputedStyle(node);
    const scrolls = node === document.documentElement || ['auto', 'scroll'].includes(style.overflowX);
    if (scrolls && node.scrollWidth > node.clientWidth) problems.push(`${node.tagName.toLowerCase()}.${node.getAttribute('class') ?? ''} ${node.clientWidth}/${node.scrollWidth}`);
  }
  const pane = element.closest('[data-testid="setup-wizard-right-pane"]') ?? document.documentElement;
  const { left, right } = pane.getBoundingClientRect();
  for (const node of [element, ...Array.from(element.querySelectorAll('*'))]) {
    const box = node.getBoundingClientRect();
    if (box.width && (box.right > right + 0.5 || box.left < left - 0.5)) problems.push(`${node.tagName.toLowerCase()} ${node.textContent?.slice(0, 30)} ${box.left}-${box.right} outside ${left}-${right}`);
  }
  return problems;
}, wholeCanvas);

async function expectReadableScope(page: Page, width: number, level: number, typed: string, wholeCanvas = true) {
  const estimate = page.getByTestId('context-scope-estimate');
  const slider = page.getByRole('slider');
  const scope = width >= 768 ? page.getByTestId('setup-wizard-right-pane').locator(':scope > div').first() : page.getByTestId('setup-settings-group').locator(':scope > div', { has: slider });
  await scope.scrollIntoViewIfNeeded();
  expect(await horizontalOverflow(scope, wholeCanvas)).toEqual([]);
  // The whole budget and scan time are there, unclipped, in their own box and at a readable size.
  // The separator is held to the token budget by a no-break space; read as plain spaces it is the same estimate.
  const text = (await estimate.textContent())!.replace(/\u00a0/g, ' ');
  expect(width >= 768 ? text : text.replace(/^.+? · /, '')).toMatch(estimatePattern);
  expect(await estimate.evaluate(element => element.scrollWidth <= element.clientWidth && getComputedStyle(element).textOverflow !== 'ellipsis')).toBe(true);
  expect(await estimate.evaluate(element => parseFloat(getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(11);
  await expect(estimate).toBeInViewport({ ratio: 1 });
  await expect(slider).toHaveValue(String(level));
  await expect(slider).toBeInViewport({ ratio: 1 });
  if (width >= 768) {
    await expect(scope.getByText('Context Scope', { exact: true })).toBeInViewport({ ratio: 1 });
    await expect(scope.getByText(`${level}%`, { exact: true })).toBeInViewport({ ratio: 1 });
    for (const shortcut of ['Focused', 'Expanded', 'Full Scan']) await expect(scope.getByRole('button', { name: shortcut, exact: true })).toBeInViewport({ ratio: 1 });
  } else {
    await expect(page.getByTestId('context-scope-descriptor')).toHaveText(new RegExp(`^${level}% \\(`));
    await expect(page.getByTestId('context-scope-descriptor')).toBeInViewport({ ratio: 1 });
  }
  await expect(page.getByPlaceholder(/Describe the feature/)).toHaveValue(typed);
}

// Typing into a new plan creates its draft a second later, turning it into an edit, so the new plan keeps an empty
// prompt (and sends nothing at all), while the existing draft carries an edited, not yet generated prompt through every step.
const modes = [
  { name: 'new', path: '/studio/new', level: 50, estimate: '≤490k tokens · ~1-2m scan', typed: '' },
  { name: 'edit', path: '/studio/plan-setup', level: 100, estimate: '≤980k tokens · ~3-5m scan', typed: prompt },
];
const viewports = [
  { width: 320, height: 640 }, { width: 390, height: 844 }, { width: 768, height: 900 }, { width: 842, height: 680 },
  { width: 880, height: 620 }, { width: 1280, height: 800 }, { width: 1390, height: 864 },
];

for (const mode of modes) {
  test(`the ${mode.name}-plan scope estimate stays inside the canvas at every width`, async ({ page }) => {
    const writes = await routeSetup(page);
    await page.setViewportSize(viewports[2]);
    await page.goto(mode.path);
    await expect(page.getByTestId('context-scope-estimate')).toHaveText(mode.estimate);
    if (mode.typed) await page.getByPlaceholder(/Describe the feature/).fill(mode.typed);
    let level = mode.level;
    for (const viewport of viewports) {
      await page.setViewportSize(viewport);
      await expectReadableScope(page, viewport.width, level, mode.typed);
      if (viewport.width === 768 || viewport.width === 880) await capture(page, `planner-scope-estimate-${mode.name}-${viewport.width}`);
      // The slider still steps from the keyboard at this width, and the header keeps fitting at the new value.
      await page.getByRole('slider').focus();
      await page.keyboard.press(level > 10 ? 'ArrowLeft' : 'ArrowRight');
      level += level > 10 ? -10 : 10;
      await expectReadableScope(page, viewport.width, level, mode.typed);
    }
    expect(writes).toEqual([]);
  });

  for (const scale of [150, 200]) {
    test(`the ${mode.name}-plan scope estimate stays inside the canvas with ${scale}% text`, async ({ page }) => {
      const writes = await routeSetup(page);
      await page.setViewportSize(viewports[2]);
      await page.goto(mode.path);
      await expect(page.getByTestId('context-scope-estimate')).toHaveText(mode.estimate);
      await page.addStyleTag({ content: `html { font-size: ${scale}% !important; }` });
      if (mode.typed) await page.getByPlaceholder(/Describe the feature/).fill(mode.typed);
      for (const viewport of [viewports[1], viewports[2], viewports[3], viewports[4], viewports[5]]) {
        await page.setViewportSize(viewport);
        // Other setup controls (context repositories, the docked Generate label) still overflow with enlarged text on
        // their own; that is outside the scope block, so here only the scope block's own containment is asserted.
        await expectReadableScope(page, viewport.width, mode.level, mode.typed, false);
        if (scale === 200 && viewport.width === 768) await capture(page, `planner-scope-estimate-${mode.name}-768-200pct`);
      }
      expect(writes).toEqual([]);
    });
  }
}
