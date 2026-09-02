export interface DeepLinkWindow {
  isDestroyed(): boolean;
  webContents: {
    isLoading(): boolean;
    send(channel: string, value: string): void;
  };
}

/** Coordinates protocol delivery across the window creation/load boundary. */
export class DeepLinkDelivery<TWindow extends DeepLinkWindow> {
  private window: TWindow | null = null;
  private readonly recentlyAccepted = new Map<string, number>();

  constructor(
    private readonly channel: string,
    private readonly pending: string[] = [],
    private readonly delivered: (value: string) => void = () => undefined,
    private readonly now: () => number = Date.now,
    private readonly duplicateWindowMs = 1_000,
  ) {
    if (!Number.isFinite(duplicateWindowMs) || duplicateWindowMs < 0) {
      throw new Error('Desktop deep-link duplicate window must be non-negative');
    }
    const uniquePending = [...new Set(pending)];
    pending.splice(0, pending.length, ...uniquePending);
    const acceptedAt = this.now();
    uniquePending.forEach(value => this.recentlyAccepted.set(value, acceptedAt));
  }

  deliver(value: string): boolean {
    const acceptedAt = this.now();
    const previous = this.recentlyAccepted.get(value);
    if (previous !== undefined && acceptedAt - previous <= this.duplicateWindowMs) return false;
    this.recentlyAccepted.set(value, acceptedAt);
    for (const [candidate, time] of this.recentlyAccepted) {
      if (acceptedAt - time > this.duplicateWindowMs) this.recentlyAccepted.delete(candidate);
    }
    if (!this.window || this.window.isDestroyed() || this.window.webContents.isLoading()) {
      this.pending.push(value);
      return true;
    }
    this.send(this.window, value);
    return true;
  }

  didFinishLoad(window: TWindow): void {
    if (this.window === window) this.flush(window);
  }

  setWindow(window: TWindow): void {
    this.window = window;
    this.flush(window);
  }

  clearWindow(window: TWindow): void {
    if (this.window === window) this.window = null;
  }

  private flush(window: TWindow): void {
    if (window.isDestroyed() || window.webContents.isLoading()) return;
    const linksToDeliver = this.pending.splice(0);
    linksToDeliver.forEach(value => this.send(window, value));
  }

  private send(window: TWindow, value: string): void {
    window.webContents.send(this.channel, value);
    this.delivered(value);
  }
}
