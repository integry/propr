import { GitHubAccountIdentity } from '../components/GitHubAccountIdentity';
import React, { useLayoutEffect, useRef, useState } from 'react';
import {
  DEFAULT_LOCAL_API_BASE_URL,
  isProprLoopbackHostname,
  parseProprConnectEndpoint,
} from '@propr/shared';
import {
  AlertTriangle,
  ArrowLeft,
  ChevronRight,
  Cloud,
  Copy,
  Computer,
  ExternalLink,
  LoaderCircle,
  Pencil,
  RefreshCw,
  Search,
  Server,
  Trash2,
} from 'lucide-react';
import { normalizeBaseUrl } from './browserAdapters';
import type { DesktopAdapters, DesktopAuthenticationProgressStage, DesktopConnectionResult, DesktopPairingApprovalActionResult, DesktopProfile } from './types';

interface DesktopSetupLayerProps {
  children: React.ReactNode;
  editor: React.ReactNode;
  suspended: boolean;
}

export const DesktopSetupLayer: React.FC<DesktopSetupLayerProps> = ({ children, editor, suspended }) => <>
  <div hidden={suspended} inert={suspended} aria-hidden={suspended || undefined} style={suspended ? undefined : { display: 'contents' }}>
    {children}
  </div>
  {suspended && editor}
</>;

const createProfileId = (): string => {
  try { return crypto.randomUUID(); } catch { return `profile-${Date.now()}`; }
};

const safeVersion = (version: string | undefined): string | null =>
  version && /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/.test(version) ? version : null;

