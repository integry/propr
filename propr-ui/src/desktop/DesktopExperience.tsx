import React, { useCallback, useEffect, useRef, useState } from 'react';
import { parseProprConnectEndpoint } from '@propr/shared';
import { LoaderCircle } from 'lucide-react';
import { setApiBaseUrl } from '../api/apiClient';
import * as runtimeConfig from '../config/runtimeConfig';
import type { DesktopDeepLinkInbox } from '../desktop-deep-link';
import { DesktopConnectedExperience } from './DesktopConnectedExperience';
import { useAttemptFence, useDesktopModal, useSerializedMutationQueue } from './desktopExperienceHooks';
import { ConnectionPanel, DesktopBrand, InstanceChooser, ManagedRecoveryReview, ProfileEditor } from './DesktopExperiencePanels';
import { managedRecoveryMessage, managedRediscoveryUnavailableMessage, safeConnectionMessage } from './desktopExperienceMessages';
import { mergeProfiles, recoverableError, settleAuthenticationCancellation, type ExperienceState } from './desktopExperienceState';
import { DESKTOP_ACCESS_INVALID_EVENT, type DesktopAccessInvalidEventDetail, type DesktopAdapters, type DesktopConnectionResult, type DesktopProfile } from './types';
import { useDesktopDeepLinks } from './useDesktopDeepLinks';
import './desktop.css';

interface DesktopExperienceProps {
  adapters: DesktopAdapters;
  deepLinks?: DesktopDeepLinkInbox;
  children: React.ReactNode;
}

