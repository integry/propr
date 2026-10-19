import { expect, test, type Locator, type Page } from '@playwright/test';
import { capture } from './planner-studio.fixture';
import { modes, openSetup, routeSetup, viewports } from './planner-setup.fixture';

// #3257: the full Context Scope header kept `≤490k tokens · ~1-2m scan` on one line beside the title, so at md
// widths the 35% right pane pushed the setup canvas sideways (833px of content at a 768px viewport, 906px at 880px).
const estimatePattern = /^≤\d+(\.\d+)?[kM] tokens · (<1m|~1-2m|~3-5m) scan$/;

// Every scroll container from the slider up to the document, any of which would let the canvas scroll sideways,
// plus every element of the scope block that reaches past the right pane.
const horizontalOverflow = (scope: Locator) => scope.evaluate(element => {
  const problems: string[] = [];
  for (let node: Element | null = element; node; node = node.parentElement) {
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
});

async function expectReadableScope(page: Page, width: number, level: number, typed: string) {
  const estimate = page.getByTestId('context-scope-estimate');
  const slider = page.getByRole('slider');
  const scope = width >= 768 ? page.getByTestId('setup-wizard-right-pane').locator(':scope > div').first() : page.getByTestId('setup-settings-group').locator(':scope > div', { has: slider });
  await scope.scrollIntoViewIfNeeded();
  expect(await horizontalOverflow(scope)).toEqual([]);
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

for (const mode of modes) {
  test(`the ${mode.name}-plan scope estimate stays inside the canvas at every width`, async ({ page }) => {
    const writes = await routeSetup(page);
    await openSetup(page, mode);
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
      await openSetup(page, mode, scale);
      for (const viewport of [viewports[1], viewports[2], viewports[3], viewports[4], viewports[5]]) {
        await page.setViewportSize(viewport);
        // No scroll container from the scope block up to the document may scroll sideways, enlarged text included;
        // planner-whole-canvas.pw.ts holds the rest of the canvas to the same rule.
        await expectReadableScope(page, viewport.width, mode.level, mode.typed);
        if (scale === 200 && viewport.width === 768) await capture(page, `planner-scope-estimate-${mode.name}-768-200pct`);
      }
      expect(writes).toEqual([]);
    });
  }
}
