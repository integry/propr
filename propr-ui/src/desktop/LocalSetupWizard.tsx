import React, { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, Check, ChevronRight, CircleAlert, Folder, KeyRound, LoaderCircle, RotateCcw, X } from 'lucide-react';
import type { DesktopFilesystemSelection, DesktopProfileView, DesktopSetupRequest, DesktopSetupSnapshot } from '../../../apps/desktop/src/shared/contract';
import type { DesktopLocalSetupAdapter } from './types';

type FormStage = 'prerequisites' | 'directory' | 'github' | 'intake' | 'agents' | 'summary';
type GithubMode = DesktopSetupRequest['github']['mode'];
type IntakeMode = DesktopSetupRequest['intake']['mode'];
type RootChoice = { mode: 'default' | 'resume'; label: string } | ({ mode: 'selected' } & DesktopFilesystemSelection);
const agents = ['codex', 'claude', 'antigravity', 'opencode', 'vibe'];
const stages: FormStage[] = ['prerequisites', 'directory', 'github', 'intake', 'agents', 'summary'];

interface SetupDraft {
  root: RootChoice;
  githubMode: GithubMode;
  appId: string;
  privateKey: DesktopFilesystemSelection | null;
  installationId: string;
  intakeMode: IntakeMode;
  webhookSecret: string;
  selectedAgents: string[];
  loginAgents: string[];
  reinitialize: boolean;
  whitelist: string[] | null;
  repository: DesktopSetupRequest['repository'];
}

const buildSetupRequest = (sessionId: string, draft: SetupDraft): DesktopSetupRequest => ({
  sessionId,
  root: draft.root.mode === 'selected' ? { mode: 'selected', capability: draft.root.capability } : { mode: draft.root.mode },
  reinitialize: draft.reinitialize,
  agents: draft.selectedAgents,
  loginAgents: draft.loginAgents,
  github: draft.githubMode === 'app'
    ? { mode: 'app', appId: draft.appId, privateKeyCapability: draft.privateKey?.capability ?? '', installationId: draft.installationId }
    : { mode: draft.githubMode },
  intake: draft.intakeMode === 'direct_webhook'
    ? { mode: 'direct_webhook', webhookSecret: draft.webhookSecret }
    : { mode: draft.intakeMode },
  whitelist: draft.whitelist,
  repository: draft.repository,
});

const UnsupportedSetup: React.FC<{ error?: string; onBack(): void }> = ({ error, onBack }) => (
  <main className="desktop-setup-wizard"><CircleAlert className="desktop-setup-hero-icon" /><h1>Local setup is unavailable</h1><p>{error}</p><p>Local Docker setup is intentionally Linux-only.</p><button className="desktop-primary-button" type="button" onClick={onBack}>Back to instances</button></main>
);

const RunningSetup: React.FC<{ snapshot: DesktopSetupSnapshot; onCancel(): void }> = ({ snapshot, onCancel }) => {
  const completed = snapshot.state?.steps.filter(step => ['done', 'skipped', 'warning'].includes(step.status)).length ?? 0;
  const total = snapshot.state?.steps.length ?? 1;
  return <main className="desktop-setup-wizard" aria-live="polite"><span className="desktop-eyebrow">Installing locally</span><h1>Setting up ProPR</h1><div className="desktop-setup-progress"><span style={{ width: `${Math.round((completed / total) * 100)}%` }} /></div><div className="desktop-setup-step-list">{snapshot.state?.steps.map(step => <div key={step.id} data-status={step.status}><span>{step.status === 'active' ? <LoaderCircle className="desktop-spin" /> : step.status === 'done' ? <Check /> : step.status === 'failed' ? <X /> : null}</span><div><strong>{step.title}</strong><small>{step.detail || step.description}</small></div></div>)}</div>{snapshot.logs.length > 0 && <pre className="desktop-setup-log">{snapshot.logs.slice(-8).join('\n')}</pre>}<button type="button" className="desktop-secondary-button" onClick={onCancel}>Cancel safely</button></main>;
};