export const DesktopExperience: React.FC<DesktopExperienceProps> = ({ adapters, deepLinks, children }) => {
  const [profiles, setProfiles] = useState<DesktopProfile[]>([]);
  const [state, setState] = useState<ExperienceState>({ phase: 'loading' });
  const [editing, setEditing] = useState<DesktopProfile | 'new' | null>(null);
  const [managerOpen, setManagerOpen] = useState(false);
  const [operationError, setOperationError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const connectionAttempt = useRef(0);
  const activeProfileId = useRef<string | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;
  const { begin: beginDiscoveryAttempt, invalidate: invalidateDiscovery } = useAttemptFence();
  const cancelDiscovery = useCallback(() => {
    invalidateDiscovery();
    setBusy(false);
  }, [invalidateDiscovery]);
  const stageConnectCandidate = useCallback((candidate: DesktopProfile, phase: ExperienceState['phase']) => {
    cancelDiscovery();
    setOperationError(null);
    setEditing(candidate);
    if (phase === 'connected') setManagerOpen(true);
    else if (phase !== 'loading') {
      connectionAttempt.current += 1;
      setState({ phase: 'choose' });
    }
  }, [cancelDiscovery]);
  const {
    deepLinkError,
    editorNotice,
    clearConnectCandidate,
    hasPendingConnectCandidate,
  } = useDesktopDeepLinks({
    deepLinks,
    phase: state.phase,
    profileId: state.phase === 'connecting' || state.phase === 'connected' ? state.profile.id : null,
    activeProfileId,
    onStageConnectCandidate: stageConnectCandidate,
  });
  const enqueueProfileMutation = useSerializedMutationQueue();
  const closeManager = useCallback(() => {
    cancelDiscovery();
    clearConnectCandidate();
    setManagerOpen(false);
    setEditing(null);
  }, [cancelDiscovery, clearConnectCandidate]);
  const { dialogRef: managerRef, openModal: openManager } = useDesktopModal(managerOpen, setManagerOpen, closeManager);
  const reportAcceptanceStage = useCallback(async (
    stage: Parameters<NonNullable<DesktopAdapters['acceptance']>['reportJourneyStage']>[0],
  ): Promise<void> => {
    try {
      await adapters.acceptance?.reportJourneyStage(stage);
    } catch {
      // Acceptance diagnostics must never alter the renderer lifecycle they observe.
    }
  }, [adapters]);

  const connect = useCallback(async (profile: DesktopProfile) => {
    cancelDiscovery();
    const attempt = ++connectionAttempt.current;
    const isCurrentAttempt = () => connectionAttempt.current === attempt;
    setOperationError(null);
    setState({ phase: 'connecting', profile });
    let operation: 'probe' | 'persist' = 'probe';
    try {
      const probeResult = await adapters.connection.probe(profile);
      if (!isCurrentAttempt()) return;
      if (probeResult.status !== 'ready') {
        if (probeResult.status === 'authentication-required') {
          await reportAcceptanceStage('AUTHENTICATION_REQUIRED');
        }
        setState({
          phase: 'blocked',
          profile,
          result: { ...probeResult, message: safeConnectionMessage(probeResult, Boolean(parseProprConnectEndpoint(profile.baseUrl))) },
        });
        return;
      }
      await reportAcceptanceStage('AUTHENTICATED_REPROBE_READY');

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
        if (result.status === 'ready') {
          activeProfileId.current = profile.id;
          await reportAcceptanceStage('ACTIVATION_COMMITTED');
        }
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
      await reportAcceptanceStage('ACTIVATION_PUBLISHED');
      setState({ phase: 'connected', profile: connectedProfile, result });
    } catch {
      if (!isCurrentAttempt()) return;
      const message = operation === 'persist'
        ? 'The instance is reachable, but ProPR Desktop could not save this connection. Try again.'
        : 'ProPR Desktop could not check this instance. Try again.';
      setState({ phase: 'blocked', profile, result: { status: 'offline', message } });
    }
  }, [adapters, cancelDiscovery, enqueueProfileMutation, reportAcceptanceStage]);

  useEffect(() => {
    let cancelled = false;
    activeProfileId.current = null;
    void Promise.all([adapters.profiles.list(), adapters.profiles.getActiveId()]).then(([stored, activeId]) => {
      if (cancelled) return;
      activeProfileId.current = activeId;
      setProfiles(stored);
      if (hasPendingConnectCandidate()) {
        setState({ phase: 'choose' });
        return;
      }
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
      invalidateDiscovery();
    };
  }, [adapters, connect, hasPendingConnectCandidate, invalidateDiscovery]);

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
    cancelDiscovery();
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
    cancelDiscovery();
    clearConnectCandidate();
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
    cancelDiscovery();
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
    const isCurrentAttempt = beginDiscoveryAttempt();
    setBusy(true);
    setOperationError(null);
    try {
      const discovered = await adapters.discovery.discover();
      if (!isCurrentAttempt()) return;
      const candidate = discovered[0];
      if (candidate) {
        // Discovery is evidence for a proposed endpoint, never permission to
        // persist, pair, or activate it. The editor owns explicit confirmation.
        setEditing(candidate);
      } else {
        setOperationError('No new ProPR instances were found on this network.');
      }
    } catch {
      if (isCurrentAttempt()) setOperationError('Network discovery is unavailable. Try again.');
    } finally {
      if (isCurrentAttempt()) setBusy(false);
    }
  };

  const choose = () => {
    cancelDiscovery();
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
    cancelDiscovery();
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

  const openEditor = (profile: DesktopProfile | 'new') => {
    cancelDiscovery();
    clearConnectCandidate();
    setOperationError(null);
    setEditing(profile);
  };

  const closeEditor = () => {
    cancelDiscovery();
    clearConnectCandidate();
    setEditing(null);
  };

  const reenterManagedEndpoint = (profile: DesktopProfile) => {
    cancelDiscovery();
    connectionAttempt.current += 1;
    setOperationError(null);
    setState({ phase: 'choose' });
    setEditing({ ...profile, baseUrl: '' });
  };

  const rediscoverManagedEndpoint = async (profile: DesktopProfile) => {
    const isCurrentDiscovery = beginDiscoveryAttempt();
    const attempt = ++connectionAttempt.current;
    const showUnavailable = () => {
      if (connectionAttempt.current !== attempt || !isCurrentDiscovery()) return;
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
      if (connectionAttempt.current !== attempt || !isCurrentDiscovery()) return;
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
    if (state.phase === 'recovery-review') return <ManagedRecoveryReview profile={state.profile} onCancel={() => { cancelDiscovery(); setState({ phase: 'blocked', profile: state.profile, result: { status: 'offline', message: managedRecoveryMessage } }); }} onConfirm={() => void connect(state.candidate)} />;
    if (state.phase === 'blocked') return <ConnectionPanel profile={state.profile} result={state.result} onBack={choose} onRetry={retry} onAuthenticate={() => void runBlockedAction(state.profile, async () => {
      await adapters.authentication.authenticate(state.profile);
      await reportAcceptanceStage('CREDENTIAL_COMMITTED');
    }, 'ProPR Desktop could not open sign in.', 'ProPR Connect pairing could not be completed.', () => connect(state.profile))} onHelp={() => void runBlockedAction(state.profile, () => adapters.externalBrowser.open('https://propr.dev'), 'ProPR Desktop could not open connection help.')} onReenter={() => reenterManagedEndpoint(state.profile)} onRediscover={() => void rediscoverManagedEndpoint(state.profile)} />;
    if (editing) return <main className="desktop-welcome-card"><DesktopBrand /><ProfileEditor key={editing === 'new' ? editing : editing.id} initial={editing === 'new' ? undefined : editing} candidate={hasPendingConnectCandidate()} notice={editorNotice} operationError={operationError} onCancel={closeEditor} onSave={profile => void saveProfile(profile)} /></main>;
    return <InstanceChooser profiles={profiles} busy={busy} error={operationError} localSetupSupported={adapters.platform === 'linux' && adapters.localSetup.supported} networkDiscoverySupported={adapters.discovery.supported} onLocalSetup={() => void setupLocal()} onConnectNew={() => openEditor('new')} onDiscover={() => void discover()} onConnect={profile => void connect(profile)} onEdit={openEditor} onRemove={profile => void removeProfile(profile)} />;
  };

  if (state.phase !== 'connected') return <div className={`desktop-entry desktop-platform-${adapters.platform}`}>{deepLinkError && <div className="desktop-inline-error" role="alert">{deepLinkError}</div>}{content()}</div>;

  return (
    <DesktopConnectedExperience
      adapters={adapters} profile={state.profile} result={state.result} profiles={profiles}
      managerOpen={managerOpen} managerRef={managerRef} editing={editing}
      operationError={operationError} deepLinkError={deepLinkError} editorNotice={editorNotice}
      hasPendingConnectCandidate={hasPendingConnectCandidate()} openManager={openManager}
      closeManager={closeManager} closeEditor={closeEditor} openEditor={openEditor}
      connect={connect} removeProfile={removeProfile} saveProfile={saveProfile} retry={retry}
      setManagerOpen={setManagerOpen}
    >{children}</DesktopConnectedExperience>
  );
};
