/**
 * An inert socket context value for tests and packaged-renderer fixtures.
 *
 * The desktop packaged-acceptance fixtures render real production components
 * (`Layout`, `Dashboard`, the native menu shell) against a stubbed socket, and
 * `apps/desktop/tsconfig.json` only typechecks `src/**` — so a hand-written
 * object literal in a fixture drifts from `SocketContextValue` silently, and the
 * first hook that calls a missing member fails at runtime inside a packaged
 * Electron window. Building the stub here instead means `propr-ui`'s typecheck,
 * which `npm run desktop:typecheck` runs, fails the moment the context gains a
 * member the stub does not answer.
 *
 * Every function is a no-op: a subscription returns its unsubscriber and nothing
 * is ever pushed. Callers that need to deliver frames should override the
 * relevant `on…` member rather than assembling their own value.
 */

import type { SocketContextValue } from '../contexts/SocketContext';

const noop = () => undefined;
const subscribe = () => noop;

export function createInertSocketContextValue(
  overrides: Partial<SocketContextValue> = {},
): SocketContextValue {
  return {
    socket: null,
    isConnected: false,
    subscribeToTask: noop,
    unsubscribeFromTask: noop,
    subscribeToDraft: noop,
    unsubscribeFromDraft: noop,
    subscribeToIndexing: noop,
    unsubscribeFromIndexing: noop,
    subscribeToIndexingUpdates: noop,
    unsubscribeFromIndexingUpdates: noop,
    subscribeToQueueStats: noop,
    unsubscribeFromQueueStats: noop,
    subscribeToTaskLive: noop,
    unsubscribeFromTaskLive: noop,
    subscribeToActivity: noop,
    unsubscribeFromActivity: noop,
    onTaskUpdate: subscribe,
    onDraftUpdate: subscribe,
    onIndexingUpdate: subscribe,
    onQueueStatsUpdate: subscribe,
    onTaskLiveUpdate: subscribe,
    onActivityUpdate: subscribe,
    onGoalUpdate: subscribe,
    ...overrides,
  };
}
