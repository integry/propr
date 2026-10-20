import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { it } from 'node:test';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { expect } from '@playwright/test';
import postcss from 'postcss';
import tailwind from 'tailwindcss';
import tailwindConfig from '../../../propr-ui/tailwind.config.js';

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = resolve(desktop, '../..');
const TITLEBAR = 44;
const CHROME_CONTAINERS = '#root, .desktop-app, .desktop-shell, .desktop-shell-content';

/** Rendered chrome edges: toolbar (when shown), drag strip, control group and every control. */
const measureChrome = page => page.evaluate(containers => {
  const edges = element => {
    if (!element || !element.getClientRects().length) return null;
    const { top, bottom, left, right } = element.getBoundingClientRect();
    return { top, bottom, left, right };
  };
  return {
    toolbar: edges(document.querySelector('header[aria-label="Application toolbar"]')),
    drag: edges(document.querySelector('.desktop-connected-drag-region')),
    controls: edges(document.querySelector('.desktop-window-controls')),
    buttons: [...document.querySelectorAll('.desktop-window-controls button')].map(edges),
    scrolled: [document.scrollingElement, ...document.querySelectorAll(containers)].map(element => element.scrollTop),
    width: innerWidth,
  };
}, CHROME_CONTAINERS);

const expectFlush = (chrome, label) => {
  const rows = { drag: chrome.drag, controls: chrome.controls, ...(chrome.toolbar ? { toolbar: chrome.toolbar } : {}) };
  chrome.buttons.forEach((button, index) => { rows[`control ${index}`] = button; });
  for (const [name, box] of Object.entries(rows)) {
    expect(box, `${label}: ${name} rendered`).not.toBeNull();
    expect({ name, top: box.top, bottom: box.bottom }, label).toEqual({ name, top: 0, bottom: TITLEBAR });
  }
  expect(chrome.controls.right, label).toBe(chrome.width);
  expect(chrome.scrolled.every(value => value === 0), `${label}: no chrome container scrolled ${chrome.scrolled}`).toBe(true);
};

/**
 * Ways content can scroll the chrome containers, each from an unscrolled
 * layout. On the published build a `100vh` app inside the frame-inset root let
 * scrollIntoView of the content's end (or any programmatic scroll) move the
 * toolbar and drag strip to y -3 while the fixed controls stayed at 0.
 */
const SCROLL_TRIGGERS = ['focus', 'scrollIntoView', 'programmatic'];

const triggerScroll = (page, trigger) => page.evaluate(({ trigger, containers }) => {
  const scrollers = [document.scrollingElement, ...document.querySelectorAll(containers)];
  for (const element of scrollers) element.scrollTop = 0;
  if (trigger === 'focus') [...document.querySelectorAll('.desktop-sidebar :is(a, button)')].at(-1)?.focus();
  if (trigger === 'scrollIntoView') document.querySelector('main').scrollIntoView({ block: 'end' });
  if (trigger === 'programmatic') {
    for (const element of scrollers) element.scrollTop = 50;
    window.scrollTo(0, 50);
  }
}, { trigger, containers: CHROME_CONTAINERS });

/**
 * The Linux frame allowance makes #root three pixels shorter than the viewport.
 * Restored/maximized and focused/unfocused windows at the supported sizes and
 * at 200% zoom must keep toolbar, drag strip and controls on the same edges.
 */
const expectAlignedChrome = async (page, capture) => {
  const cdp = await page.context().newCDPSession(page);
  const sizes = [[880, 620, 1], [1280, 820, 1], [1390, 820, 1], [880, 620, 2], [1280, 820, 2], [1390, 820, 2]];
  for (const [width, height, zoom] of sizes) {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: width / zoom, height: height / zoom, deviceScaleFactor: zoom, mobile: false });
    for (const expanded of ['false', 'true']) {
      for (const focused of ['true', 'false']) {
        await page.evaluate(state => Object.assign(document.documentElement.dataset, state), { windowExpanded: expanded, windowFocused: focused });
        const label = `${width}x${height} @${zoom * 100}% ${expanded === 'true' ? 'maximized' : 'restored'} ${focused === 'true' ? 'focused' : 'unfocused'}`;
        expectFlush(await measureChrome(page), label);
        for (const trigger of SCROLL_TRIGGERS) {
          await triggerScroll(page, trigger);
          expectFlush(await measureChrome(page), `${label} after ${trigger} scroll trigger`);
        }
      }
    }
    if ((zoom === 1 && width === 1280) || (zoom === 2 && width === 880)) {
      await page.evaluate(() => Object.assign(document.documentElement.dataset, { windowExpanded: 'false', windowFocused: 'true' }));
      // Let the sidebar finish sliding into (or out of) its drawer first.
      await page.waitForFunction(() => document.getAnimations().length === 0);
      // Playwright's own screenshot resets the CDP zoom emulation; capture through CDP.
      const window = async () => Buffer.from((await cdp.send('Page.captureScreenshot', { format: 'png' })).data, 'base64');
      await capture(`chrome-aligned-${width}-${zoom * 100}`, window, `Linux ${width}×${height} at ${zoom * 100}% zoom, restored: toolbar/drag strip and window controls share their upper and lower edges`);
    }
  }
  await cdp.send('Emulation.clearDeviceMetricsOverride');
  await page.evaluate(() => Object.assign(document.documentElement.dataset, { windowExpanded: 'false', windowFocused: 'true' }));
};

/** Narrow Search targets, each hit-tested at its centre; the window controls must keep their own points. */
const measureSearchSheet = page => page.evaluate(() => {
  const box = element => {
    if (!element || !element.getClientRects().length) return null;
    const { left, right, top, bottom } = element.getBoundingClientRect();
    return { left, right, top, bottom };
  };
  const hit = element => {
    const rect = element?.getBoundingClientRect();
    if (!rect?.width) return null;
    const found = document.elementFromPoint((rect.left + rect.right) / 2, (rect.top + rect.bottom) / 2);
    return element.contains(found) ? true : `${found?.tagName}[aria-label="${found?.closest('[aria-label]')?.getAttribute('aria-label')}"]`;
  };
  const sheet = document.querySelector('[role="dialog"][aria-label="Search"]');
  const input = sheet?.querySelector('input[aria-label="Search"]');
  const clear = sheet?.querySelector('[aria-label="Clear search"]');
  const close = sheet?.querySelector('[aria-label="Close search"]');
  const palette = document.querySelector('[data-testid="global-search-palette"]');
  const controls = [...document.querySelectorAll('.desktop-window-controls button')];
  return {
    sheet: box(sheet), row: box(close?.parentElement), root: box(document.getElementById('root')),
    palette: box(palette),
    // However many results: force more height than any window has and let max-height clamp it.
    tallestPalette: palette && (() => {
      palette.style.height = '10000px';
      const tallest = box(palette);
      palette.style.height = '';
      return tallest;
    })(), input: box(input), clear: box(clear), close: box(close),
    hits: { input: hit(input), clear: clear ? hit(clear) : 'absent', close: hit(close) },
    controls: box(document.querySelector('.desktop-window-controls')),
    controlHits: controls.map(control => [control.getAttribute('aria-label'), hit(control)]),
    inputRegion: input && (getComputedStyle(input).getPropertyValue('-webkit-app-region') || 'none'),
    controlsId: input?.getAttribute('aria-controls'),
    otherIds: [...document.querySelectorAll('input[aria-label="Search"]')].filter(other => other !== input).map(other => other.getAttribute('aria-controls')),
    width: innerWidth, height: innerHeight,
  };
});

