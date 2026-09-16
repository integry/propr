import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, Check, ChevronRight, CircleAlert, ExternalLink, Github, KeyRound, LoaderCircle, RefreshCw, RotateCcw, UserRoundCog, X } from 'lucide-react';
import type {
  DesktopFilesystemSelection, DesktopGithubInstallationDecision, DesktopGithubSelectedIdentity,
  DesktopSecretSelection, DesktopSetupRequest, DesktopSetupResumeView, DesktopSetupSnapshot,
} from '../../../apps/desktop/src/shared/contract';
import type { DesktopGuidedLocalSetupAdapter, DesktopProfile } from './types';

type Stage = 'prerequisites' | 'directory' | 'github' | 'intake' | 'agents' | 'summary';
type GithubMode = DesktopSetupRequest['github']['mode'];
type DraftGithubMode = GithubMode | 'demo';
type IntakeMode = DesktopSetupRequest['intake']['mode'];
const stages: Stage[] = ['prerequisites', 'directory', 'github', 'intake', 'agents', 'summary'];
const agents = ['codex', 'claude', 'antigravity', 'opencode', 'vibe', 'muse'];

interface Draft {
  githubMode: DraftGithubMode; appId: string; installationId: string; privateKey: DesktopFilesystemSelection | null;
  githubIdentity: DesktopGithubSelectedIdentity | null;
  intakeMode: IntakeMode; webhookSecret: DesktopSecretSelection | null; selectedAgents: string[];
  whitelist: string; reinitialize: boolean;
}

const requestFrom = (sessionId: string, draft: Draft): DesktopSetupRequest | null => {
  if (draft.githubMode === 'demo') return null;
  return {
    sessionId, root: { mode: 'default' }, reinitialize: draft.reinitialize, agents: draft.selectedAgents,
    github: draft.githubMode === 'app' ? { mode: 'app', appId: draft.appId, installationId: draft.installationId,
      privateKeyCapability: draft.privateKey?.capability ?? '' } : { mode: draft.githubMode },
    intake: draft.intakeMode === 'direct_webhook' ? { mode: 'direct_webhook', secretCapability: draft.webhookSecret?.capability ?? '' }
      : { mode: draft.intakeMode },
    whitelist: draft.whitelist.trim()
      ? draft.whitelist.split(',').map(value => value.trim()).filter(Boolean)
      : null,
    repository: null,
  };
};

const githubModeLabel = (mode: DraftGithubMode): string => mode === 'relay' ? 'ProPR Connect'
  : mode === 'app' ? 'Custom GitHub App'
    : mode === 'keep' ? 'Keep existing configuration' : 'Demo mode (unsupported)';

const intakeModeLabel = (mode: IntakeMode): string => mode === 'routing_websocket' ? 'WebSocket'
  : mode === 'polling' ? 'Polling'
    : mode === 'direct_webhook' ? 'Direct webhook' : 'Keep existing configuration';

const githubModesFor = (allowKeep: boolean): GithubMode[] => allowKeep ? ['relay', 'app', 'keep'] : ['relay', 'app'];

const InlineError: React.FC<{ message: string | null }> = ({ message }) => message
  ? <div className="desktop-inline-error" role="alert">{message}</div>
  : null;

const hasSavedChoices = (snapshot: DesktopSetupSnapshot): boolean => Boolean(snapshot.resumeAvailable && snapshot.resume);

const recoveryDetailsFrom = (snapshot: DesktopSetupSnapshot) => {
  const failed = snapshot.state?.steps.find(step => step.status === 'failed');
  return {
    title: snapshot.phase === 'interrupted' ? 'Continue your setup' : 'Setup needs attention',
    message: failed?.detail || snapshot.error || snapshot.errors?.[0]?.message || 'Setup stopped safely.',
    nextAction: failed?.nextAction || snapshot.errors?.[0]?.nextAction,
    identity: snapshot.resume?.github.mode === 'relay' ? snapshot.resume.github.identity : undefined,
  };
};