const safeProfileDisplayLabel = (name: string): string => {
  const normalized = name.replace(/[\p{Cc}\p{Cf}]/gu, ' ').trim();
  const bounded = Array.from(normalized).slice(0, 80).join('');
  if (!bounded || /https?:|\.propr\.dev\b|[/?#@\\]|token|secret|password/i.test(bounded)) {
    return 'Saved connection';
  }
  return bounded;
};

const connectionLabel = (result: DesktopConnectionResult): string => {
  if (result.status === 'incompatible') return 'Update required';
  if (result.status === 'authentication-required') return 'Sign in required';
  if (result.status === 'offline') return 'Instance unavailable';
  return 'Connected';
};

export const DesktopBrand: React.FC = () => (
  <div className="desktop-brand" aria-label="ProPR Desktop">
    <img src="/logo.png" alt="" />
    <span>ProPR</span>
  </div>
);

interface ProfileEditorProps {
  initial?: DesktopProfile;
  candidate?: boolean;
  notice?: string | null;
  operationError?: string | null;
  discovery?: DesktopAdapters['discovery'];
  onPresented?(): void;
  onCancel(): void;
  onSave(profile: DesktopProfile): void;
}

export const ProfileEditor: React.FC<ProfileEditorProps> = ({ initial, candidate = false, notice, operationError, discovery, onPresented, onCancel, onSave }) => {
  const [name, setName] = useState(() => initial?.name || 'My ProPR');
  const [baseUrl, setBaseUrl] = useState(() => initial ? initial.baseUrl : DEFAULT_LOCAL_API_BASE_URL);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [discovering, setDiscovering] = useState(false);
  const [discoveryMessage, setDiscoveryMessage] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<DesktopProfile[]>([]);
  const [selectedCandidate, setSelectedCandidate] = useState<DesktopProfile | null>(null);
  const discoveryAttempt = useRef(0);
  const connectEndpoint = parseProprConnectEndpoint(baseUrl);

  useLayoutEffect(() => { onPresented?.(); }, [onPresented]);
  useLayoutEffect(() => () => { discoveryAttempt.current += 1; }, []);

  const cancelDiscovery = () => {
    discoveryAttempt.current += 1;
    setDiscovering(false);
    setCandidates([]);
    setDiscoveryMessage(null);
  };
  const prefill = (profile: DesktopProfile) => {
    setBaseUrl(profile.baseUrl);
    setSelectedCandidate(profile);
    setCandidates([]);
    setValidationError(null);
    setDiscoveryMessage('Address filled from ProPR Connect. Review it, then choose Connect to continue.');
  };
  const discoverConnect = async () => {
    if (!discovery?.supported) return;
    const attempt = ++discoveryAttempt.current;
    setDiscovering(true);
    setCandidates([]);
    setDiscoveryMessage(null);
    try {
      const found = await discovery.discover();
      if (attempt !== discoveryAttempt.current) return;
      // Only accept canonical Connect origins from the trusted adapter. Retain
      // its id for main-process identity checks, but never its account or label.
      const endpoints = new Set<string>();
      const choices = found.flatMap(profile => {
        const endpoint = parseProprConnectEndpoint(profile.baseUrl);
        if (!endpoint || endpoints.has(endpoint.origin)) return [];
        endpoints.add(endpoint.origin);
        return [{ id: profile.id, name: 'ProPR Connect', baseUrl: endpoint.origin, kind: 'remote' as const }];
      });
      if (choices.length === 1) prefill(choices[0]);
      else if (choices.length > 1) setCandidates(choices);
      else setDiscoveryMessage('No shared endpoint was found. Open or run ProPR Connect, make sure sharing is ready, then retry Use ProPR Connect. You can also paste its API URL below.');
    } catch {
      if (attempt === discoveryAttempt.current) setDiscoveryMessage('Could not discover ProPR Connect. Open or run ProPR Connect, check that sharing is ready, then retry Use ProPR Connect or paste its API URL below.');
    } finally {
      if (attempt === discoveryAttempt.current) setDiscovering(false);
    }
  };

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    cancelDiscovery();
    try {
      const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
      const hostname = new URL(normalizedBaseUrl).hostname;
      onSave({
        id: (selectedCandidate?.baseUrl === normalizedBaseUrl ? selectedCandidate.id : undefined) || initial?.id || createProfileId(),
        account: initial?.account,
        name: name.trim() || 'My ProPR',
        baseUrl: normalizedBaseUrl,
        kind: isProprLoopbackHostname(hostname) ? 'local' : 'remote',
        lastConnectedAt: initial?.lastConnectedAt,
      });
    } catch (caught) {
      setValidationError(caught instanceof Error ? caught.message : 'Enter a valid instance URL.');
    }
  };

  const error = validationError || operationError;
  return (
    <form className="desktop-profile-form" onSubmit={submit}>
      <button type="button" className="desktop-back-button" onClick={() => { cancelDiscovery(); onCancel(); }}>
        <ArrowLeft aria-hidden="true" /> Back
      </button>
      <h2>{candidate || !initial ? 'Connect to an instance' : 'Edit instance'}</h2>
      <p>Enter the address shown by your ProPR server.</p>
      {notice && <div className="desktop-version-note" role="status">{notice}</div>}
      {!initial && discovery?.supported && <>
        <div className="flex flex-wrap items-center gap-3">
          <button type="button" className="desktop-secondary-button" disabled={discovering} onClick={() => void discoverConnect()}><Cloud aria-hidden="true" /> Use ProPR Connect</button>
          {(discovering || candidates.length > 0) && <button type="button" className="desktop-link-button" onClick={cancelDiscovery}>Cancel discovery</button>}
        </div>
        {discovering && <div role="status">Looking for a shared ProPR Connect API URL…</div>}
        {discoveryMessage && <div className="desktop-version-note" role="status">{discoveryMessage}</div>}
        {candidates.length > 0 && <fieldset className="mt-3">
          <legend className="mb-2 text-sm font-semibold">Choose a ProPR Connect endpoint</legend>
          <div className="desktop-profile-list">{candidates.map(profile => <button key={profile.id} type="button" className="desktop-secondary-button" onClick={() => prefill(profile)}>{profile.baseUrl}</button>)}</div>
        </fieldset>}
      </>}
      <label>
        Display name
        <input autoFocus value={name} onChange={event => setName(event.target.value)} placeholder="Team ProPR" maxLength={80} />
      </label>
      <label>
        Instance URL
        <input value={baseUrl} onChange={event => { cancelDiscovery(); setValidationError(null); setBaseUrl(event.target.value); }} inputMode="url" placeholder="https://propr.example.com" maxLength={2048} aria-describedby={error ? 'profile-url-error' : undefined} />
      </label>
      {connectEndpoint && <div className="desktop-connect-verified" role="status"><Cloud aria-hidden="true" /> ProPR Connect address · Identity checked when connecting</div>}
      {error && <div id="profile-url-error" className="desktop-inline-error" role="alert">{error}</div>}
      <button type="submit" className="desktop-primary-button">{candidate || !initial ? 'Connect' : 'Save changes'}</button>
    </form>
  );
};

