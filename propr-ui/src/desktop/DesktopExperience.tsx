import React, { useCallback, useEffect, useRef, useState } from 'react';
import { LoaderCircle, Plus, X } from 'lucide-react';
import { connectApiBaseUrlFromDeepLink } from '../../../apps/desktop/src/security';
import { setApiBaseUrl } from '../api/apiClient';
import * as runtimeConfig from '../config/runtimeConfig';
import { DesktopDeepLinkNavigation, type DesktopDeepLinkInbox } from '../desktop-deep-link';
import { DesktopContext } from './DesktopContext';
import { useDesktopModal, useSerializedMutationQueue } from './desktopExperienceHooks';
import { ConnectionPanel, DesktopBrand, InstanceChooser, ProfileEditor, ProfileList } from './DesktopExperiencePanels';
import type { DesktopAdapters, DesktopConnectionResult, DesktopProfile } from './types';
import { LocalSetupWizard } from './LocalSetupWizard';
import './desktop.css';

type ExperienceState =
  | { phase: 'loading' }
  | { phase: 'choose' }
  | { phase: 'local-setup' }
  | { phase: 'connecting'; profile: DesktopProfile }
  | { phase: 'blocked'; profile: DesktopProfile; result: Exclude<DesktopConnectionResult, { status: 'ready' }> }
  | { phase: 'connected'; profile: DesktopProfile; result: Extract<DesktopConnectionResult, { status: 'ready' }> };

interface DesktopExperienceProps {
  adapters: DesktopAdapters;
  deepLinks?: DesktopDeepLinkInbox;
  children: React.ReactNode;
}

const REJECTED_DEEP_LINK_MESSAGE = 'ProPR Desktop could not use that link. Choose an instance and try again.';
const CONNECT_CANDIDATE_NOTICE = 'Review this untrusted instance address, then choose Connect to continue.';

const profileId = (): string => {
  try { return crypto.randomUUID(); } catch { return `profile-${Date.now()}`; }
};

const mergeProfiles = (current: DesktopProfile[], incoming: DesktopProfile[]): DesktopProfile[] => {
  const profiles = new Map(current.map(profile => [profile.id, profile]));
  incoming.forEach(profile => profiles.set(profile.id, profile));
  return [...profiles.values()].sort((a, b) => (b.lastConnectedAt || '').localeCompare(a.lastConnectedAt || ''));
};

const recoverableError = (message: string, error: unknown): string =>
  `${message}${error instanceof Error && error.message ? ` ${error.message}` : ''} Try again.`;

