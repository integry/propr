import type { RegisteredIpcHandlers } from './ipc';

interface ShutdownEvent {
  preventDefault(): void;
}

interface DestructibleWindow {
  isDestroyed(): boolean;
  destroy(): void;
}

interface ShutdownOptions {
  credentials: { dispose(): Promise<void> };
  lifecycle: { shutdown(): Promise<void> };
  ipc: RegisteredIpcHandlers;
  profiles: { close(): Promise<void> };
  sessionSecurity: { close(): void; dispose(): void };
  disposeRendererProtocol(): void;
  getWindow(): DestructibleWindow | null;
  quit(): void;
  onStarted(): void;
  log(level: 'info' | 'error', event: string, fields?: Record<string, unknown>): void;
}

interface ShutdownCoordinatorOptions {
  drainTimeoutMs?: number;
}

export interface DesktopShutdownCoordinator {
  beforeQuit(event: ShutdownEvent): void;
  readonly started: boolean;
  awaitFinished(): Promise<void>;
}

/**
 * The single production shutdown order used by Electron and lifecycle tests.
 * Admission closes synchronously; admitted service/IPC work drains before the
 * profile store, session hooks, handlers, and renderer window are destroyed.
 */
export const createDesktopShutdownCoordinator = (
  options: ShutdownOptions,
  coordinatorOptions: ShutdownCoordinatorOptions = {},
): DesktopShutdownCoordinator => {
  let state: 'idle' | 'draining' | 'allow-final-quit' | 'finished' = 'idle';
  let completion: Promise<void> | null = null;
  const drainTimeoutMs = coordinatorOptions.drainTimeoutMs ?? 15_000;
  const step = (name: string): void => options.log('info', 'desktop.app.shutdown_step', { step: name });
  const bounded = async (promise: Promise<unknown>, phase: string): Promise<void> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = await Promise.race([
      promise.then(() => false, error => {
        options.log('error', 'desktop.app.shutdown_failed', { phase, error });
        return false;
      }),
      new Promise<true>(resolve => {
        timer = setTimeout(() => resolve(true), drainTimeoutMs);
      }),
    ]);
    if (timer) clearTimeout(timer);
    if (timedOut) options.log('error', 'desktop.app.shutdown_forced', { phase, drainTimeoutMs });
  };

  return {
    beforeQuit(event) {
      if (state === 'allow-final-quit') {
        state = 'finished';
        return;
      }
      event.preventDefault();
      if (state !== 'idle') {
        if (state === 'draining') options.log('info', 'desktop.app.shutdown_retry');
        return;
      }
      state = 'draining';
      options.onStarted();
      step('admission-closed');
      options.ipc.close();
      step('ipc-closed');
      options.sessionSecurity.close();
      step('session-closed');
      options.disposeRendererProtocol();
      step('protocol-disposed');
      step('credentials-dispose-started');
      const credentialDrain = options.credentials.dispose();
      step('authentication-cleared');
      const lifecycleDrain = options.lifecycle.shutdown();
      step('lifecycle-drain-started');
      const ipcDrain = options.ipc.awaitIdle();
      step('ipc-drain-started');
      completion = bounded(Promise.allSettled([
        credentialDrain,
        lifecycleDrain,
        ipcDrain,
      ]).then(results => {
        for (const result of results) if (result.status === 'rejected') throw result.reason;
      }), 'service-drain').then(async () => {
        step('service-drain-finished');
        step('profiles-close-started');
        await bounded(options.profiles.close(), 'profile-store');
        step('profiles-close-finished');
        options.sessionSecurity.dispose();
        step('session-disposed');
        options.ipc.dispose();
        step('ipc-disposed');
        const window = options.getWindow();
        if (window && !window.isDestroyed()) window.destroy();
        step('window-destroyed');
        options.log('info', 'desktop.app.shutdown');
        state = 'allow-final-quit';
        step('final-quit');
        options.quit();
      });
    },
    get started() { return state !== 'idle'; },
    awaitFinished() { return completion ?? Promise.resolve(); },
  };
};
