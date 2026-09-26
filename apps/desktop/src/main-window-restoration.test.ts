import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createMainWindowRestorer } from './main-window-restoration';

class FakeWindow {
  destroyed = false;
  minimized = false;
  restores = 0;
  shows = 0;
  focuses = 0;

  isDestroyed(): boolean { return this.destroyed; }
  isMinimized(): boolean { return this.minimized; }
  restore(): void { this.restores += 1; this.minimized = false; }
  show(): void { this.shows += 1; }
  focus(): void { this.focuses += 1; }
  destroy(): void { this.destroyed = true; }
}

const deferred = <Value>() => {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>(settle => { resolve = settle; });
  return { promise, resolve };
};

const nextTurn = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

describe('main-window restoration', () => {
  it('restores, shows, and focuses an existing minimized window on every activation', () => {
    const current = new FakeWindow();
    current.minimized = true;
    let creations = 0;
    const restorer = createMainWindowRestorer({
      getWindow: () => current,
      setWindow: () => { assert.fail('the existing-window path must not replace the window'); },
      createWindow: async () => { creations += 1; return new FakeWindow(); },
      shutdownStarted: () => false,
      creationFailed: assert.fail,
    });

    restorer.restore();
    restorer.restore();

    assert.equal(current.restores, 1, 'only the minimized activation needs native restore');
    assert.equal(current.shows, 2);
    assert.equal(current.focuses, 2);
    assert.equal(creations, 0, 'the normal creation path is not used while a live window exists');
  });

  it('coalesces concurrent restore requests into one pending window creation', async () => {
    const pending = deferred<FakeWindow>();
    const created = new FakeWindow();
    const replacement = new FakeWindow();
    let current: FakeWindow | null = null;
    let creations = 0;
    const restorer = createMainWindowRestorer({
      getWindow: () => current,
      setWindow: window => { current = window; },
      createWindow: () => {
        creations += 1;
        return creations === 1 ? pending.promise : Promise.resolve(replacement);
      },
      shutdownStarted: () => false,
      creationFailed: assert.fail,
    });

    restorer.restore();
    restorer.restore();
    assert.equal(creations, 1);

    pending.resolve(created);
    await nextTurn();
    assert.equal(current, created);
    assert.equal(created.shows, 1);
    assert.equal(created.focuses, 1);
    assert.equal(created.destroyed, false);

    created.destroyed = true;
    restorer.restore();
    await nextTurn();
    assert.equal(creations, 2, 'settlement clears the pending creation');
    assert.equal(current, replacement);
  });

  it('discards a restored window if shutdown starts while creation is pending', async () => {
    const pending = deferred<FakeWindow>();
    const created = new FakeWindow();
    let current: FakeWindow | null = null;
    let shutdownStarted = false;
    const restorer = createMainWindowRestorer({
      getWindow: () => current,
      setWindow: window => { current = window; },
      createWindow: () => pending.promise,
      shutdownStarted: () => shutdownStarted,
      creationFailed: assert.fail,
    });

    restorer.restore();
    shutdownStarted = true;
    pending.resolve(created);
    await nextTurn();

    assert.equal(current, null);
    assert.equal(created.destroyed, true);
    assert.equal(created.shows, 0);
    assert.equal(created.focuses, 0);
  });
});