const SetupSummary: React.FC<{ draft: Draft }> = ({ draft }) => <>
  <h1>Ready to install</h1>
  <dl className="desktop-setup-summary" aria-label="Selected configuration">
    <div><dt>Directory</dt><dd>Desktop-managed local runtime</dd></div>
    <div><dt>GitHub</dt><dd>{githubModeLabel(draft.githubMode)}{draft.githubIdentity
      ? ` · @${draft.githubIdentity.username}`
      : draft.githubMode === 'relay' ? ' · identity verified next' : ''}</dd></div>
    {draft.githubIdentity && <div><dt>Installation</dt><dd>{draft.githubIdentity.installation.accountLogin} ({draft.githubIdentity.installation.accountType})</dd></div>}
    <div><dt>Intake</dt><dd>{intakeModeLabel(draft.intakeMode)}</dd></div>
    <div><dt>Agents</dt><dd>{draft.selectedAgents.join(', ') || 'None'}</dd></div>
  </dl>
</>;

const RecoveryConfiguration: React.FC<{ resume?: DesktopSetupResumeView }> = ({ resume }) => {
  if (!resume) return null;
  return <dl className="desktop-setup-summary" aria-label="Selected configuration">
    <div><dt>GitHub</dt><dd>{githubModeLabel(resume.github.mode)}</dd></div>
    <div><dt>Intake</dt><dd>{intakeModeLabel(resume.intake.mode)}</dd></div>
  </dl>;
};

const GithubInstallationChoice: React.FC<{
  snapshot: DesktopSetupSnapshot; busy: boolean;
  choose(decision: DesktopGithubInstallationDecision): void;
}> = ({ snapshot, busy, choose }) => {
  const identity = snapshot.githubIdentity!;
  const [selected, setSelected] = useState(identity.selectedInstallationId ?? '');
  const installationIds = identity.installations.map(item => item.installationId).join(':');
  const previousIdentity = useRef({
    username: identity.username,
    installationIds,
    selectedInstallationId: identity.selectedInstallationId,
  });
  useEffect(() => {
    const previous = previousIdentity.current;
    const accountChanged = previous.username !== identity.username;
    const installationsChanged = previous.installationIds !== installationIds;
    const serverSelectionChanged = previous.selectedInstallationId !== identity.selectedInstallationId;
    previousIdentity.current = {
      username: identity.username,
      installationIds,
      selectedInstallationId: identity.selectedInstallationId,
    };
    if (!accountChanged && !installationsChanged && !serverSelectionChanged) return;
    const available = new Set(installationIds.split(':').filter(Boolean));
    setSelected(current => {
      if (accountChanged) return '';
      if (identity.selectedInstallationId && available.has(identity.selectedInstallationId)) {
        return identity.selectedInstallationId;
      }
      return available.has(current) ? current : '';
    });
  }, [identity.selectedInstallationId, identity.username, installationIds]);
  const waiting = ['refreshing', 'installing', 'reauthenticating', 'enrolling'].includes(identity.status);
  return <section className="desktop-github-choice" aria-labelledby="desktop-github-choice-title">
    <div className="desktop-github-identity"><Github aria-hidden="true" /><div><small>Authenticated GitHub account</small><strong>@{identity.username}</strong></div></div>
    <h2 id="desktop-github-choice-title">Choose a GitHub App installation</h2>
    <p>Discovery shows installations this account can access. The relay separately verifies enrollment permission after you choose.</p>
    {identity.permissionExplanation && <div className="desktop-inline-error" role="alert">{identity.permissionExplanation}</div>}
    {identity.installations.length > 0 ? <div className="desktop-setup-options desktop-github-installations">
      {identity.installations.map(installation => <label key={installation.installationId}>
        <input type="radio" name="github-installation" checked={selected === installation.installationId}
          disabled={busy || waiting} onChange={() => setSelected(installation.installationId)} />
        <span><strong>{installation.accountLogin}</strong><small>{installation.accountType} · Installation {installation.installationId}</small></span>
      </label>)}
    </div> : <div className="desktop-setup-note">No GitHub App installation is visible to @{identity.username} yet. Install the app, then refresh this list.</div>}
    <div className="desktop-github-actions">
      <button type="button" className="desktop-secondary-button" disabled={busy || waiting} onClick={() => choose({ action: 'refresh' })}><RefreshCw /> Refresh installations</button>
      {identity.installAvailable && <button type="button" className="desktop-secondary-button" disabled={busy || waiting} onClick={() => choose({ action: 'install' })}><ExternalLink /> Install GitHub App</button>}
      <button type="button" className="desktop-secondary-button" disabled={busy || waiting} onClick={() => {
        setSelected('');
        choose({ action: 'reauthenticate' });
      }}><UserRoundCog /> Change GitHub account</button>
    </div>
    <button type="button" className="desktop-primary-button" disabled={busy || waiting || !selected}
      onClick={() => choose({ action: 'select', installationId: selected })}>
      {waiting ? <><LoaderCircle className="desktop-spin" /> {identity.status === 'enrolling' ? 'Checking permission…' : 'Updating…'}</> : <>Continue with selection <ChevronRight /></>}
    </button>
  </section>;
};

