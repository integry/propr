import { useCallback, useEffect, useState } from 'react';
import {
  getMcpAdminSettings,
  updateMcpAdminSettings,
  revokeAllMcpConnections,
  type McpAdminResponse,
  type McpScope,
  MCP_ALL_SCOPES,
} from '../../api/adminMcpApi';
import { useDemoMode } from '../../contexts/DemoModeContext';
import { SettingsSection, SettingsStatus, type SettingsStatusTone } from './SettingsLayout';

function statusLabel(data: McpAdminResponse | null): string {
  if (!data) return 'Loading…';
  const { status } = data;
  if (status.demoMode) return 'Demo mode';
  if (status.operatorForced === 'off') return 'Disabled by operator';
  if (status.operatorForced === 'on') return 'Managed by environment';
  if (status.keyChanged) return 'Reconnect required';
  if (status.missingHttpsOrigin) return 'No HTTPS origin';
  if (status.missingSecretChain) return 'No secret configured';
  return status.enabled ? 'Enabled' : 'Disabled';
}

function statusTone(data: McpAdminResponse | null): SettingsStatusTone {
  if (!data) return 'pending';
  const { status } = data;
  if (status.enabled || status.operatorForced === 'on') return 'ok';
  if (status.keyChanged || status.missingHttpsOrigin || status.missingSecretChain) return 'error';
  return 'pending';
}

function statusDescriptionSuffix(data: McpAdminResponse | null): string {
  if (!data) return '';
  const { status } = data;
  if (status.operatorForced === 'off') return ' MCP is disabled by operator configuration.';
  if (status.operatorForced === 'on') return ' MCP is enabled and managed through environment variables.';
  if (status.missingHttpsOrigin) return ' An HTTPS public URL is required (set API_PUBLIC_URL or GH_OAUTH_CALLBACK_URL).';
  if (status.missingSecretChain) return ' A secret is required (set PROPR_CREDENTIAL_ENCRYPTION_KEY, SYSTEM_TASK_SECRET, or SESSION_SECRET).';
  if (status.keyChanged) return ' The encryption key has changed — existing connections need to reconnect.';
  return '';
}

interface EnableToggleProps {
  isEnabled: boolean;
  saving: boolean;
  canToggle: boolean;
  confirmEnable: boolean;
  onToggle: (enabled: boolean) => void;
  onCancelConfirm: () => void;
}

function EnableToggle({ isEnabled, saving, canToggle, confirmEnable, onToggle, onCancelConfirm }: EnableToggleProps) {
  if (confirmEnable) {
    return (
      <div className="max-w-2xl border-l-2 border-amber-400 pl-3 text-[12px] leading-5 text-amber-900">
        <p className="font-medium">Enable MCP server?</p>
        <p className="mt-1">This will expose an OAuth endpoint and allow AI clients to access this ProPR instance on behalf of your users.</p>
        <div className="mt-2 flex gap-2">
          <button
            type="button"
            disabled={saving}
            onClick={() => onToggle(true)}
            className="rounded bg-amber-600 px-3 py-1.5 text-white disabled:opacity-50"
          >
            {saving ? 'Enabling…' : 'Enable'}
          </button>
          <button type="button" onClick={onCancelConfirm} className="rounded border border-slate-300 bg-white px-3 py-1.5 text-slate-700 hover:bg-slate-50">
            Cancel
          </button>
        </div>
      </div>
    );
  }
  return (
    <label className="flex cursor-pointer items-center gap-3">
      <input
        type="checkbox"
        checked={isEnabled}
        disabled={saving || !canToggle}
        onChange={e => onToggle(e.target.checked)}
        className="h-4 w-4 flex-shrink-0 rounded border-slate-300 text-primary-600 focus:ring-primary-500"
      />
      <span className="text-sm font-medium text-slate-900">Enable MCP server</span>
    </label>
  );
}

interface McpDetailsProps {
  data: McpAdminResponse;
  saving: boolean;
  revoking: boolean;
  isOperatorManaged: boolean;
  onUpdateScopes: (scopes: McpScope[]) => void;
  onRevokeAll: () => void;
}