/**
 * Search / Go To… and Ctrl/Cmd+K below `md` (the reported 207% zoom of an
 * 880x620 window, and a narrow 320px one) open the Search sheet. On Linux the
 * whole sheet row sits below the native window-control row: every target takes
 * its own pointer events and the native controls keep theirs. macOS (no
 * renderer window controls) keeps the sheet flush with the top edge.
 */
const expectNarrowSearch = async (page, click, capture, platform) => {
  const cdp = await page.context().newCDPSession(page);
  const shortcut = platform === 'darwin' ? 'Meta+k' : 'Control+k';
  const sheet = page.getByRole('dialog', { name: 'Search' });
  const input = sheet.getByRole('combobox', { name: 'Search', exact: true });
  const opener = () => page.evaluate(() => { window.__searchOpener = document.activeElement; });
  const openerFocused = () => page.evaluate(() => document.activeElement === window.__searchOpener && document.activeElement !== document.body);
  const centre = async locator => { const { x, y, width, height } = await locator.boundingBox(); return [x + width / 2, y + height / 2]; };
  for (const [width, height, scale] of [[406, 286, 2.1708], [320, 568, 2]]) {
    const label = `${platform} ${width}x${height} @${scale}`;
    await page.setViewportSize({ width, height });
    await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile: false });
    await expect(page.locator('header[aria-label="Application toolbar"]')).toBeHidden();
    // A focusable, visible opener in the collapsed layout, to return focus to.
    await page.locator('main').evaluate(main => { main.tabIndex = -1; main.focus(); });
    await opener();
    await click('Search / Go To…');
    await expect(sheet).toHaveCount(1);
    await expect(input).toBeFocused();
    // A repeated request keeps one sheet and the field focused.
    await click('Search / Go To…');
    await expect(sheet).toHaveCount(1);
    await expect(input).toBeFocused();
    await page.keyboard.type('Stop work');
    await expect(sheet.getByRole('button', { name: 'Clear search' })).toBeVisible();
    await page.waitForFunction(() => document.getAnimations().length === 0);
    const layout = await measureSearchSheet(page);
    expect(layout.hits, label).toEqual({ input: true, clear: true, close: true });
    expect(layout.inputRegion, label).not.toBe('drag');
    for (const target of ['row', 'input', 'clear', 'close']) {
      expect(layout[target], `${label}: ${target}`).not.toBeNull();
      expect(layout[target].left, `${label}: ${target} left`).toBeGreaterThanOrEqual(0);
      expect(layout[target].right, `${label}: ${target} right`).toBeLessThanOrEqual(layout.width);
      if (platform === 'linux') expect(layout[target].top, `${label}: ${target} below window controls`).toBeGreaterThanOrEqual(layout.controls.bottom);
    }
    if (platform === 'linux') {
      expect(layout.sheet.top, label).toBe(TITLEBAR);
      expect(layout.controls, label).toMatchObject({ top: 0, bottom: TITLEBAR, right: layout.width });
      expect(layout.controlHits, label).toEqual([
        ['Application menu', true], ['Minimize window', true], ['Maximize or restore window', true], ['Close window', true],
      ]);
    } else {
      expect(layout.controls, label).toBeNull();
      expect(layout.sheet.top, `${label}: no Linux frame gap`).toBe(0);
    }
    // The results palette hangs below the field and, however many results, stays inside the window.
    expect(layout.palette, label).not.toBeNull();
    expect(layout.palette.top, label).toBeGreaterThanOrEqual(layout.input.bottom);
    expect(layout.tallestPalette.bottom, `${label}: palette max height`).toBeLessThanOrEqual(layout.root.bottom);
    expect(layout.otherIds.length, label).toBeGreaterThan(0);
    expect(layout.otherIds, `${label}: per-instance listbox ids`).not.toContain(layout.controlsId);
    if (width === 406) {
      const window = async () => Buffer.from((await cdp.send('Page.captureScreenshot', { format: 'png' })).data, 'base64');
      await capture(`search-narrow-${width}`, window, `${platform === 'linux' ? 'Linux' : 'macOS'} ${width}×${height} at ${Math.round(scale * 100)}%: Search sheet ${platform === 'linux' ? 'below the window controls' : 'at the top edge'}`);
    }
    // Real pointer presses at each target's centre.
    await page.mouse.click(...await centre(sheet.getByRole('button', { name: 'Clear search' })));
    await expect(input).toHaveValue('');
    await expect(sheet).toHaveCount(1);
    await page.mouse.click(...await centre(input));
    await expect(input).toBeFocused();
    await page.keyboard.type('Stop');
    await page.mouse.click(...await centre(sheet.getByRole('button', { name: 'Close search' })));
    await expect(sheet).toHaveCount(0);
    expect(await openerFocused(), `${label}: focus restored after Close search`).toBe(true);
    // Ctrl/Cmd+K, then Escape.
    await page.keyboard.press(shortcut);
    await expect(input).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(sheet).toHaveCount(0);
    expect(await openerFocused(), `${label}: focus restored after Escape`).toBe(true);
    // One backdrop press, with a query typed, closes the sheet.
    await click('Search / Go To…');
    await expect(input).toBeFocused();
    await page.keyboard.type('Stop work');
    await expect(page.getByTestId('global-search-backdrop')).toBeVisible();
    await page.mouse.click(width - 4, height - 8);
    await expect(sheet).toHaveCount(0);
    expect(await openerFocused(), `${label}: focus restored after backdrop press`).toBe(true);
    await page.locator('main').evaluate(main => main.removeAttribute('tabindex'));
  }
  await expectShortSearchResults(page, cdp, click, capture, platform);
  await cdp.send('Emulation.clearDeviceMetricsOverride');
  await page.setViewportSize({ width: 1280, height: 820 });
  await cdp.detach();
};

/** Five ordinary short task results, served only to the search reads. */
const SEARCH_TASKS = ['Fix login redirect', 'Update docs', 'Stop work on cache', 'Tidy logs', 'Bump deps']
  .map((title, index) => ({ id: `short-${index + 1}`, title, repository: 'integry/propr', status: 'completed', createdAt: '2026-10-19T12:00:00.000Z' }));
