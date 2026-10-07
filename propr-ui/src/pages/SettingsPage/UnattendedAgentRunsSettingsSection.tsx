import React, { useEffect, useState } from 'react';
import {
  describeUnattendedWindow,
  formatUnattendedWindowTime,
  parseUnattendedWindow,
  UNATTENDED_MAX_CONCURRENT_MAX,
  UNATTENDED_MAX_CONCURRENT_MIN,
  UNATTENDED_WINDOW_EXAMPLE,
  UNATTENDED_WINDOW_MAX_LENGTH,
  unattendedWindowState,
} from '@propr/shared';
import { SettingsField, SettingsSection, SettingsStatus } from './SettingsLayout';
import { SETTINGS_CONTROL } from './settingsStyles';
import type { UnattendedSettingName, UnattendedSettingValues } from './types';

const USAGE_PAUSE_MIN = 50;
const USAGE_PAUSE_MAX = 100;

interface UnattendedAgentRunsSettingsSectionProps {
  values: UnattendedSettingValues;
  /** Why the stored window is unusable, as reported by the server. */
  windowError?: string;
  onCommit: <K extends UnattendedSettingName>(name: K, value: UnattendedSettingValues[K]) => void;
  /** The current time, for the window state line; injectable for tests. */
  now?: () => number;
}

type Drafts = Record<UnattendedSettingName, string>;

function draftsFor(values: UnattendedSettingValues): Drafts {
  return {
    agent_run_usage_pause_percent: String(values.agent_run_usage_pause_percent),
    unattended_max_concurrent: String(values.unattended_max_concurrent),
    unattended_window: values.unattended_window,
  };
}

function parseInteger(raw: string, min: number, max: number): number | null {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return value >= min && value <= max ? value : null;
}

/** "Open now until 07:00 Europe/Riga" or "Closed until 02:00 Europe/Riga". */
function windowStateLine(text: string, timestamp: number): string | null {
  const parsed = parseUnattendedWindow(text);
  if (!parsed.ok) return null;
  const { window } = parsed;
  const state = unattendedWindowState(window, timestamp);
  const boundary = state.open ? state.closesAt : state.opensAt;
  const until = boundary === undefined ? '' : ` until ${formatUnattendedWindowTime(boundary, window.timeZone)} ${window.timeZone}`;
  return state.open
    ? `Inside the window (${describeUnattendedWindow(window)}) now${until}: unattended runs start.`
    : `Outside the window (${describeUnattendedWindow(window)})${until}: unattended runs wait.`;
}

/**
 * Admission limits for unattended agent runs (schedule, API, MCP and CLI
 * triggers): the usage pause threshold, the concurrency cap and the
 * local-time window. Run now from the Agents page is exempt from all three.
 * Each field saves on its own when it loses focus.
 */