const Running: React.FC<{ snapshot: DesktopSetupSnapshot; busy: boolean; choiceBusy: boolean; error: string | null; back(): void; cancel(): void;
  choose(decision: DesktopGithubInstallationDecision): void }> = ({ snapshot, busy, choiceBusy, error, back, cancel, choose }) => {
  const complete = snapshot.state?.steps.filter(step => ['done', 'skipped', 'warning'].includes(step.status)).length ?? 0;
  const total = snapshot.state?.steps.length ?? 1;
  return <main className="desktop-setup-wizard" aria-live="polite">
    <span className="desktop-eyebrow">Installing locally</span><h1>Setting up ProPR</h1>
    <div className="desktop-setup-progress"><span style={{ width: `${Math.round(complete / total * 100)}%` }} /></div>
    <div className="desktop-setup-step-list">{snapshot.state?.steps.map(step => <div key={step.id} data-status={step.status}>
      <span>{step.status === 'active' ? <LoaderCircle className="desktop-spin" /> : step.status === 'done' ? <Check /> : step.status === 'failed' ? <X /> : null}</span>
      <div><strong>{step.title}</strong><small>{step.detail || step.description}</small></div>
    </div>)}</div>
    {snapshot.githubIdentity && snapshot.githubIdentity.status !== 'enrolled'
      && <GithubInstallationChoice snapshot={snapshot} busy={choiceBusy} choose={choose} />}
    {snapshot.logs.length > 0 && <pre className="desktop-setup-log">{snapshot.logs.slice(-8).join('\n')}</pre>}
    <InlineError message={error} />
    <div className="desktop-setup-footer">{error && <button type="button" className="desktop-secondary-button" onClick={back}>Back</button>}
      <button type="button" className="desktop-secondary-button" disabled={busy} onClick={cancel}>{busy ? 'Cancelling…' : error ? 'Try cancellation again' : 'Cancel safely'}</button></div>
  </main>;
};

const RuntimeReplacementButton: React.FC<{
  available: boolean; busy: boolean; replace(): void;
}> = ({ available, busy, replace }) => available
  ? <button className="desktop-secondary-button" type="button" disabled={busy} onClick={replace}>Restart with aligned runtime</button>
  : null;

const runtimeReplacementAvailable = (snapshot: DesktopSetupSnapshot): boolean => snapshot.state?.steps
  .some(step => step.status === 'failed' && step.recoveryAction === 'replace-running-stack') ?? false;

const Recovery: React.FC<{ snapshot: DesktopSetupSnapshot; busy: boolean; error: string | null; back(): void; retry(): void; replace(): void; review(): void }> = ({ snapshot, busy, error, back, retry, replace, review }) => {
  const { title, message, nextAction, identity } = recoveryDetailsFrom(snapshot);
  return <main className="desktop-setup-wizard"><CircleAlert className="desktop-setup-hero-icon desktop-setup-error-icon" />
    <span className="desktop-eyebrow">Recovery</span><h1>{title}</h1>
    <p>{message}</p>
    {nextAction && <div className="desktop-setup-recovery">{nextAction}</div>}
    {identity && <div className="desktop-github-identity"><Github aria-hidden="true" /><div><small>Saved GitHub choice</small><strong>@{identity.username} · {identity.installation.accountLogin} ({identity.installation.accountType})</strong></div></div>}
    <RecoveryConfiguration resume={snapshot.resume} />
    <InlineError message={error} />
    <div className="desktop-setup-footer"><button className="desktop-secondary-button" type="button" onClick={back}>Back</button>
      {hasSavedChoices(snapshot) && <button className="desktop-secondary-button" type="button" disabled={busy} onClick={review}>Review saved choices</button>}
      <RuntimeReplacementButton available={runtimeReplacementAvailable(snapshot)} busy={busy} replace={replace} />
      <button className="desktop-primary-button" type="button" disabled={busy} onClick={retry}><RotateCcw /> {busy ? 'Waiting…' : 'Retry setup'}</button></div>
  </main>;
};