const RecoverySetup: React.FC<{ snapshot: DesktopSetupSnapshot; busy: boolean; onBack(): void; onRetry(): void }> = ({ snapshot, busy, onBack, onRetry }) => {
  const failed = snapshot.state?.steps.find(step => step.status === 'failed');
  const nextAction = failed?.nextAction || snapshot.errors?.[0]?.nextAction;
  const label = snapshot.reconfigurationRequired ? 'Review saved choices' : 'Retry setup';
  return <main className="desktop-setup-wizard"><CircleAlert className="desktop-setup-hero-icon desktop-setup-error-icon" /><span className="desktop-eyebrow">Recovery</span><h1>{snapshot.phase === 'interrupted' ? 'Continue your setup' : 'Setup needs attention'}</h1><p>{failed?.detail || snapshot.error || snapshot.errors?.[0]?.message || 'Setup stopped safely.'}</p>{snapshot.resumeAvailable === false && <div className="desktop-setup-recovery">Resume after restart is unavailable.</div>}{nextAction && <div className="desktop-setup-recovery">{nextAction}</div>}<div className="desktop-setup-footer"><button type="button" className="desktop-secondary-button" onClick={onBack}>Back</button><button type="button" className="desktop-primary-button" disabled={busy} onClick={onRetry}><RotateCcw /> {busy ? 'Waiting…' : label}</button></div></main>;
};

const CompletedSetup: React.FC<{ profile: DesktopProfileView; onConfigureAgain(): void; onComplete(profile: DesktopProfileView): void }> = ({ profile, onConfigureAgain, onComplete }) => (
  <main className="desktop-setup-wizard"><div className="desktop-setup-success"><Check /></div><span className="desktop-eyebrow">Setup complete</span><h1>ProPR is ready</h1><p>Your local stack is healthy and registered as “This computer”.</p><div className="desktop-setup-footer"><button type="button" className="desktop-secondary-button" onClick={onConfigureAgain}>Run setup again</button><button type="button" className="desktop-primary-button" onClick={() => onComplete(profile)}>Open dashboard</button></div></main>
);

const githubModeCopy: Record<GithubMode, { title: string; description: string }> = {
  relay: { title: 'ProPR Connect', description: 'Uses the official ProPR GitHub relay.' },
  app: { title: 'Custom GitHub App', description: 'Use your App ID, installation, and a natively selected private key.' },
  demo: { title: 'Demo mode', description: 'Explore locally without GitHub access.' },
  keep: { title: 'Keep existing configuration', description: 'Best for an already configured stack.' },
};

interface FormProps extends Omit<SetupDraft, 'whitelist'> {
  stage: FormStage;
  busy: boolean;
  error: string | null;
  setStage(value: FormStage): void;
  setGithubMode(value: GithubMode): void;
  setAppId(value: string): void;
  setInstallationId(value: string): void;
  setIntakeMode(value: IntakeMode): void;
  setWebhookSecret(value: string): void;
  setSelectedAgents(value: React.SetStateAction<string[]>): void;
  setWhitelist(value: string): void;
  whitelist: string;
  onChooseDirectory(): void;
  onChoosePrivateKey(): void;
  onBack(): void;
  onContinue(): void;
}

const GithubStage: React.FC<FormProps> = props => <><h1>Connect GitHub</h1><p>Credentials remain in the trusted desktop process and are never returned to this page.</p><div className="desktop-setup-options">{(['relay', 'app', 'demo', 'keep'] as GithubMode[]).map(mode => <label key={mode}><input type="radio" checked={props.githubMode === mode} onChange={() => props.setGithubMode(mode)} /><span><strong>{githubModeCopy[mode].title}</strong><small>{githubModeCopy[mode].description}</small></span></label>)}</div>{props.githubMode === 'relay' && <div className="desktop-setup-note">The official ProPR relay will be used. Custom renderer URLs are not accepted.</div>}{props.githubMode === 'app' && <div className="desktop-setup-grid"><label>App ID<input value={props.appId} onChange={event => props.setAppId(event.target.value)} /></label><label>Installation ID<input value={props.installationId} onChange={event => props.setInstallationId(event.target.value)} /></label><div className="desktop-setup-wide"><button type="button" className="desktop-secondary-button" onClick={props.onChoosePrivateKey}><KeyRound /> Choose private key</button><small>{props.privateKey?.label ?? 'No key selected'}</small></div></div>}</>;

