import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DesktopOperationCoordinator, coordinatorBusyError, coordinatorShutdownError } from './operation-coordinator';

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
};

describe('desktop main-process operation coordinator', () => {
  it('rejects setup-vs-lifecycle races before the second host action', async () => {
    const coordinator = new DesktopOperationCoordinator();
    const release = deferred<void>();
    let lifecycleActions = 0;
    const setup = coordinator.run('setup', async () => release.promise);
    await assert.rejects(coordinator.run('start', async () => { lifecycleActions += 1; }), new RegExp(coordinatorBusyError));
    assert.equal(lifecycleActions, 0);
    release.resolve();
    await setup;
  });

  it('allows cancellation only for setup and awaits its cleanup settlement', async () => {
    const coordinator = new DesktopOperationCoordinator();
    const cleaned = deferred<void>();
    let cancelCalled = false;
    const setup = coordinator.run('setup', signal => new Promise<void>(resolve => {
      const abort = () => { void cleaned.promise.then(resolve); };
      if (signal.aborted) abort();
      else signal.addEventListener('abort', abort, { once: true });
    }));
    const cancellation = coordinator.cancel(async () => { cancelCalled = true; await cleaned.promise; });
    await Promise.resolve();
    assert.equal(cancelCalled, true);
    let settled = false;
    void cancellation.then(() => { settled = true; });
    await Promise.resolve();
    assert.equal(settled, false);
    cleaned.resolve();
    await Promise.all([setup, cancellation]);
  });

  it('coalesces concurrent cancellation requests into one cleanup', async () => {
    const coordinator = new DesktopOperationCoordinator();
    const cleaned = deferred<void>();
    const setup = coordinator.run('setup', signal => new Promise<void>(resolve => {
      const abort = () => resolve();
      if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
    }));
    let cleanupCalls = 0;
    const cancel = () => { cleanupCalls += 1; return cleaned.promise; };
    const first = coordinator.cancel(cancel);
    const second = coordinator.cancel(cancel);
    await setup;
    assert.equal(cleanupCalls, 1);
    cleaned.resolve();
    await Promise.all([first, second]);
  });

  it('makes shutdown idempotent, aborts active work, and rejects late operations', async () => {
    const coordinator = new DesktopOperationCoordinator();
    let aborted = false;
    const active = coordinator.run('stop', signal => new Promise<void>(resolve => {
      const abort = () => { aborted = true; resolve(); };
      if (signal.aborted) abort();
      else signal.addEventListener('abort', abort, { once: true });
    }));
    let cleanup = 0;
    const shutdown = coordinator.shutdown(async () => { cleanup += 1; });
    assert.equal(coordinator.shutdown(async () => { cleanup += 10; }), shutdown);
    await Promise.all([active, shutdown]);
    assert.equal(aborted, true);
    assert.equal(cleanup, 1);
    await assert.rejects(coordinator.run('start', async () => undefined), new RegExp(coordinatorShutdownError));
  });

  it('runs shutdown cleanup only after the aborted host operation settles', async () => {
    const coordinator = new DesktopOperationCoordinator();
    const release = deferred<void>();
    let cleanupStarted = false;
    const active = coordinator.run('start', signal => new Promise<void>(resolve => {
      const abort = () => { void release.promise.then(resolve); };
      if (signal.aborted) abort();
      else signal.addEventListener('abort', abort, { once: true });
    }));
    const shutdown = coordinator.shutdown(async () => { cleanupStarted = true; });
    await Promise.resolve();
    assert.equal(cleanupStarted, false);
    release.resolve();
    await Promise.all([active, shutdown]);
    assert.equal(cleanupStarted, true);
  });

  it('awaits in-flight cancellation cleanup before shutdown cleanup', async () => {
    const coordinator = new DesktopOperationCoordinator();
    const cancelled = deferred<void>();
    const setup = coordinator.run('setup', signal => new Promise<void>(resolve => {
      const abort = () => resolve();
      if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
    }));
    const cancel = coordinator.cancel(() => cancelled.promise);
    let shutdownCleanup = false;
    const shutdown = coordinator.shutdown(async () => { shutdownCleanup = true; });
    await setup;
    await Promise.resolve();
    assert.equal(shutdownCleanup, false);
    cancelled.resolve();
    await Promise.all([cancel, shutdown]);
    assert.equal(shutdownCleanup, true);
  });

  it('settles cancel-vs-shutdown races only after shared setup cleanup', async () => {
    const coordinator = new DesktopOperationCoordinator();
    const cleanup = deferred<void>();
    const setup = coordinator.run('setup', signal => new Promise<void>(resolve => {
      const abort = () => { void cleanup.promise.then(resolve); };
      if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
    }));
    const cancel = coordinator.cancel(() => cleanup.promise);
    const shutdown = coordinator.shutdown(() => cleanup.promise);
    let settled = false;
    void Promise.all([cancel, shutdown]).then(() => { settled = true; });
    await Promise.resolve();
    assert.equal(settled, false);
    cleanup.resolve();
    await Promise.all([setup, cancel, shutdown]);
  });
});