const serveSearchResults = async (page, tasks = SEARCH_TASKS) => {
  const search = url => ['/api/tasks', '/api/planner/drafts', '/api/instance/catalog'].includes(url.pathname);
  const handler = route => {
    const { pathname } = new URL(route.request().url());
    route.fulfill({ json: pathname === '/api/tasks' ? { tasks, total: tasks.length } : pathname === '/api/planner/drafts' ? { drafts: [] } : { repositories: [] } });
  };
  await page.route(search, handler);
  return () => page.unroute(search, handler);
};

/** The selected result's title line, the list around it, the footer action and every Search/window target. */
const measureSelectedResult = page => page.evaluate(() => {
  const box = element => {
    if (!element || !element.getClientRects().length) return null;
    const { left, right, top, bottom } = element.getBoundingClientRect();
    return { left, right, top, bottom };
  };
  const hit = element => {
    const rect = element?.getBoundingClientRect();
    if (!rect?.width) return null;
    const found = document.elementFromPoint((rect.left + rect.right) / 2, (rect.top + rect.bottom) / 2);
    return element.contains(found) ? true : `${found?.tagName}[aria-label="${found?.closest('[aria-label]')?.getAttribute('aria-label')}"]`;
  };
  const sheet = document.querySelector('[role="dialog"][aria-label="Search"]');
  const palette = document.querySelector('[data-testid="global-search-palette"]');
  const list = palette?.querySelector('[role="listbox"]')?.parentElement;
  const options = [...(palette?.querySelectorAll('li[role="option"]') ?? [])];
  const selected = options.find(option => option.getAttribute('aria-selected') === 'true');
  const title = selected?.querySelector('span.block.break-words');
  const lineHeight = title && parseFloat(getComputedStyle(title).lineHeight);
  const action = [...(palette?.querySelectorAll('button') ?? [])].find(button => button.textContent.startsWith('Search all tasks'));
  // The title's rendered line boxes, and how many of them sit wholly inside the list scrollport.
  const range = title && document.createRange();
  range?.selectNodeContents(title);
  const lines = range ? [...range.getClientRects()].map(({ top, bottom }) => ({ top, bottom })) : [];
  const listRect = list?.getBoundingClientRect();
  const completeLines = listRect ? lines.filter(line => line.top >= listRect.top && line.bottom <= listRect.bottom).length : 0;
  return {
    options: options.length, selectedIndex: options.indexOf(selected),
    title: box(title), lineHeight, lines: lines.length, completeLines,
    list: box(list), scrolled: list?.scrollTop, palette: box(palette), root: box(document.getElementById('root')),
    hints: palette?.textContent.includes('navigate'),
    hits: {
      input: hit(sheet?.querySelector('input[aria-label="Search"]')), clear: hit(sheet?.querySelector('[aria-label="Clear search"]')),
      close: hit(sheet?.querySelector('[aria-label="Close search"]')), action: hit(action),
    },
    controlHits: [...document.querySelectorAll('.desktop-window-controls button')].map(control => [control.getAttribute('aria-label'), hit(control)]),
  };
});

/**
 * A short supported window (880x480 at about 207% zoom, and the reported 880x620)
 * with real results: arrowing to the last one keeps at least one complete line of
 * its title inside the list, and the footer action, Search targets and native
 * controls keep their pointer targets. Enter opens the selected task.
 */
const expectShortSearchResults = async (page, cdp, click, capture, platform) => {
  const sheet = page.getByRole('dialog', { name: 'Search' });
  const stopServing = await serveSearchResults(page);
  try {
    for (const [width, height, scale] of [[406, 221, 2.1708], [406, 286, 2.1708]]) {
      const label = `${platform} ${width}x${height} @${scale} results`;
      await page.setViewportSize({ width, height });
      await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile: false });
      await click('Search / Go To…');
      await expect(sheet.getByRole('combobox', { name: 'Search', exact: true })).toBeFocused();
      await page.keyboard.type('short task');
      await expect(sheet.getByRole('option')).toHaveCount(SEARCH_TASKS.length);
      for (let step = 1; step < SEARCH_TASKS.length; step += 1) await page.keyboard.press('ArrowDown');
      await expect(sheet.getByRole('option', { selected: true })).toContainText('Bump deps');
      // Settled keyboard scrolling: the list's scroll offset stops changing.
      await expect.poll(async () => {
        const first = await page.evaluate(() => document.querySelector('[data-testid="global-search-palette"] [role="listbox"]').parentElement.scrollTop);
        await page.evaluate(() => new Promise(requestAnimationFrame));
        return first === await page.evaluate(() => document.querySelector('[data-testid="global-search-palette"] [role="listbox"]').parentElement.scrollTop);
      }).toBe(true);
      const result = await measureSelectedResult(page);
      expect(result.selectedIndex, label).toBe(SEARCH_TASKS.length - 1);
      expect(result.lineHeight, label).toBeGreaterThan(0);
      // At least one complete title line inside the list scrollport.
      const visibleTitle = Math.min(result.title.bottom, result.list.bottom) - Math.max(result.title.top, result.list.top);
      expect(result.title.top, `${label}: title top inside list`).toBeGreaterThanOrEqual(result.list.top);
      expect(visibleTitle, `${label}: visible title line ${JSON.stringify(result)}`).toBeGreaterThanOrEqual(result.lineHeight);
      expect(result.palette.bottom, `${label}: palette inside window`).toBeLessThanOrEqual(result.root.bottom);
      expect(result.hits, label).toEqual({ input: true, clear: true, close: true, action: true });
      if (platform === 'linux') {
        expect(result.controlHits, label).toEqual([
          ['Application menu', true], ['Minimize window', true], ['Maximize or restore window', true], ['Close window', true],
        ]);
      }
      // Only the short Linux frame (sheet below the window controls) gives up the keyboard hints.
      expect(result.hints, label).toBe(height !== 221 || platform !== 'linux');
      if (height === 221 && platform === 'linux') {
        const window = async () => Buffer.from((await cdp.send('Page.captureScreenshot', { format: 'png' })).data, 'base64');
        await capture(`search-short-results-${width}x${height}`, window, `Linux ${width}×${height} at ${Math.round(scale * 100)}%: last search result selected with its title fully visible`);
      }
      // ArrowUp back to the first result keeps its title in the list too.
      for (let step = 1; step < SEARCH_TASKS.length; step += 1) await page.keyboard.press('ArrowUp');
      await expect(sheet.getByRole('option', { selected: true })).toContainText('Fix login redirect');
      const first = await measureSelectedResult(page);
      expect(Math.min(first.title.bottom, first.list.bottom) - Math.max(first.title.top, first.list.top), `${label}: first title`).toBeGreaterThanOrEqual(first.lineHeight);
      if (height === 221) {
        await page.keyboard.press('ArrowUp');
        await expect(sheet.getByRole('option', { selected: true })).toContainText('Bump deps');
        await page.keyboard.press('Enter');
        await expect(sheet).toHaveCount(0);
        await expect(page).toHaveURL(/#\/tasks\/short-5$/);
        await page.goBack();
        await expect(page).not.toHaveURL(/#\/tasks\/short-5$/);
      } else {
        await page.keyboard.press('Escape');
        await expect(sheet).toHaveCount(0);
      }
    }
  } finally {
    await stopServing();
  }
  await expectShortWrappedTitle(page, cdp, click, capture, platform);
  await expectSearchResize(page, cdp, click, capture, platform);
  await expectShortNoResults(page, cdp, click, capture, platform);
};

