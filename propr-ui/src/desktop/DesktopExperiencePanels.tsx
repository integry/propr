import React, { useState } from 'react';
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

const connectionLabel = (result: DesktopConnectionResult): string => {
  if (result.status === 'incompatible') return 'Update required';
  if (result.status === 'authentication-required') return 'Sign in required';
  if (result.status === 'offline') return 'Instance unavailable';
  return 'Connected';
};

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

export const ProfileEditor: React.FC<ProfileEditorProps> = ({ initial, operationError, onCancel, onSave }) => {
  const [name, setName] = useState(initial?.name || 'My ProPR');
  const [baseUrl, setBaseUrl] = useState(initial?.baseUrl || 'http://127.0.0.1:3000');
  const [validationError, setValidationError] = useState<string | null>(null);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    try {
      const hostname = new URL(baseUrl).hostname;
      onSave({
        id: initial?.id || createProfileId(),
        name: name.trim() || 'My ProPR',
        baseUrl: normalizeBaseUrl(baseUrl),
        kind: initial?.kind || (hostname === '127.0.0.1' || hostname === 'localhost' ? 'local' : 'remote'),
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

export const ProfileList: React.FC<ProfileListProps> = ({ profiles, onConnect, onEdit, onRemove }) => (
  <div className="desktop-recents">
    <h2>Recent instances</h2>
    <div className="desktop-profile-list">
      {profiles.map(profile => (
        <div className="desktop-profile-row" key={profile.id}>
          <button type="button" className="desktop-profile-connect" onClick={() => onConnect(profile)}>
            <span className="desktop-profile-icon">{profile.kind === 'local' ? <Computer /> : <Cloud />}</span>
            <span><strong>{profile.name}</strong><small>{profile.baseUrl}</small></span>
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

export const InstanceChooser: React.FC<ChooserProps> = ({
  profiles, busy, error, localSetupSupported, onLocalSetup, onConnectNew, onDiscover, ...listProps
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
    <button type="button" className="desktop-discover-button" onClick={onDiscover} disabled={busy}>
      <Search aria-hidden="true" /> Search for instances on this network
    </button>
  </main>
);

interface ConnectionPanelProps {
  profile: DesktopProfile;
  result?: Exclude<DesktopConnectionResult, { status: 'ready' }>;
  onBack(): void;
  onRetry(): void;
  onAuthenticate(): void;
  onHelp(): void;
}

export const ConnectionPanel: React.FC<ConnectionPanelProps> = ({
  profile, result, onBack, onRetry, onAuthenticate, onHelp,
}) => (
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
        {'version' in result && result.version && <div className="desktop-version-note">Instance version {result.version} · Desktop {__APP_VERSION__}</div>}
        {'authentication' in result && result.authentication && <div className="desktop-version-note">{result.authentication}</div>}
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

export { DesktopBrand };
