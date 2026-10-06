import React, { useEffect, useState } from 'react';
import { SettingsField, SettingsSection } from './SettingsLayout';
import { SETTINGS_CONTROL } from './settingsStyles';
import type { AgentWatchdogSettingName, AgentWatchdogValues } from './types';

const MS_PER_MINUTE = 60_000;

interface FieldSpec {
  name: AgentWatchdogSettingName;
  label: string;
  helperText: string;
  /** Timeouts are edited in minutes and stored in milliseconds. */
  unit: 'minutes' | 'count';
}

const FIELDS: FieldSpec[] = [
  {
    name: 'agent_stall_timeout_ms',
    label: 'Stall timeout (minutes)',
    helperText: 'Stop a run whose agent produces no output for this long. Partial work is published like a timed-out run. 0 disables.',
    unit: 'minutes',
  },
  {
    name: 'agent_tool_stall_timeout_ms',
    label: 'Tool stall timeout (minutes)',
    helperText: 'Silence allowed after a tool call starts without streaming output (builds, test suites). 0 never stops a run during a tool call.',
    unit: 'minutes',
  },
  {
    name: 'agent_degenerate_output_limit',
    label: 'Whitespace-only output limit',
    helperText: 'Stop a run after this many consecutive whitespace-only text deltas. Empty deltas never count. 0 disables.',
    unit: 'count',
  },
];

function toDisplay(value: number | null, unit: FieldSpec['unit']): string {
  if (value === null) return '';
  return unit === 'minutes' ? String(Math.round((value / MS_PER_MINUTE) * 100) / 100) : String(value);
}

/** '' clears the override; anything else must be a non-negative number. */
function fromDisplay(raw: string, unit: FieldSpec['unit']): number | null | undefined {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  if (unit === 'count') return /^\d+$/.test(trimmed) ? Number(trimmed) : undefined;
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return undefined;
  return Math.round(Number(trimmed) * MS_PER_MINUTE);
}

interface AgentWatchdogSettingsSectionProps {
  values: AgentWatchdogValues;
  defaults?: Partial<Record<AgentWatchdogSettingName, number>>;
  onCommit: (name: AgentWatchdogSettingName, value: number | null) => void;
}

/**
 * Instance overrides for the agent stall and degenerate-output watchdog. An
 * empty field uses the environment default shown as its placeholder; changes
 * apply to the next agent run without a restart.
 */
export function AgentWatchdogSettingsSection({ values, defaults, onCommit }: AgentWatchdogSettingsSectionProps) {
  const [drafts, setDrafts] = useState<Record<AgentWatchdogSettingName, string>>(() => draftsFor(values));
  const { agent_stall_timeout_ms: stall, agent_tool_stall_timeout_ms: toolStall, agent_degenerate_output_limit: limit } = values;
  // Resync only when a saved value changes, never while the user is typing.
  useEffect(() => {
    setDrafts(draftsFor({ agent_stall_timeout_ms: stall, agent_tool_stall_timeout_ms: toolStall, agent_degenerate_output_limit: limit }));
  }, [stall, toolStall, limit]);

  const commit = (field: FieldSpec) => {
    const parsed = fromDisplay(drafts[field.name], field.unit);
    if (parsed === undefined) {
      setDrafts(previous => ({ ...previous, [field.name]: toDisplay(values[field.name], field.unit) }));
      return;
    }
    if (parsed !== values[field.name]) onCommit(field.name, parsed);
  };

  return (
    <SettingsSection
      title="Agent watchdog"
      description="Stops agent runs that go silent or emit only whitespace, so they release their worker slot and repository capacity instead of waiting for the execution timeout. Leave a field empty to use the environment default."
    >
      {FIELDS.map(field => {
        const fallback = defaults?.[field.name];
        return (
          <SettingsField key={field.name} label={field.label} htmlFor={field.name} helperText={field.helperText}>
            <input
              type="number"
              id={field.name}
              name={field.name}
              min={0}
              step={field.unit === 'minutes' ? 'any' : 1}
              value={drafts[field.name]}
              placeholder={fallback === undefined ? 'Default' : `Default: ${toDisplay(fallback, field.unit)}`}
              onChange={(event: React.ChangeEvent<HTMLInputElement>) => setDrafts(previous => ({ ...previous, [field.name]: event.target.value }))}
              onBlur={() => commit(field)}
              className={SETTINGS_CONTROL}
            />
          </SettingsField>
        );
      })}
    </SettingsSection>
  );
}

function draftsFor(values: AgentWatchdogValues): Record<AgentWatchdogSettingName, string> {
  return Object.fromEntries(FIELDS.map(field => [field.name, toDisplay(values[field.name], field.unit)])) as Record<AgentWatchdogSettingName, string>;
}

export default AgentWatchdogSettingsSection;
