import React, { useEffect, useId } from 'react';
import { parseProprConnectEndpoint } from '@propr/shared';
import {
  ChevronsUpDown,
  Cloud,
  Computer,
} from 'lucide-react';
import { useDesktop } from './DesktopContext';
import { SIDEBAR_ICON_STROKE_WIDTH, SIDEBAR_ICON_STROKE_CLASS } from '../components/icons/sidebarIconStroke';

interface DesktopInstanceSelectorProps {
  /** Authenticated REST and Socket.IO are ready for the published desktop scope. */
  transportReady?: boolean;
}

export const DesktopInstanceSelector: React.FC<DesktopInstanceSelectorProps> = ({ transportReady }) => {
  const desktop = useDesktop();
  const descriptionId = useId();
  const activated = desktop?.connection.status === 'ready';
  // The startup probe establishes the active profile and credentials. Once the
  // connected app is mounted, its scoped socket is the live reachability signal.
  const connected = Boolean(activated && transportReady !== false);
  const reconnecting = Boolean(activated && transportReady === false);

  useEffect(() => {
    if (!connected || !transportReady) return;
    void desktop?.reportConnectedRendererReady?.().catch(() => {
      // Acceptance diagnostics must never alter the renderer lifecycle they observe.
    });
  }, [connected, desktop, transportReady]);

  if (!desktop) return null;

  const incompatible = desktop.connection.status === 'incompatible';
  const statusLabel = connected ? 'Connected' : reconnecting ? 'Reconnecting' : incompatible ? 'Update required' : 'Offline';
  const connectionClass = reconnecting ? 'reconnecting' : desktop.connection.status;
  const instanceLabel = parseProprConnectEndpoint(desktop.profile.baseUrl)
    ? 'ProPR Connect'
    : desktop.profile.kind === 'local'
      ? 'Local instance'
      : 'Remote instance';
  const InstanceIcon = desktop.profile.kind === 'local' ? Computer : Cloud;

  return (
    <div className="desktop-instance-selector">
      <button
        type="button"
        className={`desktop-instance-selector-button desktop-connection-${connectionClass}`}
        onClick={desktop.openProfileManager}
        aria-label={`${statusLabel}: ${desktop.profile.name}`}
        aria-describedby={descriptionId}
        aria-haspopup="dialog"
        title="Manage instances"
      >
        <span className="desktop-instance-icon" aria-hidden="true">
          <InstanceIcon className={SIDEBAR_ICON_STROKE_CLASS} strokeWidth={SIDEBAR_ICON_STROKE_WIDTH} />
        </span>
        <span className="desktop-instance-copy">
          <strong title={desktop.profile.name}>{desktop.profile.name}</strong>
        </span>
        <span className="desktop-instance-switch" aria-hidden="true">
          <span className="desktop-connection-dot" title={statusLabel} />
          <ChevronsUpDown className={`${SIDEBAR_ICON_STROKE_CLASS} desktop-instance-action`} strokeWidth={SIDEBAR_ICON_STROKE_WIDTH} />
        </span>
      </button>
      <span id={descriptionId} className="sr-only">
        {`${instanceLabel}. ${desktop.profile.account ? `GitHub account: @${desktop.profile.account.username}. ` : ''}Switch instance or GitHub account.`}
      </span>
    </div>
  );
};
