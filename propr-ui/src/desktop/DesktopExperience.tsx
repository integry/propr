import React, { useCallback, useEffect, useRef, useState } from 'react';
import { parseProprConnectEndpoint } from '@propr/shared';
import { LoaderCircle, Plus, X } from 'lucide-react';
import { setApiBaseUrl } from '../api/apiClient';
import * as runtimeConfig from '../config/runtimeConfig';
import { DesktopContext } from './DesktopContext';
import { useDesktopModal, useSerializedMutationQueue } from './desktopExperienceHooks';
import {
  ConnectionPanel,
  DesktopBrand,
  InstanceChooser,
  ManagedRecoveryReview,
  ProfileEditor,
  ProfileList,
} from './DesktopExperiencePanels';
import {
  managedRecoveryMessage,
  managedRediscoveryUnavailableMessage,
  safeConnectionMessage,
} from './desktopExperienceMessages';
import { DESKTOP_ACCESS_INVALID_EVENT, type DesktopAccessInvalidEventDetail, type DesktopAdapters, type DesktopConnectionResult, type DesktopProfile } from './types';
import './desktop.css';

type ExperienceState =
  | { phase: 'loading' }
  | { phase: 'choose' }
  | { phase: 'connecting'; profile: DesktopProfile }
  | { phase: 'blocked'; profile: DesktopProfile; result: Exclude<DesktopConnectionResult, { status: 'ready' }> }
  | { phase: 'recovery-review'; profile: DesktopProfile; candidate: DesktopProfile }
  | { phase: 'connected'; profile: DesktopProfile; result: Extract<DesktopConnectionResult, { status: 'ready' }> };

interface DesktopExperienceProps {
  adapters: DesktopAdapters;
  children: React.ReactNode;
}

const mergeProfiles = (current: DesktopProfile[], incoming: DesktopProfile[]): DesktopProfile[] => {
  const profiles = new Map(current.map(profile => [profile.id, profile]));
  incoming.forEach(profile => profiles.set(profile.id, profile));
  return [...profiles.values()].sort((a, b) =>
    (b.lastConnectedAt || '').localeCompare(a.lastConnectedAt || ''));
};

const recoverableError = (message: string): string => `${message} Try again.`;

