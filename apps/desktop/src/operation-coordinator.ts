export type DesktopHostOperation = 'setup' | 'start' | 'stop' | 'restart' | 'status' | 'cancel';

export const coordinatorBusyError = 'Another local runtime operation is already in progress.';
export const coordinatorShutdownError = 'ProPR Desktop is shutting down.';

interface ActiveOperation {
  kind: DesktopHostOperation;
  controller: AbortController;
  promise: Promise<unknown>;
}

/** Single main-process gate for every local setup/lifecycle host action. */
export class DesktopOperationCoordinator {
  #active: ActiveOperation | null = null;
  #cancellation: Promise<unknown> | null = null;
  #shutdown: Promise<void> | null = null;

  run<T>(kind: DesktopHostOperation, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.#shutdown) return Promise.reject(new Error(coordinatorShutdownError));
    if (this.#active || this.#cancellation) return Promise.reject(new Error(coordinatorBusyError));
    const controller = new AbortController();
    const active = { kind, controller, promise: Promise.resolve() } as ActiveOperation;
    const promise = Promise.resolve().then(() => operation(controller.signal)).finally(() => {
      if (this.#active === active) this.#active = null;
    });
    active.promise = promise;
    this.#active = active;
    return promise;
  }

  async cancel(cancelSetup: () => Promise<unknown>): Promise<unknown> {
    if (this.#shutdown) throw new Error(coordinatorShutdownError);
    if (this.#cancellation) return this.#cancellation;
    const cancellation = (async () => {
      const active = this.#active;
      if (!active) return this.run('cancel', async () => cancelSetup());
      if (active.kind !== 'setup') throw new Error(coordinatorBusyError);
      active.controller.abort();
      const cleanup = cancelSetup();
      await Promise.allSettled([active.promise, cleanup]);
      return cleanup;
    })();
    this.#cancellation = cancellation;
    try {
      return await cancellation;
    } finally {
      if (this.#cancellation === cancellation) this.#cancellation = null;
    }
  }

  shutdown(cleanup: () => Promise<void>): Promise<void> {
    if (this.#shutdown) return this.#shutdown;
    const active = this.#active;
    const cancellation = this.#cancellation;
    active?.controller.abort();
    this.#shutdown = (async () => {
      await Promise.allSettled([
        ...(active ? [active.promise] : []),
        ...(cancellation ? [cancellation] : []),
      ]);
      await cleanup();
    })();
    return this.#shutdown;
  }
}
