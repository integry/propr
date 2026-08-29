import React, { useCallback, useEffect, useRef, useState } from 'react';
import { parseProprConnectEndpoint } from '@propr/shared';
import { AlertTriangle, ArrowLeft, ChevronRight, Cloud, Computer, LoaderCircle, Pencil, Plus, RefreshCw, Search, Server, Trash2, X } from 'lucide-react';
import { setApiBaseUrl } from '../api/apiClient';
import * as runtimeConfig from '../config/runtimeConfig';
import { DesktopContext } from './DesktopContext';
import { normalizeBaseUrl } from './browserAdapters';
import { useDesktopModal, useSerializedMutationQueue } from './desktopExperienceHooks';
import type { DesktopAdapters, DesktopConnectionResult, DesktopProfile } from './types';
import './desktop.css';

type ExperienceState =
  | { phase: 'loading' }
  | { phase: 'choose' }
  | { phase: 'connecting'; profile: DesktopProfile }
  | { phase: 'blocked'; profile: DesktopProfile; result: Exclude<DesktopConnectionResult, { status: 'ready' }> }
  | { phase: 'connected'; profile: DesktopProfile; result: Extract<DesktopConnectionResult, { status: 'ready' }> };

interface DesktopExperienceProps {
  adapters: DesktopAdapters;
  children: React.ReactNode;
}

const profileId = (): string => {
  try { return crypto.randomUUID(); } catch { return `profile-${Date.now()}`; }
};

const mergeProfiles = (current: DesktopProfile[], incoming: DesktopProfile[]): DesktopProfile[] => {
  const profiles = new Map(current.map(profile => [profile.id, profile]));
  incoming.forEach(profile => profiles.set(profile.id, profile));
  return [...profiles.values()].sort((a, b) => (b.lastConnectedAt || '').localeCompare(a.lastConnectedAt || ''));
};

const connectionLabel = (result: DesktopConnectionResult): string => {
  if (result.status === 'incompatible') return 'Update required';
  if (result.status === 'authentication-required') return 'Sign in required';
  if (result.status === 'offline') return 'Instance unavailable';
  return 'Connected';
};

const recoverableError = (message: string, error: unknown): string =>
  `${message}${error instanceof Error && error.message ? ` ${error.message}` : ''} Try again.`;

const DesktopBrand: React.FC = () => (
  <div className="desktop-brand" aria-label="ProPR Desktop">
    <img src="/logo.png" alt="" />
    <span>ProPR</span>
  </div>
);

interface ProfileEditorProps {
  initial?: DesktopProfile;
  operationError?: string | null;
  onCancel(): void;
  onSave(profile: DesktopProfile): void;
}

const ProfileEditor: React.FC<ProfileEditorProps> = ({ initial, operationError, onCancel, onSave }) => {
  const [name, setName] = useState(initial?.name || 'My ProPR');
  const [baseUrl, setBaseUrl] = useState(initial?.baseUrl || 'http://127.0.0.1:3000');
  const [validationError, setValidationError] = useState<string | null>(null);
  const connectEndpoint = parseProprConnectEndpoint(baseUrl);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    try {
      onSave({
        id: initial?.id || profileId(),
        name: name.trim() || 'My ProPR',
        baseUrl: normalizeBaseUrl(baseUrl),
        kind: initial?.kind || (new URL(baseUrl).hostname === '127.0.0.1' || new URL(baseUrl).hostname === 'localhost' ? 'local' : 'remote'),
        lastConnectedAt: initial?.lastConnectedAt,
      });
    } catch (caught) {
      setValidationError(caught instanceof Error ? caught.message : 'Enter a valid instance URL.');
    }
  };

  const error = validationError || operationError;

  return (
    <form className="desktop-profile-form" onSubmit={submit}>
      <button type="button" className="desktop-back-button" onClick={onCancel}>
        <ArrowLeft aria-hidden="true" /> Back
      </button>
      <h2>{initial ? 'Edit instance' : 'Connect to an instance'}</h2>
      <p>Enter the address shown by your ProPR server.</p>
      <label>
        Display name
        <input autoFocus value={name} onChange={event => setName(event.target.value)} placeholder="Team ProPR" />
      </label>
      <label>
        Instance URL
        <input value={baseUrl} onChange={event => setBaseUrl(event.target.value)} inputMode="url" placeholder="https://propr.example.com" aria-describedby={error ? 'profile-url-error' : undefined} />
      </label>
      {connectEndpoint && <div className="desktop-connect-verified" role="status"><Cloud aria-hidden="true" /> Verified ProPR Connect endpoint</div>}
      {error && <div id="profile-url-error" className="desktop-inline-error" role="alert">{error}</div>}
      <button type="submit" className="desktop-primary-button">{initial ? 'Save changes' : 'Connect'}</button>
    </form>
  );
};