interface ProfileListProps {
  activeProfileId?: string;
  onAddAccount?(profile: DesktopProfile): void;
  profiles: DesktopProfile[];
  onConnect(profile: DesktopProfile): void;
  onEdit(profile: DesktopProfile): void;
  onRemove(profile: DesktopProfile): void;
}

export const ProfileList: React.FC<ProfileListProps> = ({ profiles, onConnect, onEdit, onRemove, onAddAccount, activeProfileId }) => (
  <div className="desktop-recents">
    <h2>{onAddAccount ? 'Saved accounts and instances' : 'Recent instances'}</h2>
    {onAddAccount && <p className="desktop-account-scope-note">One active account in this desktop window. Browser accounts are managed separately.</p>}
    <div className="desktop-profile-list">
      {profiles.map(profile => (
        <div className="desktop-profile-row" key={profile.id}>
          <button type="button" className="desktop-profile-connect" onClick={() => onConnect(profile)}>
            <span className="desktop-profile-icon">{profile.kind === 'local' ? <Computer /> : <Cloud />}</span>
            <span>
              <strong>{profile.name}{profile.id === activeProfileId ? ' · Current' : ''}</strong>
              {profile.account && <small><GitHubAccountIdentity account={profile.account} /></small>}
              <small>{parseProprConnectEndpoint(profile.baseUrl) ? 'ProPR Connect' : profile.account ? profile.baseUrl : profile.kind === 'local' ? 'Local instance' : 'Remote instance'}</small>
            </span>
            <ChevronRight className="desktop-profile-chevron" aria-hidden="true" />
          </button>
          {onAddAccount && <button type="button" className="desktop-secondary-button desktop-account-add" onClick={() => onAddAccount(profile)} aria-label={`Add GitHub account to ${profile.name}`}>Add account</button>}
          <button type="button" className="desktop-icon-button" onClick={() => onEdit(profile)} aria-label={profile.account ? `Edit ${profile.name} for @${profile.account.username}` : `Edit ${profile.name}`}><Pencil /></button>
          <button type="button" className="desktop-icon-button desktop-danger-button" onClick={() => onRemove(profile)} aria-label={profile.account ? `Remove @${profile.account.username} from ${profile.name}` : `Remove ${profile.name}`}><Trash2 /></button>
        </div>
      ))}
    </div>
  </div>
);

interface ChooserProps extends ProfileListProps {
  busy: boolean;
  error: string | null;
  localSetupSupported: boolean;
  networkDiscoverySupported: boolean;
  onLocalSetup(): void;
  onConnectNew(): void;
  onDiscover(): void;
}

