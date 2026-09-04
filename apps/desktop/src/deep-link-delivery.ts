import type {
  DesktopDeepLinkAcknowledgement,
  DesktopDeepLinkConsumption,
  DesktopDeepLinkDelivery,
} from './shared/contract';

export const DEFAULT_DEEP_LINK_ACKNOWLEDGEMENT_TIMEOUT_MS = 5_000;
export const NATIVE_SMOKE_DEEP_LINK_ACKNOWLEDGEMENT_TIMEOUT_MS = 15_000;

export const deepLinkAcknowledgementTimeoutMs = (nativeArtifactSmoke: boolean): number => (
  nativeArtifactSmoke
    ? NATIVE_SMOKE_DEEP_LINK_ACKNOWLEDGEMENT_TIMEOUT_MS
    : DEFAULT_DEEP_LINK_ACKNOWLEDGEMENT_TIMEOUT_MS
);

export interface DeepLinkWindow {
  isDestroyed(): boolean;
  webContents: {
    isLoading(): boolean;
    send(channel: string, value: DesktopDeepLinkDelivery): void;
  };
}

/** Coordinates protocol delivery across the window creation/load boundary. */
export class DeepLinkDelivery<TWindow extends DeepLinkWindow> {
  private window: TWindow | null = null;
  private readonly recentlyAccepted = new Map<string, number>();
  private deliveryId = 0;
  private draining = false;
  private closed = false;
  private active: {
    acknowledged: boolean;
    delivery: DesktopDeepLinkDelivery;
    resolve: (consumption: DesktopDeepLinkConsumption) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
    window: TWindow;
  } | null = null;
  private readonly idleWaiters = new Set<() => void>();

  constructor(
    private readonly channel: string,
    private readonly pending: string[] = [],
    private readonly delivered: (
      value: string,
      consumption: DesktopDeepLinkConsumption,
      window: TWindow,
    ) => void | Promise<void> = () => undefined,
    private readonly failed: (error: Error) => void = () => undefined,
    private readonly now: () => number = Date.now,
    private readonly duplicateWindowMs = 1_000,
    private readonly acknowledgementTimeoutMs = DEFAULT_DEEP_LINK_ACKNOWLEDGEMENT_TIMEOUT_MS,
  ) {
    if (!Number.isFinite(duplicateWindowMs) || duplicateWindowMs < 0
      || !Number.isFinite(acknowledgementTimeoutMs) || acknowledgementTimeoutMs <= 0) {
      throw new Error('Desktop deep-link timing configuration is invalid');
    }
    const uniquePending = [...new Set(pending)];
    pending.splice(0, pending.length, ...uniquePending);
    const acceptedAt = this.now();
    uniquePending.forEach(value => this.recentlyAccepted.set(value, acceptedAt));
  }

  deliver(value: string): boolean {
    if (this.closed) return false;
    const acceptedAt = this.now();
    const previous = this.recentlyAccepted.get(value);
    if (previous !== undefined && acceptedAt - previous <= this.duplicateWindowMs) return false;
    this.recentlyAccepted.set(value, acceptedAt);
    for (const [candidate, time] of this.recentlyAccepted) {
      if (acceptedAt - time > this.duplicateWindowMs) this.recentlyAccepted.delete(candidate);
    }
    this.pending.push(value);
    void this.drain();
    return true;
  }

  didFinishLoad(window: TWindow): void {
    if (this.window === window) this.flush(window);
  }

  setWindow(window: TWindow): void {
    this.window = window;
    void this.drain();
  }

  clearWindow(window: TWindow): void {
    if (this.window === window) this.window = null;
  }

  acknowledge(window: TWindow, acknowledgement: DesktopDeepLinkAcknowledgement): boolean {
    if (!this.active || this.active.acknowledged || this.active.window !== window
      || acknowledgement.deliveryId !== this.active.delivery.deliveryId
      || acknowledgement.url !== this.active.delivery.url) return false;
    this.active.acknowledged = true;
    clearTimeout(this.active.timer);
    this.active.resolve(acknowledgement.consumption);
    return true;
  }

  acknowledgeSender(sender: unknown, acknowledgement: DesktopDeepLinkAcknowledgement): boolean {
    if (!this.active || this.active.window.webContents !== sender) return false;
    return this.acknowledge(this.active.window, acknowledgement);
  }

  whenIdle(): Promise<void> {
    if (!this.draining && !this.active && this.pending.length === 0) return Promise.resolve();
    return new Promise(resolve => this.idleWaiters.add(resolve));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.pending.splice(0);
    this.active?.reject(new Error('Desktop deep-link delivery closed during shutdown'));
    if (!this.draining && !this.active) {
      this.idleWaiters.forEach(resolve => resolve());
      this.idleWaiters.clear();
    }
  }

  private flush(_window: TWindow): void {
    void this.drain();
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.pending.length > 0) {
        const window = this.window;
        if (!window || window.isDestroyed() || window.webContents.isLoading()) return;
        const value = this.pending.shift();
        if (value === undefined) return;
        const delivery = { deliveryId: ++this.deliveryId, url: value };
        let resolveAcknowledgement!: (value: DesktopDeepLinkConsumption) => void;
        let rejectAcknowledgement!: (error: Error) => void;
        const acknowledgement = new Promise<DesktopDeepLinkConsumption>((resolve, reject) => {
          resolveAcknowledgement = resolve;
          rejectAcknowledgement = reject;
        });
        const timer = setTimeout(
          () => rejectAcknowledgement(new Error('Desktop renderer deep-link acknowledgement deadline expired')),
          this.acknowledgementTimeoutMs,
        );
        this.active = {
          acknowledged: false,
          delivery,
          resolve: resolveAcknowledgement,
          reject: rejectAcknowledgement,
          timer,
          window,
        };
        window.webContents.send(this.channel, delivery);
        try {
          const consumption = await acknowledgement;
          await this.delivered(value, consumption, window);
        } catch (error) {
          this.pending.splice(0);
          if (!this.closed) {
            this.failed(error instanceof Error ? error : new Error('Desktop renderer deep-link acknowledgement failed'));
          }
          return;
        } finally {
          clearTimeout(timer);
          this.active = null;
        }
      }
    } finally {
      this.draining = false;
      if (!this.active && this.pending.length === 0) {
        this.idleWaiters.forEach(resolve => resolve());
        this.idleWaiters.clear();
      }
    }
  }
}