interface ProfileListProps {
  profiles: DesktopProfile[];
  onConnect(profile: DesktopProfile): void;
  onEdit(profile: DesktopProfile): void;
  onRemove(profile: DesktopProfile): void;
}

const ProfileList: React.FC<ProfileListProps> = ({ profiles, onConnect, onEdit, onRemove }) => (
  <div className="desktop-recents">
    <h2>Recent instances</h2>
    <div className="desktop-profile-list">
      {profiles.map(profile => (
        <div className="desktop-profile-row" key={profile.id}>
          <button type="button" className="desktop-profile-connect" onClick={() => onConnect(profile)}>
            <span className="desktop-profile-icon">{profile.kind === 'local' ? <Computer /> : <Cloud />}</span>
            <span>
              <strong>{profile.name}</strong>
              <small>{profile.baseUrl}</small>
            </span>
            <ChevronRight className="desktop-profile-chevron" aria-hidden="true" />
          </button>
          <button type="button" className="desktop-icon-button" onClick={() => onEdit(profile)} aria-label={`Edit ${profile.name}`}><Pencil /></button>
          <button type="button" className="desktop-icon-button desktop-danger-button" onClick={() => onRemove(profile)} aria-label={`Remove ${profile.name}`}><Trash2 /></button>
        </div>
      ))}
    </div>
  </div>
);

interface ChooserProps extends ProfileListProps {
  busy: boolean;
  error: string | null;
  localSetupSupported: boolean;
  onLocalSetup(): void;
  onConnectNew(): void;
  onDiscover(): void;
}

const InstanceChooser: React.FC<ChooserProps> = ({ profiles, busy, error, localSetupSupported, onLocalSetup, onConnectNew, onDiscover, ...listProps }) => (
  <main className="desktop-welcome-card">
    <DesktopBrand />
    <div className="desktop-welcome-copy">
      <span className="desktop-eyebrow">ProPR Desktop</span>
      <h1>{profiles.length ? 'Choose an instance' : localSetupSupported ? 'Let’s set up this computer' : 'Connect to ProPR'}</h1>
      <p>{localSetupSupported
        ? 'Keep your repositories and coding agents close, or connect securely to a ProPR instance you already use.'
        : 'Local setup is currently available on Linux. Connect securely to a ProPR instance hosted elsewhere.'}</p>
    </div>
    <div className="desktop-setup-actions">
      {localSetupSupported && (
        <button type="button" className="desktop-choice-button desktop-choice-primary" onClick={onLocalSetup} disabled={busy}>
          <span><Computer aria-hidden="true" /></span>
          <span><strong>Set up this computer</strong><small>Create a local ProPR workspace</small></span>
          {busy ? <LoaderCircle className="desktop-spin" /> : <ChevronRight />}
        </button>
      )}
      <button type="button" className="desktop-choice-button" onClick={onConnectNew} disabled={busy}>
        <span><Server aria-hidden="true" /></span>
        <span><strong>Connect to an existing instance</strong><small>Use a local or remote server URL</small></span>
        <ChevronRight />
      </button>
    </div>
    {error && <div className="desktop-inline-error" role="alert">{error}</div>}
    {profiles.length > 0 && <ProfileList profiles={profiles} {...listProps} />}
    <button type="button" className="desktop-discover-button" onClick={onDiscover} disabled={busy}>
      <Search aria-hidden="true" /> Search for instances on this network
    </button>
  </main>
);

