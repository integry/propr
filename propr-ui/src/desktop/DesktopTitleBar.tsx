import React, { useEffect } from 'react';
import { ChevronDown, CircleAlert, CloudOff, RefreshCw, Wifi } from 'lucide-react';
import { useDesktop } from './DesktopContext';

interface DesktopTitleBarProps {
  /** Authenticated REST and Socket.IO are ready for the published desktop scope. */
  transportReady?: boolean;
}

export const DesktopTitleBar: React.FC<DesktopTitleBarProps> = ({ transportReady = false }) => {
  const desktop = useDesktop();
  const connected = desktop?.connection.status === 'ready';

  useEffect(() => {
    if (!connected || !transportReady) return;
    void desktop?.reportConnectedRendererReady?.().catch(() => {
      // Acceptance diagnostics must never alter the renderer lifecycle they observe.
    });
  }, [connected, desktop, transportReady]);

  if (!desktop) return null;
  const incompatible = desktop.connection.status === 'incompatible';
  const label = connected ? 'Connected' : incompatible ? 'Update required' : 'Offline';

  return (
    <div className="desktop-titlebar" data-platform={desktop.platform}>
      <div className="desktop-titlebar-drag" aria-hidden="true" />
      <div className="desktop-window-title">ProPR</div>
      <div className="desktop-titlebar-actions">
        <button
          type="button"
          className={`desktop-connection-pill desktop-connection-${desktop.connection.status}`}
          onClick={connected ? desktop.openProfileManager : desktop.retry}
          aria-label={`${label}: ${desktop.profile.name}`}
          title={connected ? 'Manage instances' : 'Retry connection'}
        >
          {connected ? <Wifi aria-hidden="true" /> : incompatible ? <CircleAlert aria-hidden="true" /> : <CloudOff aria-hidden="true" />}
          <span className="desktop-connection-dot" aria-hidden="true" />
          <span>{desktop.profile.name}</span>
          {!connected && <RefreshCw className="desktop-pill-retry" aria-hidden="true" />}
          {connected && <ChevronDown aria-hidden="true" />}
        </button>
      </div>
    </div>
  );
};
