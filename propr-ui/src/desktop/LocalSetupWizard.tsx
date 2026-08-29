import React, { useEffect, useMemo, useState } from 'react';
import { DEFAULT_PROPR_GH_RELAY_URL } from '@propr/shared';
import { ArrowLeft, Check, ChevronRight, CircleAlert, Folder, LoaderCircle, RotateCcw, X } from 'lucide-react';
import type {
  DesktopProfileView,
  DesktopSetupRequest,
  DesktopSetupSnapshot,
} from '../../../apps/desktop/src/shared/contract';
import type { DesktopLocalSetupAdapter } from './types';

type FormStage = 'prerequisites' | 'directory' | 'github' | 'agents' | 'summary';
type GithubMode = DesktopSetupRequest['github']['mode'];
const agents = ['codex', 'claude', 'antigravity', 'opencode', 'vibe'];

const nextStage: Record<FormStage, FormStage | 'install'> = {
  prerequisites: 'directory',
  directory: 'github',
  github: 'agents',
  agents: 'summary',
  summary: 'install',
};
const previousStage: Partial<Record<FormStage, FormStage>> = {
  directory: 'prerequisites',
  github: 'directory',
  agents: 'github',
  summary: 'agents',
};

const phaseIsRecovery = (phase: DesktopSetupSnapshot['phase']): boolean =>
  phase === 'failed' || phase === 'cancelled' || phase === 'interrupted';