export const InstanceChooser: React.FC<ChooserProps> = ({
  profiles, busy, error, localSetupSupported, networkDiscoverySupported,
  onLocalSetup, onConnectNew, onDiscover, ...listProps
}) => (
  <main className="desktop-welcome-card">
    <DesktopBrand />
    <div className="desktop-welcome-copy">
      <span className="desktop-eyebrow">ProPR Desktop</span>
      <h1>{profiles.length ? (listProps.onAddAccount ? 'Choose an account' : 'Choose an instance') : localSetupSupported ? 'Let’s set up this computer' : 'Connect to ProPR'}</h1>
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
    {networkDiscoverySupported && (
      <button type="button" className="desktop-discover-button" onClick={onDiscover} disabled={busy}>
        <Search aria-hidden="true" /> Search for instances on this network
      </button>
    )}
  </main>
);

interface ConnectionPanelProps {
  profile: DesktopProfile;
  result?: Exclude<DesktopConnectionResult, { status: 'ready' }>;
  onBack(): void;
  onRetry(): void;
  onAuthenticate(): void;
  onHelp(): void;
  onReenter(): void;
  onRediscover(): void;
}

export const ConnectionPanel = ({ profile, result, onBack, onRetry, onAuthenticate, onHelp, onReenter, onRediscover }: ConnectionPanelProps) => {
  const managed = Boolean(result && parseProprConnectEndpoint(profile.baseUrl));
  return (
    <main className="desktop-connection-card" aria-live="polite">
      <DesktopBrand />
      {!result ? (
        <><div className="desktop-connection-visual desktop-connecting"><LoaderCircle /></div><h1>Connecting to {profile.name}</h1><p>Checking the instance and desktop compatibility…</p><div className="desktop-connection-actions"><button type="button" className="desktop-link-button" onClick={onBack}><ArrowLeft aria-hidden="true" /> Back</button></div></>
      ) : (
        <>
          <div className={`desktop-connection-visual desktop-${result.status}`}><AlertTriangle /></div>
          <span className="desktop-eyebrow">{connectionLabel(result)}</span><h1>{profile.name}</h1>
          <p>{result.message}</p>
          {result.status === 'incompatible' && safeVersion(result.version) && <div className="desktop-version-note">Instance version {safeVersion(result.version)} · Desktop {__APP_VERSION__}</div>}
          {'authentication' in result && result.authentication && <div className="desktop-version-note">{result.authentication}</div>}
          <div className="desktop-connection-actions">
            {result.status === 'authentication-required' && <button type="button" className="desktop-primary-button" onClick={onAuthenticate}>Sign in in browser</button>}
            <button type="button" className={result.status === 'authentication-required' ? 'desktop-secondary-button' : 'desktop-primary-button'} onClick={onRetry}><RefreshCw /> {managed ? 'Retry' : 'Try again'}</button>
            {managed && <button type="button" className="desktop-secondary-button" onClick={onReenter}>Re-enter Connect address</button>}
            {managed && <button type="button" className="desktop-secondary-button" onClick={onRediscover}>Rediscover Connect endpoint</button>}
            <button type="button" className="desktop-link-button" onClick={onBack}>Choose another instance</button>
            <button type="button" className="desktop-link-button" onClick={onHelp}>Open connection help</button>
          </div>
        </>
      )}
    </main>
  );
};

const authenticationProgressMessage = (progress: DesktopAuthenticationProgressStage): string => {
  if (progress === 'browser-opening') return 'Opening the secure approval page in your default browser…';
  if (progress === 'approval-pending') {
    return 'Finish signing in and approve ProPR Desktop in your browser. This window will continue automatically.';
  }
  if (progress === 'browser-open-failed') {
    return 'ProPR Desktop could not confirm that your browser opened. If the approval page appeared, finish there and this window will keep waiting. If it did not, reopen it or copy the approval link below.';
  }
  return 'Preparing a secure browser approval request…';
};

