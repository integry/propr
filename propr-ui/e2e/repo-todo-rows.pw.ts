import { expect, test, type Locator, type Page, type Route } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

// Repository To-Do rows against a stateful local to-do store: every action is
// performed on the real control (trusted touch on phones, mouse and keyboard
// on desktop) and checked by the PUT/DELETE/reorder requests it sends and the
// rows the store returns. Nothing else may be written, so no task starts.

const octocat = { id: '583231', login: 'octocat', displayName: 'The Octocat', avatarUrl: null };
const hubot = { id: '480938', login: 'hubot', displayName: null, avatarUrl: null };
const NOTE = 'Teach the indexer to resume an interrupted crawl without rescanning';
const LONG = 'Check invoice dates\nsee https://billing.example.test/invoices/2026/october/reconciliation-report-final';
const DONE = 'Archive the old release notes';
// Real Inter (OFL-1.1, provenance in e2e/fonts/README.md), served in place of Google Fonts.
const INTER = readFileSync(new URL('./fonts/inter-var-latin.woff2', import.meta.url));
const INTER_URL = 'https://fonts.gstatic.com/s/inter/e2e-fixture/inter-var-latin.woff2';
const INTER_CSS = `@font-face { font-family: 'Inter'; font-weight: 400 700; font-display: swap; src: url(${INTER_URL}) format('woff2');
  unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD; }`;
const repos = [{ id: 'propr', name: 'integry/propr', enabled: true, visualPreview: { enabled: false, types: ['image'] } }];

const todo = (todoId: string, content: string, extra: Record<string, unknown> = {}) => ({
  todoId, categoryId: null, content, orderIndex: 0, isCompleted: false, linkedDraftId: null, createdBy: null,
  linkedIssueRepository: null, linkedIssueNumber: null, linkedTaskId: null,
  createdAt: '2026-10-18T06:00:00.000Z', updatedAt: '2026-10-18T06:00:00.000Z', ...extra,
});

interface Write { method: string; path: string; body: unknown }

async function todoStore(page: Page) {
  const todos = [
    todo('t-note', NOTE, { orderIndex: 0, createdBy: octocat, linkedDraftId: 'draft-1' }),
    todo('t-long', LONG, { orderIndex: 1, linkedIssueRepository: 'integry/propr', linkedIssueNumber: 42 }),
    todo('t-done', DONE, { orderIndex: 2, isCompleted: true, createdBy: hubot, linkedIssueRepository: 'integry/propr', linkedIssueNumber: 7 }),
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
      if (pathname === '/api/repos/todos/reorder' && method === 'POST') return route.fulfill({ json: { success: true } });
      return route.fulfill({ status: 503, json: { error: 'Unexpected write in to-do row fixture' } });
    }
    const responses: Record<string, unknown> = {
      '/api/auth/demo-mode': { demoMode: false },
      '/api/auth/user': { id: octocat.id, login: 'octocat', username: 'octocat', displayName: 'The Octocat', email: null, avatarUrl: null, role: 'admin', permissions: ['instance.manage_settings'], authorizationSource: 'local' },
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
    return route.fulfill(pathname in responses ? { json: responses[pathname] } : { status: 503, json: { error: 'Unavailable in to-do row fixture' } });
  });
  return { todos, writes };
}

async function openTodos(page: Page, press: (target: Locator) => Promise<void>, waitUntil: 'load' | 'domcontentloaded' = 'load') {
  await page.goto('/repositories', { waitUntil });
  await press(page.getByRole('button', { name: 'Select integry/propr', exact: true }).first());
  await press(page.getByRole('button', { name: 'To-Dos', exact: true }));
  await expect(page.getByText(NOTE)).toBeVisible();
}

const rowOf = (page: Page, content: string) =>
  page.getByTestId('repo-todo-row').filter({ has: page.getByText(content, { exact: true }) });
const control = (row: Locator, action: string, content: string) =>
  row.getByRole('button', { name: `${action} todo: ${content}`, exact: true });
/** Every action on an active row, in tab order. */
const actions = (row: Locator, content: string) => [
  row.getByRole('button', { name: `Reorder todo: ${content}` }),
  control(row, 'Select', content), control(row, 'Complete', content),
  control(row, 'Edit', content), control(row, 'Delete', content),
];