/**
 * A task whose title wraps to more lines than the short window's list can show on
 * every frame: the macOS sheet has no window-control row above it, so its list is
 * taller (about 69px, 3 lines) than Linux's. The title stays within GitHub's
 * 256-character issue title limit, so a real task can carry it.
 */
const WRAPPED_TITLE = 'Investigate why the nightly desktop acceptance run reports stale profile journals after a restore drill, the cache warm-up step retries three times, and the follow-up Search index rebuild leaves archived tasks visible until the next manual refresh';
const WRAPPED_TASKS = [
  SEARCH_TASKS[0],
  { ...SEARCH_TASKS[1], id: 'wrapped-2', title: WRAPPED_TITLE },
  SEARCH_TASKS[4],
];

/**
 * The short 406x221 window with a wrapped selected title taller than the list:
 * arrowing onto it from either side leaves at least one of its rendered lines
 * wholly inside the list scrollport.
 */
const expectShortWrappedTitle = async (page, cdp, click, capture, platform) => {
  const sheet = page.getByRole('dialog', { name: 'Search' });
  const [width, height, scale] = [406, 221, 2.1708];
  const label = `${platform} ${width}x${height} @${scale} wrapped title`;
  const stopServing = await serveSearchResults(page, WRAPPED_TASKS);
  try {
    await page.setViewportSize({ width, height });
    await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile: false });
    await click('Search / Go To…');
    await expect(sheet.getByRole('combobox', { name: 'Search', exact: true })).toBeFocused();
    await page.keyboard.type('wrapped task');
    await expect(sheet.getByRole('option')).toHaveCount(WRAPPED_TASKS.length);
    const settledSelection = async (text, from) => {
      await expect(sheet.getByRole('option', { selected: true })).toContainText(text);
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const result = await measureSelectedResult(page);
      expect(result.hits, `${label} ${from}`).toEqual({ input: true, clear: true, close: true, action: true });
      return result;
    };
    // Down onto the wrapped title, then down past it and back up onto it.
    await page.keyboard.press('ArrowDown');
    const down = await settledSelection('Investigate why', 'from above');
    // The title really is taller than the list: several lines, more than the scrollport holds.
    expect(down.lines, `${label}: wrapped ${JSON.stringify(down)}`).toBeGreaterThanOrEqual(2);
    expect(down.title.bottom - down.title.top, `${label}: taller than list ${JSON.stringify(down)}`).toBeGreaterThan(down.list.bottom - down.list.top);
    expect(down.completeLines, `${label} from above: complete line ${JSON.stringify(down)}`).toBeGreaterThanOrEqual(1);
    expect(down.title.top, `${label} from above: first line shown`).toBeGreaterThanOrEqual(down.list.top);
    if (platform === 'linux') {
      const window = async () => Buffer.from((await cdp.send('Page.captureScreenshot', { format: 'png' })).data, 'base64');
      await capture(`search-short-wrapped-title-${width}x${height}`, window, `Linux ${width}×${height} at ${Math.round(scale * 100)}%: a wrapped selected title shows complete lines inside the list`);
    }
    await page.keyboard.press('ArrowDown');
    await settledSelection('Bump deps', 'next');
    await page.keyboard.press('ArrowUp');
    const up = await settledSelection('Investigate why', 'from below');
    expect(up.completeLines, `${label} from below: complete line ${JSON.stringify(up)}`).toBeGreaterThanOrEqual(1);
    if (platform === 'linux') {
      expect(up.controlHits, label).toEqual([
        ['Application menu', true], ['Minimize window', true], ['Maximize or restore window', true], ['Close window', true],
      ]);
    }
    expect(up.palette.bottom, `${label}: palette inside window`).toBeLessThanOrEqual(up.root.bottom);
    await page.keyboard.press('Escape');
    await expect(sheet).toHaveCount(0);
  } finally {
    await stopServing();
  }
};

/**
 * Resizing (or zooming) the window with Search open and the last result selected:
 * the selection does not change, yet its title comes back into the resized list.
 * Shrinking the reported 880x620 window at about 207% to 880x480 (CSS 406x286 to
 * 406x221) once left the list scrolled for the taller window, the title wholly below it.
 */
const expectSearchResize = async (page, cdp, click, capture, platform) => {
  const sheet = page.getByRole('dialog', { name: 'Search' });
  const input = sheet.getByRole('combobox', { name: 'Search', exact: true });
  const palette = page.getByTestId('global-search-palette');
  const scale = 2.1708;
  const resize = async (width, height) => {
    await page.setViewportSize({ width, height });
    await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile: false });
    // The palette's anchor has followed the new size (only the short Linux frame drops the key hints) ...
    if (height === 221 && platform === 'linux') await expect(palette).not.toContainText('navigate');
    else await expect(palette).toContainText('navigate');
    // ... then two frames for the list to settle; no polling until the title turns up.
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  };
  const expectSelectedTitle = async (text, index, label) => {
    await expect(sheet.getByRole('option', { selected: true })).toContainText(text);
    const result = await measureSelectedResult(page);
    const selectedId = await sheet.getByRole('option', { selected: true }).getAttribute('id');
    expect(await input.getAttribute('aria-activedescendant'), `${label}: active option`).toBe(selectedId);
    expect(result.selectedIndex, label).toBe(index);
    const visibleTitle = Math.min(result.title.bottom, result.list.bottom) - Math.max(result.title.top, result.list.top);
    expect(result.title.top, `${label}: title top inside list ${JSON.stringify(result)}`).toBeGreaterThanOrEqual(result.list.top);
    expect(visibleTitle, `${label}: visible title line ${JSON.stringify(result)}`).toBeGreaterThanOrEqual(result.lineHeight);
    expect(result.palette.bottom, `${label}: palette inside window`).toBeLessThanOrEqual(result.root.bottom);
    expect(result.hits, label).toEqual({ input: true, clear: true, close: true, action: true });
    if (platform === 'linux') {
      expect(result.controlHits, label).toEqual([
        ['Application menu', true], ['Minimize window', true], ['Maximize or restore window', true], ['Close window', true],
      ]);
    }
    return result;
  };
  const stopServing = await serveSearchResults(page);
  try {
    await page.setViewportSize({ width: 406, height: 286 });
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 406, height: 286, deviceScaleFactor: scale, mobile: false });
    await click('Search / Go To…');
    await expect(input).toBeFocused();
    await page.keyboard.type('short task');
    await expect(sheet.getByRole('option')).toHaveCount(SEARCH_TASKS.length);
    for (let step = 1; step < SEARCH_TASKS.length; step += 1) await page.keyboard.press('ArrowDown');
    const last = SEARCH_TASKS.length - 1;
    await resize(406, 286);
    const tall = await expectSelectedTitle('Bump deps', last, `${platform} 406x286 before resize`);
    expect(tall.scrolled, `${platform}: the taller list was scrolled to the last result`).toBeGreaterThan(0);
    // Shrink with Search open and the selection unchanged.
    await resize(406, 221);
    await expectSelectedTitle('Bump deps', last, `${platform} 406x286 -> 406x221`);
    if (platform === 'linux') {
      const window = async () => Buffer.from((await cdp.send('Page.captureScreenshot', { format: 'png' })).data, 'base64');
      await capture('search-resized-short-results-406x221', window, 'Linux 406×286 resized to 406×221 at 217% with Search open: the selected last result keeps its title in view');
    }
    // Grow back, then the keyboard still walks the list from the kept selection.
    await resize(406, 286);
    await expectSelectedTitle('Bump deps', last, `${platform} 406x221 -> 406x286`);
    await page.keyboard.press('ArrowUp');
    await expectSelectedTitle('Tidy logs', last - 1, `${platform} 406x286 ArrowUp after resize`);
    await resize(406, 221);
    await expectSelectedTitle('Tidy logs', last - 1, `${platform} 406x286 -> 406x221 again`);
    await page.keyboard.press('Escape');
    await expect(sheet).toHaveCount(0);
  } finally {
    await stopServing();
  }
};

