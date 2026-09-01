import { StrictMode, type ComponentType, useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type {
  DesktopAppMetadata,
  DesktopProfile,
  StorageSecurity,
} from '../../apps/desktop/src/shared/contract';
import { activateDesktopProfile } from './desktop-profile';
import { DesktopDeepLinkNavigation } from './desktop-deep-link';
import './index.css';
import './desktop.css';

const logoUrl = new URL('./media/logo-and-name.png', window.location.href).href;

export const DesktopTitleBar = ({
  metadata,
  profile,
  onDisconnect,
}: {
  metadata: DesktopAppMetadata | null;
  profile: DesktopProfile | null;
  onDisconnect?: () => void;
}) => (
  <header className="desktop-titlebar">
    <div className="desktop-titlebar-drag flex min-w-0 items-center gap-3">
      <img src={logoUrl} alt="ProPR" className="h-5 w-auto" />
      <span className="truncate text-xs text-slate-500">
        {profile ? profile.label : 'Desktop'}
      </span>
    </div>
    <div className="desktop-titlebar-actions">
      {metadata && <span>v{metadata.version} · {metadata.platform}</span>}
      {onDisconnect && (
        <button type="button" onClick={onDisconnect} className="desktop-titlebar-button">
          Connections
        </button>
      )}
    </div>
  </header>
);

export const ConnectionPlaceholder = ({
  metadata,
  security,
  initialApiUrl,
  onConnect,
}: {
  metadata: DesktopAppMetadata | null;
  security: StorageSecurity | null;
  initialApiUrl: string;
  onConnect: (label: string, apiBaseUrl: string) => Promise<void>;
}) => {
  const [label, setLabel] = useState('Local ProPR');
  const [apiBaseUrl, setApiBaseUrl] = useState(initialApiUrl);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => setApiBaseUrl(initialApiUrl), [initialApiUrl]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    setSaving(true);
    try {
      await onConnect(label, apiBaseUrl);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not save this connection.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <main className="desktop-connection-canvas">
      <section className="desktop-connection-card" aria-labelledby="desktop-connection-title">
        <div className="mb-7 flex items-center justify-between gap-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-teal-700">ProPR Desktop</p>
            <h1 id="desktop-connection-title" className="mt-2 text-2xl font-semibold text-slate-950">
              Connect to your ProPR instance
            </h1>
          </div>
          <div className="desktop-connection-status" aria-label="Not connected">
            <span /> Not connected
          </div>
        </div>
        <p className="mb-6 text-sm leading-6 text-slate-600">
          Add an existing instance to open the same dashboard you use on the web. The desktop app will not
          install, download, or start runtime components.
        </p>
        <form onSubmit={submit} className="space-y-5">
          <label className="block text-sm font-medium text-slate-700">
            Connection name
            <input
              value={label}
              onChange={event => setLabel(event.target.value)}
              maxLength={80}
              autoComplete="off"
              className="desktop-input"
            />
          </label>
          <label className="block text-sm font-medium text-slate-700">
            API URL
            <input
              value={apiBaseUrl}
              onChange={event => setApiBaseUrl(event.target.value)}
              placeholder="http://localhost:4000"
              inputMode="url"
              spellCheck={false}
              className="desktop-input font-mono"
            />
            <span className="mt-2 block text-xs font-normal text-slate-500">
              HTTPS is required except for localhost connections.
            </span>
          </label>
          {security && !security.available && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs leading-5 text-amber-900">
              OS-backed encryption is unavailable ({security.backend}). Profiles can still be saved, but this
              app will refuse to persist credentials until secure storage is available.
            </div>
          )}
          {error && <div role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</div>}
          <button type="submit" disabled={saving} className="desktop-primary-button">
            {saving ? 'Saving…' : 'Open dashboard'}
          </button>
        </form>
        <div className="mt-7 border-t border-slate-200 pt-5 text-xs leading-5 text-slate-500">
          Local lifecycle controls and secure pairing will appear here in a later setup flow.
          {metadata && <span className="block">Runtime: Electron on {metadata.platform} ({metadata.arch})</span>}
        </div>
      </section>
    </main>
  );
};