/** Opacity as painted: the product of the element's and every ancestor's opacity. */
const paintedOpacity = (target: Locator) => target.evaluate(element => {
  let opacity = 1;
  for (let node: Element | null = element; node; node = node.parentElement) opacity *= Number(getComputedStyle(node).opacity);
  return opacity;
});

type Box = { x: number; y: number; width: number; height: number };
const overlaps = (a: Box, b: Box) =>
  a.x < b.x + b.width - 0.5 && b.x < a.x + a.width - 0.5 && a.y < b.y + b.height - 0.5 && b.y < a.y + a.height - 0.5;
const inside = (inner: Box, outer: Box) =>
  inner.x >= outer.x - 0.5 && inner.y >= outer.y - 0.5
  && inner.x + inner.width <= outer.x + outer.width + 0.5 && inner.y + inner.height <= outer.y + outer.height + 0.5;

/** The row, its note and each control as laid out in one frame, with what a tap at each control's centre hits. */
interface RowLayout { row: Box; text: Box; textOverflow: number; controls: { box: Box; hit: boolean }[] }

/**
 * Reads the whole row in a single task after an animation frame, so every box comes
 * from the same layout. Separate boundingBox() calls can straddle a relayout: when
 * the Inter web font arrives mid-check the page above the list reflows, and a row
 * box from before it is no longer comparable with control boxes from after it.
 */
async function rowLayout(row: Locator, text: Locator, controls: Locator[]): Promise<RowLayout> {
  const handles = await Promise.all([row, text, ...controls].map(target => target.elementHandle()));
  try {
    return await row.page().evaluate(async ([rowElement, textElement, ...controlElements]) => {
      await new Promise(resolve => requestAnimationFrame(resolve));
      const box = (element: Element) => {
        const { x, y, width, height } = element.getBoundingClientRect();
        return { x, y, width, height };
      };
      return {
        row: box(rowElement!),
        text: box(textElement!),
        textOverflow: textElement!.scrollWidth - textElement!.clientWidth,
        controls: controlElements.map(element => {
          const target = box(element!);
          const hit = element!.contains(document.elementFromPoint(target.x + target.width / 2, target.y + target.height / 2));
          return { box: target, hit };
        }),
      };
    }, handles);
  } finally {
    await Promise.all(handles.map(handle => handle?.dispose()));
  }
}

/**
 * The row's layout once two samples a frame apart agree. That only shows the layout
 * was stable for that frame, not that fonts are ready: a font still loading can
 * arrive later and reflow the row. Each sample is one coherent frame either way.
 */
async function settledRowLayout(row: Locator, text: Locator, controls: Locator[]): Promise<RowLayout> {
  let layout = await rowLayout(row, text, controls);
  await expect.poll(async () => {
    const previous = JSON.stringify(layout);
    layout = await rowLayout(row, text, controls);
    return JSON.stringify(layout) === previous;
  }, { message: 'row layout settles' }).toBe(true);
  return layout;
}

/** Touch rows: every control is visible, at least 44px square, hit at its centre, and clear of the note and each other. */
async function expectTouchRow(row: Locator, content: string, controls: Locator[]) {
  await row.scrollIntoViewIfNeeded();
  const text = row.getByText(content, { exact: true });
  for (const target of controls) {
    await expect(target).toBeVisible();
    await expect.poll(() => paintedOpacity(target)).toBeGreaterThanOrEqual(0.99);
  }
  const layout = await settledRowLayout(row, text, controls);
  // The note gets the row's width instead of sharing it with a desktop action strip.
  expect(layout.text.width).toBeGreaterThanOrEqual(layout.row.width * 0.8);
  expect(layout.textOverflow).toBeLessThanOrEqual(0);
  const boxes: Box[] = [layout.text];
  for (const [index, { box, hit }] of layout.controls.entries()) {
    const at = `${content} control ${index}: ${JSON.stringify(box)} in row ${JSON.stringify(layout.row)}`;
    expect(box.width, at).toBeGreaterThanOrEqual(44);
    expect(box.height, at).toBeGreaterThanOrEqual(44);
    expect(inside(box, layout.row), at).toBe(true);
    expect(hit, at).toBe(true);
    for (const other of boxes) expect(overlaps(box, other), at).toBe(false);
    boxes.push(box);
  }
}

const noPageOverflow = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

