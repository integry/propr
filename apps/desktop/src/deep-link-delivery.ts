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
    readonly mainFrame: {
      readonly frameToken: string;
      readonly processId: number;
    };
    send(channel: string, value: DesktopDeepLinkDelivery): void;
  };
}

type DeepLinkWebContents = DeepLinkWindow['webContents'];

const rendererDocumentId = (frame: unknown): string | null => {
  if ((typeof frame !== 'object' && typeof frame !== 'function') || frame === null
    || !('frameToken' in frame) || typeof frame.frameToken !== 'string'
    || frame.frameToken.length === 0
    || !('processId' in frame) || !Number.isSafeInteger(frame.processId)) return null;
  return `${String(frame.processId)}:${frame.frameToken}`;
};

/** Coordinates protocol delivery across the window creation/load boundary. */
export class DeepLinkDelivery<TWindow extends DeepLinkWindow> {
  private window: TWindow | null = null;
  private windowWebContents: DeepLinkWebContents | null = null;
  private readonly readyRendererDocuments = new WeakMap<object, string>();
  private readonly staleRendererDocuments = new WeakMap<object, Set<string>>();
  private readonly pendingMainFrameNavigations = new WeakSet<object>();
  private readonly outgoingRendererDocuments = new WeakMap<object, string>();
  private readonly recentlyAccepted = new Map<string, number>();
  private deliveryId = 0;
  private draining = false;
  private closed = false;
  private active: {
    acknowledged: boolean;
    delivery: DesktopDeepLinkDelivery;
    resolve: (consumption: DesktopDeepLinkConsumption) => void;
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
    private readonly requireRendererConsumerReady = false,
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

  /** Startup must observe accepted Connect intent even before the window can receive it. */
  hasPendingConnectIntent(): boolean {
    const values = this.active ? [this.active.delivery.url, ...this.pending] : this.pending;
    return values.some(value => {
      try {
        const url = new URL(value);
        return url.protocol === 'propr:' && url.hostname === 'connect';
      } catch {
        return false;
      }
    });
  }

  didStartMainFrameNavigation(window: TWindow): void {
    const { webContents } = window;
    this.readyRendererDocuments.delete(webContents);
    this.pendingMainFrameNavigations.add(webContents);
    const documentId = rendererDocumentId(webContents.mainFrame);
    if (documentId === null) return;
    this.outgoingRendererDocuments.set(webContents, documentId);
    const stale = this.staleRendererDocuments.get(webContents) ?? new Set<string>();
    stale.add(documentId);
    this.staleRendererDocuments.set(webContents, stale);
  }

  didCommitMainFrameNavigation(window: TWindow): void {
    const { webContents } = window;
    this.pendingMainFrameNavigations.delete(webContents);
    const outgoingDocumentId = this.outgoingRendererDocuments.get(webContents);
    this.outgoingRendererDocuments.delete(webContents);
    const currentDocumentId = rendererDocumentId(webContents.mainFrame);
    if (currentDocumentId !== null && currentDocumentId === outgoingDocumentId) {
      // Electron 44 can retain both its WebFrameMain wrapper and render-frame
      // identity for a same-process document navigation. The commit is the
      // boundary that makes that reused identity safe for the incoming document.
      this.staleRendererDocuments.get(webContents)?.delete(currentDocumentId);
    }
  }

  /** Starts delivery only after the renderer has installed its consumer. */
  rendererConsumerReady(sender: unknown, senderFrame: unknown): boolean {
    const documentId = rendererDocumentId(senderFrame);
    if ((typeof sender !== 'object' && typeof sender !== 'function') || sender === null
      || (typeof senderFrame !== 'object' && typeof senderFrame !== 'function') || senderFrame === null
      || !('mainFrame' in sender) || sender.mainFrame !== senderFrame
      || documentId === null
      || this.pendingMainFrameNavigations.has(sender)
      || this.staleRendererDocuments.get(sender)?.has(documentId)) return false;
    this.readyRendererDocuments.set(sender, documentId);
    if (this.windowWebContents === sender) void this.drain();
    return true;
  }

  setWindow(window: TWindow): void {
    const { webContents } = window;
    this.window = window;
    this.windowWebContents = webContents;
    void this.drain();
  }

  clearWindow(window: TWindow): void {
    if (this.window === window) {
      const webContents = this.windowWebContents;
      this.window = null;
      this.windowWebContents = null;
      if (!webContents) return;
      this.readyRendererDocuments.delete(webContents);
      this.staleRendererDocuments.delete(webContents);
      this.pendingMainFrameNavigations.delete(webContents);
      this.outgoingRendererDocuments.delete(webContents);
    }
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

  /** Closes admission without canceling deliveries accepted before shutdown. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
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
        const currentDocumentId = rendererDocumentId(window.webContents.mainFrame);
        if (this.requireRendererConsumerReady && (currentDocumentId === null
          || this.readyRendererDocuments.get(window.webContents) !== currentDocumentId
          || this.staleRendererDocuments.get(window.webContents)?.has(currentDocumentId))) return;
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
          timer,
          window,
        };
        try {
          window.webContents.send(this.channel, delivery);
          const consumption = await acknowledgement;
          await this.delivered(value, consumption, window);
        } catch (error) {
          if (!this.closed) {
            this.failed(error instanceof Error ? error : new Error('Desktop renderer deep-link acknowledgement failed'));
          }
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