export const DesktopExperience: React.FC<DesktopExperienceProps> = ({ adapters, deepLinks, children }) => {
  const [profiles, setProfiles] = useState<DesktopProfile[]>([]);
  const [state, setState] = useState<ExperienceState>({ phase: 'loading' });
  const [editing, setEditing] = useState<DesktopProfile | 'new' | null>(null);
  const [managerOpen, setManagerOpen] = useState(false);
  const [operationError, setOperationError] = useState<string | null>(null);
  const [deepLinkError, setDeepLinkError] = useState<string | null>(null);
  const [editorNotice, setEditorNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [networkOffline, setNetworkOffline] = useState(!navigator.onLine);
  const connectionAttempt = useRef(0);
  const activeProfileId = useRef<string | null>(null);
  const pendingConnectCandidate = useRef(false);
  const startupOpenLinks = useRef<string[]>([]);
  const stateRef = useRef(state);
  stateRef.current = state;
  const deepLinkHandler = useRef<(value: string) => void>(() => undefined);
  const [deepLinkNavigation] = useState(() => new DesktopDeepLinkNavigation(
    path => {
      window.location.hash = path;
      setDeepLinkError(null);
    },
    () => setDeepLinkError(REJECTED_DEEP_LINK_MESSAGE),
  ));
  const enqueueProfileMutation = useSerializedMutationQueue();
  const closeManager = useCallback(() => { setManagerOpen(false); setEditing(null); }, []);
  const { dialogRef: managerRef, openModal: openManager } = useDesktopModal(managerOpen, setManagerOpen, closeManager);

  deepLinkHandler.current = value => {
    let action: string | null = null;
    try {
      const url = new URL(value);
      if (url.protocol === 'propr:') action = url.hostname;
    } catch {
      // The fixed rejection below deliberately omits attacker-controlled input.
    }

    if (action === 'connect') {
      const baseUrl = connectApiBaseUrlFromDeepLink(value);
      if (!baseUrl) {
        setDeepLinkError(REJECTED_DEEP_LINK_MESSAGE);
        return;
      }
      const hostname = new URL(baseUrl).hostname.toLowerCase();
      const candidate: DesktopProfile = {
        id: profileId(),
        name: 'Discovered ProPR instance',
        baseUrl,
        kind: hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' ? 'local' : 'remote',
      };
      pendingConnectCandidate.current = true;
      setDeepLinkError(null);
      setOperationError(null);
      setEditorNotice(CONNECT_CANDIDATE_NOTICE);
      setEditing(candidate);
      if (stateRef.current.phase === 'connected') setManagerOpen(true);
      else if (stateRef.current.phase !== 'loading') {
        connectionAttempt.current += 1;
        setState({ phase: 'choose' });
      }
      return;
    }

    if (action === 'open') {
      const current = stateRef.current;
      if (current.phase === 'loading') {
        startupOpenLinks.current.push(value);
        return;
      }
      if (current.phase === 'connecting' || current.phase === 'connected') {
        if (activeProfileId.current !== current.profile.id
          || !deepLinkNavigation.receive(value, current.profile.id)) {
          setDeepLinkError(REJECTED_DEEP_LINK_MESSAGE);
        }
        return;
      }
    }

    setDeepLinkError(REJECTED_DEEP_LINK_MESSAGE);
  };

  useEffect(() => deepLinks?.subscribe(value => deepLinkHandler.current(value)), [deepLinks]);

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
      if (pendingConnectCandidate.current) {
        setState({ phase: 'choose' });
        return;
      }
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
    if (state.phase === 'connecting') {
      deepLinkNavigation.setDashboardUnavailable();
      if (activeProfileId.current === state.profile.id) {
        startupOpenLinks.current.splice(0).forEach(value => deepLinkNavigation.receive(value, state.profile.id));
      } else if (startupOpenLinks.current.splice(0).length > 0) {
        setDeepLinkError(REJECTED_DEEP_LINK_MESSAGE);
      }
      return;
    }
    if (state.phase === 'connected') {
      if (activeProfileId.current === state.profile.id) deepLinkNavigation.setDashboardReady(state.profile.id);
      else setDeepLinkError(REJECTED_DEEP_LINK_MESSAGE);
      return;
    }
    deepLinkNavigation.setDashboardUnavailable();
    if (state.phase !== 'loading') {
      if (startupOpenLinks.current.splice(0).length > 0) setDeepLinkError(REJECTED_DEEP_LINK_MESSAGE);
      deepLinkNavigation.rejectPending();
    }
  }, [deepLinkNavigation, state]);

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
    setEditorNotice(null);
    pendingConnectCandidate.current = false;
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
    setOperationError(null);
    setState({ phase: 'local-setup' });
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

  const openEditor = (profile: DesktopProfile | 'new') => { setOperationError(null); setEditorNotice(null); setEditing(profile); };

  const content = () => {
    if (state.phase === 'loading') return <div className="desktop-loading"><LoaderCircle className="desktop-spin" /><span>Opening ProPR…</span></div>;
    if (state.phase === 'connecting') return <ConnectionPanel profile={state.profile} onBack={choose} onRetry={retry} onAuthenticate={() => undefined} onHelp={() => undefined} />;
    if (state.phase === 'blocked') return <ConnectionPanel profile={state.profile} result={state.result} onBack={choose} onRetry={retry} onAuthenticate={() => void runBlockedAction(state.profile, () => adapters.authentication.authenticate(state.profile), 'ProPR Desktop could not open sign in.', () => connect(state.profile))} onHelp={() => void runBlockedAction(state.profile, () => adapters.externalBrowser.open('https://propr.dev'), 'ProPR Desktop could not open connection help.')} />;
    if (state.phase === 'local-setup') return <LocalSetupWizard adapter={adapters.localSetup} onBack={() => setState({ phase: 'choose' })} onComplete={profile => void saveProfile(profile)} />;
    if (editing) return <main className="desktop-welcome-card"><DesktopBrand /><ProfileEditor initial={editing === 'new' ? undefined : editing} candidate={pendingConnectCandidate.current} notice={editorNotice} operationError={operationError} onCancel={() => { pendingConnectCandidate.current = false; setEditorNotice(null); setEditing(null); }} onSave={profile => void saveProfile(profile)} /></main>;
    return <InstanceChooser profiles={profiles} busy={busy} error={operationError} localSetupSupported={adapters.platform === 'linux'} onLocalSetup={() => void setupLocal()} onConnectNew={() => openEditor('new')} onDiscover={() => void discover()} onConnect={profile => void connect(profile)} onEdit={openEditor} onRemove={profile => void removeProfile(profile)} />;
  };

  if (state.phase !== 'connected') return <div className={`desktop-entry desktop-platform-${adapters.platform}`}>{deepLinkError && <div className="desktop-inline-error" role="alert">{deepLinkError}</div>}{content()}</div>;

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
      {deepLinkError && <div className="desktop-inline-error" role="alert">{deepLinkError}</div>}
      <div className={`desktop-app desktop-platform-${adapters.platform}`} inert={managerOpen} aria-hidden={managerOpen || undefined}>{children}</div>
      {managerOpen && (
        <div className="desktop-modal-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) closeManager(); }}>
          <section ref={managerRef} className="desktop-profile-manager" role="dialog" aria-modal="true" aria-labelledby="desktop-manager-title" tabIndex={-1}>
            <header><div><span className="desktop-eyebrow">Desktop</span><h2 id="desktop-manager-title">Manage instances</h2></div><button type="button" className="desktop-icon-button" onClick={closeManager} aria-label="Close instance manager"><X /></button></header>
            {editing ? (
              <ProfileEditor initial={editing === 'new' ? undefined : editing} candidate={pendingConnectCandidate.current} notice={editorNotice} operationError={operationError} onCancel={() => { pendingConnectCandidate.current = false; setEditorNotice(null); setEditing(null); }} onSave={profile => void saveProfile(profile, pendingConnectCandidate.current || editing === 'new' || state.profile.id === profile.id)} />
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
