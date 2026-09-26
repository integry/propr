import React, { useCallback, useEffect, useRef, useState } from 'react';
import { parseProprConnectEndpoint } from '@propr/shared';
import { LoaderCircle } from 'lucide-react';
import { setApiBaseUrl } from '../api/apiClient';
import * as runtimeConfig from '../config/runtimeConfig';
import type { DesktopDeepLinkInbox } from '../desktop-deep-link';
import { DesktopConnectedExperience } from './DesktopConnectedExperience';
import { DesktopWindowControls } from './DesktopWindowControls';
import { LocalSetupWizard } from './LocalSetupWizard';
import { createDesktopAuthenticationActions } from './desktopAuthenticationActions';
import { useAttemptFence, useDesktopAccessInvalidation, useDesktopModal, useSerializedMutationQueue } from './desktopExperienceHooks';
import { AuthenticationPanel, ConnectionPanel, DesktopBrand, DesktopSetupLayer, InstanceChooser, ManagedRecoveryReview, ProfileEditor } from './DesktopExperiencePanels';
import { managedRecoveryMessage, managedRediscoveryUnavailableMessage, safeConnectionMessage } from './desktopExperienceMessages';
import { isGuidedLocalSetup, mergeProfiles, recoverableError, settleAuthenticationCancellation, settleConnectCandidateSetup, type ExperienceState } from './desktopExperienceState';
import type { DesktopAdapters, DesktopConnectionResult, DesktopProfile } from './types';
import { useDesktopDeepLinks } from './useDesktopDeepLinks';
import { useConnectCandidatePresentation } from './useConnectCandidatePresentation';
import { useDesktopNativeCommands } from './useDesktopNativeCommands';
import { DesktopConnectionDiagnostics } from './DesktopConnectionDiagnostics';
import { PackagedAcceptanceLocalSetup } from './PackagedAcceptanceLocalSetup';
import { packagedAcceptanceSetupSurface, type PackagedAcceptanceSetupSurface } from './packagedAcceptanceLocalSetupSurface';
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
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const [operationError, setOperationError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [acceptanceSetup, setAcceptanceSetup] = useState<PackagedAcceptanceSetupSurface | null>(null);
  const [localSetupOpen, setLocalSetupOpen] = useState(false);
  const connectionAttempt = useRef(0);
  const { recordPresentation: connectCandidatePresented, waitForPresentation } = useConnectCandidatePresentation();
  const activeProfileId = useRef<string | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;
  const { begin: beginDiscoveryAttempt, invalidate: invalidateDiscovery } = useAttemptFence();
  const cancelDiscovery = useCallback(() => {
    invalidateDiscovery();
    setBusy(false);
  }, [invalidateDiscovery]);
  const stageConnectCandidate = useCallback((candidate: DesktopProfile, phase: ExperienceState['phase']) => {
    const presented = waitForPresentation(candidate);
    cancelDiscovery();
    if (phase === 'authenticating' && stateRef.current.phase === 'authenticating') {
      settleAuthenticationCancellation(adapters, stateRef.current.profile.id);
    }
    setOperationError(null);
    setEditing(candidate);
    if (phase === 'connected') setManagerOpen(true);
    else if (phase !== 'loading') {
      connectionAttempt.current += 1;
      setState({ phase: 'choose' });
    }
    return presented;
  }, [adapters, cancelDiscovery, waitForPresentation]);
  const { deepLinkError, editorNotice, clearConnectCandidate, hasPendingConnectCandidate } = useDesktopDeepLinks({
    deepLinks,
    phase: state.phase,
    profileId: state.phase === 'connecting' || state.phase === 'authenticating' || state.phase === 'connected'
      ? state.profile.id
      : null,
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
      if (adapters.savedAccounts) {
        // Drop the old renderer scope immediately; persist no selection before probing.
        // Reload during a failed or interrupted switch must not restore the old account.
        adapters.connection.deactivate?.();
        await enqueueProfileMutation(() => adapters.profiles.setActiveId(null));
        if (!isCurrentAttempt()) return;
        activeProfileId.current = null;
      }
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
      const savedProfile = adapters.savedAccounts
        ? (await adapters.profiles.list()).find(item => item.id === profile.id)
        : undefined;
      if (!isCurrentAttempt()) return;
      const connectedProfile = { ...profile, account: savedProfile?.account ?? profile.account, lastConnectedAt: new Date().toISOString() };
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

  const { authenticate, cancelAuthentication, runBlockedAction } = createDesktopAuthenticationActions({
    adapters,
    cancelDiscovery,
    connect,
    connectionAttempt,
    reportCredentialCommitted: () => reportAcceptanceStage('CREDENTIAL_COMMITTED'),
    setOperationError,
    setState,
  });

  const showInstanceChooser = useCallback(() => {
    cancelDiscovery();
    clearConnectCandidate();
    setEditing(null);
    setOperationError(null);
    setState({ phase: 'choose' });
  }, [cancelDiscovery, clearConnectCandidate]);

  const openEditor = (profile: DesktopProfile | 'new') => {
    cancelDiscovery();
    clearConnectCandidate();
    setOperationError(null);
    setEditing(profile);
  };

  useDesktopNativeCommands({
    app: adapters.app,
    state,
    instanceChooserBlocked: localSetupOpen || Boolean(acceptanceSetup),
    onManageInstances: () => { setEditing(null); openManager(); },
    onConnectInstance: () => {
      openEditor('new');
      if (state.phase === 'connected') openManager();
      else setState({ phase: 'choose' });
    },
    onDiagnostics: () => setDiagnosticsOpen(true),
    onNavigate: () => { setDiagnosticsOpen(false); closeManager(); },
    onChooseInstances: showInstanceChooser,
    onReconnect: connect,
  });

  useEffect(() => {
    let cancelled = false;
    activeProfileId.current = null;
    void Promise.all([
      adapters.profiles.list(),
      adapters.profiles.getActiveId(),
      adapters.app.hasStartupConnectIntent?.() ?? false,
    ]).then(([stored, activeId, startupConnectIntent]) => {
      if (cancelled) return;
      activeProfileId.current = activeId;
      setProfiles(stored);
      // The main-owned cold link can still be waiting for window load/presentation.
      // Do not let automatic reconnect clear its account binding before it arrives.
      if (startupConnectIntent || hasPendingConnectCandidate()) {
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

  useDesktopAccessInvalidation(adapters, setState);

  const removeProfile = async (profile: DesktopProfile) => {
    cancelDiscovery();
    if (!window.confirm(profile.account
      ? `Remove @${profile.account.username} from “${profile.name}” on this computer?`
      : `Remove “${profile.name}” from this computer?`)) return;
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

  const settleSetupBeforeConnectCandidate = () => settleConnectCandidateSetup({ acceptanceSetupOpen: Boolean(acceptanceSetup), candidatePending: hasPendingConnectCandidate(), guidedSetup: localSetupOpen && isGuidedLocalSetup(adapters.localSetup) ? adapters.localSetup : null, onAcceptanceSetupSettled: () => setAcceptanceSetup(null), onFailure: () => setOperationError('Local setup could not be cancelled safely. Try Connect again or return to setup.'), onGuidedSetupSettled: () => setLocalSetupOpen(false) });

  const saveProfile = async (profile: DesktopProfile, shouldConnect = true) => {
    cancelDiscovery();
    setOperationError(null);
    if (shouldConnect) {
      if (!await settleSetupBeforeConnectCandidate()) return;
      clearConnectCandidate();
      closeManager();
      await connect(profile);
      return;
    }

    clearConnectCandidate();

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
    const acceptanceSurface = packagedAcceptanceSetupSurface();
    if (acceptanceSurface) {
      setAcceptanceSetup(acceptanceSurface);
      return;
    }
    if (isGuidedLocalSetup(adapters.localSetup)) {
      setOperationError(null);
      setLocalSetupOpen(true);
      return;
    }
    setBusy(true);
    setOperationError(null);
    try {
      const profile = await adapters.localSetup.setup!();
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

  const addAccount = adapters.savedAccounts ? (instance: DesktopProfile) => {
    setManagerOpen(false);
    // A fresh binding id is essential: never overwrite the existing user's credential.
    void connect({ id: crypto.randomUUID(), name: instance.name, baseUrl: instance.baseUrl, kind: instance.kind });
  } : undefined;

  const content = () => {
    const profileEditor = editing ? <main className="desktop-welcome-card"><DesktopBrand /><ProfileEditor discovery={adapters.platform !== 'windows' ? adapters.discovery : undefined} key={editing === 'new' ? editing : editing.id} initial={editing === 'new' ? undefined : editing} candidate={hasPendingConnectCandidate()} notice={editorNotice} operationError={operationError} onPresented={hasPendingConnectCandidate() && editing !== 'new' ? () => connectCandidatePresented(editing) : undefined} onCancel={closeEditor} onSave={profile => void saveProfile(profile)} /></main> : null;
    const setupLayer = (surface: React.ReactNode) => <DesktopSetupLayer editor={profileEditor} suspended={Boolean(profileEditor && hasPendingConnectCandidate())}>{surface}</DesktopSetupLayer>;

    if (state.phase === 'loading') return <div className="desktop-loading"><LoaderCircle className="desktop-spin" /><span>Opening ProPR…</span></div>;
    if (acceptanceSetup) return setupLayer(<PackagedAcceptanceLocalSetup initial={acceptanceSetup} onBack={() => setAcceptanceSetup(null)} />);
    if (state.phase === 'connecting') return <ConnectionPanel profile={state.profile} onBack={choose} onRetry={retry} onAuthenticate={() => undefined} onHelp={() => undefined} onReenter={() => undefined} onRediscover={() => undefined} />;
    if (state.phase === 'authenticating') return <AuthenticationPanel profile={state.profile} progress={state.progress} onCancel={() => cancelAuthentication(state)} onChoose={choose} onReopen={adapters.authentication.reopenApproval ? () => adapters.authentication.reopenApproval!(state.profile.id) : undefined} onCopy={adapters.authentication.copyApproval ? () => adapters.authentication.copyApproval!(state.profile.id) : undefined} />;
    if (state.phase === 'recovery-review') return <ManagedRecoveryReview profile={state.profile} onCancel={() => { cancelDiscovery(); setState({ phase: 'blocked', profile: state.profile, result: { status: 'offline', message: managedRecoveryMessage } }); }} onConfirm={() => void connect(state.candidate)} />;
    if (state.phase === 'blocked') return <ConnectionPanel profile={state.profile} result={state.result} onBack={choose} onRetry={retry} onAuthenticate={() => {
      if (state.result.status === 'authentication-required') void authenticate(state.profile, state.result);
    }} onHelp={() => void runBlockedAction(state.profile, () => adapters.externalBrowser.open('https://propr.dev'), 'ProPR Desktop could not open connection help.')} onReenter={() => reenterManagedEndpoint(state.profile)} onRediscover={() => void rediscoverManagedEndpoint(state.profile)} />;
    if (localSetupOpen && isGuidedLocalSetup(adapters.localSetup)) return setupLayer(<LocalSetupWizard adapter={adapters.localSetup} onBack={() => setLocalSetupOpen(false)} onComplete={profile => { setLocalSetupOpen(false); void saveProfile(profile); }} />);
    if (profileEditor) return profileEditor;
    return <InstanceChooser onAddAccount={addAccount} profiles={profiles} busy={busy} error={operationError} localSetupSupported={adapters.platform === 'linux' && adapters.localSetup.supported} networkDiscoverySupported={adapters.discovery.supported} onLocalSetup={() => void setupLocal()} onConnectNew={() => openEditor('new')} onDiscover={() => void discover()} onConnect={profile => void connect(profile)} onEdit={openEditor} onRemove={profile => void removeProfile(profile)} />;
  };

  const diagnostics = diagnosticsOpen ? <DesktopConnectionDiagnostics state={state} platform={adapters.platform} onClose={() => setDiagnosticsOpen(false)} /> : null;

  if (state.phase !== 'connected') return <>{diagnostics}<div className={`desktop-entry desktop-platform-${adapters.platform}`}><div className="desktop-entry-drag-region" aria-hidden="true" />{adapters.platform === 'linux' && <DesktopWindowControls actions={adapters.app} />}{deepLinkError && <div className="desktop-inline-error" role="alert">{deepLinkError}</div>}{content()}</div></>;

  return (
    <>{diagnostics}<DesktopConnectedExperience
      adapters={adapters} profile={state.profile} result={state.result} profiles={profiles}
      managerOpen={managerOpen} managerRef={managerRef} editing={editing}
      operationError={operationError} deepLinkError={deepLinkError} editorNotice={editorNotice}
      hasPendingConnectCandidate={hasPendingConnectCandidate()} openManager={openManager}
      onConnectCandidatePresented={connectCandidatePresented}
      closeManager={closeManager} closeEditor={closeEditor} openEditor={openEditor}
      addAccount={addAccount} connect={connect} removeProfile={removeProfile} saveProfile={saveProfile} retry={retry}
      setManagerOpen={setManagerOpen}
      windowControls={adapters.platform === 'linux' ? adapters.app : undefined}
    >{children}</DesktopConnectedExperience></>
  );
};
