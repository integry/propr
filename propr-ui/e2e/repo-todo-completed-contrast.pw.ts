import { expect, test, type Locator, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

// Completed repository To-Dos are readable content with live Restore/Delete
// controls, so their text must meet WCAG 1.4.3 (4.5:1 for normal text) as
// painted: computed colours composited through every background and every
// ancestor's group opacity, not sampled from antialiased screenshot pixels.
// The store is local; only the fixture item an action targets may be written.

const ACTIVE = 'Draft the changelog for the next release';
const DONE = 'Archive the old release notes';
const LONG = 'Rotate the staging certificate\nsee https://certs.example.test/staging/rotation/2026/october/renewal-checklist-final';
const repos = [{ id: 'propr', name: 'integry/propr', enabled: true, visualPreview: { enabled: false, types: ['image'] } }];
const MIN_CONTRAST = 4.5;

const todo = (todoId: string, content: string, extra: Record<string, unknown> = {}) => ({
  todoId, categoryId: null, content, orderIndex: 0, isCompleted: false, linkedDraftId: null, createdBy: null,
  linkedIssueRepository: null, linkedIssueNumber: null, linkedTaskId: null,
  createdAt: '2026-10-18T06:00:00.000Z', updatedAt: '2026-10-18T06:00:00.000Z', ...extra,
});

interface Write { method: string; path: string; body: unknown }

async function todoStore(page: Page) {
  const todos = [
    todo('t-active', ACTIVE),
    todo('t-done', DONE, { orderIndex: 1, isCompleted: true, linkedIssueRepository: 'integry/propr', linkedIssueNumber: 7 }),
    todo('t-long', LONG, { orderIndex: 2, isCompleted: true }),
  ];
  const writes: Write[] = [];
  await page.routeWebSocket('**/socket.io/**', socket => socket.close());
  await page.route('**/api/**', route => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    const method = request.method();
    if (method !== 'GET') {
      writes.push({ method, path: pathname, body: request.postData() ? request.postDataJSON() : null });
      const item = todos.find(entry => pathname === `/api/repos/todos/${entry.todoId}`);
      if (item && method === 'PUT') {
        Object.assign(item, request.postDataJSON(), { updatedAt: '2026-10-18T07:00:00.000Z' });
        return route.fulfill({ json: item });
      }
      if (item && method === 'DELETE') {
        todos.splice(todos.indexOf(item), 1);
        return route.fulfill({ json: { success: true } });
      }
      return route.fulfill({ status: 503, json: { error: 'Unexpected write in completed to-do fixture' } });
    }
    const responses: Record<string, unknown> = {
      '/api/auth/demo-mode': { demoMode: false },
      '/api/auth/user': { id: '583231', login: 'octocat', username: 'octocat', displayName: 'The Octocat', email: null, avatarUrl: null, role: 'admin', permissions: ['instance.manage_settings'], authorizationSource: 'local' },
      '/api/instance/catalog': { agents: [], repositories: repos },
      '/api/config/repos': { success: true, repos_to_monitor: repos },
      '/api/github/repos': { repos: [] },
      '/api/config/settings': {},
      '/api/user/repo-preferences': { preferences: {} },
      '/api/repositories/indexing-status': { repositories: [] },
      '/api/repos/chat/messages': { messages: [] },
      '/api/repos/todos': { todos },
      '/api/repos/todos/categories': { categories: [] },
      '/api/tasks': { tasks: [], total: 0 },
      '/api/queue/stats': { active: 0, waiting: 0, completed: 0, failed: 0 },
      '/api/notifications/unread-count': { unreadCount: 0 },
      '/api/notifications/preferences': { preferences: {}, quietHours: {}, badgeEnabled: false },
    };
    return route.fulfill(pathname in responses ? { json: responses[pathname] } : { status: 503, json: { error: 'Unavailable in completed to-do fixture' } });
  });
  return { todos, writes };
}

async function openCompleted(page: Page, press: (target: Locator) => Promise<void>) {
  await page.goto('/repositories');
  await press(page.getByRole('button', { name: 'Select integry/propr', exact: true }).first());
  await press(page.getByRole('button', { name: 'To-Dos', exact: true }));
  await expect(page.getByText(ACTIVE)).toBeVisible();
  const completed = page.getByRole('button', { name: /Completed Items/ });
  await press(completed);
  await expect(completed).toHaveAttribute('aria-expanded', 'true');
}

const rowOf = (page: Page, content: string) =>
  page.getByTestId('repo-todo-row').filter({ has: page.getByText(content, { exact: true }) });
const control = (row: Locator, action: string, content: string) =>
  row.getByRole('button', { name: `${action} todo: ${content}`, exact: true });

