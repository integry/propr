import { expect, test, type Locator, type Page } from '@playwright/test';
import { capture } from './planner-studio.fixture';
import { modes, openSetup, routeSetup, viewports } from './planner-setup.fixture';

// #3259: with the scope estimate fitting its pane (#3257), the rest of the setup canvas still ran sideways with enlarged
// text: the phase pill and the Break plan / model / Generate footer ran under the context pane, "(optional)" past it,
// and on a phone the context repos picker past the screen (768/862 at 200%, 800/883 at 1280px/200%, 390/405 on a phone).

// Everything that would make the planner unreadable sideways: any scroll container in the document that scrolls
// horizontally, any visible element of the canvas (or the phone's Generate dock) that reaches past its pane or the
// screen, and any element that cuts its own text off. Hover-only tooltips (opacity 0) are not laid out content.
const canvasProblems = (page: Page) => page.evaluate(() => {
  const problems: string[] = [];
  const name = (node: Element) => `${node.tagName.toLowerCase()} "${(node.textContent || node.getAttribute('aria-label') || '').trim().slice(0, 40)}"`;
  const width = document.documentElement.clientWidth;
  for (const node of [document.documentElement, ...Array.from(document.body.querySelectorAll('*'))]) {
    const scrolls = node === document.documentElement || ['auto', 'scroll'].includes(getComputedStyle(node).overflowX);
    if (scrolls && node.scrollWidth > node.clientWidth) problems.push(`${name(node).slice(0, 30)} scrolls sideways ${node.clientWidth}/${node.scrollWidth}`);
  }
  const canvas = document.querySelector('[data-testid="setup-wizard-left-pane"]')!.parentElement!;
  const dock = document.querySelector('[data-testid="mobile-generate-dock"]');
  for (const node of [canvas, dock].flatMap(root => root ? Array.from(root.querySelectorAll('*')) : [])) {
    const box = node.getBoundingClientRect();
    const visible = (node as Element & { checkVisibility(options: object): boolean }).checkVisibility({ opacityProperty: true, visibilityProperty: true });
    if (!visible || box.width <= 1 || box.height <= 1) continue;
    const region = (node.closest('[data-testid="setup-wizard-left-pane"], [data-testid="setup-wizard-right-pane"]') ?? (canvas.contains(node) ? canvas : dock!)).getBoundingClientRect();
    const left = Math.max(region.left, 0), right = Math.min(region.right, width);
    if (box.left < left - 0.5 || box.right > right + 0.5) problems.push(`${name(node)} at ${Math.round(box.left)}-${Math.round(box.right)} outside ${Math.round(left)}-${Math.round(right)}`);
    const style = getComputedStyle(node);
    if (['hidden', 'clip'].includes(style.overflowX) && !['INPUT', 'TEXTAREA', 'SELECT'].includes(node.tagName) && node.scrollWidth > node.clientWidth + 1) {
      problems.push(`${name(node)} cut to ${node.clientWidth}/${node.scrollWidth}`);
    }
  }
  return problems;
});

