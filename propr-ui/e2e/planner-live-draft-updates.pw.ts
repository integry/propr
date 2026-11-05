import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, test, type Page, type WebSocketRoute } from '@playwright/test';
import { fixture, generationUpdate, liveDraftUpdates } from './planner-studio.fixture';

type Interval = ReturnType<typeof setInterval>;

/**
 * Records the intervals `liveDraftUpdates` starts, identified by call site rather than by the
 * fixture's own bookkeeping, along with how often each fires and whether it was cleared.
 */
function watchFixtureIntervals() {
  const realSetInterval = globalThis.setInterval;
  const realClearInterval = globalThis.clearInterval;
  const fired = new Map<Interval, number>();
  const cleared = new Set<unknown>();
  globalThis.setInterval = ((callback: () => void, ms?: number) => {
    if (!new Error().stack?.includes('planner-studio.fixture')) return realSetInterval(callback, ms);
    const timer: Interval = realSetInterval(() => { fired.set(timer, (fired.get(timer) ?? 0) + 1); callback(); }, ms);
    fired.set(timer, 0);
    return timer;
  }) as typeof setInterval;
  globalThis.clearInterval = ((timer?: Interval) => { cleared.add(timer); realClearInterval(timer); }) as typeof clearInterval;
  return {
    timers: () => [...fired.keys()],
    active: () => [...fired.keys()].filter(timer => !cleared.has(timer)),
    fired: () => [...fired.values()].reduce((total, count) => total + count, 0),
    restore: () => {
      globalThis.setInterval = realSetInterval;
      globalThis.clearInterval = realClearInterval;
      // Leave nothing behind for later cases, but only after the assertions above have seen the state.
      fired.forEach((_count, timer) => realClearInterval(timer));
    },
  };
}

let intervals: ReturnType<typeof watchFixtureIntervals>;
test.beforeEach(() => { intervals = watchFixtureIntervals(); });
test.afterEach(() => intervals.restore());

for (const closing of ['page', 'context'] as const) {
  test(`live draft updates stop repeating once the subscribed ${closing} closes`, async ({ browser, baseURL }) => {
    const context = await browser.newContext({ baseURL, serviceWorkers: 'block' });
    try {
      const page = await context.newPage();
      await fixture(page);
      await liveDraftUpdates(page, { 'plan-gathering': [generationUpdate('plan-gathering')] });
      await page.goto('/studio/plan-gathering');
      await expect(page.getByTestId('generation-telemetry').getByText('packages/core/src/services/taskPlanningService.ts')).toBeVisible();
      // The subscribed socket is repeating its updates while the page is open.
      await expect.poll(() => intervals.active().length).toBeGreaterThan(0);
      await expect.poll(() => intervals.fired()).toBeGreaterThan(0);

      await (closing === 'page' ? page.close() : context.close());
      expect(intervals.active()).toEqual([]);
      const firedAtClose = intervals.fired();
      await delay(2_200);
      expect(intervals.active()).toEqual([]);
      expect(intervals.fired()).toBe(firedAtClose);
    } finally {
      await context.close();
    }
  });
}

/** A page and socket stand-in, so teardown races can be ordered exactly rather than hoped for. */
function fakeLiveSocket() {
  const context = new EventEmitter();
  let closed = false;
  let route: ((socket: WebSocketRoute) => void) | undefined;
  const page = Object.assign(new EventEmitter(), {
    context: () => context,
    isClosed: () => closed,
    routeWebSocket: async (_url: string, handler: (socket: WebSocketRoute) => void) => { route = handler; },
  });
  const open = () => {
    const socket = { sent: [] as string[], message: (() => {}) as (text: string) => void, close: () => {} };
    route!({
      send: (text: string) => { socket.sent.push(text); },
      onMessage: (handler: (text: string) => void) => { socket.message = handler; },
      onClose: (handler: () => void) => { socket.close = handler; },
    } as unknown as WebSocketRoute);
    return socket;
  };
  const closePage = () => { closed = true; page.emit('close', page); };
  return { page, context, open, closePage, asPage: page as unknown as Page };
}

const subscribe = (draftId: string) => `42${JSON.stringify(['subscribe:draft', draftId])}`;
const updates = { 'plan-gathering': [{ step: 'gathering', status: 'in_progress' }] };

test('a subscription delivered after the page closes starts no timer', async () => {
  const live = fakeLiveSocket();
  await liveDraftUpdates(live.asPage, updates);
  const socket = live.open();
  socket.message('40');
  live.closePage();
  socket.message(subscribe('plan-gathering'));
  expect(intervals.timers()).toEqual([]);
  expect(socket.sent.filter(text => text.includes('draft:update'))).toEqual([]);
  expect(live.page.listenerCount('close')).toBe(0);
  expect(live.context.listenerCount('close')).toBe(0);
});

test('a socket routed after the page closes is not answered', async () => {
  const live = fakeLiveSocket();
  await liveDraftUpdates(live.asPage, updates);
  live.closePage();
  const socket = live.open();
  socket.message(subscribe('plan-gathering'));
  expect(socket.sent).toEqual([]);
  expect(intervals.timers()).toEqual([]);
});

test('context close stops every socket once, and later close signals are harmless', async () => {
  const live = fakeLiveSocket();
  await liveDraftUpdates(live.asPage, updates);
  // One socket per navigation; both subscribed and repeating.
  const sockets = [live.open(), live.open()];
  sockets.forEach(socket => socket.message(subscribe('plan-gathering')));
  expect(intervals.active()).toHaveLength(2);

  live.context.emit('close', live.context);
  expect(intervals.active()).toEqual([]);
  live.closePage();
  sockets.forEach(socket => socket.close());
  sockets.forEach(socket => socket.message(subscribe('plan-gathering')));
  expect(intervals.timers()).toHaveLength(2);
  expect(live.page.listenerCount('close')).toBe(0);
  expect(live.context.listenerCount('close')).toBe(0);
});

test('a socket closing on its own stops only its timers', async () => {
  const live = fakeLiveSocket();
  await liveDraftUpdates(live.asPage, updates);
  const [first, second] = [live.open(), live.open()];
  first.message(subscribe('plan-gathering'));
  second.message(subscribe('plan-gathering'));
  const [firstTimer, secondTimer] = intervals.timers();
  first.close();
  expect(intervals.active()).toEqual([secondTimer]);
  expect(intervals.active()).not.toContain(firstTimer);
  // The open socket keeps the existing handshake, ack and timestamped update shape.
  expect(second.sent[0]).toMatch(/^0\{"sid":"preview"/);
  second.message('40');
  expect(second.sent).toContain('40{"sid":"preview-socket"}');
  const [, update] = JSON.parse(second.sent[1].slice(2)) as [string, Record<string, unknown>];
  expect(update).toMatchObject({ eventType: 'draft:update', draftId: 'plan-gathering', step: 'gathering', status: 'in_progress' });
  expect(Number.isNaN(Date.parse(String(update.timestamp)))).toBe(false);
  live.closePage();
  expect(intervals.active()).toEqual([]);
});
