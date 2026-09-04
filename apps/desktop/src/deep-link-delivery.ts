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

  constructor(
    private readonly channel: string,
    private readonly pending: string[] = [],
  ) {}

  deliver(value: string): void {
    if (!this.window || this.window.isDestroyed() || this.window.webContents.isLoading()) {
      this.pending.push(value);
      return;
    }
    this.window.webContents.send(this.channel, value);
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
    linksToDeliver.forEach(value => window.webContents.send(this.channel, value));
  }
}