// Measure the layout the planner settles on at this width: crossing 768px swaps the phone and desktop layouts.
async function settle(page: Page, width: number) {
  await expect(page.getByTestId(width >= 768 ? 'setup-wizard-right-pane' : 'setup-settings-group')).toBeVisible();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function expectReachable(...targets: Locator[]) {
  for (const target of targets) {
    await target.scrollIntoViewIfNeeded();
    await expect(target).toBeInViewport({ ratio: 1 });
  }
}

// Every label and control of the setup canvas, whole and on screen once scrolled to (the canvas scrolls vertically).
async function expectReadableCanvas(page: Page, width: number) {
  const model = page.getByTestId('planner-model-selector');
  await expect(page.getByTestId('scope-pill')).toHaveText('propr/main');
  await expect(model).toHaveText('Claude Opus 5.5 (Default)');
  if (width >= 768) {
    const phases = page.getByRole('navigation', { name: 'Plan phase' });
    const right = page.getByTestId('setup-wizard-right-pane');
    // Fitting comes from wrapping inside the panes, not from moving the 65/35 split between them.
    const split = await page.getByTestId('setup-wizard-left-pane').evaluate(pane => pane.getBoundingClientRect().width / pane.parentElement!.clientWidth);
    expect(split).toBeCloseTo(0.65, 2);
    // From md the pill names the repository and the chip the branch; the pill's `/main` suffix is for phones only.
    await expect(page.getByTestId('scope-pill-branch')).toBeHidden();
    await expect(page.getByTestId('branch-chip')).toHaveText('main');
    await expectReachable(
      page.getByTestId('scope-pill'), page.getByTestId('branch-chip'),
      ...['Define', 'Review', 'Execute'].map(phase => phases.getByText(phase, { exact: true })),
      page.getByText('Break plan:', { exact: true }),
      ...['Single', 'Balanced', 'Granular'].map(pill => page.getByRole('button', { name: pill, exact: true })),
      page.getByText('Model:', { exact: true }), model,
      page.getByRole('button', { name: 'Export Context' }), page.getByRole('button', { name: /^Generate Plan/ }),
      right.getByText('Additional Context Repositories', { exact: true }), right.getByText('(optional)', { exact: true }),
    );
  } else {
    const settings = page.getByTestId('setup-settings-group');
    await expect(page.getByTestId('phase-step-badge')).toHaveText('Step 1/3');
    await expectReachable(
      page.getByTestId('scope-pill'), page.getByTestId('phase-step-badge'),
      settings.getByText('Break into', { exact: true }),
      ...['1', '3-5', '7+'].map(pill => settings.getByRole('button', { name: pill, exact: true })),
      settings.getByText('Model', { exact: true }), model,
      settings.getByText('Context repos', { exact: true }), settings.getByRole('button', { name: 'Context repos: None indexed' }),
      page.getByTestId('mobile-generate-dock').getByRole('button', { name: /^Generate Plan/ }),
    );
  }
}

test('the whole-canvas check reports content that runs past a pane or is cut short', async ({ page }) => {
  await routeSetup(page);
  await openSetup(page, modes[0]);
  expect(await canvasProblems(page)).toEqual([]);
  // The kinds of failure seen before the fix: a nowrap label under the context pane, a squeezed control that cuts
  // its own text, and a row that scrolls sideways inside the canvas.
  await page.getByTestId('setup-wizard-left-pane').evaluate(pane => {
    pane.querySelector('nav')!.insertAdjacentHTML('beforeend', '<span id="probe-wide" style="display: inline-block; width: 900px">Execute</span>');
    pane.querySelector('[data-testid="composer-footer"]')!.insertAdjacentHTML('beforeend', '<span id="probe-cut" style="display: block; width: 40px; overflow: hidden; white-space: nowrap">Claude Opus 5.5 (Default)</span><div id="probe-scroll" style="overflow-x: auto"><span style="display: inline-block; width: 2000px">Granular</span></div>');
  });
  const problems = (await canvasProblems(page)).join('\n');
  expect(problems).toMatch(/span "Execute" at \d+-\d+ outside/);
  expect(problems).toContain('span "Claude Opus 5.5 (Default)" cut to 40/');
  expect(problems).toMatch(/div "Granular" scrolls sideways/);
});

for (const mode of modes) {
  for (const scale of [100, 150, 200]) {
    test(`the whole ${mode.name}-plan setup canvas fits and stays readable with ${scale}% text`, async ({ page }) => {
      const writes = await routeSetup(page);
      await openSetup(page, mode, scale);
      for (const viewport of viewports) {
        await page.setViewportSize(viewport);
        await settle(page, viewport.width);
        if (scale === 200 && [390, 768, 1280].includes(viewport.width)) await capture(page, `planner-whole-canvas-${mode.name}-${viewport.width}-${scale}pct`);
        expect(await canvasProblems(page), `${viewport.width}px`).toEqual([]);
        await expectReadableCanvas(page, viewport.width);
        await expect(page.getByPlaceholder(/Describe the feature/)).toHaveValue(mode.typed);
      }
      expect(writes).toEqual([]);
    });
  }
}
