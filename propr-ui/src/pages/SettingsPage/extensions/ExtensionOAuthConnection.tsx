import { useState } from 'react';
import type { ExtensionOAuthConnectionStatus } from '@propr/shared';
import { buttonClass, dangerButtonClass } from './extensionUi';

const badge = 'inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide';
const STATE_LABELS = {
  not_connected: { label: 'Not connected', className: 'bg-slate-200 text-slate-700' },
  connected: { label: 'Connected', className: 'bg-teal-50 text-teal-800' },
  needs_sign_in: { label: 'Needs sign-in', className: 'bg-amber-100 text-amber-900' },
} as const;
export const NO_PUBLIC_URL = 'Connect needs a public HTTPS base URL for this instance (API_PUBLIC_URL), which the provider redirects back to.';

/**
 * Connection state of an OAuth server row and its Connect, Reconnect and
 * Disconnect actions. Connecting opens the provider's sign-in page in a new tab.
 */
export function ExtensionOAuthConnection({ name, status, redirectUri, busy, onConnect, onDisconnect }: {
  name: string;
  status?: ExtensionOAuthConnectionStatus;
  /** Null when the instance has no public base URL: Connect is unavailable. */
  redirectUri: string | null;
  busy: boolean;
  onConnect: () => void;
  onDisconnect: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const state = status?.state ?? 'not_connected';
  const shown = STATE_LABELS[state];
  const unavailable = !redirectUri;
  return (
    <div data-testid="extension-oauth-connection" data-state={state} className="mt-2 space-y-1 pl-7 text-xs">
      <p className="flex flex-wrap items-center gap-2">
        <span className="text-slate-600">OAuth sign-in:</span>
        <span className={`${badge} ${shown.className}`}>{shown.label}</span>
        {status?.connectedBy && status.connectedAt !== undefined && (
          <span className="text-slate-600">by administrator {status.connectedBy} · {new Date(status.connectedAt).toLocaleString()}</span>
        )}
      </p>
      {state !== 'not_connected' && (
        <p className="break-words text-slate-600">Granted scopes: {status?.scopes?.length ? status.scopes.join(', ') : 'none reported'}</p>
      )}
      {state === 'not_connected' && <p className="text-amber-800">Runs skip this server until an administrator connects it.</p>}
      {state === 'needs_sign_in' && <p className="text-amber-800">The provider refused to refresh the connection. Runs skip this server until it is reconnected.</p>}
      {unavailable && <p className="text-slate-600">{NO_PUBLIC_URL}</p>}
      <div className="flex flex-wrap items-center gap-2 pt-1">
        {confirming ? (
          <>
            <span className="text-red-800">Disconnect {name}? ProPR asks the provider to revoke the tokens, then deletes them.</span>
            <button type="button" className={dangerButtonClass} disabled={busy} onClick={() => { setConfirming(false); onDisconnect(); }}>Confirm disconnect</button>
            <button type="button" className={buttonClass} onClick={() => setConfirming(false)}>Keep connected</button>
          </>
        ) : (
          <>
            <button type="button" className={buttonClass} disabled={busy || unavailable} onClick={onConnect}>
              {state === 'not_connected' ? 'Connect' : 'Reconnect'}
            </button>
            {state !== 'not_connected' && <button type="button" className={dangerButtonClass} disabled={busy} onClick={() => setConfirming(true)}>Disconnect</button>}
            {busy && <span className="text-slate-500">Working…</span>}
          </>
        )}
      </div>
    </div>
  );
}