const FormContent: React.FC<FormProps> = props => {
  switch (props.stage) {
    case 'prerequisites': return <><h1>Check the essentials</h1><p>ProPR requires a running Docker Engine on Linux. The installer verifies it before changing the stack.</p></>;
    case 'directory': return <><h1>Choose where ProPR keeps data</h1><p>The default is owned by the desktop process. To use another existing directory, choose it in the native picker.</p><button type="button" className="desktop-secondary-button" onClick={props.onChooseDirectory}><Folder /> Choose directory</button><div className="desktop-setup-note">{props.root.label}</div></>;
    case 'github': return <GithubStage {...props} />;
    case 'intake': {
      const allowed: IntakeMode[] = props.githubMode === 'relay' ? ['keep', 'routing_websocket', 'polling'] : props.githubMode === 'app' ? ['keep', 'polling', 'direct_webhook'] : props.githubMode === 'demo' ? ['keep'] : ['keep', 'routing_websocket', 'polling', 'direct_webhook'];
      return <><h1>Choose GitHub event intake</h1><div className="desktop-setup-options">{allowed.map(mode => <label key={mode}><input type="radio" checked={props.intakeMode === mode} onChange={() => props.setIntakeMode(mode)} /><span><strong>{mode.replace(/_/g, ' ')}</strong></span></label>)}</div>{props.intakeMode === 'direct_webhook' && <label className="desktop-setup-field"><span>Webhook secret</span><div><input type="password" value={props.webhookSecret} onChange={event => props.setWebhookSecret(event.target.value)} /></div></label>}</>;
    }
    case 'agents': return <><h1>Select coding agents</h1><div className="desktop-agent-options">{agents.map(agent => <label key={agent}><input type="checkbox" checked={props.selectedAgents.includes(agent)} onChange={() => props.setSelectedAgents(current => current.includes(agent) ? current.filter(value => value !== agent) : [...current, agent])} /><span>{agent}</span></label>)}</div>{props.githubMode !== 'demo' && <label className="desktop-setup-field"><span>Allowed GitHub users (comma-separated, optional)</span><div><input value={props.whitelist} onChange={event => props.setWhitelist(event.target.value)} /></div></label>}</>;
    case 'summary': return <><h1>Ready to install</h1><dl className="desktop-setup-summary"><div><dt>Directory</dt><dd>{props.root.label}</dd></div><div><dt>GitHub</dt><dd>{props.githubMode}</dd></div><div><dt>Intake</dt><dd>{props.intakeMode}</dd></div><div><dt>Agents</dt><dd>{props.selectedAgents.join(', ') || 'None'}</dd></div></dl></>;
  }
};

const SetupForm: React.FC<FormProps> = props => {
  const index = stages.indexOf(props.stage);
  return <main className="desktop-setup-wizard"><button type="button" className="desktop-back-button" onClick={index > 0 ? () => props.setStage(stages[index - 1]) : props.onBack}><ArrowLeft /> Back</button><span className="desktop-eyebrow">Local setup · {index + 1} of {stages.length}</span><FormContent {...props} />{props.error && <div className="desktop-inline-error" role="alert">{props.error}</div>}<div className="desktop-setup-footer"><button type="button" className="desktop-primary-button" disabled={props.busy} onClick={props.onContinue}>{props.stage === 'summary' ? 'Install ProPR' : 'Continue'} <ChevronRight /></button></div></main>;
};