const ConnectionPanel: React.FC<{
  profile: DesktopProfile;
  result?: Exclude<DesktopConnectionResult, { status: 'ready' }>;
  onBack(): void;
  onRetry(): void;
  onAuthenticate(): void;
  onHelp(): void;
}> = ({ profile, result, onBack, onRetry, onAuthenticate, onHelp }) => (
  <main className="desktop-connection-card" aria-live="polite">
    <DesktopBrand />
    {!result ? (
      <>
        <div className="desktop-connection-visual desktop-connecting"><LoaderCircle /></div>
        <h1>Connecting to {profile.name}</h1>
        <p>Checking the instance and desktop compatibility…</p>
        <div className="desktop-connection-actions"><button type="button" className="desktop-link-button" onClick={onBack}><ArrowLeft aria-hidden="true" /> Back</button></div>
      </>
    ) : (
      <>
        <div className={`desktop-connection-visual desktop-${result.status}`}><AlertTriangle /></div>
        <span className="desktop-eyebrow">{connectionLabel(result)}</span>
        <h1>{profile.name}</h1>
        <p>{result.message || 'This instance needs authentication before ProPR Desktop can connect.'}</p>
        {result.status === 'incompatible' && result.version && <div className="desktop-version-note">Instance version {result.version} · Desktop {__APP_VERSION__}</div>}
        <div className="desktop-connection-actions">
          {result.status === 'authentication-required' && <button type="button" className="desktop-primary-button" onClick={onAuthenticate}>Sign in in browser</button>}
          <button type="button" className={result.status === 'authentication-required' ? 'desktop-secondary-button' : 'desktop-primary-button'} onClick={onRetry}><RefreshCw /> Try again</button>
          <button type="button" className="desktop-link-button" onClick={onBack}>Choose another instance</button>
          <button type="button" className="desktop-link-button" onClick={onHelp}>Open connection help</button>
        </div>
      </>
    )}
  </main>
);

