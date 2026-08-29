import type { LocalLifecycleOperationResult, LocalLifecycleStatus } from './shared/contract';

export interface LocalLifecycleHost {
  running(): Promise<boolean>;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export class LocalLifecycleController {
  #status: LocalLifecycleStatus = { state: 'disconnected' };
  readonly #host?: LocalLifecycleHost;

  constructor(host?: LocalLifecycleHost) {
    this.#host = host;
  }

  async status(): Promise<LocalLifecycleStatus> {
    if (!this.#host) return { ...this.#status };
    try {
      this.#status = { state: await this.#host.running() ? 'connected' : 'disconnected' };
    } catch (error) {
      this.#status = { state: 'error', detail: (error as Error).message };
    }
    return { ...this.#status };
  }

  async start(): Promise<LocalLifecycleOperationResult> {
    return this.#operate('starting', 'connected', () => this.#host?.start());
  }

  async stop(): Promise<LocalLifecycleOperationResult> {
    return this.#operate('stopping', 'disconnected', () => this.#host?.stop());
  }

  async restart(): Promise<LocalLifecycleOperationResult> {
    if (!this.#host) return this.#unsupported();
    this.#status = { state: 'stopping' };
    try {
      await this.#host.stop();
      this.#status = { state: 'starting' };
      await this.#host.start();
      this.#status = { state: 'connected' };
      return { ok: true, status: { ...this.#status } };
    } catch (error) {
      this.#status = { state: 'error', detail: (error as Error).message };
      throw error;
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
      this.#status = { state: 'error', detail: (error as Error).message };
      throw error;
    }
  }
}
