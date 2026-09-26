import type { LocalLifecycleOperationResult, LocalLifecycleStatus } from './shared/contract';

/**
 * Stable renderer-facing lifecycle boundary. Runtime installation and process
 * control are deliberately absent until the user-approved setup work lands.
 */
export class LocalLifecycleController {
  #status: LocalLifecycleStatus = { state: 'disconnected' };

  status(): LocalLifecycleStatus {
    return { ...this.#status };
  }

  start(): LocalLifecycleOperationResult {
    return this.#unsupported();
  }

  stop(): LocalLifecycleOperationResult {
    return this.#unsupported();
  }

  restart(): LocalLifecycleOperationResult {
    return this.#unsupported();
  }

  async shutdown(): Promise<void> {
    this.#status = { state: 'disconnected' };
  }

  #unsupported(): LocalLifecycleOperationResult {
    return {
      ok: false,
      code: 'not-implemented',
      status: {
        ...this.#status,
        detail: 'Local runtime management is not available in this desktop scaffold.',
      },
    };
  }
}