export const DesktopRoot = () => {
  const bridge = window.proprDesktop;
  const [metadata, setMetadata] = useState<DesktopAppMetadata | null>(null);
  const [security, setSecurity] = useState<StorageSecurity | null>(null);
  const [profile, setProfile] = useState<DesktopProfile | null>(null);
  const [DashboardApp, setDashboardApp] = useState<ComponentType | null>(null);
  const [initialApiUrl, setInitialApiUrl] = useState('http://localhost:4000');
  const [loading, setLoading] = useState(true);
  const [fatalError, setFatalError] = useState<string | null>(null);
  const [deepLinkNavigation] = useState(() => new DesktopDeepLinkNavigation(path => {
    window.location.hash = path;
  }));

  const loadDashboard = useCallback(async (activeProfile: DesktopProfile) => {
    window.__PROPR_CONFIG__ = { apiBaseUrl: activeProfile.apiBaseUrl };
    const application = await import('./App');
    setProfile(activeProfile);
    setDashboardApp(() => application.default);
    deepLinkNavigation.setDashboardReady();
  }, [deepLinkNavigation]);

  useEffect(() => {
    if (!bridge) {
      setFatalError('The secure desktop bridge did not load. Restart ProPR Desktop.');
      setLoading(false);
      return;
    }
    let cancelled = false;
    const unsubscribe = bridge.app.onDeepLink(value => {
      try {
        const deepLink = new URL(value);
        if (deepLink.hostname === 'connect') {
          const apiUrl = deepLink.searchParams.get('api');
          if (apiUrl) setInitialApiUrl(apiUrl);
        } else if (deepLink.hostname === 'open') {
          deepLinkNavigation.receive(value);
        }
      } catch {
        // Main validates protocol input; ignore malformed values defensively.
      }
    });
    void Promise.all([bridge.app.getMetadata(), bridge.storage.security(), bridge.profiles.list()])
      .then(async ([appMetadata, storageSecurity, profiles]) => {
        if (cancelled) return;
        setMetadata(appMetadata);
        setSecurity(storageSecurity);
        const active = profiles.profiles.find(item => item.id === profiles.activeProfileId);
        if (active) await loadDashboard(active);
      })
      .catch(error => {
        if (!cancelled) setFatalError(error instanceof Error ? error.message : 'Desktop startup failed.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [bridge, deepLinkNavigation, loadDashboard]);

  const connect = async (label: string, apiBaseUrl: string) => {
    if (!bridge) return;
    const saved = await bridge.profiles.save({ label, apiBaseUrl });
    await activateDesktopProfile(bridge.profiles, saved);
  };

  const disconnect = async () => {
    if (!bridge) return;
    await bridge.profiles.setActive(null);
    setProfile(null);
    setDashboardApp(null);
    deepLinkNavigation.setDashboardUnavailable();
    window.__PROPR_CONFIG__ = undefined;
    window.location.hash = '';
  };

  if (loading) {
    return (
      <div className="desktop-shell">
        <DesktopTitleBar metadata={metadata} profile={null} />
        <div className="flex flex-1 items-center justify-center text-sm text-slate-500">Starting ProPR Desktop…</div>
      </div>
    );
  }

  if (fatalError) {
    return (
      <div className="desktop-shell">
        <DesktopTitleBar metadata={metadata} profile={null} />
        <div className="flex flex-1 items-center justify-center p-8">
          <div role="alert" className="max-w-md rounded-xl border border-red-200 bg-white p-6 text-sm text-red-700 shadow-sm">
            {fatalError}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="desktop-shell">
      <DesktopTitleBar metadata={metadata} profile={profile} onDisconnect={profile ? disconnect : undefined} />
      <div className="min-h-0 flex-1">
        {profile && DashboardApp
          ? <DashboardApp />
          : <ConnectionPlaceholder metadata={metadata} security={security} initialApiUrl={initialApiUrl} onConnect={connect} />}
      </div>
    </div>
  );
};

const container = document.getElementById('root');
if (!container) throw new Error('Root container missing in renderer.html');
createRoot(container).render(<StrictMode><DesktopRoot /></StrictMode>);
