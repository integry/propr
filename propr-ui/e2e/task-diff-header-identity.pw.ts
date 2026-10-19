import { expect, test, type Locator, type Page } from '@playwright/test';
import { ago, capture, fixture, selectedRun } from './task-list-desktop.fixture';

// The diff popup's header must name the file readably at phone width: the name and path get the header's
// width to themselves rather than a sliver beside the status, counts and close control.
interface Case { path: string; status: 'added' | 'modified' | 'deleted'; linesAdded: number; linesRemoved: number; label: string }
const deep = 'docs/validation/linux-web-mobile/black-box/2026/october/authenticated-runs/three-repository-access-acceptance-20261015.md';
const unbroken = `src/${'VeryLongGeneratedIdentifierWithoutAnyBreakOpportunity'.repeat(2)}.generated.ts`;
const cases: Case[] = [
  { path: deep, status: 'modified', linesAdded: 12, linesRemoved: 4, label: 'MODIFIED' },
  { path: 'README.md', status: 'added', linesAdded: 3, linesRemoved: 0, label: 'NEW' },
  { path: unbroken, status: 'deleted', linesAdded: 0, linesRemoved: 123456, label: 'DELETED' },
];
// Long enough, and wide enough, to scroll both ways.
const diffFor = (file: string) => [
  `--- a/${file}`, `+++ b/${file}`, '@@ -1,80 +1,80 @@',
  ...Array.from({ length: 80 }, (_, index) => `${index % 2 ? '+' : '-'}| row ${index + 1} | ${'wide acceptance evidence column '.repeat(6)}|`),
  '// END OF DIFF',
].join('\n');

async function open(page: Page, file: Case, platform?: 'linux') {
  await fixture(page, platform);
  await page.route(`**/api/task/${selectedRun}/file-changes`, route => route.fulfill({ json: { taskId: selectedRun, lastUpdated: ago(0.5),
    files: [{ path: file.path, linesAdded: file.linesAdded, linesRemoved: file.linesRemoved, status: file.status, diff: diffFor(file.path) }] } }));
  await page.goto(`/tasks/${selectedRun}`);
  await page.getByRole('button', { name: `View diff for ${file.path}` }).first().click();
  const name = file.path.split('/').pop()!;
  const dialog = page.getByRole('dialog', { name });
  await expect(dialog).toBeVisible();
  return { dialog, name };
}

const box = async (locator: Locator) => (await locator.boundingBox())!;
const overlaps = (a: { x: number; y: number; width: number; height: number }, b: typeof a) =>
  a.x < b.x + b.width - 0.5 && b.x < a.x + a.width - 0.5 && a.y < b.y + b.height - 0.5 && b.y < a.y + a.height - 0.5;
/** The rendered lines of a text block (one rect each), the widest line's width, and whether any text is clipped. */
const textLayout = (locator: Locator) => locator.evaluate(element => {
  const range = document.createRange();
  range.selectNodeContents(element);
  const byLine = new Map<number, DOMRect[]>();
  for (const rect of Array.from(range.getClientRects()).filter(rect => rect.width > 0)) {
    const key = Math.round(rect.top);
    byLine.set(key, [...(byLine.get(key) ?? []), rect]);
  }
  const lines = [...byLine.values()].map(rects => {
    const x = Math.min(...rects.map(rect => rect.left));
    const y = Math.min(...rects.map(rect => rect.top));
    return { x, y, width: Math.max(...rects.map(rect => rect.right)) - x, height: Math.max(...rects.map(rect => rect.bottom)) - y };
  });
  return { lines, widest: Math.max(...lines.map(line => line.width)), clipped: element.scrollWidth > element.clientWidth + 0.5 };
});

/**
 * Each rendered line's text for the name and path at phone width, beside what the browser itself renders for the same text in plain
 * blocks of the header's full usable width: the name beside a spacer the size of the close control's margin box, then the path cleared
 * below it. Only font and wrapping properties are copied to the reference, so the comparison holds whatever the font's metrics or
 * hinting, and a narrowed column, a squeezed name or a covering control all break the text differently from the reference.
 */
