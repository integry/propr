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
): DesktopShutdownCoordinator => {
  let started = false;
  let completion: Promise<void> | null = null;

  return {
    beforeQuit(event) {
      if (started) return;
      event.preventDefault();
      started = true;
      options.onStarted();
      options.ipc.close();
      options.sessionSecurity.close();
      options.disposeRendererProtocol();
      completion = Promise.allSettled([
        options.credentials.dispose(),
        options.lifecycle.shutdown(),
        options.ipc.awaitIdle(),
      ]).then(async results => {
        for (const result of results) {
          if (result.status === 'rejected') {
            options.log('error', 'desktop.app.shutdown_failed', { error: result.reason });
          }
        }
        await options.profiles.close().catch(error => {
          options.log('error', 'desktop.profile_store.shutdown_failed', { error });
        });
        options.sessionSecurity.dispose();
        options.ipc.dispose();
        const window = options.getWindow();
        if (window && !window.isDestroyed()) window.destroy();
        options.log('info', 'desktop.app.shutdown');
        options.quit();
      });
    },
    get started() { return started; },
    awaitFinished() { return completion ?? Promise.resolve(); },
  };
};