const settleAuthenticationCancellation = (adapters: DesktopAdapters, profileId: string): void => {
  // Back/navigation must remain synchronous. Cancellation is best effort and
  // its rejection is deliberately consumed so shutdown cannot create an
  // unhandled promise containing host-specific IPC details.
  void Promise.resolve()
    .then(() => adapters.authentication.cancel?.(profileId))
    .catch(() => undefined);
};
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
  const stateRef = useRef(state);
  stateRef.current = state;
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
      const probeResult = await adapters.connection.probe(profile);
      if (!isCurrentAttempt()) return;
      if (probeResult.status !== 'ready') {
        setState({
          phase: 'blocked',
          profile,
          result: { ...probeResult, message: safeConnectionMessage(probeResult, Boolean(parseProprConnectEndpoint(profile.baseUrl))) },
        });
        return;
      }

      operation = 'persist';
      const connectedProfile = { ...profile, lastConnectedAt: new Date().toISOString() };
      let result: DesktopConnectionResult = probeResult;
      await enqueueProfileMutation(async () => {
        if (!isCurrentAttempt()) return;
        await adapters.profiles.save(connectedProfile);
        if (!isCurrentAttempt()) return;
        if (adapters.connection.activate) {
          result = await adapters.connection.activate(connectedProfile, probeResult, isCurrentAttempt);
        }
        else if (activeProfileId.current !== profile.id) await adapters.profiles.setActiveId(profile.id);
        if (result.status === 'ready') activeProfileId.current = profile.id;
      });
      if (!isCurrentAttempt()) return;
      setProfiles(current => mergeProfiles(current, [connectedProfile]));
      if (result.status !== 'ready') {
        setState({ phase: 'blocked', profile: connectedProfile, result });
        return;
      }
      runtimeConfig.setDesktopApiBaseUrl(connectedProfile.baseUrl);
      if (adapters.connection.publishActivation) adapters.connection.publishActivation(connectedProfile, result);
      else setApiBaseUrl(connectedProfile.baseUrl);
      setState({ phase: 'connected', profile: connectedProfile, result });
    } catch {
      if (!isCurrentAttempt()) return;
      const message = operation === 'persist'
        ? 'The instance is reachable, but ProPR Desktop could not save this connection. Try again.'
        : 'ProPR Desktop could not check this instance. Try again.';
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
    }).catch(() => {
      if (!cancelled) {
        setOperationError('Profiles could not be loaded. Try again.');
        setState({ phase: 'choose' });
      }
    });
    return () => {
      cancelled = true;
      connectionAttempt.current += 1;
    };
  }, [adapters, connect]);

  useEffect(() => {
    const accessInvalid = (event: Event) => {
      const detail = (event as CustomEvent<DesktopAccessInvalidEventDetail>).detail;
      setState(current => {
        if (current.phase !== 'connected') return current;
        if (!detail || detail.profileId !== current.profile.id || detail.transportScope !== current.result.transportScope) return current;
        adapters.connection.deactivate?.();
        return {
          phase: 'blocked',
          profile: current.profile,
          result: { status: 'authentication-required',
            message: 'Access to this instance was revoked or expired. Pair again to continue.',
            version: current.result.version, authentication: current.result.authentication },
        };
      });
    };
    window.addEventListener(DESKTOP_ACCESS_INVALID_EVENT, accessInvalid);
    return () => window.removeEventListener(DESKTOP_ACCESS_INVALID_EVENT, accessInvalid);
  }, [adapters]);

  useEffect(() => {
    const online = () => setNetworkOffline(false); const offline = () => setNetworkOffline(true);
    window.addEventListener('online', online); window.addEventListener('offline', offline);
    return () => {
      window.removeEventListener('online', online); window.removeEventListener('offline', offline);
    };
  }, []);

  useEffect(() => {
    const handleKeyboard = (event: KeyboardEvent) => {
      const current = stateRef.current;
      if (current.phase !== 'connected') return;
      if ((event.metaKey || event.ctrlKey) && event.key === ',') {
        event.preventDefault();
        openManager();
      } else if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === 'r') {
        event.preventDefault();
        void connect(current.profile);
      }
    };
    document.addEventListener('keydown', handleKeyboard);
    return () => document.removeEventListener('keydown', handleKeyboard);
  }, [connect, openManager]);

  const removeProfile = async (profile: DesktopProfile) => {
    if (!window.confirm(`Remove “${profile.name}” from this computer?`)) return;
    setOperationError(null);
    try {
      await enqueueProfileMutation(() => adapters.profiles.remove(profile.id));
      setProfiles(current => current.filter(item => item.id !== profile.id));
      if (activeProfileId.current === profile.id) activeProfileId.current = null;
      if (state.phase === 'connected' && state.profile.id === profile.id) {
        adapters.connection.deactivate?.();
        setState({ phase: 'choose' });
      }
    } catch {
      setOperationError(recoverableError('ProPR Desktop could not remove this instance.'));
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
    } catch {
      setOperationError(recoverableError('ProPR Desktop could not save this instance.'));
    }
  };

  const setupLocal = async () => {
    setBusy(true);
    setOperationError(null);
    try {
      const profile = await adapters.localSetup.setup();
      await saveProfile(profile);
    } catch {
      setOperationError('Local setup could not be started. Try again.');
    } finally {
      setBusy(false);
    }
  };

  const discover = async () => {
    setBusy(true);
    setOperationError(null);
    try {
      const discovered = await adapters.discovery.discover();
      const candidate = discovered[0];
      if (candidate) {
        // Discovery is evidence for a proposed endpoint, never permission to
        // persist, pair, or activate it. The editor owns explicit confirmation.
        setEditing(candidate);
      } else {
        setOperationError('No new ProPR instances were found on this network.');
      }
    } catch {
      setOperationError('Network discovery is unavailable. Try again.');
    } finally {
      setBusy(false);
    }
  };

  const choose = () => {
    if ('profile' in state) settleAuthenticationCancellation(adapters, state.profile.id);
    adapters.connection.deactivate?.();
    const attempt = ++connectionAttempt.current;
    void enqueueProfileMutation(async () => {
      if (connectionAttempt.current !== attempt) return;
      await adapters.profiles.setActiveId(null);
      activeProfileId.current = null;
    }).catch(() => {
      if (connectionAttempt.current === attempt) setOperationError(recoverableError('ProPR Desktop could not clear the active instance.'));
    });
    setManagerOpen(false);
    setEditing(null);
    setState({ phase: 'choose' });
  };

  const retry = () => { if ('profile' in state) void connect(state.profile); };

  const runBlockedAction = async (
    profile: DesktopProfile,
    action: () => Promise<void>,
    failureMessage: string,
    connectFailureMessage?: string,
    onSuccess?: () => Promise<void>,
  ) => {
    const attempt = connectionAttempt.current;
    try {
      await action();
      if (connectionAttempt.current === attempt) await onSuccess?.();
    } catch {
      const message = recoverableError(failureMessage);
      setState(current => current.phase === 'blocked' && current.profile.id === profile.id
        ? {
          ...current,
          result: parseProprConnectEndpoint(profile.baseUrl) && connectFailureMessage
            ? { status: 'offline', message: recoverableError(connectFailureMessage) }
            : { ...current.result, message },
        }
        : current);
    }
  };

  const openEditor = (profile: DesktopProfile | 'new') => { setOperationError(null); setEditing(profile); };

  const reenterManagedEndpoint = (profile: DesktopProfile) => {
    connectionAttempt.current += 1;
    setOperationError(null);
    setState({ phase: 'choose' });
    setEditing({ ...profile, baseUrl: '' });
  };

  const rediscoverManagedEndpoint = async (profile: DesktopProfile) => {
    const attempt = ++connectionAttempt.current;
    const showUnavailable = () => {
      if (connectionAttempt.current !== attempt) return;
      setState(current => current.phase === 'blocked' && current.profile.id === profile.id
        ? {
          phase: 'blocked',
          profile,
          result: { status: 'offline', message: managedRediscoveryUnavailableMessage },
        }
        : current);
    };
    if (!adapters.managedTunnelRecovery) {
      showUnavailable();
      return;
    }
    try {
      const discovered = await adapters.managedTunnelRecovery.rediscover(profile.id);
      if (connectionAttempt.current !== attempt) return;
      if (!discovered || discovered.id !== profile.id) return showUnavailable();
      const endpoint = parseProprConnectEndpoint(discovered.baseUrl);
      if (!endpoint) return showUnavailable();
      setState({
        phase: 'recovery-review',
        profile,
        candidate: { ...profile, baseUrl: endpoint.origin, kind: 'remote' },
      });
    } catch {
      showUnavailable();
    }
  };

  const content = () => {
    if (state.phase === 'loading') return <div className="desktop-loading"><LoaderCircle className="desktop-spin" /><span>Opening ProPR…</span></div>;
    if (state.phase === 'connecting') return <ConnectionPanel profile={state.profile} onBack={choose} onRetry={retry} onAuthenticate={() => undefined} onHelp={() => undefined} onReenter={() => undefined} onRediscover={() => undefined} />;
    if (state.phase === 'recovery-review') return <ManagedRecoveryReview profile={state.profile} onCancel={() => setState({ phase: 'blocked', profile: state.profile, result: { status: 'offline', message: managedRecoveryMessage } })} onConfirm={() => void connect(state.candidate)} />;
    if (state.phase === 'blocked') return <ConnectionPanel profile={state.profile} result={state.result} onBack={choose} onRetry={retry} onAuthenticate={() => void runBlockedAction(state.profile, () => adapters.authentication.authenticate(state.profile), 'ProPR Desktop could not open sign in.', 'ProPR Connect pairing could not be completed.', () => connect(state.profile))} onHelp={() => void runBlockedAction(state.profile, () => adapters.externalBrowser.open('https://propr.dev'), 'ProPR Desktop could not open connection help.')} onReenter={() => reenterManagedEndpoint(state.profile)} onRediscover={() => void rediscoverManagedEndpoint(state.profile)} />;
    if (editing) return <main className="desktop-welcome-card"><DesktopBrand /><ProfileEditor initial={editing === 'new' ? undefined : editing} operationError={operationError} onCancel={() => setEditing(null)} onSave={profile => void saveProfile(profile)} /></main>;
    return <InstanceChooser profiles={profiles} busy={busy} error={operationError} localSetupSupported={adapters.platform === 'linux' && adapters.localSetup.supported} networkDiscoverySupported={adapters.discovery.supported} onLocalSetup={() => void setupLocal()} onConnectNew={() => openEditor('new')} onDiscover={() => void discover()} onConnect={profile => void connect(profile)} onEdit={openEditor} onRemove={profile => void removeProfile(profile)} />;
  };

  if (state.phase !== 'connected') return <div className={`desktop-entry desktop-platform-${adapters.platform}`}>{content()}</div>;

  const displayedConnection: DesktopConnectionResult = networkOffline ? { status: 'offline', message: 'This computer is offline.' } : state.result;
  const contextValue = {
    isDesktop: true as const, platform: adapters.platform, profile: state.profile,
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