export const LocalSetupWizard: React.FC<{
  adapter: DesktopLocalSetupAdapter;
  onBack(): void;
  onComplete(profile: DesktopProfileView): void;
}> = ({ adapter, onBack, onComplete }) => {
  const [stage, setStage] = useState<FormStage>('prerequisites');
  const [snapshot, setSnapshot] = useState<DesktopSetupSnapshot | null>(null);
  const [rootDir, setRootDir] = useState('');
  const [githubMode, setGithubMode] = useState<GithubMode>('relay');
  const [relayUrl, setRelayUrl] = useState(DEFAULT_PROPR_GH_RELAY_URL);
  const [appId, setAppId] = useState('');
  const [privateKeyPath, setPrivateKeyPath] = useState('');
  const [installationId, setInstallationId] = useState('');
  const [selectedAgents, setSelectedAgents] = useState<string[]>(['codex']);
  const [whitelist, setWhitelist] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [configureAgain, setConfigureAgain] = useState(false);

  useEffect(() => {
    let mounted = true;
    const unsubscribe = adapter.onProgress(value => {
      if (mounted) setSnapshot(value);
    });
    void adapter.status().then(value => {
      if (!mounted) return;
      setSnapshot(value);
      if (value.rootDir) setRootDir(value.rootDir);
    }).catch(caught => {
      if (mounted) setError(caught instanceof Error ? caught.message : 'Setup status is unavailable.');
    });
    return () => { mounted = false; unsubscribe(); };
  }, [adapter]);

  const request = useMemo<DesktopSetupRequest>(() => ({
    rootDir,
    reinitialize: false,
    agents: selectedAgents,
    loginAgents: [],
    github: githubMode === 'relay'
      ? { mode: 'relay', relayUrl }
      : githubMode === 'app'
        ? { mode: 'app', appId, privateKeyPath, installationId }
        : githubMode === 'demo'
          ? { mode: 'demo' }
          : { mode: 'keep' },
    intake: githubMode === 'relay'
      ? { mode: 'routing_websocket' }
      : githubMode === 'app'
        ? { mode: 'polling' }
        : { mode: 'keep' },
    whitelist: whitelist.trim() ? whitelist.split(',').map(value => value.trim()).filter(Boolean) : null,
    repository: null,
  }), [appId, githubMode, installationId, privateKeyPath, relayUrl, rootDir, selectedAgents, whitelist]);

  const run = async (retry = false) => {
    setError(null);
    setBusy(true);
    try {
      const result = retry && snapshot?.phase === 'interrupted'
        ? await adapter.retry()
        : retry
          ? await adapter.retry(request)
          : await adapter.start(request);
      setSnapshot(result);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Local setup could not be started.');
    } finally {
      setBusy(false);
    }
  };

  if (!snapshot) return <div className="desktop-loading"><LoaderCircle className="desktop-spin" /> Loading setup…</div>;

  if (snapshot.phase === 'unsupported') {
    return <main className="desktop-setup-wizard"><CircleAlert className="desktop-setup-hero-icon" /><h1>Local setup is unavailable</h1><p>{snapshot.error}</p><p>Remote ProPR connections are fully supported on this platform. Docker Desktop actions are intentionally not offered because this installer is Linux-only.</p><button className="desktop-primary-button" type="button" onClick={onBack}>Connect to a remote instance</button></main>;
  }

  if (snapshot.phase === 'running') {
    const completed = snapshot.state?.steps.filter(step => ['done', 'skipped', 'warning'].includes(step.status)).length ?? 0;
    const total = snapshot.state?.steps.length ?? 1;
    return (
      <main className="desktop-setup-wizard" aria-live="polite">
        <span className="desktop-eyebrow">Installing locally</span><h1>Setting up ProPR</h1>
        <div className="desktop-setup-progress"><span style={{ width: `${Math.round((completed / total) * 100)}%` }} /></div>
        <div className="desktop-setup-step-list">
          {snapshot.state?.steps.map(step => <div key={step.id} data-status={step.status}><span>{step.status === 'active' ? <LoaderCircle className="desktop-spin" /> : step.status === 'done' ? <Check /> : step.status === 'failed' ? <X /> : null}</span><div><strong>{step.title}</strong><small>{step.detail || step.description}</small></div></div>)}
        </div>
        {snapshot.logs.length > 0 && <pre className="desktop-setup-log">{snapshot.logs.slice(-8).join('\n')}</pre>}
        <button type="button" className="desktop-secondary-button" onClick={() => void adapter.cancel()}>Cancel safely</button>
      </main>
    );
  }

  if (phaseIsRecovery(snapshot.phase)) {
    const failed = snapshot.state?.steps.find(step => step.status === 'failed');
    return (
      <main className="desktop-setup-wizard">
        <CircleAlert className="desktop-setup-hero-icon desktop-setup-error-icon" />
        <span className="desktop-eyebrow">Recovery</span><h1>{snapshot.phase === 'interrupted' ? 'Continue your setup' : 'Setup needs attention'}</h1>
        <p>{failed?.detail || snapshot.error || snapshot.errors?.[0]?.message || 'Setup stopped safely.'}</p>
        {(failed?.nextAction || snapshot.errors?.[0]?.nextAction) && <div className="desktop-setup-recovery">{failed?.nextAction || snapshot.errors?.[0]?.nextAction}</div>}
        <div className="desktop-setup-footer"><button type="button" className="desktop-secondary-button" onClick={onBack}>Back to instances</button><button type="button" className="desktop-primary-button" disabled={busy} onClick={() => void run(true)}><RotateCcw /> {busy ? 'Retrying…' : 'Retry setup'}</button></div>
      </main>
    );
  }

  if (snapshot.phase === 'completed' && snapshot.profile && !configureAgain) {
    return <main className="desktop-setup-wizard"><div className="desktop-setup-success"><Check /></div><span className="desktop-eyebrow">Setup complete</span><h1>ProPR is ready</h1><p>Your local stack is healthy and registered as “This computer”. You can safely run this setup again later; existing data and configuration are preserved.</p><div className="desktop-setup-footer"><button type="button" className="desktop-secondary-button" onClick={() => { setConfigureAgain(true); setGithubMode('keep'); }}>Run setup again</button><button type="button" className="desktop-primary-button" onClick={() => onComplete(snapshot.profile!)}>Open dashboard</button></div></main>;
  }

  const continueForm = () => {
    setError(null);
    if (stage === 'directory' && !rootDir.trim()) { setError('Choose an absolute data directory.'); return; }
    if (stage === 'github' && githubMode === 'app' && (!appId.trim() || !privateKeyPath.trim() || !installationId.trim())) { setError('Enter the App ID, private-key path, and installation ID.'); return; }
    const next = nextStage[stage];
    if (next === 'install') void run(); else setStage(next);
  };

  return (
    <main className="desktop-setup-wizard">
      <button type="button" className="desktop-back-button" onClick={previousStage[stage] ? () => setStage(previousStage[stage]!) : onBack}><ArrowLeft /> Back</button>
      <span className="desktop-eyebrow">Local setup · {Object.keys(nextStage).indexOf(stage) + 1} of 5</span>
      {stage === 'prerequisites' && <><h1>Check the essentials</h1><p>ProPR runs its services in Docker. Make sure Docker Engine is installed, the daemon is running, and your Linux user can run Docker commands. The installer will verify this before changing your stack.</p><div className="desktop-setup-note">This app will pull published ProPR images. It will not install Docker or open Docker Desktop.</div></>}
      {stage === 'directory' && <><h1>Choose where ProPR keeps data</h1><p>Your configuration, database, logs, and checked-out repositories live here. Reusing an existing ProPR directory is safe.</p><label className="desktop-setup-field"><span>Data directory</span><div><Folder /><input autoFocus value={rootDir} onChange={event => setRootDir(event.target.value)} spellCheck={false} /></div></label></>}
      {stage === 'github' && <><h1>Connect GitHub</h1><p>Use ProPR Connect for the guided path, your own GitHub App, or demo mode for a local evaluation.</p><div className="desktop-setup-options">{(['relay', 'app', 'demo', 'keep'] as GithubMode[]).map(mode => <label key={mode}><input type="radio" checked={githubMode === mode} onChange={() => setGithubMode(mode)} /><span><strong>{mode === 'relay' ? 'ProPR Connect' : mode === 'app' ? 'Custom GitHub App' : mode === 'demo' ? 'Demo mode' : 'Keep existing configuration'}</strong><small>{mode === 'relay' ? 'Uses an existing GitHub CLI sign-in and the hosted ProPR App.' : mode === 'app' ? 'Use your App ID, installation, and host private-key file.' : mode === 'demo' ? 'Explore locally without GitHub access.' : 'Best when resuming an already configured stack.'}</small></span></label>)}</div>{githubMode === 'relay' && <label className="desktop-setup-field"><span>Connect URL</span><div><input value={relayUrl} onChange={event => setRelayUrl(event.target.value)} /></div></label>}{githubMode === 'app' && <div className="desktop-setup-grid"><label>App ID<input value={appId} onChange={event => setAppId(event.target.value)} /></label><label>Installation ID<input value={installationId} onChange={event => setInstallationId(event.target.value)} /></label><label className="desktop-setup-wide">Private-key path<input value={privateKeyPath} onChange={event => setPrivateKeyPath(event.target.value)} placeholder="/home/you/github-app.pem" /></label></div>}</>}
      {stage === 'agents' && <><h1>Select coding agents</h1><p>Choose the agent credentials ProPR should mount. Missing private credential directories are created with restricted permissions. Setup validates each selected agent inside its image; if an interactive login is needed, recovery shows the exact terminal command instead of opening an invisible login process.</p><div className="desktop-agent-options">{agents.map(agent => <label key={agent}><input type="checkbox" checked={selectedAgents.includes(agent)} onChange={() => setSelectedAgents(current => current.includes(agent) ? current.filter(value => value !== agent) : [...current, agent])} /><span>{agent}</span></label>)}</div>{githubMode !== 'demo' && <label className="desktop-setup-field"><span>Allowed GitHub users (comma-separated, optional)</span><div><input value={whitelist} onChange={event => setWhitelist(event.target.value)} /></div></label>}</>}
      {stage === 'summary' && <><h1>Ready to install</h1><p>Review the configuration. Setup is re-runnable: it fills in missing pieces and keeps existing data and unrelated environment values.</p><dl className="desktop-setup-summary"><div><dt>Directory</dt><dd>{rootDir}</dd></div><div><dt>GitHub</dt><dd>{githubMode}</dd></div><div><dt>Agents</dt><dd>{selectedAgents.join(', ') || 'None'}</dd></div><div><dt>Stack</dt><dd>Pull images, start services, verify health</dd></div></dl></>}
      {error && <div className="desktop-inline-error" role="alert">{error}</div>}
      <div className="desktop-setup-footer"><button type="button" className="desktop-primary-button" disabled={busy} onClick={continueForm}>{stage === 'summary' ? 'Install ProPR' : 'Continue'} <ChevronRight /></button></div>
    </main>
  );
};
