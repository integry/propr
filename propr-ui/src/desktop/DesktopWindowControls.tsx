import React from 'react';
import { Minus, Square, X } from 'lucide-react';

export interface DesktopWindowControlActions {
  minimize(): Promise<void>;
  toggleMaximize(): Promise<void>;
  closeWindow(): Promise<void>;
}

interface DesktopWindowControlsProps {
  actions?: Partial<DesktopWindowControlActions>;
}

const invoke = (action: (() => Promise<void>) | undefined): void => {
  void action?.().catch(() => undefined);
};

export const DesktopWindowControls: React.FC<DesktopWindowControlsProps> = ({ actions }) => {
  if (!actions?.minimize || !actions.toggleMaximize || !actions.closeWindow) return null;
  return (
    <div className="desktop-window-controls" role="group" aria-label="Window controls">
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
