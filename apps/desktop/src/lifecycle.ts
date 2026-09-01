import type { LocalLifecycleOperationResult, LocalLifecycleStatus } from './shared/contract';

export interface LocalLifecycleHost {
  running(signal?: AbortSignal): Promise<boolean>;
  start(signal?: AbortSignal): Promise<void>;
  stop(signal?: AbortSignal): Promise<void>;
}

const lifecycleFailure = 'Local runtime operation failed. Review the protected desktop log for details.';

export class LocalLifecycleController {
  #status: LocalLifecycleStatus = { state: 'disconnected' };
  readonly #host?: LocalLifecycleHost;
  readonly #diagnose?: (event: string, fields: Record<string, unknown>) => void;

  constructor(host?: LocalLifecycleHost, diagnose?: (event: string, fields: Record<string, unknown>) => void) {
    this.#host = host;
    this.#diagnose = diagnose;
  }

  async status(signal?: AbortSignal): Promise<LocalLifecycleStatus> {
    if (!this.#host) return { ...this.#status };
    try {
      this.#status = { state: await this.#host.running(signal) ? 'connected' : 'disconnected' };
    } catch (error) {
      this.#diagnose?.('desktop.lifecycle.status_failed', { error });
      this.#status = { state: 'error', detail: lifecycleFailure };
    }
    return { ...this.#status };
  }

  async start(signal?: AbortSignal): Promise<LocalLifecycleOperationResult> {
    return this.#operate('starting', 'connected', () => this.#host?.start(signal));
  }

  async stop(signal?: AbortSignal): Promise<LocalLifecycleOperationResult> {
    return this.#operate('stopping', 'disconnected', () => this.#host?.stop(signal));
  }

  async restart(signal?: AbortSignal): Promise<LocalLifecycleOperationResult> {
    if (!this.#host) return this.#unsupported();
    this.#status = { state: 'stopping' };
    try {
      await this.#host.stop(signal);
      this.#status = { state: 'starting' };
      await this.#host.start(signal);
      this.#status = { state: 'connected' };
      return { ok: true, status: { ...this.#status } };
    } catch (error) {
      this.#diagnose?.('desktop.lifecycle.restart_failed', { error });
      this.#status = { state: 'error', detail: lifecycleFailure };
      throw new Error(lifecycleFailure);
    }
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

  async #operate(
    transitional: 'starting' | 'stopping',
    completed: 'connected' | 'disconnected',
    operation: () => Promise<void> | undefined,
  ): Promise<LocalLifecycleOperationResult> {
    if (!this.#host) return this.#unsupported();
    this.#status = { state: transitional };
    try {
      await operation();
      this.#status = { state: completed };
      return { ok: true, status: { ...this.#status } };
    } catch (error) {
      this.#diagnose?.(`desktop.lifecycle.${transitional}_failed`, { error });
      this.#status = { state: 'error', detail: lifecycleFailure };
      throw new Error(lifecycleFailure);
    }
  }
}