const Form: React.FC<{ stage: Stage; draft: Draft; busy: boolean; error: string | null; back(): void; next(): void;
  allowGithubKeep: boolean; setDraft: React.Dispatch<React.SetStateAction<Draft>>; chooseKey(): void; acquireSecret(): void }> = props => {
  const { stage, draft, setDraft } = props;
  const index = stages.indexOf(stage);
  const githubModes = githubModesFor(props.allowGithubKeep);
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft(current => ({ ...current, [key]: value }));
  const selectGithubMode = (mode: GithubMode) => setDraft(current => ({ ...current, githubMode: mode,
    githubIdentity: mode === 'relay' ? current.githubIdentity : null,
    intakeMode: mode === 'relay' ? 'routing_websocket'
      : mode === 'app' && current.intakeMode === 'routing_websocket' ? 'polling' : current.intakeMode }));
  return <main className="desktop-setup-wizard"><button type="button" className="desktop-back-button" onClick={props.back}><ArrowLeft /> Back</button>
    <span className="desktop-eyebrow">Local setup · {index + 1} of {stages.length}</span>
    {stage === 'prerequisites' && <><h1>Check the essentials</h1><p>ProPR needs Linux and a running Docker Engine. Setup checks Docker before changing the local stack and reports anything you need to fix.</p></>}
    {stage === 'directory' && <><h1>Private local storage</h1><p>Environment, data, logs, and repositories stay in a fixed owner-only directory managed by ProPR Desktop.</p><div className="desktop-setup-note">Desktop-managed local runtime</div></>}
    {stage === 'github' && <><h1>Connect GitHub</h1><p>Secrets stay in the trusted desktop process and are never returned to this page.</p>
      {draft.githubMode === 'demo' && <div className="desktop-setup-recovery">Demo mode is no longer available in desktop setup. Select a supported GitHub configuration to continue.</div>}
      <div className="desktop-setup-options">{githubModes.map(mode => <label key={mode}><input type="radio" checked={draft.githubMode === mode} onChange={() => selectGithubMode(mode)} /><span><strong>{githubModeLabel(mode)}</strong></span></label>)}</div>
      {draft.githubMode === 'app' && <div className="desktop-setup-grid"><label>App ID<input value={draft.appId} onChange={event => set('appId', event.target.value)} /></label>
        <label>Installation ID<input value={draft.installationId} onChange={event => set('installationId', event.target.value)} /></label>
        <div className="desktop-setup-wide"><button type="button" className="desktop-secondary-button" onClick={props.chooseKey}><KeyRound /> Choose private key</button><small>{draft.privateKey?.label ?? ' No key selected'}</small></div></div>}</>}
    {stage === 'intake' && <><h1>GitHub event intake</h1>{draft.githubMode === 'relay'
      ? <div className="desktop-setup-note"><strong>WebSocket</strong><br />ProPR Connect uses a persistent WebSocket connection for GitHub events.</div>
      : <div className="desktop-setup-options">
        {(draft.githubMode === 'app' ? ['keep', 'polling', 'direct_webhook'] : ['keep', 'routing_websocket', 'polling', 'direct_webhook']).map(mode =>
          <label key={mode}><input type="radio" checked={draft.intakeMode === mode} onChange={() => set('intakeMode', mode as IntakeMode)} /><span><strong>{intakeModeLabel(mode as IntakeMode)}</strong></span></label>)}</div>}
      {draft.intakeMode === 'direct_webhook' && <div className="desktop-setup-wide"><button type="button" className="desktop-secondary-button" onClick={props.acquireSecret}><KeyRound /> Enter webhook secret securely</button><small>{draft.webhookSecret?.label ?? ' No secret entered'}</small></div>}</>}
    {stage === 'agents' && <><h1>Select coding agents</h1><div className="desktop-agent-options">{agents.map(agent => <label key={agent}><input type="checkbox" checked={draft.selectedAgents.includes(agent)} onChange={() => set('selectedAgents', draft.selectedAgents.includes(agent) ? draft.selectedAgents.filter(value => value !== agent) : [...draft.selectedAgents, agent])} /><span>{agent}</span></label>)}</div>
      {draft.githubMode !== 'demo' && <label className="desktop-setup-field"><span>Allowed GitHub users (comma-separated, optional)</span><div><input value={draft.whitelist} onChange={event => set('whitelist', event.target.value)} /></div></label>}</>}
    {stage === 'summary' && <SetupSummary draft={draft} />}
    {props.error && <div className="desktop-inline-error" role="alert">{props.error}</div>}
    <div className="desktop-setup-footer"><button type="button" className="desktop-primary-button" disabled={props.busy} onClick={props.next}>{stage === 'summary' ? 'Install ProPR' : 'Continue'} <ChevronRight /></button></div>
  </main>;
};