export function UnattendedAgentRunsSettingsSection({ values, windowError, onCommit, now = Date.now }: UnattendedAgentRunsSettingsSectionProps) {
  const [drafts, setDrafts] = useState<Drafts>(() => draftsFor(values));
  const [invalid, setInvalid] = useState<Partial<Record<UnattendedSettingName, string>>>({});
  const { agent_run_usage_pause_percent: pause, unattended_max_concurrent: cap, unattended_window: window } = values;
  // Resync only when a saved value changes, never while the user is typing.
  useEffect(() => {
    setDrafts(draftsFor({ agent_run_usage_pause_percent: pause, unattended_max_concurrent: cap, unattended_window: window }));
    setInvalid({});
  }, [pause, cap, window]);

  const change = (name: UnattendedSettingName) => (event: React.ChangeEvent<HTMLInputElement>) => {
    setDrafts(previous => ({ ...previous, [name]: event.target.value }));
    setInvalid(previous => ({ ...previous, [name]: undefined }));
  };

  const commitInteger = (name: 'agent_run_usage_pause_percent' | 'unattended_max_concurrent', min: number, max: number) => () => {
    const parsed = parseInteger(drafts[name], min, max);
    if (parsed === null) {
      setInvalid(previous => ({ ...previous, [name]: `Enter a whole number from ${min} to ${max}.` }));
      return;
    }
    if (parsed !== values[name]) onCommit(name, parsed);
  };

  const commitWindow = () => {
    const text = drafts.unattended_window.trim();
    if (text) {
      const parsed = parseUnattendedWindow(text);
      if (!parsed.ok) {
        setInvalid(previous => ({ ...previous, unattended_window: `Not saved: ${parsed.error}.` }));
        return;
      }
    }
    if (text !== values.unattended_window || windowError) onCommit('unattended_window', text);
  };

  const stateLine = !invalid.unattended_window && !windowError && drafts.unattended_window.trim() === values.unattended_window && values.unattended_window
    ? windowStateLine(values.unattended_window, now())
    : null;

  return (
    <SettingsSection
      title="Unattended agent runs"
      description="Limits for agent runs nobody is watching: scheduled runs and runs started through the API, MCP or CLI. A held run is deferred and retried automatically, or skipped with the reason in its run history. Run now on the Agents page is never held."
      status={windowError ? <SettingsStatus tone="error" role="status">Blocked: window is malformed</SettingsStatus> : undefined}
    >
      <SettingsField
        label="Pause at % of subscription usage"
        htmlFor="agent_run_usage_pause_percent"
        helperText={`When Agent Tank reports the agent's session or weekly usage at or above this percent, unattended runs are deferred until the session resets, or skipped for a weekly limit (${USAGE_PAUSE_MIN}-${USAGE_PAUSE_MAX}, default 90).`}
      >
        <input
          type="number"
          id="agent_run_usage_pause_percent"
          name="agent_run_usage_pause_percent"
          min={USAGE_PAUSE_MIN}
          max={USAGE_PAUSE_MAX}
          value={drafts.agent_run_usage_pause_percent}
          onChange={change('agent_run_usage_pause_percent')}
          onBlur={commitInteger('agent_run_usage_pause_percent', USAGE_PAUSE_MIN, USAGE_PAUSE_MAX)}
          aria-invalid={Boolean(invalid.agent_run_usage_pause_percent)}
          className={SETTINGS_CONTROL}
        />
        {invalid.agent_run_usage_pause_percent && <p role="alert" className="mt-1 text-[12px] text-red-600">{invalid.agent_run_usage_pause_percent}</p>}
      </SettingsField>

      <SettingsField
        label="Concurrent unattended runs"
        htmlFor="unattended_max_concurrent"
        helperText={`At most this many unattended agent runs may be queued, running or acting at once. Another run waits 5 minutes at a time and is skipped after 6 waits (${UNATTENDED_MAX_CONCURRENT_MIN}-${UNATTENDED_MAX_CONCURRENT_MAX}, default 1).`}
      >
        <input
          type="number"
          id="unattended_max_concurrent"
          name="unattended_max_concurrent"
          min={UNATTENDED_MAX_CONCURRENT_MIN}
          max={UNATTENDED_MAX_CONCURRENT_MAX}
          value={drafts.unattended_max_concurrent}
          onChange={change('unattended_max_concurrent')}
          onBlur={commitInteger('unattended_max_concurrent', UNATTENDED_MAX_CONCURRENT_MIN, UNATTENDED_MAX_CONCURRENT_MAX)}
          aria-invalid={Boolean(invalid.unattended_max_concurrent)}
          className={SETTINGS_CONTROL}
        />
        {invalid.unattended_max_concurrent && <p role="alert" className="mt-1 text-[12px] text-red-600">{invalid.unattended_max_concurrent}</p>}
      </SettingsField>

      <SettingsField
        label="Unattended window (local time)"
        htmlFor="unattended_window"
        helperText="Unattended runs only start inside this window, e.g. 02:00-07:00@Europe/Riga; overnight windows such as 22:00-06:00@UTC work too. Outside it they wait until it opens. Leave empty to allow any time."
      >
        <input
          type="text"
          id="unattended_window"
          name="unattended_window"
          maxLength={UNATTENDED_WINDOW_MAX_LENGTH}
          spellCheck={false}
          placeholder={UNATTENDED_WINDOW_EXAMPLE}
          value={drafts.unattended_window}
          onChange={change('unattended_window')}
          onBlur={commitWindow}
          aria-invalid={Boolean(invalid.unattended_window || windowError)}
          className={`${SETTINGS_CONTROL} font-mono`}
        />
        {invalid.unattended_window && <p role="alert" className="mt-1 text-[12px] text-red-600">{invalid.unattended_window}</p>}
        {windowError && (
          <p role="alert" data-testid="unattended-window-warning" className="mt-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] leading-5 text-amber-900">
            The stored window “{values.unattended_window}” is malformed ({windowError}). Unattended agent runs are blocked and skipped until you fix or clear it.
          </p>
        )}
        {stateLine && <p data-testid="unattended-window-state" className="mt-1 text-[12px] text-slate-600">{stateLine}</p>}
      </SettingsField>
    </SettingsSection>
  );
}

export default UnattendedAgentRunsSettingsSection;
