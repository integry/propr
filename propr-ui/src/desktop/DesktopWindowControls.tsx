import React, { useCallback, useEffect, useRef } from 'react';
import { Minus, Square, X } from 'lucide-react';
import type { DesktopApplicationMenuRequest } from '../../../apps/desktop/src/shared/contract';

export interface DesktopWindowControlActions {
  minimize(): Promise<void>;
  toggleMaximize(): Promise<void>;
  closeWindow(): Promise<void>;
  /** Linux only: main pops up the native application menu template below the anchor. */
  showApplicationMenu?(request: DesktopApplicationMenuRequest): Promise<void>;
}

interface DesktopWindowControlsProps {
  actions?: Partial<DesktopWindowControlActions>;
}

const invoke = (action: (() => Promise<void>) | undefined): void => {
  void action?.().catch(() => undefined);
};

/** F10 is the GTK primary-menu key; Alt+F matches Chromium-style app menus. */
const isApplicationMenuShortcut = (event: KeyboardEvent): boolean =>
  !event.ctrlKey && !event.metaKey && !event.shiftKey
  && ((event.key === 'F10' && !event.altKey) || (event.altKey && event.code === 'KeyF'));

const ApplicationMenuButton: React.FC<{ show(request: DesktopApplicationMenuRequest): Promise<void> }> = ({ show }) => {
  const button = useRef<HTMLButtonElement>(null);
  const open = useCallback((source: DesktopApplicationMenuRequest['source']) => {
    const bounds = button.current?.getBoundingClientRect();
    if (!bounds) return;
    // Main clamps this to the sender window; only these three fields cross IPC.
    invoke(() => show({ x: Math.max(0, bounds.left), y: Math.max(0, bounds.bottom), source }));
  }, [show]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || !isApplicationMenuShortcut(event)) return;
      event.preventDefault();
      open('keyboard');
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open]);

  return (
    <button
      ref={button}
      className="desktop-application-menu-button"
      type="button"
      aria-label="Application menu"
      aria-haspopup="menu"
      aria-keyshortcuts="F10 Alt+F"
      title="ProPR application menu (F10)"
      // Keep focus in the current field so Edit menu roles act on it.
      onMouseDown={event => { if (event.button === 0) event.preventDefault(); }}
      onClick={event => open(event.detail === 0 ? 'keyboard' : 'mouse')}
    >
      {/* The native popup cannot carry an image; this app-owned entry carries
          the ProPR mark instead. Decorative: the button keeps its own name. */}
      <img className="desktop-application-menu-logo" src="/logo.png" alt="" aria-hidden="true" draggable={false} />
    </button>
  );
};

export const DesktopWindowControls: React.FC<DesktopWindowControlsProps> = ({ actions }) => {
  if (!actions?.minimize || !actions.toggleMaximize || !actions.closeWindow) return null;
  return (
    <div className="desktop-window-controls" role="group" aria-label="Window controls" data-window-chrome>
      {actions.showApplicationMenu && <ApplicationMenuButton show={actions.showApplicationMenu} />}
      <button type="button" onClick={() => invoke(actions.minimize)} aria-label="Minimize window">
        <Minus aria-hidden="true" />
      </button>
      <button type="button" onClick={() => invoke(actions.toggleMaximize)} aria-label="Maximize or restore window">
        <Square aria-hidden="true" />
      </button>
      <button className="desktop-window-close" type="button" onClick={() => invoke(actions.closeWindow)} aria-label="Close window">
        <X aria-hidden="true" />
      </button>
    </div>
  );
};