export const DesktopExperience: React.FC<DesktopExperienceProps> = ({ adapters, children }) => {
  const [profiles, setProfiles] = useState<DesktopProfile[]>([]);
  const [state, setState] = useState<ExperienceState>({ phase: 'loading' });
  const [editing, setEditing] = useState<DesktopProfile | 'new' | null>(null);
  const [managerOpen, setManagerOpen] = useState(false);
  const [operationError, setOperationError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [networkOffline, setNetworkOffline] = useState(!navigator.onLine);
  const connectionAttempt = useRef(0);
  const activeProfileId = useRef<string | null>(null);
  const enqueueProfileMutation = useSerializedMutationQueue();
  const closeManager = useCallback(() => { setManagerOpen(false); setEditing(null); }, []);
  const { dialogRef: managerRef, openModal: openManager } = useDesktopModal(managerOpen, setManagerOpen, closeManager);

  const connect = useCallback(async (profile: DesktopProfile) => {
    const attempt = ++connectionAttempt.current;
    const isCurrentAttempt = () => connectionAttempt.current === attempt;
    setOperationError(null);
    setState({ phase: 'connecting', profile });
    let operation: 'probe' | 'persist' = 'probe';
    try {
      const result = await adapters.connection.probe(profile);
      if (!isCurrentAttempt()) return;
      if (result.status !== 'ready') { setState({ phase: 'blocked', profile, result }); return; }

      operation = 'persist';
      const connectedProfile = { ...profile, lastConnectedAt: new Date().toISOString() };
      await enqueueProfileMutation(async () => {
        if (!isCurrentAttempt()) return;
        await adapters.profiles.save(connectedProfile);
        if (!isCurrentAttempt()) return;
        if (activeProfileId.current !== profile.id) await adapters.profiles.setActiveId(profile.id);
        activeProfileId.current = profile.id;
      });
      if (!isCurrentAttempt()) return;
      setProfiles(current => mergeProfiles(current, [connectedProfile]));
      runtimeConfig.setDesktopApiBaseUrl(connectedProfile.baseUrl);
      setApiBaseUrl(connectedProfile.baseUrl);
      setState({ phase: 'connected', profile: connectedProfile, result });
    } catch (error) {
      if (!isCurrentAttempt()) return;
      const detail = error instanceof Error && error.message ? ` ${error.message}` : '';
      const message = operation === 'persist'
        ? `The instance is reachable, but ProPR Desktop could not save this connection.${detail} Try again.`
        : `ProPR Desktop could not check this instance.${detail} Try again.`;
      setState({ phase: 'blocked', profile, result: { status: 'offline', message } });
    }
  }, [adapters, enqueueProfileMutation]);

  useEffect(() => {
    let cancelled = false;
    activeProfileId.current = null;
    void Promise.all([adapters.profiles.list(), adapters.profiles.getActiveId()]).then(([stored, activeId]) => {
      if (cancelled) return;
      activeProfileId.current = activeId;
      setProfiles(stored);
      const active = stored.find(profile => profile.id === activeId);
      if (active) void connect(active);
      else setState({ phase: 'choose' });
    }).catch(error => {
      if (!cancelled) {
        setOperationError(error instanceof Error ? error.message : 'Profiles could not be loaded.');
        setState({ phase: 'choose' });
      }
    });
    return () => {
      cancelled = true;
      connectionAttempt.current += 1;
    };
  }, [adapters, connect]);

  useEffect(() => {
    const online = () => setNetworkOffline(false);
    const offline = () => setNetworkOffline(true);
    window.addEventListener('online', online);
    window.addEventListener('offline', offline);
    return () => {
      window.removeEventListener('online', online);
      window.removeEventListener('offline', offline);
    };
  }, []);

  useEffect(() => {
    const handleKeyboard = (event: KeyboardEvent) => {
      if (state.phase !== 'connected') return;
      if ((event.metaKey || event.ctrlKey) && event.key === ',') {
        event.preventDefault();
        openManager();
      } else if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === 'r') {
        event.preventDefault();
        void connect(state.profile);
      }
    };
    document.addEventListener('keydown', handleKeyboard);
    return () => document.removeEventListener('keydown', handleKeyboard);
  }, [connect, openManager, state]);

  const removeProfile = async (profile: DesktopProfile) => {
    if (!window.confirm(`Remove “${profile.name}” from this computer?`)) return;
    setOperationError(null);
    try {
      await enqueueProfileMutation(() => adapters.profiles.remove(profile.id));
      setProfiles(current => current.filter(item => item.id !== profile.id));
      if (activeProfileId.current === profile.id) activeProfileId.current = null;
      if (state.phase === 'connected' && state.profile.id === profile.id) setState({ phase: 'choose' });
    } catch (error) {
      setOperationError(recoverableError('ProPR Desktop could not remove this instance.', error));
    }
  };

  const saveProfile = async (profile: DesktopProfile, shouldConnect = true) => {
    setOperationError(null);
    if (shouldConnect) {
      closeManager();
      await connect(profile);
      return;
    }

    try {
      await enqueueProfileMutation(() => adapters.profiles.save(profile));
      setProfiles(current => mergeProfiles(current, [profile]));
      setEditing(null);
    } catch (error) {
      setOperationError(recoverableError('ProPR Desktop could not save this instance.', error));
    }
  };

  const setupLocal = async () => {
    setBusy(true);
    setOperationError(null);
    try {
      const profile = await adapters.localSetup.setup();
      await saveProfile(profile);
    } catch (error) {
      setOperationError(error instanceof Error ? error.message : 'Local setup could not be started.');
    } finally {
      setBusy(false);
    }
  };

  const discover = async () => {
    setBusy(true);
    setOperationError(null);
    try {
      const discovered = await adapters.discovery.discover();
      setProfiles(current => mergeProfiles(current, discovered));
      if (!discovered.length) setOperationError('No new ProPR instances were found on this network.');
    } catch (error) {
      setOperationError(error instanceof Error ? error.message : 'Network discovery is unavailable.');
    } finally {
      setBusy(false);
    }
  };

  const choose = () => {
    const attempt = ++connectionAttempt.current;
    void enqueueProfileMutation(async () => {
      if (connectionAttempt.current !== attempt) return;
      await adapters.profiles.setActiveId(null);
      activeProfileId.current = null;
    }).catch(error => {
      if (connectionAttempt.current === attempt) setOperationError(recoverableError('ProPR Desktop could not clear the active instance.', error));
    });
    setManagerOpen(false);
    setEditing(null);
    setState({ phase: 'choose' });
  };

  const retry = () => { if ('profile' in state) void connect(state.profile); };

  const runBlockedAction = async (profile: DesktopProfile, action: () => Promise<void>, failureMessage: string, onSuccess?: () => Promise<void>) => {
    const attempt = connectionAttempt.current;
    try {
      await action();
      if (connectionAttempt.current === attempt) await onSuccess?.();
    } catch (error) {
      const message = recoverableError(failureMessage, error);
      setState(current => current.phase === 'blocked' && current.profile.id === profile.id
        ? { ...current, result: { ...current.result, message } }
        : current);
    }
  };

  const openEditor = (profile: DesktopProfile | 'new') => { setOperationError(null); setEditing(profile); };

  const content = () => {
    if (state.phase === 'loading') return <div className="desktop-loading"><LoaderCircle className="desktop-spin" /><span>Opening ProPR…</span></div>;
    if (state.phase === 'connecting') return <ConnectionPanel profile={state.profile} onBack={choose} onRetry={retry} onAuthenticate={() => undefined} onHelp={() => undefined} />;
    if (state.phase === 'blocked') return <ConnectionPanel profile={state.profile} result={state.result} onBack={choose} onRetry={retry} onAuthenticate={() => void runBlockedAction(state.profile, () => adapters.authentication.authenticate(state.profile), 'ProPR Desktop could not open sign in.', () => connect(state.profile))} onHelp={() => void runBlockedAction(state.profile, () => adapters.externalBrowser.open('https://propr.dev'), 'ProPR Desktop could not open connection help.')} />;
    if (editing) return <main className="desktop-welcome-card"><DesktopBrand /><ProfileEditor initial={editing === 'new' ? undefined : editing} operationError={operationError} onCancel={() => setEditing(null)} onSave={profile => void saveProfile(profile)} /></main>;
    return <InstanceChooser profiles={profiles} busy={busy} error={operationError} localSetupSupported={adapters.platform === 'linux'} onLocalSetup={() => void setupLocal()} onConnectNew={() => openEditor('new')} onDiscover={() => void discover()} onConnect={profile => void connect(profile)} onEdit={openEditor} onRemove={profile => void removeProfile(profile)} />;
  };

  if (state.phase !== 'connected') return <div className={`desktop-entry desktop-platform-${adapters.platform}`}>{content()}</div>;

  const displayedConnection: DesktopConnectionResult = networkOffline ? { status: 'offline', message: 'This computer is offline.' } : state.result;
  const contextValue = {
    isDesktop: true as const,
    platform: adapters.platform,
    profile: state.profile,
    connection: displayedConnection,
    openProfileManager: openManager,
    authenticate: () => adapters.authentication.authenticate(state.profile),
    openConnectionHelp: () => adapters.externalBrowser.open('https://propr.dev'),
    retry,
  };

  return (
    <DesktopContext.Provider value={contextValue}>
      <div className={`desktop-app desktop-platform-${adapters.platform}`} inert={managerOpen} aria-hidden={managerOpen || undefined}>{children}</div>
      {managerOpen && (
        <div className="desktop-modal-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) closeManager(); }}>
          <section ref={managerRef} className="desktop-profile-manager" role="dialog" aria-modal="true" aria-labelledby="desktop-manager-title" tabIndex={-1}>
            <header><div><span className="desktop-eyebrow">Desktop</span><h2 id="desktop-manager-title">Manage instances</h2></div><button type="button" className="desktop-icon-button" onClick={closeManager} aria-label="Close instance manager"><X /></button></header>
            {editing ? (
              <ProfileEditor initial={editing === 'new' ? undefined : editing} operationError={operationError} onCancel={() => setEditing(null)} onSave={profile => void saveProfile(profile, editing === 'new' || state.profile.id === profile.id)} />
            ) : (
              <>
                {operationError && <div className="desktop-inline-error" role="alert">{operationError}</div>}
                <ProfileList profiles={profiles} onConnect={profile => { setManagerOpen(false); void connect(profile); }} onEdit={openEditor} onRemove={profile => void removeProfile(profile)} />
                <button type="button" className="desktop-secondary-button desktop-add-instance" onClick={() => openEditor('new')}><Plus /> Add instance</button>
              </>
            )}
          </section>
        </div>
      )}
    </DesktopContext.Provider>
  );
};
