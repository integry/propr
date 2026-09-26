import React, { useCallback, useEffect, useState } from 'react';
import { Check, KeyRound, LoaderCircle, Unplug, X } from 'lucide-react';
import { SettingsSection, SettingsStatus } from './SettingsLayout';
import {
  disconnectVisualPreviewAuth,
  getVisualPreviewAuthStatus,
  connectCurrentGitHubLoginForVisualPreviews,
  connectVisualPreviewPersonalAccessToken,
  type VisualPreviewAuthStatus,
} from '../../api/visualPreviewAuthApi';

const FINE_GRAINED_TOKEN_URL = 'https://github.com/settings/personal-access-tokens/new?name=ProPR%20visual%20previews&description=Uploads%20generated%20preview%20media%20to%20pull%20requests&pull_requests=write';

function statusDescription(status: VisualPreviewAuthStatus | null): string {
  if (status?.source === 'environment') {
    return status.status === 'active'
      ? 'A server-managed credential is configured through GITHUB_VISUAL_PREVIEW_TOKEN.'
      : 'GITHUB_VISUAL_PREVIEW_TOKEN is set but is not a supported upload credential. Remove or replace it and restart the worker.';
  }
  if (status?.status === 'active' && status.source === 'static_token' && status.githubUsername) {
    return `Uploads use an encrypted upload token owned by @${status.githubUsername}.`;
  }
  if (status?.status === 'active' && status.githubUsername) {
    return `Uploads use the GitHub login for @${status.githubUsername}. Expiring OAuth credentials are refreshed automatically.`;
  }
  if (status?.currentLoginTokenType === 'github_app_user') {
    return 'Your normal login uses a GitHub App token, which GitHub attachment uploads reject. Add a personal access token once for preview uploads.';
  }
  return 'Add a GitHub personal access token so background workers can attach generated screenshots and videos to pull requests.';
}

interface VisualPreviewAuthControlsProps {
  status: VisualPreviewAuthStatus | null;
  saving: boolean;
  onConnectCurrentLogin: () => Promise<void>;
  onDisconnect: () => Promise<void>;
  onSaveToken: (token: string) => Promise<boolean>;
  onClearError: () => void;
}