/** The empty state's message, its Search all tasks action and every Search/window target. */
const measureNoResults = page => page.evaluate(() => {
  const box = element => {
    if (!element || !element.getClientRects().length) return null;
    const { left, right, top, bottom } = element.getBoundingClientRect();
    return { left, right, top, bottom };
  };
  const hit = (element, x, y) => {
    const found = document.elementFromPoint(x, y);
    return element.contains(found) ? true : `${found?.tagName}[aria-label="${found?.closest('[aria-label]')?.getAttribute('aria-label')}"]:${found?.textContent?.slice(0, 40)}`;
  };
  const centreHit = element => {
    const rect = element?.getBoundingClientRect();
    if (!rect?.width) return null;
    return hit(element, (rect.left + rect.right) / 2, (rect.top + rect.bottom) / 2);
  };
  const sheet = document.querySelector('[role="dialog"][aria-label="Search"]');
  const palette = document.querySelector('[data-testid="global-search-palette"]');
  const message = [...(palette?.querySelectorAll('p') ?? [])].find(p => p.textContent.startsWith('No results found'));
  const action = [...(palette?.querySelectorAll('button') ?? [])].find(button => button.textContent === 'Search all tasks');
  const rect = action?.getBoundingClientRect();
  // Points just inside each corner of the action: the whole label takes the pointer, not only its centre.
  const corners = rect && [[rect.left + 1, rect.top + 1], [rect.right - 1, rect.top + 1], [rect.left + 1, rect.bottom - 1], [rect.right - 1, rect.bottom - 1]]
    .map(([x, y]) => hit(action, x, y));
  return {
    palette: box(palette), message: box(message), action: box(action), root: box(document.getElementById('root')),
    paletteClips: palette && getComputedStyle(palette).overflow,
    hits: {
      input: centreHit(sheet?.querySelector('input[aria-label="Search"]')), clear: centreHit(sheet?.querySelector('[aria-label="Clear search"]')),
      close: centreHit(sheet?.querySelector('[aria-label="Close search"]')), action: centreHit(action),
    },
    corners,
    controlHits: [...document.querySelectorAll('.desktop-window-controls button')].map(control => [control.getAttribute('aria-label'), centreHit(control)]),
  };
});

/**
 * A query with no results in the short supported window (880x480 at about 207%
 * zoom) and the reported 880x620 one: the whole Search all tasks action stays
 * inside the clipped palette and takes real pointer presses, with a short and a
 * wrapped query message. The Search targets and native controls keep theirs.
 */
const expectShortNoResults = async (page, cdp, click, capture, platform) => {
  const sheet = page.getByRole('dialog', { name: 'Search' });
  const input = sheet.getByRole('combobox', { name: 'Search', exact: true });
  const stopServing = await serveSearchResults(page, []);
  const queries = ['zzq', 'no task anywhere matches this deliberately long query about stale journals and restores'];
  try {
    for (const [width, height, scale] of [[406, 221, 2.1708], [406, 286, 2.1708]]) {
      for (const query of queries) {
        const label = `${platform} ${width}x${height} @${scale} no results "${query.slice(0, 12)}"`;
        await page.setViewportSize({ width, height });
        await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile: false });
        await click('Search / Go To…');
        await expect(input).toBeFocused();
        await page.keyboard.type(query);
        const action = sheet.getByRole('button', { name: 'Search all tasks', exact: true });
        await expect(sheet.getByText(`No results found for "${query}"`)).toBeAttached();
        await expect(action).toBeVisible();
        await page.waitForFunction(() => document.getAnimations().length === 0);
        const result = await measureNoResults(page);
        const detail = `${label} ${JSON.stringify(result)}`;
        expect(result.paletteClips, label).toBe('hidden');
        // Fully inside the palette that clips it, and inside the window.
        expect(result.action.top, `${detail}: action top`).toBeGreaterThanOrEqual(result.palette.top);
        expect(result.action.bottom, `${detail}: action bottom`).toBeLessThanOrEqual(result.palette.bottom);
        expect(result.action.left, `${detail}: action left`).toBeGreaterThanOrEqual(result.palette.left);
        expect(result.action.right, `${detail}: action right`).toBeLessThanOrEqual(result.palette.right);
        expect(result.action.bottom - result.action.top, `${detail}: action height`).toBeGreaterThan(0);
        expect(result.palette.bottom, `${detail}: palette inside window`).toBeLessThanOrEqual(result.root.bottom);
        // The message sits above the action rather than under it.
        expect(result.message.top, `${detail}: message`).toBeGreaterThanOrEqual(result.palette.top);
        expect(Math.min(result.message.bottom, result.palette.bottom), `${detail}: message above action`).toBeLessThanOrEqual(result.action.top);
        expect(result.hits, detail).toEqual({ input: true, clear: true, close: true, action: true });
        expect(result.corners, detail).toEqual([true, true, true, true]);
        if (platform === 'linux') {
          expect(result.controlHits, label).toEqual([
            ['Application menu', true], ['Minimize window', true], ['Maximize or restore window', true], ['Close window', true],
          ]);
        }
        if (height === 221 && platform === 'linux' && query === queries[1]) {
          const window = async () => Buffer.from((await cdp.send('Page.captureScreenshot', { format: 'png' })).data, 'base64');
          await capture(`search-short-no-results-${width}x${height}`, window, `Linux ${width}×${height} at ${Math.round(scale * 100)}%: no results for a long query, with Search all tasks fully visible`);
        }
        // A real pointer press on the action opens the full task search for the query.
        const { x, y, width: actionWidth, height: actionHeight } = await action.boundingBox();
        await page.mouse.click(x + actionWidth / 2, y + actionHeight / 2);
        await expect(sheet).toHaveCount(0);
        await expect.poll(() => new URL(page.url()).hash, label).toBe(`#/tasks?search=${encodeURIComponent(query)}`);
        await page.goBack();
        await expect(page).not.toHaveURL(/#\/tasks\?search=/);
      }
    }
  } finally {
    await stopServing();
  }
};