const phoneWrapping = (header: Locator) => header.evaluate(element => {
  const name = element.querySelector<HTMLElement>('[data-testid="diff-file-name"]')!;
  const path = element.querySelector<HTMLElement>('[data-testid="diff-file-path"]')!;
  const close = element.querySelector<HTMLElement>('button[aria-label="Close diff view"]')!;
  const lines = (block: HTMLElement) => {
    const text = block.firstChild as Text;
    const result: string[] = [];
    let top: number | undefined;
    for (let index = 0; index < text.length; index++) {
      const range = document.createRange();
      range.setStart(text, index);
      range.setEnd(text, index + 1);
      const rect = range.getBoundingClientRect();
      if (top === undefined || rect.top > top + rect.height / 2) { result.push(''); top = rect.top; }
      result[result.length - 1] += text.data[index];
    }
    return result;
  };
  const headerStyle = getComputedStyle(element);
  const usable = element.clientWidth - parseFloat(headerStyle.paddingLeft) - parseFloat(headerStyle.paddingRight);
  const reference = document.createElement('div');
  reference.style.cssText = `position: absolute; left: 0; top: 0; width: ${usable}px; visibility: hidden; display: flow-root`;
  const closeBox = close.getBoundingClientRect();
  const spacer = document.createElement('div');
  spacer.style.cssText = `float: right; width: ${closeBox.width}px; height: ${closeBox.height}px; margin: ${getComputedStyle(close).margin}`;
  const copy = (block: HTMLElement) => {
    const style = getComputedStyle(block);
    const plain = document.createElement('div');
    for (const property of ['font-family', 'font-size', 'font-weight', 'font-style', 'font-stretch', 'font-feature-settings', 'font-variation-settings',
      'font-kerning', 'font-optical-sizing', 'letter-spacing', 'word-spacing', 'line-height', 'text-rendering', 'text-transform', 'overflow-wrap',
      'word-break', 'white-space', 'hyphens']) plain.style.setProperty(property, style.getPropertyValue(property));
    plain.textContent = block.textContent;
    return plain;
  };
  const [plainName, plainPath] = [copy(name), copy(path)];
  plainPath.style.clear = 'right';
  reference.append(spacer, plainName, plainPath);
  element.parentElement!.append(reference);
  const result = { usable, nameWidth: name.getBoundingClientRect().width, pathWidth: path.getBoundingClientRect().width,
    name: lines(name), expectedName: lines(plainName), path: lines(path), expectedPath: lines(plainPath) };
  reference.remove();
  return result;
});

