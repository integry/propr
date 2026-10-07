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

const SEGMENT_CLASSES = 'px-3 py-1 text-xs font-medium focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-teal-500 disabled:cursor-not-allowed';

/** What happens once a run has produced its report: a segmented control, with the chosen mode explained beneath it. */
export const AgentAutonomySection: React.FC<AgentAutonomySectionProps> = ({ autonomy, onChange, actingAvailable, disabled }) => (
  <AgentFormRow
    label="Autonomy"
    hint={actingAvailable ? 'What happens after the report is written.' : 'The selected coding agent cannot use ProPR tools, so this automation can only run dry.'}
  >
    <div role="radiogroup" aria-label="Autonomy" className="inline-flex overflow-hidden rounded-md border border-slate-300">
      {AGENT_AUTONOMY_MODES.map((mode, index) => {
        const locked = mode !== 'dry_run' && !actingAvailable;
        const selected = autonomy === mode;
        let tone = 'bg-white text-slate-600 hover:bg-slate-50';
        if (selected) tone = 'bg-slate-900 text-white';
        else if (locked) tone = 'bg-white text-slate-400';
        return (
          <button
            key={mode}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-describedby={selected ? 'agent-autonomy-description' : undefined}
            disabled={disabled || locked}
            onClick={() => onChange(mode)}
            className={`${SEGMENT_CLASSES} ${index > 0 ? 'border-l border-slate-300' : ''} ${tone}`}
          >
            {AUTONOMY_TEXT[mode].label}
          </button>
        );
      })}
    </div>
    <p id="agent-autonomy-description" className="mt-2 text-xs text-slate-500" data-testid="agent-autonomy-description">
      {AUTONOMY_TEXT[autonomy].description}
    </p>
  </AgentFormRow>
);
