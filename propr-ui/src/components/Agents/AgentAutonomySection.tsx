import React from 'react';
import { AGENT_AUTONOMY_MODES, type AgentAutonomyMode } from '@propr/shared';
import { AgentFormRow } from './AgentFormRow';

interface AgentAutonomySectionProps {
  autonomy: AgentAutonomyMode;
  onChange: (autonomy: AgentAutonomyMode) => void;
  /** The acting step needs ProPR tools, so coding agents without them are limited to dry runs. */
  actingAvailable: boolean;
  disabled: boolean;
}

const AUTONOMY_TEXT: Record<AgentAutonomyMode, { label: string; description: string }> = {
  dry_run: {
    label: 'Dry run',
    description: 'The report is saved for you to read. Nothing else happens.',
  },
  preview: {
    label: 'Preview & approve',
    description: 'After the report, an acting step is prepared and waits for your approval before it uses ProPR tools.',
  },
  auto: {
    label: 'Auto',
    description: 'After the report, the acting step runs immediately and may create tasks, issues or goals through ProPR tools.',
  },
};

const SEGMENT_CLASSES = 'px-3 py-1 text-xs font-medium has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-inset has-[:focus-visible]:ring-teal-500';

/**
 * What happens once a run has produced its report: a segmented control, with the chosen mode explained beneath it.
 * The segments are native radio inputs, so the browser keeps one Tab stop for the group and moves the selection with the arrow keys.
 */
export const AgentAutonomySection: React.FC<AgentAutonomySectionProps> = ({ autonomy, onChange, actingAvailable, disabled }) => (
  <AgentFormRow
    label="Autonomy"
    hint={actingAvailable ? 'What happens after the report is written.' : 'The selected coding agent cannot use ProPR tools, so this automation can only run dry.'}
  >
    <div role="radiogroup" aria-label="Autonomy" className="inline-flex overflow-hidden rounded-md border border-slate-300">
      {AGENT_AUTONOMY_MODES.map((mode, index) => {
        const locked = mode !== 'dry_run' && !actingAvailable;
        const selected = autonomy === mode;
        const unavailable = disabled || locked;
        let tone = 'cursor-pointer bg-white text-slate-600 hover:bg-slate-50';
        if (selected) tone = `bg-slate-900 text-white ${unavailable ? 'cursor-not-allowed' : 'cursor-pointer'}`;
        else if (locked) tone = 'cursor-not-allowed bg-white text-slate-400';
        else if (disabled) tone = 'cursor-not-allowed bg-white text-slate-600';
        return (
          <label key={mode} className={`${SEGMENT_CLASSES} ${index > 0 ? 'border-l border-slate-300' : ''} ${tone}`}>
            <input
              type="radio"
              name="agent-autonomy"
              value={mode}
              checked={selected}
              aria-describedby={selected ? 'agent-autonomy-description' : undefined}
              disabled={unavailable}
              onChange={() => onChange(mode)}
              className="sr-only"
            />
            {AUTONOMY_TEXT[mode].label}
          </label>
        );
      })}
    </div>
    <p id="agent-autonomy-description" className="mt-2 text-xs text-slate-500" data-testid="agent-autonomy-description">
      {AUTONOMY_TEXT[autonomy].description}
    </p>
  </AgentFormRow>
);