interface Painted { foreground: number[]; background: number[]; opacity: number; contrast: number; size: string; weight: string }

/**
 * The text colour and the colour behind it as painted at one of the element's text
 * pixels. Each colour is resolved through a canvas (so any CSS colour syntax works),
 * laid over its own background, then every ancestor's background from the canvas
 * (white) up, and mixed with what lies behind each ancestor by that ancestor's
 * opacity, exactly as group opacity composites. Contrast is the WCAG ratio.
 */
const painted = (target: Locator): Promise<Painted> => target.evaluate(element => {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 1;
  const context = canvas.getContext('2d', { willReadFrequently: true })!;
  const rgba = (css: string) => {
    context.clearRect(0, 0, 1, 1);
    context.fillStyle = css;
    context.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data;
    return { rgb: [r, g, b], alpha: a / 255 };
  };
  const over = (top: { rgb: number[]; alpha: number }, below: number[]) =>
    below.map((channel, index) => top.rgb[index] * top.alpha + channel * (1 - top.alpha));
  const mix = (inner: number[], behind: number[], opacity: number) =>
    behind.map((channel, index) => inner[index] * opacity + channel * (1 - opacity));

  const chain: Element[] = [];
  for (let node: Element | null = element; node; node = node.parentElement) chain.unshift(node);
  for (const node of chain) {
    const image = getComputedStyle(node).backgroundImage;
    if (image !== 'none') throw new Error(`background-image on ${node.tagName}.${node.className}: ${image}`);
  }
  // `leaf` paints what the element itself adds on top of its own background.
  const paint = (leaf: (behind: number[]) => number[]) => {
    const at = (index: number, behind: number[]): number[] => {
      const style = getComputedStyle(chain[index]);
      const withBackground = over(rgba(style.backgroundColor), behind);
      const inner = index === chain.length - 1 ? leaf(withBackground) : at(index + 1, withBackground);
      return mix(inner, behind, Number(style.opacity));
    };
    return at(0, [255, 255, 255]);
  };
  const style = getComputedStyle(element);
  const foreground = paint(behind => over(rgba(style.color), behind));
  const background = paint(behind => behind);
  const luminance = (rgb: number[]) => {
    const [r, g, b] = rgb.map(channel => {
      const value = channel / 255;
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const [light, dark] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  const opacity = chain.reduce((product, node) => product * Number(getComputedStyle(node).opacity), 1);
  return { foreground, background, opacity, contrast: (light + 0.05) / (dark + 0.05), size: style.fontSize, weight: style.fontWeight };
});

/** Every completed row's note and issue chip reads at 4.5:1 or better in the current state. */
async function expectReadable(page: Page, state: string) {
  for (const content of [DONE, LONG]) {
    const row = rowOf(page, content);
    const targets = [row.getByText(content, { exact: true }), ...(content === DONE ? [row.getByRole('link', { name: '#7' })] : [])];
    for (const target of targets) {
      const result = await painted(target);
      const at = `${state}: ${JSON.stringify(content.split('\n')[0])} ${await target.evaluate(node => node.tagName)} ${JSON.stringify(result)}`;
      test.info().annotations.push({ type: 'contrast', description: at });
      expect(result.contrast, at).toBeGreaterThanOrEqual(MIN_CONTRAST);
      expect(result.opacity, at).toBe(1);
    }
  }
}

/**
 * The same measurement on the style this fix replaced (slate-400 text, the row at
 * 60% opacity on desktop and 100% on touch) must fail, so a pass above is not an
 * artefact of the measurement.
 */
async function expectPreFixStyleFails(page: Page, rowOpacity: number, expected: number) {
  const row = rowOf(page, DONE);
  const note = row.getByText(DONE, { exact: true });
  await row.evaluate((node, opacity) => { (node as HTMLElement).style.opacity = String(opacity); }, rowOpacity);
  await note.evaluate(node => { (node as HTMLElement).style.color = 'rgb(148, 163, 184)'; });
  const result = await painted(note);
  await row.evaluate(node => { (node as HTMLElement).style.opacity = ''; });
  await note.evaluate(node => { (node as HTMLElement).style.color = ''; });
  expect(result.opacity).toBeCloseTo(rowOpacity, 5);
  expect(result.contrast).toBeLessThan(MIN_CONTRAST);
  expect(result.contrast).toBeCloseTo(expected, 1);
}

/** Notes wrap inside the row instead of overflowing it or the page. */
async function expectWrapped(page: Page) {
  const note = rowOf(page, LONG).getByText(LONG, { exact: true });
  expect(await note.evaluate(node => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(0);
  expect((await note.boundingBox())!.height).toBeGreaterThan(40);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
}

async function capture(page: Page, name: string) {
  if (!process.env.PROPR_CAPTURE_PREVIEWS) return;
  const directory = path.resolve('../.propr/previews');
  await mkdir(directory, { recursive: true });
  await rowOf(page, DONE).scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(directory, `${name}.png`), animations: 'disabled' });
}

test.describe('desktop 1280px fine pointer', () => {
  test.use({ viewport: { width: 1280, height: 820 } });

  test('completed rows stay readable at rest, on hover and under keyboard focus', async ({ page }) => {
    const { writes } = await todoStore(page);
    await openCompleted(page, target => target.click());
    expect(await page.evaluate(() => matchMedia('(pointer: fine)').matches)).toBe(true);
    await page.mouse.move(0, 0);
    await expectReadable(page, 'rest');
    await expectPreFixStyleFails(page, 0.6, 1.653);

    const done = rowOf(page, DONE);
    await done.hover();
    await expectReadable(page, 'row hover');
    await done.getByRole('link', { name: '#7' }).hover();
    await expectReadable(page, 'issue link hover');
    await page.mouse.move(0, 0);

    await control(done, 'Restore', DONE).focus();
    await page.keyboard.press('Tab');
    await expect(done.getByRole('link', { name: '#7' })).toBeFocused();
    await expectReadable(page, 'issue link focus');
    await page.keyboard.press('Tab');
    const remove = control(done, 'Delete', DONE);
    await expect(remove).toBeFocused();
    await expect(remove).toBeEnabled();
    await expect(control(done, 'Restore', DONE)).toBeEnabled();
    expect(await remove.evaluate(node => getComputedStyle(node).boxShadow)).not.toBe('none');
    await expectReadable(page, 'delete focus');
    await expectWrapped(page);
    await capture(page, 'completed-todos-desktop-1280');
    expect(writes).toEqual([]);
  });

  test('keyboard restores and deletes only the fixture item', async ({ page }) => {
    const { todos, writes } = await todoStore(page);
    await openCompleted(page, target => target.click());
    await control(rowOf(page, DONE), 'Restore', DONE).focus();
    await page.keyboard.press('Enter');
    await expect(control(rowOf(page, DONE), 'Complete', DONE)).toBeVisible();
    await control(rowOf(page, LONG), 'Delete', LONG).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByText(LONG, { exact: true })).toHaveCount(0);
    expect(writes).toEqual([
      { method: 'PUT', path: '/api/repos/todos/t-done', body: { isCompleted: false } },
      { method: 'DELETE', path: '/api/repos/todos/t-long', body: null },
    ]);
    expect(todos.map(item => [item.todoId, item.isCompleted])).toEqual([['t-active', false], ['t-done', false]]);
  });
});

for (const width of [320, 390]) {
  test.describe(`${width}px coarse pointer`, () => {
    test.use({ viewport: { width, height: 844 }, isMobile: true, hasTouch: true });

    test('completed rows stay readable with full-size, fully visible controls', async ({ page }) => {
      const { writes } = await todoStore(page);
      await openCompleted(page, target => target.tap());
      expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true);
      await expectReadable(page, 'rest');
      await expectPreFixStyleFails(page, 1, 2.451);

      const done = rowOf(page, DONE);
      for (const action of ['Restore', 'Delete']) {
        const target = control(done, action, DONE);
        await expect(target).toBeEnabled();
        const box = (await target.boundingBox())!;
        expect(box.width).toBeGreaterThanOrEqual(44);
        expect(box.height).toBeGreaterThanOrEqual(44);
        expect((await painted(target)).opacity).toBe(1);
      }
      await control(done, 'Restore', DONE).focus();
      await expectReadable(page, 'restore focus');
      await expectWrapped(page);
      await capture(page, `completed-todos-touch-${width}`);
      expect(writes).toEqual([]);
    });

    test('touch restores and deletes only the fixture item', async ({ page }) => {
      const { todos, writes } = await todoStore(page);
      await openCompleted(page, target => target.tap());
      await control(rowOf(page, LONG), 'Delete', LONG).tap();
      await expect(page.getByText(LONG, { exact: true })).toHaveCount(0);
      await control(rowOf(page, DONE), 'Restore', DONE).tap();
      await expect(control(rowOf(page, DONE), 'Complete', DONE)).toBeVisible();
      expect(writes).toEqual([
        { method: 'DELETE', path: '/api/repos/todos/t-long', body: null },
        { method: 'PUT', path: '/api/repos/todos/t-done', body: { isCompleted: false } },
      ]);
      expect(todos.map(item => [item.todoId, item.isCompleted])).toEqual([['t-active', false], ['t-done', false]]);
    });
  });
}