export const AuthenticationPanel = ({ profile, progress, onCancel, onChoose, onReopen, onCopy }: {
  profile: DesktopProfile;
  progress: DesktopAuthenticationProgressStage;
  onCancel(): void;
  onChoose(): void;
  onReopen?(): Promise<DesktopPairingApprovalActionResult>;
  onCopy?(): Promise<DesktopPairingApprovalActionResult>;
}) => {
  const [pendingAction, setPendingAction] = useState<'reopen' | 'copy' | null>(null);
  const [feedback, setFeedback] = useState<{ error: boolean; message: string } | null>(null);
  const recoveryAvailable = progress === 'approval-pending' || progress === 'browser-open-failed';
  const runRecovery = async (
    action: 'reopen' | 'copy',
    recover: () => Promise<DesktopPairingApprovalActionResult>,
  ) => {
    setPendingAction(action);
    setFeedback(null);
    try {
      const result = await recover();
      if (result.status === 'succeeded') {
        setFeedback({
          error: false,
          message: action === 'reopen'
            ? 'Approval page requested in your default browser.'
            : 'Approval link copied.',
        });
      } else if (result.status === 'unavailable') {
        setFeedback({ error: true, message: 'This approval request is no longer available. Start sign in again.' });
      } else {
        setFeedback({
          error: true,
          message: action === 'reopen'
            ? 'Could not reopen the approval page. Check your default browser, or copy the link instead.'
            : 'Could not copy the approval link. Check clipboard access and try again.',
        });
      }
    } catch {
      setFeedback({
        error: true,
        message: action === 'reopen'
          ? 'Could not reopen the approval page. Check your default browser, or copy the link instead.'
          : 'Could not copy the approval link. Check clipboard access and try again.',
      });
    } finally {
      setPendingAction(null);
    }
  };

  return (
    <main className="desktop-connection-card" aria-live="polite">
      <DesktopBrand />
      <div className={`desktop-connection-visual ${progress === 'browser-open-failed' ? '' : 'desktop-connecting'}`}>
        {progress === 'browser-open-failed' ? <AlertTriangle aria-hidden="true" /> : <LoaderCircle aria-hidden="true" />}
      </div>
      <span className="desktop-eyebrow">Waiting for browser approval</span>
      <h1>{profile.name}</h1>
      <p>{authenticationProgressMessage(progress)}</p>
      {feedback && <div className={feedback.error ? 'desktop-inline-error' : 'desktop-inline-status'} role={feedback.error ? 'alert' : 'status'}>{feedback.message}</div>}
      <div className="desktop-connection-actions">
        {recoveryAvailable && onReopen && <button type="button" className="desktop-secondary-button" disabled={pendingAction !== null} onClick={() => void runRecovery('reopen', onReopen)}><ExternalLink /> {pendingAction === 'reopen' ? 'Reopening…' : 'Reopen browser'}</button>}
        {recoveryAvailable && onCopy && <button type="button" className="desktop-secondary-button" disabled={pendingAction !== null} onClick={() => void runRecovery('copy', onCopy)}><Copy /> {pendingAction === 'copy' ? 'Copying…' : 'Copy approval link'}</button>}
        <button type="button" className="desktop-secondary-button" onClick={onCancel}>Cancel sign in</button>
        <button type="button" className="desktop-link-button" onClick={onChoose}>Choose another instance</button>
      </div>
    </main>
  );
};

export const ManagedRecoveryReview = ({ profile, onCancel, onConfirm }: {
  profile: DesktopProfile;
  onCancel(): void;
  onConfirm(): void;
}) => (
  <main className="desktop-connection-card" aria-live="polite">
    <DesktopBrand />
    <div className="desktop-connection-visual"><Cloud aria-hidden="true" /></div>
    <span className="desktop-eyebrow">ProPR Connect rediscovered</span>
    <h1>Use the rediscovered endpoint?</h1>
    <p>A replacement endpoint was discovered for the saved connection “{safeProfileDisplayLabel(profile.name)}”. Confirm before updating that connection.</p>
    <div className="desktop-connection-actions">
      <button type="button" className="desktop-primary-button" onClick={onConfirm}>Connect to rediscovered endpoint</button>
      <button type="button" className="desktop-link-button" onClick={onCancel}>Keep saved connection</button>
    </div>
  </main>
);