/** Every File creation entry opens its existing form and never submits, creates or enables anything. */
const expectCreationForms = async (page, click, capture, mutations) => {
  await click('New Goal');
  const goal = page.getByRole('dialog', { name: 'Start a goal' });
  await expect(goal).toBeVisible();
  await expect(page).toHaveURL(/#\/goals$/);
  await goal.getByRole('textbox', { name: 'Prompt', exact: true }).fill('Draft objective that must not start');
  await capture('new-goal', goal, 'File → New Goal opens the goal creation dialog');
  // Cancelling a typed draft asks first; declining keeps it, accepting closes it.
  page.once('dialog', dialog => dialog.dismiss());
  await page.keyboard.press('Escape');
  await expect(goal.getByRole('textbox', { name: 'Prompt', exact: true })).toHaveValue('Draft objective that must not start');
  page.once('dialog', dialog => dialog.accept());
  await page.keyboard.press('Escape');
  await expect(goal).toHaveCount(0);
  await click('New Automation');
  await expect(page).toHaveURL(/#\/automations\/new$/);
  await expect(page.getByRole('heading', { name: 'New automation', exact: true })).toBeVisible();
  await capture('new-automation', page.locator('main'), 'File → New Automation opens the automation editor');
  await click('Tasks');
  await expect(page).toHaveURL(/#\/tasks$/);
  await click('New To-do');
  const idea = page.getByPlaceholder('Describe your idea...');
  await expect(idea).toBeVisible();
  await expect(idea).toBeFocused();
  await idea.fill('Quick idea that is not saved');
  await expect(page).toHaveURL(/#\/tasks$/);
  await capture('new-todo', page.locator('.desktop-toolbar-popover'), 'File → New To-do opens the toolbar quick add');
  await page.locator('main').click({ position: { x: 20, y: 200 } });
  await expect(idea).toHaveCount(0);
  // A second request after closing opens a fresh form rather than the old draft.
  await click('New To-do');
  await expect(page.getByPlaceholder('Describe your idea...')).toHaveValue('');
  await page.locator('main').click({ position: { x: 20, y: 200 } });
  // Last, because leaving Plan Studio asks to discard the draft.
  await click('New Plan');
  await expect(page).toHaveURL(/#\/studio\/new$/);
  expect(mutations).toEqual([]);
};

it('Linux/macOS menu dispatch reaches actual search, sidebar, every creation form, connection editor and diagnostics', async context => {
  const executablePath = [chromium.executablePath(), '/usr/bin/chromium'].find(existsSync);
  if (!executablePath) { context.skip('Install Playwright Chromium to exercise actual renderer commands'); return; }
  const directory = await mkdtemp(join(tmpdir(), 'propr-native-menu-'));
  let browser, server;
  const previews = [];
  try {
    await build({
      entryPoints: [join(desktop, 'scripts/fixtures/desktop-native-menu/renderer.tsx')],
      outfile: join(directory, 'renderer.js'), bundle: true, platform: 'browser', format: 'iife',
      define: { 'process.platform': 'window.__FIXTURE_PLATFORM__', 'import.meta.env': '{}', __APP_VERSION__: '"0.8.15"', __PROPR_DESKTOP__: 'true' },
    });
    await mkdir(join(directory, 'media'));
    await copyFile(join(root, 'propr-ui/public/media/logo-and-name-transparent.png'), join(directory, 'media/logo-and-name-transparent.png'));
    await copyFile(join(root, 'propr-ui/public/logo.png'), join(directory, 'logo.png'));
    const compiled = await postcss([tailwind({ ...tailwindConfig, content: [join(root, 'propr-ui/src/**/*.{ts,tsx}')] })])
      .process(await readFile(join(root, 'propr-ui/src/index.css'), 'utf8'), { from: join(root, 'propr-ui/src/index.css') });
    await writeFile(join(directory, 'base.css'), compiled.css);
    await writeFile(join(directory, 'renderer.html'), '<!doctype html><html><head><link rel="stylesheet" href="base.css"><link rel="stylesheet" href="renderer.css"></head><body><div id="root"></div><script src="renderer.js"></script></body></html>');
    server = createServer(async (request, response) => {
      const asset = new URL(request.url, 'http://fixture').pathname.slice(1);
      if (!['renderer.html', 'renderer.js', 'renderer.css', 'base.css', 'logo.png', 'media/logo-and-name-transparent.png'].includes(asset)) { response.writeHead(404).end(); return; }
      response.setHeader('Content-Type', asset.endsWith('.css') ? 'text/css' : asset.endsWith('.js') ? 'text/javascript' : asset.endsWith('.png') ? 'image/png' : 'text/html');
      response.end(await readFile(join(directory, asset)));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    // The managed path requires chromium-headless-shell: install with
    // `playwright install chromium` (without --no-shell), as CI and setup do.
    // chromium.executablePath() above checks full Chromium, not shell presence;
    // an incomplete managed installation must fail loudly at launch.
    // Shell and system Chromium exercise different rendering paths. This fixture
    // choice does not establish the cause of the prior Back-click timeout or
    // the reported concurrent-stress crash; native Electron evidence is separate.
    context.diagnostic(executablePath === chromium.executablePath()
      ? 'Renderer: Playwright managed chromium-headless-shell'
      : `Renderer: full system Chromium (${executablePath})`);
    browser = await chromium.launch({
      executablePath: executablePath === chromium.executablePath() ? undefined : executablePath,
      args: ['--no-sandbox'],
    });
    context.diagnostic(`Browser version: ${browser.version()}`);
    for (const platform of ['darwin', 'linux']) {
      const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
      await page.addInitScript(platform => {
        window.__FIXTURE_PLATFORM__ = platform;
        Object.defineProperty(navigator, 'platform', { value: platform === 'darwin' ? 'MacIntel' : 'Linux x86_64' });
        // Mirror the Linux preload's frame styling state (installWindowFrameStyles).
        const frame = () => Object.assign(document.documentElement.dataset, { desktopWindow: 'linux', windowFocused: 'true', windowExpanded: 'false' });
        if (platform === 'linux') document.addEventListener('DOMContentLoaded', frame);
      }, platform);
      await page.route('http://127.0.0.1:3000/**', route => route.fulfill({ status: 503, json: { error: 'Isolated renderer fixture' } }));
      page.on('pageerror', error => context.diagnostic(error.stack));
      // Opening a creation form must never write: record every mutating API call.
      const mutations = [];
      page.on('request', request => { if (request.url().startsWith('http://127.0.0.1:3000/') && request.method() !== 'GET') mutations.push(`${request.method()} ${request.url()}`); });
      await page.goto(`http://127.0.0.1:${server.address().port}/renderer.html`);
      const click = label => page.evaluate(({ label, platform }) => window.nativeMenu.click(label, platform), { label, platform });
      const capture = async (name, locator, title) => {
        if (!process.env.PROPR_DESKTOP_MENU_PREVIEWS) return;
        const output = resolve(root, process.env.PROPR_DESKTOP_MENU_PREVIEWS);
        await mkdir(output, { recursive: true });
        const filename = `${platform}-${name}.png`;
        if (typeof locator === 'function') await writeFile(join(output, filename), await locator());
        else await locator.screenshot({ path: join(output, filename) });
        previews.push({ path: `.propr/previews/${filename}`, title, description: 'Production renderer reached through the application menu template, dispatcher and preload bridge. Isolated fixture account; Chromium does not render native OS menus.' });
      };
      await expect(page.getByRole('heading', { name: 'Choose an instance' })).toBeVisible();
      const menuButton = page.getByRole('button', { name: 'Application menu', exact: true });
      const popup = () => page.evaluate(() => window.nativeMenu.popup());
      if (platform === 'linux') {
        // Entry surface: the same main-owned template, before any instance.
        await capture('application-menu-entry', page.locator('#root'), 'Linux: Application menu control on the instance chooser');
        await menuButton.click();
        await expect.poll(popup).toMatchObject({ menus: ['ProPR', 'File', 'Edit', 'View', 'Navigate', 'Window', 'Help'], sourceType: 'mouse' });
        expect((await popup()).file.slice(0, 5)).toEqual([
          { label: 'New Task', accelerator: 'CmdOrCtrl+Shift+T' }, { label: 'New Plan', accelerator: 'CmdOrCtrl+N' },
          { label: 'New Goal', accelerator: 'CmdOrCtrl+Shift+G' }, { label: 'New Automation', accelerator: 'CmdOrCtrl+Shift+A' },
          { label: 'New To-do', accelerator: 'CmdOrCtrl+Shift+D' },
        ]);
        // Every app-owned entry in the popup shows its shortcut, disabled or not;
        // native roles keep Electron's own defaults.
        const rows = (await popup()).shortcuts;
        expect(rows.filter(row => !row.role && !row.accelerator)).toEqual([]);
        expect(rows.filter(row => !row.enabled).length).toBeGreaterThan(0);
        expect(rows).toEqual(await page.evaluate(() => window.nativeMenu.shortcuts('linux')));
        await page.evaluate(() => window.nativeMenu.dismiss());
      } else {
        await expect(menuButton).toHaveCount(0);
        const rows = await page.evaluate(() => window.nativeMenu.shortcuts('darwin'));
        expect(rows.filter(row => !row.role && !row.accelerator)).toEqual([]);
        expect(rows.filter(row => ['unhide', 'zoom', 'front'].includes(row.role)).map(row => [row.role, row.accelerator])).toEqual([
          ['unhide', 'Command+Alt+Shift+H'], ['zoom', 'Command+Shift+M'], ['front', 'Command+Alt+Shift+M'],
        ]);
      }
      await click('Connect Instance…');
      await expect(page.getByRole('heading', { name: 'Connect to an instance' })).toBeVisible();
      await page.getByRole('button', { name: 'Back', exact: true }).click();
      await page.getByRole('button', { name: 'This computer Local instance' }).click();
      await expect(page.locator('.desktop-sidebar')).toBeVisible();
      await expect(page.locator('.desktop-sidebar footer')).toHaveCount(0);
      await expect(page.locator('.desktop-sidebar')).not.toContainText('v0.8.15');
      const iconRails = await page.locator('.desktop-sidebar').evaluate(sidebar => {
        const selectors = ['.desktop-instance-icon svg', 'a[href="#/"] svg', 'a[href="#/inbox"] svg'];
        return selectors.map(selector => {
          const box = sidebar.querySelector(selector).getBoundingClientRect();
          return box.x + box.width / 2;
        });
      });
      expect(new Set(iconRails).size).toBe(1);
      await capture('sidebar', page.locator('.desktop-sidebar'), 'Desktop sidebar without version metadata');
      if (platform === 'linux') {
        // Actual Linux minimum and a shorter supported window: the control stays
        // a separate no-drag hit target beside the native controls, never over
        // search/new-task, and the toolbar drag strip remains.
        for (const viewport of [{ width: 880, height: 620 }, { width: 880, height: 480 }]) {
          await page.setViewportSize(viewport);
          const layout = await page.evaluate(() => {
            const box = element => { const { left, right, top, bottom } = element.getBoundingClientRect(); return { left, right, top, bottom }; };
            const menu = document.querySelector('[aria-label="Application menu"]');
            const toolbar = document.querySelector('header[aria-label="Application toolbar"]');
            const minimize = document.querySelector('[aria-label="Minimize window"]');
            const toolbarControls = [...toolbar.querySelectorAll('button, input, a, [role="combobox"]')]
              .filter(element => element.getClientRects().length && getComputedStyle(element).visibility !== 'hidden').map(box);
            return {
              menu: box(menu), minimize: box(minimize), group: box(menu.parentElement),
              logo: (({ naturalWidth, naturalHeight, complete }) => ({ naturalWidth, naturalHeight, complete }))(menu.querySelector('img')),
              logoBox: box(menu.querySelector('img')),
              toolbarControls, appRegion: getComputedStyle(menu).getPropertyValue('-webkit-app-region') || getComputedStyle(menu).getPropertyValue('app-region'),
              toolbarRegion: getComputedStyle(toolbar).getPropertyValue('-webkit-app-region') || getComputedStyle(toolbar).getPropertyValue('app-region'),
              hit: document.elementFromPoint((menu.getBoundingClientRect().left + menu.getBoundingClientRect().right) / 2, 22) === menu
                || menu.contains(document.elementFromPoint((menu.getBoundingClientRect().left + menu.getBoundingClientRect().right) / 2, 22)),
              width: innerWidth,
            };
          });
          expect(layout.hit).toBe(true);
          expect(layout.appRegion).toBe('no-drag');
          expect(layout.toolbarRegion).toBe('drag');
          expect(layout.group.right).toBe(layout.width);
          expect(layout.menu.right).toBeLessThanOrEqual(layout.minimize.left);
          expect(layout.menu.top).toBe(layout.minimize.top);
          expect(layout.menu.bottom).toBe(layout.minimize.bottom);
          expect(layout.group.bottom).toBe(44);
          // The control carries the existing ProPR mark, loaded, unstretched and inside its hit target.
          expect(layout.logo.complete && layout.logo.naturalWidth).toBeGreaterThan(0);
          expect((layout.logoBox.right - layout.logoBox.left) / (layout.logoBox.bottom - layout.logoBox.top))
            .toBeCloseTo(layout.logo.naturalWidth / layout.logo.naturalHeight, 1);
          for (const edge of ['left', 'top']) expect(layout.logoBox[edge]).toBeGreaterThanOrEqual(layout.menu[edge]);
          for (const edge of ['right', 'bottom']) expect(layout.logoBox[edge]).toBeLessThanOrEqual(layout.menu[edge]);
          expect(layout.toolbarControls.length).toBeGreaterThan(0);
          for (const control of layout.toolbarControls) expect(control.right).toBeLessThanOrEqual(layout.group.left);
        }
        await capture('application-menu-control', page.locator('header[aria-label="Application toolbar"]'), 'Linux: Application menu control beside the window controls at 880px');
        await page.setViewportSize({ width: 1280, height: 820 });
        await expectAlignedChrome(page, capture);

        // Pointer: popup anchored under the control, then a real command.
        const menuBox = await menuButton.boundingBox();
        await menuButton.click();
        await expect.poll(popup).toMatchObject({ x: Math.round(menuBox.x), y: Math.round(menuBox.y + menuBox.height), sourceType: 'mouse' });
        expect((await popup()).roles).toEqual(expect.arrayContaining(['undo', 'cut', 'copy', 'paste', 'selectAll', 'resetZoom', 'zoomIn', 'zoomOut', 'togglefullscreen', 'minimize', 'close']));
        await page.evaluate(() => window.nativeMenu.choose('Settings…'));
        await expect(page).toHaveURL(/#\/settings$/);
        // Keyboard: Tab-reachable button with Enter, and F10 from a focused field
        // (focus stays in the field, so Edit roles act on it).
        await menuButton.focus();
        await page.keyboard.press('Enter');
        await expect.poll(popup).toMatchObject({ sourceType: 'keyboard' });
        await page.evaluate(() => window.nativeMenu.choose('Dashboard'));
        await expect(page).toHaveURL(/#\/$/);
        const search = page.getByRole('combobox', { name: 'Search', exact: true });
        await search.focus();
        await page.keyboard.press('F10');
        await expect.poll(popup).toMatchObject({ sourceType: 'keyboard' });
        await expect(search).toBeFocused();
        await page.evaluate(() => window.nativeMenu.dismiss());
        await page.keyboard.press('Alt+f');
        await expect.poll(popup).toMatchObject({ sourceType: 'keyboard' });
        await expect(search).toBeFocused();
        await page.evaluate(() => window.nativeMenu.dismiss());
        // Pointer activation must not take focus from the field either.
        await menuButton.click();
        await expect(search).toBeFocused();
        await page.evaluate(() => window.nativeMenu.dismiss());
      } else {
        await expect(menuButton).toHaveCount(0);
      }
      await click('Toggle Sidebar');
      await expect(page.locator('.desktop-sidebar')).toHaveCount(0);
      await capture('sidebar-hidden', page.locator('.desktop-shell'), 'View → Toggle Sidebar: content expands');
      await click('Toggle Sidebar');
      await expect(page.locator('.desktop-sidebar')).toBeVisible();
      await click('Switch Account / Instance…');
      await expect(page.getByRole('dialog', { name: 'Manage instances' })).toBeVisible();
      await click('Search / Go To…');
      await expect(page.getByRole('dialog', { name: 'Manage instances' })).toHaveCount(0);
      await expect(page.getByRole('combobox', { name: 'Search', exact: true })).toBeFocused();
      await expectNarrowSearch(page, click, capture, platform);
      // Normal width again: the toolbar field takes the request, no sheet.
      await click('Search / Go To…');
      await expect(page.getByRole('combobox', { name: 'Search', exact: true })).toBeFocused();
      await expect(page.getByRole('dialog', { name: 'Search' })).toHaveCount(0);
      await page.keyboard.press('Escape');
      await click('Connect Instance…');
      await expect(page.getByRole('heading', { name: 'Connect to an instance' })).toBeVisible();
      await capture('connect', page.getByRole('dialog', { name: 'Manage instances' }), 'File → Connect Instance opens the connection editor');
      await page.getByRole('button', { name: 'Close instance manager' }).click();
      await click('Connection Diagnostics…');
      await expect(page.getByRole('dialog', { name: 'Connection Diagnostics' })).toBeVisible();
      await expect(page.getByRole('dialog', { name: 'Connection Diagnostics' })).toContainText('connected');
      await capture('diagnostics', page.getByRole('dialog', { name: 'Connection Diagnostics' }), 'Help → Connection Diagnostics');
      await page.getByRole('button', { name: 'Close', exact: true }).click();
      await click('New Task');
      await expect(page).toHaveURL(/#\/tasks\/new$/);
      const launcher = page.getByRole('dialog', { name: 'New task', exact: true });
      await expect(launcher).toBeVisible();
      await expect(launcher.getByRole('heading', { name: 'New task', exact: true })).toBeVisible();
      await expect(launcher.getByRole('textbox', { name: 'Prompt', exact: true })).toBeVisible();
      await expect(launcher.getByRole('textbox', { name: 'Prompt', exact: true })).toBeFocused();
      await expect(launcher.getByRole('button', { name: 'Run task', exact: true })).toBeVisible();
      await expect(launcher.getByRole('button', { name: 'Plan first', exact: true })).toBeVisible();
      await expect(launcher.getByRole('combobox', { name: 'Agent', exact: true })).toBeHidden();
      await expect(launcher.getByRole('combobox', { name: 'Model', exact: true })).toBeHidden();
      await launcher.getByText('Advanced Options', { exact: false }).click();
      await expect(launcher.getByRole('combobox', { name: 'Agent', exact: true })).toBeVisible();
      await expect(launcher.getByRole('combobox', { name: 'Model', exact: true })).toBeVisible();
      await expect(launcher.getByRole('button', { name: 'Plan first', exact: true })).toBeVisible();
      await launcher.getByText('Advanced Options', { exact: false }).click();
      await expect(launcher.getByRole('combobox', { name: 'Agent', exact: true })).toBeHidden();
      await expect(launcher.getByRole('combobox', { name: 'Model', exact: true })).toBeHidden();
      await expect(launcher.getByRole('button', { name: 'Plan first', exact: true })).toBeVisible();
      await capture('new-task', launcher, 'File → New Task opens the GitHub issue task launcher');
      await expectCreationForms(page, click, capture, mutations);
      await page.close();
    }
    if (process.env.PROPR_DESKTOP_MENU_PREVIEWS) await writeFile(resolve(root, process.env.PROPR_DESKTOP_MENU_PREVIEWS, 'manifest.json'), JSON.stringify({ previews, toolSuggestions: [{ name: 'macOS Electron runner', reason: 'Verify native menu appearance, accelerator handling and About copy action using the next signed Mac build; retain the existing test login.' }] }, null, 2));
  } finally {
    await browser?.close();
    if (server) await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
