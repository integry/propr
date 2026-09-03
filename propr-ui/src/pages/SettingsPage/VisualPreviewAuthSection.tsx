import React, { useCallback, useEffect, useState } from 'react';
import { Check, LoaderCircle, LogIn, Unplug } from 'lucide-react';
import { logout } from '../../api/proprApi';
import {
  disconnectVisualPreviewAuth,
  getVisualPreviewAuthStatus,
  connectCurrentGitHubLoginForVisualPreviews,
  type VisualPreviewAuthStatus,
} from '../../api/visualPreviewAuthApi';

function statusDescription(status: VisualPreviewAuthStatus | null): string {
  if (status?.source === 'environment') {
    return status.status === 'active'
      ? 'A server-managed credential is configured through GITHUB_VISUAL_PREVIEW_TOKEN.'
      : 'GITHUB_VISUAL_PREVIEW_TOKEN is set but is not a supported upload credential. Remove or replace it and restart the worker.';
  }
  if (status?.status === 'active' && status.githubUsername) {
    return `Uploads use the GitHub login for @${status.githubUsername}. Expiring OAuth credentials are refreshed automatically.`;
  }
  return 'Connect an administrator GitHub login so background workers can attach generated screenshots and videos to pull requests.';
}

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

  if (loading) {
    return (
      <div className="border-t border-gray-200 pt-6 text-xs text-gray-500">
        Loading visual preview upload status...
      </div>
    );
  }

  const active = status?.status === 'active';
  const environmentManaged = status?.source === 'environment';

  return (
    <div className="border-t border-gray-200 pt-6">
      <div className="mb-2 flex items-center justify-between gap-3">
        <h4 className="text-[10px] font-bold uppercase tracking-wider text-gray-500">Visual preview uploads</h4>
        <span className={`flex items-center gap-1.5 text-[11px] ${active ? 'text-green-700' : 'text-amber-700'}`}>
          <span className={`h-1.5 w-1.5 rounded-full ${active ? 'bg-green-500' : 'bg-amber-500'}`} />
          {active ? 'Connected' : status?.status === 'reauth_required' ? 'Reconnect required' : 'Not connected'}
        </span>
      </div>

      <p className="text-xs leading-5 text-gray-600">
        {statusDescription(status)}
      </p>

      {!environmentManaged && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {status?.canUseCurrentLogin && status.status !== 'reauth_required' ? (
            <button
              type="button"
              onClick={() => void connect()}
              disabled={saving}
              className="inline-flex items-center gap-1.5 rounded bg-gray-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-gray-800 disabled:opacity-50"
            >
              {saving ? <LoaderCircle size={13} className="animate-spin" /> : <Check size={13} />}
              Use my GitHub login
            </button>
          ) : (
            <button
              type="button"
              onClick={() => { void logout(); }}
              disabled={saving}
              className="inline-flex items-center gap-1.5 rounded bg-gray-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-gray-800 disabled:opacity-50"
            >
              <LogIn size={13} />
              Sign in with GitHub again
            </button>
          )}
          {status?.configured && (
            <button
              type="button"
              onClick={() => void disconnect()}
              disabled={saving}
              className="inline-flex items-center gap-1.5 rounded border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-50 disabled:opacity-50"
            >
              <Unplug size={13} />
              Disconnect
            </button>
          )}
        </div>
      )}

      {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
    </div>
  );
};

export default VisualPreviewAuthSection;