export const LocalSetupWizard: React.FC<{ adapter: DesktopGuidedLocalSetupAdapter; onBack(): void; onComplete(profile: DesktopProfile): void }> = ({ adapter, onBack, onComplete }) => {
  const [stage, setStage] = useState<Stage>('prerequisites');
  const [snapshot, setSnapshot] = useState<DesktopSetupSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [choiceBusy, setChoiceBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statusAttempt, setStatusAttempt] = useState(0);
  const [reconfiguring, setReconfiguring] = useState(false);
  const [draft, setDraft] = useState<Draft>({ githubMode: 'relay', appId: '', installationId: '', privateKey: null, githubIdentity: null,
    intakeMode: 'routing_websocket', webhookSecret: null, selectedAgents: ['codex'], whitelist: '', reinitialize: false });

  useEffect(() => {
    let mounted = true; const unsubscribe = adapter.onProgress(value => { if (mounted) setSnapshot(value); });
    void adapter.status().then(value => { if (!mounted) return; setSnapshot(value); if (value.resume) setDraft(current => ({ ...current,
      githubMode: value.resume!.github.mode, appId: value.resume!.github.mode === 'app' ? value.resume!.github.appId : '',
      installationId: value.resume!.github.mode === 'app' ? value.resume!.github.installationId : '',
      intakeMode: value.resume!.github.mode === 'relay' ? 'routing_websocket' : value.resume!.intake.mode,
      githubIdentity: value.resume!.github.mode === 'relay' ? value.resume!.github.identity ?? null : null,
      selectedAgents: value.resume!.agents, whitelist: value.resume!.whitelist?.join(', ') ?? '', reinitialize: value.resume!.reinitialize })); })
      .catch(() => { if (mounted) setError('Setup status is unavailable.'); });
    return () => { mounted = false; unsubscribe(); };
  }, [adapter, statusAttempt]);
  const request = useMemo(() => snapshot ? requestFrom(snapshot.sessionId, draft) : null, [draft, snapshot]);
  const run = async (retry: boolean, review = false, replaceRunningStack = false) => {
    if (review && snapshot?.resumeAvailable && snapshot.resume && !reconfiguring) {
      setStage(snapshot.resume?.reconfigurationStage ?? 'github'); setReconfiguring(true); return;
    }
    if (!request || !snapshot) return;
    setBusy(true); setError(null);
    try {
      const nextSnapshot = retry
        ? reconfiguring
          ? await adapter.retry(request)
          : replaceRunningStack
            ? await adapter.retry({ sessionId: snapshot.sessionId, recoveryAction: 'replace-running-stack' })
            : await adapter.retry()
        : await adapter.start(request);
      setSnapshot(nextSnapshot);
      if (retry && reconfiguring && ['failed', 'cancelled'].includes(nextSnapshot.phase)) setReconfiguring(false);
    }
    catch { setError('Local setup could not be started. Check the selected values and try again.'); }
    finally { setBusy(false); }
  };
  const chooseKey = async () => { setBusy(true); try { const value = await adapter.selectPrivateKey(); if (value) setDraft(current => ({ ...current, privateKey: value })); } catch { setError('Choose a regular owner-only private-key file.'); } finally { setBusy(false); } };
  const acquireSecret = async () => { setBusy(true); try { const value = await adapter.acquireWebhookSecret(); if (value) setDraft(current => ({ ...current, webhookSecret: value })); } catch { setError('Install zenity or kdialog to enter the secret securely.'); } finally { setBusy(false); } };
  const cancel = async () => {
    setCancelling(true); setError(null);
    try { setSnapshot(await adapter.cancel()); }
    catch { setError('Setup cancellation could not be confirmed. Try again or go back and reopen setup.'); }
    finally { setCancelling(false); }
  };
  const chooseGithubInstallation = async (decision: DesktopGithubInstallationDecision) => {
    setChoiceBusy(true); setError(null);
    try { setSnapshot(await adapter.resolveGithubInstallation(decision)); }
    catch { setError('The GitHub installation list changed. Refresh it and choose again.'); }
    finally { setChoiceBusy(false); }
  };
  if (!snapshot && error) return <main className="desktop-setup-wizard"><CircleAlert className="desktop-setup-hero-icon desktop-setup-error-icon" />
    <span className="desktop-eyebrow">Setup unavailable</span><h1>Could not load setup</h1><div className="desktop-inline-error" role="alert">{error}</div>
    <div className="desktop-setup-footer"><button type="button" className="desktop-secondary-button" onClick={onBack}>Back</button>
      <button type="button" className="desktop-primary-button" onClick={() => { setError(null); setStatusAttempt(value => value + 1); }}><RotateCcw /> Retry</button></div></main>;
  if (!snapshot) return <div className="desktop-loading"><LoaderCircle className="desktop-spin" /> Loading setup…</div>;
  if (snapshot.phase === 'unsupported') return <main className="desktop-setup-wizard"><CircleAlert className="desktop-setup-hero-icon" /><h1>Local setup is unavailable</h1><p>{snapshot.error}</p><button className="desktop-primary-button" onClick={onBack}>Back to instances</button></main>;
  if (snapshot.phase === 'running') return <Running snapshot={snapshot} busy={cancelling} choiceBusy={choiceBusy} error={error} back={onBack}
    cancel={() => void cancel()} choose={decision => void chooseGithubInstallation(decision)} />;
  if (['failed', 'cancelled', 'interrupted'].includes(snapshot.phase) && !reconfiguring) return <Recovery snapshot={snapshot} busy={busy} error={error} back={onBack} retry={() => void run(true)} replace={() => void run(true, false, true)} review={() => void run(true, true)} />;
  if (snapshot.phase === 'completed' && snapshot.profile) return <main className="desktop-setup-wizard"><div className="desktop-setup-success"><Check /></div><span className="desktop-eyebrow">Setup complete</span><h1>ProPR is ready</h1><p>The local stack is healthy. Continue through the normal identity and pairing checks to open it.</p><div className="desktop-setup-footer"><button className="desktop-primary-button" onClick={() => onComplete(snapshot.profile!)}>Connect securely</button></div></main>;
  const index = stages.indexOf(stage);
  const recoveringLegacyDemo = reconfiguring && snapshot.resume?.github.mode === 'demo';
  const next = () => { setError(null); if (stage === 'github' && draft.githubMode === 'demo') return setError('Select ProPR Connect, Custom GitHub App, or keep an existing supported configuration.');
    if (stage === 'github' && draft.githubMode === 'app' && (!/^\d{1,20}$/.test(draft.appId) || !/^\d{1,20}$/.test(draft.installationId) || !draft.privateKey)) return setError('Enter numeric App and installation IDs, then choose the private key.');
    if (stage === 'intake' && draft.intakeMode === 'direct_webhook' && !draft.webhookSecret) return setError('Enter the webhook secret securely.');
    if (index === stages.length - 1) void run(reconfiguring); else setStage(stages[index + 1]); };
  return <Form stage={stage} draft={draft} allowGithubKeep={!recoveringLegacyDemo} setDraft={setDraft} busy={busy} error={error} chooseKey={() => void chooseKey()} acquireSecret={() => void acquireSecret()} next={next} back={index ? () => setStage(stages[index - 1]) : onBack} />;
};