function McpDetails({ data, saving, revoking, isOperatorManaged, onUpdateScopes, onRevokeAll }: McpDetailsProps) {
  const { status, settings } = data;
  const connectionUrl = status.resource;
  return (
    <>
      {connectionUrl && (
        <div className="mb-6 max-w-2xl">
          <p className="text-sm font-medium text-slate-900">Connection URL</p>
          <div className="mt-1.5 flex items-center gap-2">
            <code className="min-w-0 flex-1 break-all rounded border border-slate-300 bg-white px-2.5 py-1.5 text-xs text-slate-900 shadow-sm">
              {connectionUrl}
            </code>
            <button
              type="button"
              onClick={() => { void navigator.clipboard.writeText(connectionUrl); }}
              className="shrink-0 text-[12px] text-slate-600 underline hover:text-slate-900"
            >
              Copy
            </button>
          </div>
          <p className="mt-1.5 text-[12px] leading-5 text-slate-500">
            Claude Code: <code className="text-slate-700">claude mcp add --transport http propr {connectionUrl}</code>
          </p>
        </div>
      )}
      {settings.scopeCeiling && !isOperatorManaged && (
        <div className="mb-6 max-w-2xl">
          <p className="text-sm font-medium text-slate-900">Scope ceiling</p>
          <p className="mt-1.5 text-[12px] leading-5 text-slate-500">Clients cannot be granted scopes beyond this ceiling.</p>
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-2">
            {MCP_ALL_SCOPES.map(scope => (
              <label key={scope} className="flex items-center gap-2 text-[12px] text-slate-700">
                <input
                  type="checkbox"
                  checked={settings.scopeCeiling.includes(scope)}
                  disabled={saving || scope === 'read'}
                  onChange={e => {
                    const updated = e.target.checked
                      ? [...settings.scopeCeiling, scope]
                      : settings.scopeCeiling.filter(s => s !== scope);
                    onUpdateScopes(updated);
                  }}
                  className="h-3.5 w-3.5 flex-shrink-0 rounded border-slate-300 text-primary-600 focus:ring-primary-500"
                />
                {scope}
              </label>
            ))}
          </div>
        </div>
      )}
      <div className="flex max-w-2xl items-center justify-between gap-3 border-t border-slate-200 pt-4">
        {/* The /mcp/apps page is served by the API app, whose origin can differ
            from the SPA origin, so the link must target the resolved MCP origin. */}
        {status.origin ? (
          <a href={`${status.origin}/mcp/apps`} className="text-[12px] text-primary-600 underline hover:text-primary-700">
            View connected apps →
          </a>
        ) : (
          <span />
        )}
        <button
          type="button"
          disabled={revoking}
          onClick={onRevokeAll}
          className="text-[12px] text-red-600 underline disabled:opacity-50 hover:text-red-800"
        >
          {revoking ? 'Revoking…' : 'Revoke all connections'}
        </button>
      </div>
    </>
  );
}

interface KeyRotationNoticeProps {
  revoking: boolean;
  onRevokeAll: () => void;
}

function KeyRotationNotice({ revoking, onRevokeAll }: KeyRotationNoticeProps) {
  return (
    <div className="mb-6 max-w-2xl border-l-2 border-amber-400 pl-3 text-[12px] leading-5 text-amber-900">
      <p className="font-medium">Encryption key changed</p>
      <p className="mt-1">
        Existing connections were encrypted with the previous secret and can no longer be used. Revoke them to clear this
        state, then enable the MCP server again.
      </p>
      <button
        type="button"
        disabled={revoking}
        onClick={onRevokeAll}
        className="mt-2 rounded bg-amber-600 px-3 py-1.5 text-white disabled:opacity-50"
      >
        {revoking ? 'Revoking…' : 'Revoke all connections'}
      </button>
    </div>
  );
}

interface McpServerSectionProps {
  onError?: (message: string) => void;
}