const VisualPreviewAuthControls: React.FC<VisualPreviewAuthControlsProps> = ({
  status,
  saving,
  onConnectCurrentLogin,
  onDisconnect,
  onSaveToken,
  onClearError,
}) => {
  const [editingToken, setEditingToken] = useState(false);
  const [token, setToken] = useState('');
  const active = status?.status === 'active';
  const canConnectCurrentLogin = !active && status?.canUseCurrentLogin;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const submittedToken = token.trim();
    if (!submittedToken) return;
    setToken('');
    if (await onSaveToken(submittedToken)) setEditingToken(false);
  };

  return (
    <div>
      <div className="flex max-w-2xl flex-wrap items-center gap-2">
        {canConnectCurrentLogin && (
          <button
            type="button"
            onClick={() => void onConnectCurrentLogin()}
            disabled={saving}
            className="inline-flex items-center gap-1.5 rounded bg-slate-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-800 disabled:opacity-50"
          >
            {saving ? <LoaderCircle size={13} className="animate-spin" /> : <Check size={13} />}
            Use my GitHub login
          </button>
        )}
        <button
          type="button"
          onClick={() => { setEditingToken(value => !value); onClearError(); }}
          disabled={saving}
          className={`${canConnectCurrentLogin ? 'border border-slate-300 text-slate-600 hover:bg-slate-50' : 'bg-slate-900 text-white hover:bg-slate-800'} inline-flex items-center gap-1.5 rounded px-3 py-1.5 text-xs font-medium disabled:opacity-50`}
        >
          {editingToken ? <X size={13} /> : <KeyRound size={13} />}
          {editingToken ? 'Cancel' : active || status?.configured ? 'Replace token' : 'Add personal access token'}
        </button>
        {status?.configured && (
          <button
            type="button"
            onClick={() => void onDisconnect()}
            disabled={saving}
            className="inline-flex items-center gap-1.5 rounded border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50"
          >
            <Unplug size={13} />
            Disconnect
          </button>
        )}
      </div>

      {editingToken && (
        <form onSubmit={(event) => void submit(event)} className="mt-4 max-w-2xl border-t border-slate-200 pt-4">
          <label htmlFor="visual-preview-token" className="block text-sm font-medium text-slate-900">
            GitHub personal access token
          </label>
          <div className="mt-1.5 flex flex-col gap-2 sm:flex-row">
            <input
              id="visual-preview-token"
              type="password"
              value={token}
              onChange={(event) => setToken(event.target.value)}
              autoComplete="off"
              spellCheck={false}
              maxLength={512}
              placeholder="github_pat_… or ghp_…"
              className="min-w-0 flex-1 rounded border border-slate-300 bg-white px-2.5 py-1.5 text-sm text-slate-900 shadow-sm focus:border-primary-500 focus:outline-none focus:ring-1 focus:ring-primary-500"
            />
            <button
              type="submit"
              disabled={saving || !token.trim()}
              className="inline-flex items-center justify-center gap-1.5 rounded bg-slate-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-800 disabled:opacity-50"
            >
              {saving && <LoaderCircle size={13} className="animate-spin" />}
              Save token
            </button>
          </div>
          <div className="mt-4 text-[12px] leading-5 text-slate-500">
            <p className="text-[11px] font-bold uppercase tracking-widest text-slate-500">Fine-grained token requirements</p>
            <ol className="mt-1.5 list-decimal space-y-1 pl-4">
              <li>Choose the organization or user that owns the repositories as the resource owner.</li>
              <li>Select every repository where ProPR will upload visual previews.</li>
              <li>
                Under repository permissions, set <span className="font-medium text-slate-700">Pull requests</span> to{' '}
                <span className="font-medium text-slate-700">Read and write</span>. Metadata read access is added automatically;
                no other repository permission is required.
              </li>
              <li>
                Use an account with push access to those repositories. Complete organization approval or SAML SSO authorization,
                if required.
              </li>
            </ol>
            <p className="mt-2">
              GitHub will prefill the token name and Pull requests permission; you still choose the owner, repositories, and expiration.{' '}
              <a
                href={FINE_GRAINED_TOKEN_URL}
                target="_blank"
                rel="noreferrer"
                className="font-medium text-slate-700 underline hover:text-slate-900"
              >
                Create token on GitHub
              </a>
            </p>
            <p className="mt-2 text-slate-500">
              A fine-grained token can cover only one resource owner. If preview-enabled repositories span multiple owners, use a
              classic token with <code className="font-mono">repo</code>, or <code className="font-mono">public_repo</code> when
              every repository is public.
            </p>
          </div>
          <p className="mt-3 text-[12px] leading-5 text-slate-500">
            The token is sent once, validated with GitHub, and encrypted at rest. It is never displayed again after saving.
          </p>
        </form>
      )}
    </div>
  );
};

const VisualPreviewAuthSection: React.FC = () => {
  const [status, setStatus] = useState<VisualPreviewAuthStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setStatus(await getVisualPreviewAuthStatus());
      setError(null);
    } catch (requestError) {
      setError((requestError as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const connect = async () => {
    setSaving(true);
    setError(null);
    try {
      setStatus(await connectCurrentGitHubLoginForVisualPreviews());
    } catch (requestError) {
      setError((requestError as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const disconnect = async () => {
    setSaving(true);
    setError(null);
    try {
      await disconnectVisualPreviewAuth();
      await load();
    } catch (requestError) {
      setError((requestError as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const saveToken = async (submittedToken: string): Promise<boolean> => {
    setSaving(true);
    setError(null);
    try {
      setStatus(await connectVisualPreviewPersonalAccessToken(submittedToken));
      return true;
    } catch (requestError) {
      setError((requestError as Error).message);
      return false;
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <SettingsSection
        title="Visual preview uploads"
        status={<SettingsStatus tone="pending" role="status">Loading…</SettingsStatus>}
      >
        <p className="max-w-2xl text-[12px] leading-5 text-slate-500">Loading visual preview upload status...</p>
      </SettingsSection>
    );
  }

  const active = status?.status === 'active';
  const environmentManaged = status?.source === 'environment';

  return (
    <SettingsSection
      title="Visual preview uploads"
      description={statusDescription(status)}
      status={
        <SettingsStatus tone={active ? 'ok' : 'warn'} role="status">
          {active ? 'Connected' : status?.status === 'reauth_required' ? 'Reconnect required' : 'Not connected'}
        </SettingsStatus>
      }
    >
      {!environmentManaged && (
        <VisualPreviewAuthControls
          status={status}
          saving={saving}
          onConnectCurrentLogin={connect}
          onDisconnect={disconnect}
          onSaveToken={saveToken}
          onClearError={() => setError(null)}
        />
      )}

      {error && <p className="mt-3 max-w-2xl text-[12px] leading-5 text-red-600">{error}</p>}
    </SettingsSection>
  );
};

export default VisualPreviewAuthSection;