async function expectReadableHeader(page: Page, dialog: Locator, file: Case, name: string, options: { enlarged?: boolean; diffShare?: number } = {}) {
  const viewport = page.viewportSize()!;
  const header = dialog.getByTestId('diff-header');
  const title = dialog.getByTestId('diff-file-name');
  const path = dialog.getByTestId('diff-file-path');
  const status = dialog.getByText(file.label, { exact: true });
  const counts = dialog.getByTestId('diff-line-counts');
  const close = dialog.getByRole('button', { name: 'Close diff view' });
  const diff = dialog.locator('[tabindex="0"]');
  await expect(title).toHaveText(name);
  await expect(path).toHaveText(file.path);
  await expect(counts).toContainText(String(file.linesAdded));
  await expect(counts).toContainText(String(file.linesRemoved));
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);

  const headerBox = await box(header);
  const padding = await header.evaluate(element => parseFloat(getComputedStyle(element).paddingLeft) + parseFloat(getComputedStyle(element).paddingRight));
  const usable = headerBox.width - padding;
  const [statusBox, countsBox, closeBox, diffBox, dialogBox] = await Promise.all([status, counts, close, diff, dialog].map(box));
  const [titleText, pathText] = [await textLayout(title), await textLayout(path)];
  // Nothing in the header is drawn over anything else, line by line for the name and path, and the header ends where the diff begins.
  const parts = [
    ...titleText.lines.map((line, index) => [`name line ${index + 1}`, line] as const),
    ...pathText.lines.map((line, index) => [`path line ${index + 1}`, line] as const),
    ['status', statusBox] as const, ['counts', countsBox] as const, ['close', closeBox] as const,
  ];
  for (const [index, [label, part]] of parts.entries()) {
    expect(part.x, label).toBeGreaterThanOrEqual(headerBox.x);
    expect(part.x + part.width, label).toBeLessThanOrEqual(headerBox.x + headerBox.width + 0.5);
    for (const [otherLabel, other] of parts.slice(index + 1)) expect(overlaps(part, other), `${label} overlaps ${otherLabel}`).toBe(false);
    expect(overlaps(part, diffBox), `${label} overlaps the diff`).toBe(false);
  }
  expect(diffBox.y).toBeGreaterThanOrEqual(headerBox.y + headerBox.height - 0.5);
  // The whole name and path are on screen, never clipped to a glyph, and the close control is a full 44px target.
  expect(titleText.clipped).toBe(false);
  expect(pathText.clipped).toBe(false);
  expect(closeBox.width).toBeGreaterThanOrEqual(44);
  expect(closeBox.height).toBeGreaterThanOrEqual(44);
  await expect(close).toBeInViewport({ ratio: 1 });
  expect(await close.evaluate(element => {
    const rect = element.getBoundingClientRect();
    return element.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
  })).toBe(true);
  const titleBottom = Math.max(...titleText.lines.map(line => line.y + line.height));
  const pathTop = Math.min(...pathText.lines.map(line => line.y));
  const pathBottom = Math.max(...pathText.lines.map(line => line.y + line.height));
  expect(pathTop).toBeGreaterThanOrEqual(titleBottom - 0.5);
  if (viewport.width >= 640) {
    // A wider screen keeps the status beside the name and the counts and close control beyond both.
    const titleRight = Math.max(...titleText.lines.map(line => line.x + line.width));
    const pathRight = Math.max(...pathText.lines.map(line => line.x + line.width));
    expect(statusBox.x).toBeGreaterThanOrEqual(titleRight);
    expect(countsBox.x).toBeGreaterThanOrEqual(Math.max(statusBox.x + statusBox.width, pathRight));
    expect(closeBox.x).toBeGreaterThanOrEqual(countsBox.x + countsBox.width);
    // An ordinary desktop window fits the deep path and long name on a line each; only an unbroken name longer than that wraps.
    if (viewport.width >= 1280 && file.path === deep) expect([titleText.lines.length, pathText.lines.length]).toEqual([1, 1]);
  } else {
    // On a phone the name and path get the header's whole width (the defect left the name one glyph and the path a narrow column) and
    // wrap only where that width runs out, beside and then beneath the close control, and the status and counts follow below them.
    const wrapping = await phoneWrapping(header);
    expect(wrapping.usable).toBeCloseTo(usable, 0);
    expect(wrapping.nameWidth).toBeGreaterThanOrEqual(usable - 0.5);
    expect(wrapping.pathWidth).toBeGreaterThanOrEqual(usable - 0.5);
    expect(wrapping.name, 'name lines').toEqual(wrapping.expectedName);
    expect(wrapping.path, 'path lines').toEqual(wrapping.expectedPath);
    expect(wrapping.name.join('')).toBe(name);
    expect(wrapping.path.join('')).toBe(file.path);
    expect(statusBox.y).toBeGreaterThanOrEqual(pathBottom - 0.5);
    expect(countsBox.y).toBeGreaterThanOrEqual(pathBottom - 0.5);
    if (!options.enlarged) expect(Math.abs((statusBox.y + statusBox.height / 2) - (countsBox.y + countsBox.height / 2))).toBeLessThan(statusBox.height);
  }
  // The header leaves most of the popup to the diff itself; enlarged text on a phone needs more lines to name the file in full.
  expect(diffBox.height).toBeGreaterThanOrEqual(dialogBox.height * (options.diffShare ?? 0.55));
  return { usable, nameWidest: titleText.widest, nameLines: titleText.lines.length, pathWidest: pathText.widest, pathLines: pathText.lines.length, header: headerBox.height, diff: diffBox.height };
}