export default function McpServerSection({ onError }: McpServerSectionProps) {
  const { isDemoMode } = useDemoMode();
  const [data, setData] = useState<McpAdminResponse | null>(null);
  const [saving, setSaving] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [confirmEnable, setConfirmEnable] = useState(false);

  // Every failure is reported in-section as well as through onError: the parent
  // callback is optional, and an admin toggling a security-sensitive server has
  // to be told why it did not take effect.
  const reportError = useCallback((message: string) => {
    setErrorMessage(message);
    onError?.(message);
  }, [onError]);

  const load = useCallback(async () => {
    try {
      const result = await getMcpAdminSettings();
      setData(result);
    } catch {
      reportError('Failed to load MCP settings');
    }
  }, [reportError]);

  useEffect(() => {
    void load();
  }, [load]);

  const isOperatorManaged = data?.status.operatorForced !== undefined;
  const isEnabled = data?.status.enabled ?? false;

  const toggleEnable = async (enabled: boolean) => {
    if (enabled && !confirmEnable) { setConfirmEnable(true); return; }
    setConfirmEnable(false);
    setSaving(true);
    setErrorMessage(null);
    try {
      const result = await updateMcpAdminSettings({ enabled });
      setData(prev => prev ? { ...prev, status: result.status, settings: { ...prev.settings, enabled } } : prev);
      // The saved flag is only one input to the resolved state; report success
      // against what the server actually turned on.
      if (enabled && !result.status.enabled) {
        reportError('MCP could not be enabled. Resolve the reported condition and try again.');
        return;
      }
      setSuccessMessage(enabled ? 'MCP server enabled.' : 'MCP server disabled.');
      setTimeout(() => setSuccessMessage(null), 3000);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to update MCP settings';
      reportError(msg);
    } finally {
      setSaving(false);
    }
  };

  const updateScopes = async (scopes: McpScope[]) => {
    setSaving(true);
    setErrorMessage(null);
    try {
      const result = await updateMcpAdminSettings({ scopeCeiling: scopes });
      setData(prev => prev ? { ...prev, status: result.status, settings: { ...prev.settings, scopeCeiling: scopes } } : prev);
    } catch {
      reportError('Failed to update scope settings');
    } finally {
      setSaving(false);
    }
  };

  const handleRevokeAll = async () => {
    if (!window.confirm('Revoke all MCP connections? All connected clients will need to reconnect.')) return;
    setRevoking(true);
    setErrorMessage(null);
    try {
      const { revoked, status } = await revokeAllMcpConnections();
      if (status) setData(prev => prev ? { ...prev, status } : prev);
      else await load();
      setSuccessMessage(`Revoked ${revoked} connection${revoked !== 1 ? 's' : ''}.`);
      setTimeout(() => setSuccessMessage(null), 4000);
    } catch {
      reportError('Failed to revoke MCP connections');
    } finally {
      setRevoking(false);
    }
  };

  const canToggle = !isDemoMode && !isOperatorManaged && !data?.status.missingHttpsOrigin && !data?.status.missingSecretChain;

  return (
    <SettingsSection
      title="MCP Server"
      description={<>
        Allows AI assistants like Claude Code and Claude.ai to connect to this ProPR instance via the Model Context Protocol.
        {statusDescriptionSuffix(data)}
      </>}
      status={<SettingsStatus tone={statusTone(data)} role="status">{statusLabel(data)}</SettingsStatus>}
    >
      {successMessage && (
        <p className="mb-4 max-w-2xl text-[12px] leading-5 text-slate-500" role="status">{successMessage}</p>
      )}

      {errorMessage && (
        <p className="mb-4 max-w-2xl text-[12px] leading-5 text-red-600" role="alert">{errorMessage}</p>
      )}

      {!isOperatorManaged && (
        <div className="mb-6 flex max-w-2xl items-center gap-3">
          <EnableToggle
            isEnabled={isEnabled}
            saving={saving}
            canToggle={canToggle}
            confirmEnable={confirmEnable}
            onToggle={enabled => void toggleEnable(enabled)}
            onCancelConfirm={() => setConfirmEnable(false)}
          />
        </div>
      )}

      {data?.status.keyChanged && !isOperatorManaged && !isDemoMode && (
        <KeyRotationNotice revoking={revoking} onRevokeAll={() => void handleRevokeAll()} />
      )}

      {isEnabled && data && (
        <McpDetails
          data={data}
          saving={saving}
          revoking={revoking}
          isOperatorManaged={isOperatorManaged}
          onUpdateScopes={scopes => void updateScopes(scopes)}
          onRevokeAll={() => void handleRevokeAll()}
        />
      )}
    </SettingsSection>
  );
}
