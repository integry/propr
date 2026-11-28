import { useCallback, useEffect, useState } from 'react';
import type { IdleShutdownStatus } from '@propr/shared';
import { getIdleShutdownSettings, updateIdleShutdownSettings, type IdleShutdownSettings } from '../../api/idleShutdownApi';
import { SettingsCheckboxField, SettingsField, SettingsSection, SettingsStatus, type SettingsStatusTone } from './SettingsLayout';
import { SETTINGS_CONTROL } from './settingsStyles';
import { formatDateTime } from '../../utils/dateFormat';

const WAKE_SOURCES: Record<string, string> = {
  http: 'HTTP request',
  connect_ping: 'Connect wake ping',
  schedule: 'Scheduled work',
  unknown: 'Unknown',
};

function formatTime(value: string | null | undefined): string {
  if (!value) return '—';
  return formatDateTime(value) || value;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.round(ms / 60_000)} min`;
}

function headerState(settings: IdleShutdownSettings | null, error: string | null): { tone: SettingsStatusTone; label: string } {
  if (error && !settings) return { tone: 'error', label: 'Unavailable' };
  if (!settings) return { tone: 'pending', label: 'Loading…' };
  if (!settings.enabled) return { tone: 'pending', label: 'Off' };
  if (!settings.status) return { tone: 'warn', label: 'On · daemon not reporting' };
  return settings.status.idle ? { tone: 'ok', label: 'On · idle' } : { tone: 'ok', label: 'On · busy' };
}

function StatusDetails({ status, enabled }: { status: IdleShutdownStatus; enabled: boolean }) {
  return (
    <div className="max-w-2xl space-y-4 text-[12px] leading-5">
      <div>
        <p className="font-medium text-slate-900">{status.blockers.length === 0 ? 'Nothing is keeping the instance awake.' : 'Keeping the instance awake'}</p>
        {status.blockers.length > 0 && (
          <ul className="mt-1 list-disc space-y-0.5 pl-5 text-slate-600" aria-label="Idle blockers">
            {status.blockers.map(blocker => <li key={`${blocker.signal}:${blocker.detail}`}>{blocker.detail}</li>)}
          </ul>
        )}
      </div>
      <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
        {enabled && <div><dt className="text-slate-500">Stops at</dt><dd className="mt-0.5 font-medium text-slate-900">{status.shutdownAt ? formatTime(status.shutdownAt) : 'Not while busy'}</dd></div>}
        <div><dt className="text-slate-500">Next scheduled work</dt><dd className="mt-0.5 font-medium text-slate-900">{formatTime(status.nextDueAt)}</dd></div>
        <div>
          <dt className="text-slate-500">Last idle shutdown</dt>
          <dd className="mt-0.5 font-medium text-slate-900">
            {status.lastShutdown ? `${formatTime(status.lastShutdown.shutdownAt)} (${status.lastShutdown.reason})` : 'Never'}
          </dd>
        </div>
        <div>
          <dt className="text-slate-500">Last wake</dt>
          <dd className="mt-0.5 font-medium text-slate-900">
            {status.lastWake
              ? `${formatTime(status.lastWake.wokeAt)} · ${WAKE_SOURCES[status.lastWake.source] ?? status.lastWake.source} · cold start ${formatDuration(status.lastWake.coldStartMs)}`
              : 'Never'}
          </dd>
        </div>
      </dl>
    </div>
  );
}

/**
 * Opt-in idle shutdown (issue #3770): off by default. When on, the control
 * plane stops after the idle window and a supervisor (Fly, systemd) or
 * Connect starts it again on demand.
 */
export default function IdleShutdownSection() {
  const [settings, setSettings] = useState<IdleShutdownSettings | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [after, setAfter] = useState('15m');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const apply = useCallback((value: IdleShutdownSettings) => {
    setSettings(value);
    setEnabled(value.enabled);
    setAfter(value.after);
  }, []);

  useEffect(() => {
    let active = true;
    getIdleShutdownSettings()
      .then(value => { if (active) apply(value); })
      .catch((reason: Error) => { if (active) setError(reason.message); });
    return () => { active = false; };
  }, [apply]);

  const save = async () => {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      apply(await updateIdleShutdownSettings({ enabled, after: after.trim() }));
      setSaved(true);
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const locked = settings?.environmentManaged ?? false;
  const dirty = settings !== null && (enabled !== settings.enabled || after.trim() !== settings.after);
  const state = headerState(settings, error);

  return (
    <SettingsSection
      title="Idle shutdown"
      description="Stop the control plane when there is nothing to do, and start it again on demand. Suited to small or metered hosts such as a Fly Machine, a home server or a laptop. Off by default: the control plane runs continuously unless you turn this on. Waking takes about 5–10 seconds."
      status={<SettingsStatus tone={state.tone} role="status">{state.label}</SettingsStatus>}
    >
      {locked && (
        <p className="mb-5 max-w-2xl rounded border border-slate-200 bg-slate-50 px-3 py-2 text-[12px] leading-5 text-slate-600">
          Set in the environment ({Object.entries(settings?.environment ?? {}).filter(([, value]) => value !== null).map(([name, value]) => `${name}=${value}`).join(', ')}). Change it in <code>.env</code> and restart.
        </p>
      )}
      <SettingsCheckboxField
        id="idle-shutdown-enabled"
        label="Stop the instance when idle"
        helperText="Only when no job is queued or running, no agent run, goal, follow-up handoff or Ultrafix loop is active, no Web UI session or MCP request is open, and no scheduled work is due within the idle window. The process exits with code 0, so use a restart policy that does not restart on success (Fly on-failure, systemd Restart=on-failure)."
        checked={enabled}
        disabled={locked || !settings}
        onChange={event => setEnabled(event.target.checked)}
      />
      <SettingsField
        label="Idle window"
        htmlFor="idle-shutdown-after"
        helperText="How long the instance must stay idle before it stops, between 1m and 24h (for example 15m or 1h30m)."
      >
        <input
          id="idle-shutdown-after"
          type="text"
          inputMode="text"
          className={`${SETTINGS_CONTROL} max-w-[10rem]`}
          value={after}
          disabled={locked || !settings}
          onChange={event => setAfter(event.target.value)}
        />
      </SettingsField>
      {!locked && (
        <div className="mb-6 flex max-w-2xl items-center gap-3">
          <button
            type="button"
            onClick={() => void save()}
            disabled={!dirty || saving}
            className="touch-hit rounded bg-primary-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-primary-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
          {saved && !dirty && <span className="text-[12px] text-slate-500" role="status">Saved. The daemon applies it within 30 seconds.</span>}
        </div>
      )}
      {error && <p className="mb-4 max-w-2xl text-[12px] text-red-600" role="alert">{error}</p>}
      {settings?.warnings.map(warning => <p key={warning} className="mb-2 max-w-2xl text-[12px] text-amber-700">{warning}</p>)}
      {settings?.status && <StatusDetails status={settings.status} enabled={settings.enabled} />}
    </SettingsSection>
  );
}