const viewports = [
  { width: 320, height: 640, label: '320' },
  { width: 390, height: 844, label: '390' },
  { width: 700, height: 600, label: 'narrow-desktop' },
  { width: 1390, height: 900, label: 'desktop' },
];
for (const mode of ['web', 'desktop'] as const) {
  for (const viewport of viewports) {
    for (const file of cases) {
      test(`${mode} ${viewport.label}: ${file.status} file header names ${file.path.length > 40 ? 'a long path' : file.path} readably`, async ({ page }) => {
        await page.setViewportSize(viewport);
        const { dialog, name } = await open(page, file, mode === 'desktop' ? 'linux' : undefined);
        const metrics = await expectReadableHeader(page, dialog, file, name);
        test.info().annotations.push({ type: 'metrics', description: JSON.stringify(metrics) });
        if (file === cases[0]) await capture(page, `diff-header-${mode}-${viewport.label}`);
      });
    }
  }
}

for (const [scale, diffShare] of [[1.25, 0.4], [1.5, 0.25]]) {
  test(`enlarged text x${scale} at 320px keeps the header readable`, async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 640 });
    await page.addInitScript(scale => {
      document.addEventListener('DOMContentLoaded', () => { document.documentElement.style.fontSize = `${16 * scale}px`; });
    }, scale);
    const { dialog, name } = await open(page, cases[0]);
    const metrics = await expectReadableHeader(page, dialog, cases[0], name, { enlarged: true, diffShare });
    test.info().annotations.push({ type: 'metrics', description: JSON.stringify(metrics) });
    if (scale === 1.5) await capture(page, 'diff-header-web-320-text-150');
  });
}

test('320px: the diff scrolls both ways under touch while the header and close stay readable', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  const { dialog, name } = await open(page, cases[0]);
  const diff = dialog.locator('[tabindex="0"]');
  const close = dialog.getByRole('button', { name: 'Close diff view' });
  await expect(close).toBeFocused();
  const position = () => diff.evaluate(element => ({ top: element.scrollTop, left: element.scrollLeft,
    bottom: element.scrollHeight - element.clientHeight, right: element.scrollWidth - element.clientWidth }));
  const start = await position();
  expect(start.bottom).toBeGreaterThan(0);
  expect(start.right).toBeGreaterThan(0);
  const diffBox = (await diff.boundingBox())!;
  const touch = await page.context().newCDPSession(page);
  const swipe = async (dx: number, dy: number) => {
    const from = { x: diffBox.x + diffBox.width / 2, y: diffBox.y + diffBox.height / 2 };
    const point = (step: number) => ({ touchPoints: [{ x: Math.round(from.x + dx * step / 10), y: Math.round(from.y + dy * step / 10) }] });
    await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', ...point(0) });
    for (let step = 1; step <= 10; step++) await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', ...point(step) });
    await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  };
  await swipe(0, -160);
  await expect.poll(async () => (await position()).top).toBeGreaterThan(100);
  await swipe(-100, 0);
  await expect.poll(async () => (await position()).left).toBeGreaterThan(50);
  expect(await page.evaluate(() => [window.scrollX, window.scrollY])).toEqual([0, 0]);
  await expectReadableHeader(page, dialog, cases[0], name);
  await capture(page, 'diff-header-web-320-scrolled');
  // Tab stays inside the popup; Escape, the close control and the backdrop each close it and restore the page.
  await page.keyboard.press('Tab');
  await expect(diff).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(close).toBeFocused();
  expect(await page.evaluate(() => document.body.style.overflow)).toBe('hidden');
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  expect(await page.evaluate(() => document.body.style.overflow)).toBe('');
  const file = page.getByRole('button', { name: `View diff for ${cases[0].path}` }).first();
  await file.click();
  await close.click();
  await expect(dialog).toHaveCount(0);
  await file.click();
  await page.mouse.click(2, 2);
  await expect(dialog).toHaveCount(0);
  expect(await page.locator('#root').evaluate(element => (element as HTMLElement).inert)).toBe(false);
});
