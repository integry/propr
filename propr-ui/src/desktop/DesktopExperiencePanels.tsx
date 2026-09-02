import React, { useState } from 'react';
import { isProprLoopbackHostname, parseProprConnectEndpoint } from '@propr/shared';
import {
  AlertTriangle,
  ArrowLeft,
  ChevronRight,
  Cloud,
  Computer,
  LoaderCircle,
  Pencil,
  RefreshCw,
  Search,
  Server,
  Trash2,
} from 'lucide-react';
import { normalizeBaseUrl } from './browserAdapters';
import type { DesktopConnectionResult, DesktopProfile } from './types';

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
  onCancel(): void;
  onSave(profile: DesktopProfile): void;
}

export const ProfileEditor: React.FC<ProfileEditorProps> = ({ initial, candidate = false, notice, operationError, onCancel, onSave }) => {
  const [name, setName] = useState(initial?.name || 'My ProPR');
  const [baseUrl, setBaseUrl] = useState(initial ? initial.baseUrl : 'http://127.0.0.1:3000');
  const [validationError, setValidationError] = useState<string | null>(null);
  const connectEndpoint = parseProprConnectEndpoint(baseUrl);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    try {
      const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
      const hostname = new URL(normalizedBaseUrl).hostname;
      onSave({
        id: initial?.id || createProfileId(),
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
      <button type="button" className="desktop-back-button" onClick={onCancel}>
        <ArrowLeft aria-hidden="true" /> Back
      </button>
      <h2>{candidate || !initial ? 'Connect to an instance' : 'Edit instance'}</h2>
      <p>Enter the address shown by your ProPR server.</p>
      {notice && <div className="desktop-version-note" role="status">{notice}</div>}
      <label>
        Display name
        <input autoFocus value={name} onChange={event => setName(event.target.value)} placeholder="Team ProPR" maxLength={80} />
      </label>
      <label>
        Instance URL
        <input value={baseUrl} onChange={event => setBaseUrl(event.target.value)} inputMode="url" placeholder="https://propr.example.com" maxLength={2048} aria-describedby={error ? 'profile-url-error' : undefined} />
      </label>
      {connectEndpoint && <div className="desktop-connect-verified" role="status"><Cloud aria-hidden="true" /> Verified ProPR Connect endpoint</div>}
      {error && <div id="profile-url-error" className="desktop-inline-error" role="alert">{error}</div>}
      <button type="submit" className="desktop-primary-button">{candidate || !initial ? 'Connect' : 'Save changes'}</button>
    </form>
  );
};

interface ProfileListProps {
  profiles: DesktopProfile[];
  onConnect(profile: DesktopProfile): void;
  onEdit(profile: DesktopProfile): void;
  onRemove(profile: DesktopProfile): void;
}

export const ProfileList: React.FC<ProfileListProps> = ({ profiles, onConnect, onEdit, onRemove }) => (
  <div className="desktop-recents">
    <h2>Recent instances</h2>
    <div className="desktop-profile-list">
      {profiles.map(profile => (
        <div className="desktop-profile-row" key={profile.id}>
          <button type="button" className="desktop-profile-connect" onClick={() => onConnect(profile)}>
            <span className="desktop-profile-icon">{profile.kind === 'local' ? <Computer /> : <Cloud />}</span>
            <span>
              <strong>{profile.name}</strong>
              <small>{parseProprConnectEndpoint(profile.baseUrl) ? 'ProPR Connect' : profile.kind === 'local' ? 'Local instance' : 'Remote instance'}</small>
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