async function capture(page: Page, name: string) {
  if (!process.env.PROPR_CAPTURE_PREVIEWS) return;
  const directory = path.resolve('../.propr/previews');
  await mkdir(directory, { recursive: true });
  await page.screenshot({ path: path.join(directory, `${name}.png`), animations: 'disabled' });
}

for (const width of [320, 390]) {
  test.describe(`${width}px touch`, () => {
    test.use({ viewport: { width, height: 844 }, isMobile: true, hasTouch: true });

    test('every row action is a visible 44px tap target and the note keeps its width', async ({ page }) => {
      const { todos, writes } = await todoStore(page);
      await openTodos(page, target => target.tap());
      expect(await page.evaluate(() => matchMedia('(hover: hover)').matches)).toBe(false);

      const note = rowOf(page, NOTE);
      const long = rowOf(page, LONG);
      for (const [row, content] of [[note, NOTE], [long, LONG]] as const) await expectTouchRow(row, content, actions(row, content));
      // A 65-character note reads in a couple of lines, not a narrow column.
      const lineHeight = await note.getByText(NOTE).evaluate(node => parseFloat(getComputedStyle(node).lineHeight));
      expect((await note.getByText(NOTE).boundingBox())!.height).toBeLessThanOrEqual(lineHeight * 3 + 1);
      // Attribution and linked metadata stay on the row.
      await expect(note.getByRole('group', { name: 'Created by @octocat' })).toBeVisible();
      await expect(note.getByText('Linked to plan')).toBeVisible();
      await expect(long.getByRole('link', { name: '#42' })).toBeVisible();

      const completed = page.getByRole('button', { name: /Completed Items/ });
      expect((await completed.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      await completed.tap();
      const done = rowOf(page, DONE);
      await expectTouchRow(done, DONE, [control(done, 'Restore', DONE), control(done, 'Delete', DONE)]);
      await expect(done.getByRole('link', { name: '#7' })).toBeVisible();
      expect(await noPageOverflow(page)).toBeLessThanOrEqual(0);
      expect(writes).toEqual([]);
      expect(todos).toHaveLength(3);
      if (process.env.PROPR_CAPTURE_PREVIEWS) {
        // Last step: a capture drops touch emulation. Show every row at once.
        await page.setViewportSize({ width, height: 1000 });
        await note.evaluate(node => node.closest('.overflow-y-auto')?.scrollTo(0, 0));
        await capture(page, `todo-rows-touch-${width}`);
      }
    });

    test('rows keep their tap targets in the fallback font and after Inter arrives', async ({ page, browserName }) => {
      await todoStore(page);
      // Serve the stylesheet and a local copy of Inter instead of Google Fonts, and hold
      // the font file so the rows first render in the fallback font and the swap happens
      // on cue, with or without network access.
      await page.route('https://fonts.googleapis.com/**', route => route.fulfill({ contentType: 'text/css', body: INTER_CSS }));
      const serveInter = (route: Route) => route.fulfill({ contentType: 'font/woff2', headers: { 'access-control-allow-origin': '*' }, body: INTER });
      const held: Route[] = [];
      let holding = true;
      await page.route('https://fonts.gstatic.com/**', route => (holding ? held.push(route) : serveInter(route)));
      // WebKit holds the load event for a font that is still downloading, so waiting
      // for load here would wait for the very file being withheld. The rows are
      // ready once openTodos sees the note.
      await openTodos(page, target => target.tap(), 'domcontentloaded');
      const note = rowOf(page, NOTE);
      const long = rowOf(page, LONG);
      // Inter's FontFace status, whether its `loaded` promise has settled yet, and the document's FontFaceSet status.
      const interState = () => page.evaluate(async () => {
        const inter = [...document.fonts].filter(font => font.family.replace(/["']/g, '') === 'Inter');
        const unsettled = new Promise<string>(resolve => setTimeout(resolve, 0, 'pending'));
        const loaded = await Promise.all(inter.map(font => Promise.race([font.loaded.then(() => 'resolved', () => 'rejected'), unsettled])));
        return { status: inter.map(font => font.status), loaded, set: document.fonts.status };
      });
      // While the file is in flight Chromium reports the face as 'loading'. WebKit reports
      // 'error' as soon as the font-display block period ends (at once for swap, 3s for
      // block/auto): its timed-out state, in which the fallback is drawn, still swaps to
      // 'loaded' when the file arrives. A real failure rejects `loaded` and returns the
      // set to 'loaded', so an unsettled promise in a loading set is the in-flight font.
      const withheld = { status: [browserName === 'webkit' ? 'error' : 'loading'], loaded: ['pending'], set: 'loading' };

      // The page asked for Inter, and the file is withheld while the fallback is checked.
      await expect.poll(() => held.map(route => route.request().url()), { message: 'Inter requested and held' }).toEqual([INTER_URL]);
      await expect.poll(interState, { message: 'Inter in flight' }).toEqual(withheld);
      const readyState = await page.evaluate(() => document.readyState);
      for (const [row, content] of [[note, NOTE], [long, LONG]] as const) await expectTouchRow(row, content, actions(row, content));
      const fallback = await rowLayout(note, note.getByText(NOTE, { exact: true }), actions(note, NOTE));
      expect(await noPageOverflow(page)).toBeLessThanOrEqual(0);
      expect(await interState()).toEqual(withheld);

      holding = false;
      await Promise.all(held.map(serveInter));
      await expect.poll(interState, { message: 'Inter loaded after release' }).toEqual({ status: ['loaded'], loaded: ['resolved'], set: 'loaded' });
      for (const [row, content] of [[note, NOTE], [long, LONG]] as const) await expectTouchRow(row, content, actions(row, content));
      const inter = await rowLayout(note, note.getByText(NOTE, { exact: true }), actions(note, NOTE));
      // How far the swap moves the row depends on the host's fallback font, so it is recorded, not asserted.
      test.info().annotations.push({ type: 'font swap', description:
        `${held.length} Inter file(s) held (document ${readyState}); note row ${JSON.stringify(fallback.row)} in the fallback font, ${JSON.stringify(inter.row)} in Inter` });
      expect(await noPageOverflow(page)).toBeLessThanOrEqual(0);
    });

    test('select, edit, complete, restore and delete by touch', async ({ page }) => {
      const { todos, writes } = await todoStore(page);
      await openTodos(page, target => target.tap());
      const note = rowOf(page, NOTE);

      await control(note, 'Select', NOTE).tap();
      await expect(control(note, 'Select', NOTE)).toHaveAttribute('aria-pressed', 'true');
      await expect(page.getByRole('button', { name: 'Create Plan from 1 Item' })).toBeVisible();

      const long = rowOf(page, LONG);
      await control(long, 'Edit', LONG).tap();
      const editor = page.getByRole('textbox', { name: 'Edit todo' });
      await expect(editor).toBeFocused();
      await editor.fill('Check invoice dates against the account locale');
      await editor.press('Enter');
      await expect(page.getByText('Check invoice dates against the account locale', { exact: true })).toBeVisible();

      await control(note, 'Complete', NOTE).tap();
      await expect(page.getByRole('button', { name: 'Create Plan from 1 Item' })).toBeHidden();
      await page.getByRole('button', { name: /Completed Items/ }).tap();
      const done = rowOf(page, DONE);
      await control(done, 'Restore', DONE).tap();
      await expect(control(rowOf(page, DONE), 'Complete', DONE)).toBeVisible();
      await control(rowOf(page, NOTE), 'Delete', NOTE).tap();
      await expect(page.getByText(NOTE)).toHaveCount(0);
      await control(rowOf(page, DONE), 'Delete', DONE).tap();
      await expect(page.getByText(DONE)).toHaveCount(0);

      expect(writes).toEqual([
        { method: 'PUT', path: '/api/repos/todos/t-long', body: { content: 'Check invoice dates against the account locale' } },
        { method: 'PUT', path: '/api/repos/todos/t-note', body: { isCompleted: true } },
        { method: 'PUT', path: '/api/repos/todos/t-done', body: { isCompleted: false } },
        { method: 'DELETE', path: '/api/repos/todos/t-note', body: null },
        { method: 'DELETE', path: '/api/repos/todos/t-done', body: null },
      ]);
      expect(todos.map(item => [item.todoId, item.isCompleted])).toEqual([['t-long', false]]);
    });
  });
}

// `touch:` is a custom variant matching a coarse pointer OR a phone width, so
// either condition alone gives the touch row.
for (const { name, viewport, coarse } of [
  { name: 'narrow fine pointer', viewport: { width: 390, height: 844 }, coarse: false },
  { name: 'wide coarse pointer', viewport: { width: 1024, height: 768 }, coarse: true },
]) {
  test.describe(name, () => {
    test.use({ viewport, isMobile: coarse, hasTouch: coarse });

    test('rows use the touch layout', async ({ page }) => {
      await todoStore(page);
      await openTodos(page, target => (coarse ? target.tap() : target.click()));
      expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(coarse);
      expect(await page.evaluate(() => innerWidth)).toBe(viewport.width);
      await expectTouchRow(rowOf(page, NOTE), NOTE, actions(rowOf(page, NOTE), NOTE));
    });
  });
}

test.describe('768px fine pointer', () => {
  test.use({ viewport: { width: 768, height: 1024 } });

  test('rows stay compact with hover-only edit/delete', async ({ page }) => {
    await todoStore(page);
    await openTodos(page, target => target.click());
    await page.mouse.move(0, 0);
    const note = rowOf(page, NOTE);
    expect((await control(note, 'Select', NOTE).boundingBox())!).toMatchObject({ width: 16, height: 16 });
    const edit = control(note, 'Edit', NOTE);
    expect((await edit.boundingBox())!).toMatchObject({ width: 20, height: 20 });
    await expect.poll(() => paintedOpacity(edit)).toBe(0);
  });
});

test.describe('desktop', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('rows stay compact and reveal edit/delete on hover', async ({ page }) => {
    const { writes } = await todoStore(page);
    await openTodos(page, target => target.click());
    await page.mouse.move(0, 0);
    const note = rowOf(page, NOTE);
    const edit = control(note, 'Edit', NOTE);
    // One dense row with no action bar under the note: the original 16px checkbox,
    // 20px check and 20px icon buttons beside it.
    const noteText = (await note.getByText(NOTE).boundingBox())!;
    const noteContent = (await note.getByText(NOTE).locator('..').boundingBox())!;
    expect((await note.boundingBox())!.height).toBeLessThanOrEqual(noteContent.height + 24);
    expect((await edit.boundingBox())!.y).toBeLessThan(noteText.y + 12);
    expect((await control(note, 'Select', NOTE).boundingBox())!).toMatchObject({ width: 16, height: 16 });
    expect((await control(note, 'Complete', NOTE).boundingBox())!).toMatchObject({ width: 20, height: 20 });
    expect((await edit.boundingBox())!).toMatchObject({ width: 20, height: 20 });
    await expect.poll(() => paintedOpacity(edit)).toBe(0);

    await note.hover();
    await expect.poll(() => paintedOpacity(edit)).toBe(1);
    await edit.click();
    const editor = page.getByRole('textbox', { name: 'Edit todo' });
    await editor.fill('Discarded edit');
    await editor.press('Escape');
    await expect(page.getByText(NOTE, { exact: true })).toBeVisible();
    await expect(edit).toBeFocused();
    await edit.click();
    await editor.fill('Resume crawls from the last checkpoint');
    // Clicking away saves, as before.
    await page.getByRole('heading', { name: 'To-Dos' }).click();
    await expect(page.getByText('Resume crawls from the last checkpoint', { exact: true })).toBeVisible();

    const long = rowOf(page, LONG);
    const grip = long.getByRole('button', { name: `Reorder todo: ${LONG}` });
    const gripBox = (await grip.boundingBox())!;
    const target = (await page.getByText('Resume crawls from the last checkpoint').boundingBox())!;
    await page.mouse.move(gripBox.x + gripBox.width / 2, gripBox.y + gripBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(gripBox.x + gripBox.width / 2, target.y, { steps: 10 });
    await page.mouse.move(gripBox.x + gripBox.width / 2, target.y - 4, { steps: 4 });
    await page.mouse.up();
    await expect.poll(() => writes.length).toBe(2);
    // The drop is finished once dnd-kit's drag overlay (a second copy of the
    // dragged to-do) has animated into place and unmounted. The pointer sensor
    // swallows every click for 50ms after the button lifts, so clicking the
    // accordion as soon as the reorder is sent can be lost.
    await expect(page.getByText(LONG, { exact: true })).toHaveCount(1);
    await expect(page.getByTestId('repo-todo-row')).toHaveText([/Check invoice dates/, /Resume crawls from the last checkpoint/]);
    // Reordering active rows leaves the category's completed to-do in place.
    const completed = page.getByRole('button', { name: /Completed Items/ });
    await expect(completed).toContainText('1');

    await completed.click();
    await expect(completed).toHaveAttribute('aria-expanded', 'true');
    const done = rowOf(page, DONE);
    await expect(done).toHaveCount(1);
    const remove = control(done, 'Delete', DONE);
    await expect(remove).toBeAttached();
    await page.mouse.move(0, 0);
    await expect.poll(() => paintedOpacity(remove)).toBe(0);
    await done.hover();
    await expect.poll(() => paintedOpacity(remove)).toBeGreaterThan(0.5);
    await remove.click();
    await expect(page.getByText(DONE)).toHaveCount(0);

    expect(writes).toEqual([
      { method: 'PUT', path: '/api/repos/todos/t-note', body: { content: 'Resume crawls from the last checkpoint' } },
      { method: 'POST', path: '/api/repos/todos/reorder', body: { repository: 'integry/propr', items: [{ id: 't-long', orderIndex: 0 }, { id: 't-note', orderIndex: 1 }] } },
      { method: 'DELETE', path: '/api/repos/todos/t-done', body: null },
    ]);
  });

  test('keyboard focus exposes every row action', async ({ page }) => {
    const { writes } = await todoStore(page);
    await openTodos(page, target => target.click());
    await page.mouse.move(0, 0);
    const note = rowOf(page, NOTE);
    const select = control(note, 'Select', NOTE);
    const edit = control(note, 'Edit', NOTE);

    await note.getByRole('button', { name: `Reorder todo: ${NOTE}` }).focus();
    await page.keyboard.press('Tab');
    await expect(select).toBeFocused();
    await page.keyboard.press('Space');
    await expect(select).toHaveAttribute('aria-pressed', 'true');
    await page.keyboard.press('Tab');
    await expect(control(note, 'Complete', NOTE)).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(edit).toBeFocused();
    // Focus, not hover, reveals the strip, with a visible focus ring.
    await expect.poll(() => paintedOpacity(edit)).toBe(1);
    expect(await edit.evaluate(node => getComputedStyle(node).boxShadow)).not.toBe('none');
    await capture(page, 'todo-rows-desktop-keyboard-focus');
    await page.keyboard.press('Enter');
    const editor = page.getByRole('textbox', { name: 'Edit todo' });
    await expect(editor).toBeFocused();
    await page.keyboard.press('End');
    await page.keyboard.type(' quickly');
    await page.keyboard.press('Enter');
    await expect(page.getByText(`${NOTE} quickly`, { exact: true })).toBeVisible();
    const edited = rowOf(page, `${NOTE} quickly`);
    // Leaving the editor from the keyboard hands focus back to Edit.
    await expect(control(edited, 'Edit', `${NOTE} quickly`)).toBeFocused();
    await page.keyboard.press('Tab');
    const remove = control(edited, 'Delete', `${NOTE} quickly`);
    await expect(remove).toBeFocused();
    await expect.poll(() => paintedOpacity(remove)).toBe(1);

    const long = rowOf(page, LONG);
    await control(long, 'Complete', LONG).focus();
    await page.keyboard.press('Enter');
    const completed = page.getByRole('button', { name: /Completed Items/ });
    await completed.focus();
    await page.keyboard.press('Enter');
    await expect(completed).toHaveAttribute('aria-expanded', 'true');
    const restore = control(rowOf(page, DONE), 'Restore', DONE);
    await restore.focus();
    await page.keyboard.press('Tab');
    await expect(rowOf(page, DONE).getByRole('link', { name: '#7' })).toBeFocused();
    await page.keyboard.press('Tab');
    const doneDelete = control(rowOf(page, DONE), 'Delete', DONE);
    await expect(doneDelete).toBeFocused();
    await expect.poll(() => paintedOpacity(doneDelete)).toBeGreaterThan(0.5);
    await restore.focus();
    await page.keyboard.press('Enter');
    await expect(control(rowOf(page, DONE), 'Complete', DONE)).toBeVisible();

    expect(writes).toEqual([
      { method: 'PUT', path: '/api/repos/todos/t-note', body: { content: `${NOTE} quickly` } },
      { method: 'PUT', path: '/api/repos/todos/t-long', body: { isCompleted: true } },
      { method: 'PUT', path: '/api/repos/todos/t-done', body: { isCompleted: false } },
    ]);
    await expect(page.getByRole('button', { name: 'Create Plan from 1 Item' })).toBeVisible();
  });
});