export const LocalSetupWizard: React.FC<{ adapter: DesktopLocalSetupAdapter; onBack(): void; onComplete(profile: DesktopProfileView): void }> = ({ adapter, onBack, onComplete }) => {
  const [stage, setStage] = useState<FormStage>('prerequisites');
  const [snapshot, setSnapshot] = useState<DesktopSetupSnapshot | null>(null);
  const [root, setRoot] = useState<RootChoice>({ mode: 'default', label: 'Desktop default directory' });
  const [githubMode, setGithubMode] = useState<GithubMode>('relay');
  const [appId, setAppId] = useState('');
  const [privateKey, setPrivateKey] = useState<DesktopFilesystemSelection | null>(null);
  const [installationId, setInstallationId] = useState('');
  const [intakeMode, setIntakeMode] = useState<IntakeMode>('routing_websocket');
  const [webhookSecret, setWebhookSecret] = useState('');
  const [selectedAgents, setSelectedAgents] = useState<string[]>(['codex']);
  const [loginAgents, setLoginAgents] = useState<string[]>([]);
  const [reinitialize, setReinitialize] = useState(false);
  const [whitelistText, setWhitelistText] = useState('');
  const [whitelist, setWhitelistChoice] = useState<string[] | null>(null);
  const [repository, setRepository] = useState<DesktopSetupRequest['repository']>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [configureAgain, setConfigureAgain] = useState(false);
  const [reconfiguring, setReconfiguring] = useState(false);

  useEffect(() => {
    let mounted = true;
    const unsubscribe = adapter.onProgress(value => { if (mounted) setSnapshot(value); });
    void adapter.status().then(value => {
      if (!mounted) return;
      setSnapshot(value);
      setRoot({ mode: value.resume ? 'resume' : 'default', label: value.rootDir ?? 'Desktop default directory' });
      if (value.resume) {
        setSelectedAgents(value.resume.agents);
        setLoginAgents(value.resume.loginAgents);
        setReinitialize(value.resume.reinitialize);
        setGithubMode(value.resume.github.mode);
        if (value.resume.github.mode === 'app') { setAppId(value.resume.github.appId); setInstallationId(value.resume.github.installationId); }
        setIntakeMode(value.resume.intake.mode);
        setWhitelistChoice(value.resume.whitelist);
        setWhitelistText(value.resume.whitelist?.join(', ') ?? '');
        setRepository(value.resume.repository);
      }
    }).catch(() => { if (mounted) setError('Setup status is unavailable.'); });
    return () => { mounted = false; unsubscribe(); };
  }, [adapter]);

  const draft = useMemo<SetupDraft>(() => ({ root, githubMode, appId, privateKey, installationId, intakeMode, webhookSecret, selectedAgents, loginAgents, reinitialize, whitelist, repository }), [appId, githubMode, installationId, intakeMode, loginAgents, privateKey, reinitialize, repository, root, selectedAgents, webhookSecret, whitelist]);
  const request = snapshot ? buildSetupRequest(snapshot.sessionId, draft) : null;

  const run = async (retry = false) => {
    if (retry && snapshot?.reconfigurationRequired && !reconfiguring) {
      setStage(snapshot.resume?.reconfigurationStage ?? 'github');
      setReconfiguring(true);
      return;
    }
    if (!request) return;
    setError(null); setBusy(true);
    try {
      const result = retry ? reconfiguring ? await adapter.retry(request) : await adapter.retry() : await adapter.start(request);
      setSnapshot(result);
    } catch { setError('Local setup could not be started. Check the selected values and try again.'); }
    finally { setBusy(false); }
  };

  const chooseDirectory = async () => {
    setError(null); setBusy(true);
    try { const selection = await adapter.selectDirectory(); if (selection) setRoot({ mode: 'selected', ...selection }); }
    catch { setError('The directory could not be approved.'); } finally { setBusy(false); }
  };
  const choosePrivateKey = async () => {
    setError(null); setBusy(true);
    try { const selection = await adapter.selectPrivateKey(); if (selection) setPrivateKey(selection); }
    catch { setError('Choose a regular, owner-only private-key file.'); } finally { setBusy(false); }
  };

  if (!snapshot) return <div className="desktop-loading"><LoaderCircle className="desktop-spin" /> Loading setup…</div>;
  if (snapshot.phase === 'unsupported') return <UnsupportedSetup error={snapshot.error} onBack={onBack} />;
  if (snapshot.phase === 'running') return <RunningSetup snapshot={snapshot} onCancel={() => void adapter.cancel()} />;
  if (['failed', 'cancelled', 'interrupted'].includes(snapshot.phase) && !reconfiguring) return <RecoverySetup snapshot={snapshot} busy={busy} onBack={onBack} onRetry={() => void run(true)} />;
  if (snapshot.phase === 'completed' && snapshot.profile && !configureAgain) return <CompletedSetup profile={snapshot.profile} onConfigureAgain={() => { setConfigureAgain(true); setGithubMode('keep'); setIntakeMode('keep'); }} onComplete={onComplete} />;

  const continueForm = () => {
    setError(null);
    if (stage === 'github' && githubMode === 'app' && (!/^\d{1,20}$/.test(appId) || !/^\d{1,20}$/.test(installationId) || !privateKey)) { setError('Enter numeric App and installation IDs, then choose the private key.'); return; }
    if (stage === 'intake' && intakeMode === 'direct_webhook' && !webhookSecret) { setError('Enter the webhook secret.'); return; }
    const index = stages.indexOf(stage);
    if (index === stages.length - 1) void run(reconfiguring); else setStage(stages[index + 1]);
  };
  const chooseGithubMode = (mode: GithubMode) => {
    setGithubMode(mode);
    if (mode === 'relay' && intakeMode === 'direct_webhook') setIntakeMode('routing_websocket');
    if (mode === 'app' && intakeMode === 'routing_websocket') setIntakeMode('polling');
    if (mode === 'demo') setIntakeMode('keep');
  };
  const setWhitelist = (value: string) => {
    setWhitelistText(value);
    setWhitelistChoice(value.split(',').map(item => item.trim()).filter(Boolean));
  };
  return <SetupForm {...draft} whitelist={whitelistText} stage={stage} busy={busy} error={error} setStage={setStage} setGithubMode={chooseGithubMode} setAppId={setAppId} setInstallationId={setInstallationId} setIntakeMode={setIntakeMode} setWebhookSecret={setWebhookSecret} setSelectedAgents={setSelectedAgents} setWhitelist={setWhitelist} onChooseDirectory={() => void chooseDirectory()} onChoosePrivateKey={() => void choosePrivateKey()} onBack={onBack} onContinue={continueForm} />;
};
