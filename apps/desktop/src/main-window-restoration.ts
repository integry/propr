interface RestorableMainWindow {
  isDestroyed(): boolean;
  isMinimized(): boolean;
  restore(): void;
  show(): void;
  focus(): void;
  destroy(): void;
}

interface MainWindowRestorerOptions<Window extends RestorableMainWindow> {
  getWindow(): Window | null;
  setWindow(window: Window): void;
  createWindow(): Promise<Window>;
  shutdownStarted(): boolean;
  creationFailed(error: unknown): void;
}

export interface MainWindowRestorer {
  restore(): void;
}

export const createMainWindowRestorer = <Window extends RestorableMainWindow>(
  options: MainWindowRestorerOptions<Window>,
): MainWindowRestorer => {
  let pendingCreation: Promise<void> | null = null;

  return {
    restore() {
      if (options.shutdownStarted()) return;
      const existingWindow = options.getWindow();
      if (existingWindow && !existingWindow.isDestroyed()) {
        if (existingWindow.isMinimized()) existingWindow.restore();
        existingWindow.show();
        existingWindow.focus();
        return;
      }
      if (pendingCreation) return;

      const creation = options.createWindow().then(window => {
        if (options.shutdownStarted()) {
          if (!window.isDestroyed()) window.destroy();
          return;
        }
        options.setWindow(window);
        window.show();
        window.focus();
      }).catch(options.creationFailed);
      pendingCreation = creation;
      const clearPendingCreation = (): void => {
        if (pendingCreation === creation) pendingCreation = null;
      };
      void creation.then(clearPendingCreation, clearPendingCreation);
    },
  };
};
