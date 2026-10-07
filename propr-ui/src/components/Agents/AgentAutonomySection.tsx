import React from 'react';
import { AGENT_AUTONOMY_MODES, type AgentAutonomyMode } from '@propr/shared';
import { AgentFormRow } from './AgentFormRow';

interface AgentAutonomySectionProps {
  autonomy: AgentAutonomyMode;
  onChange: (autonomy: AgentAutonomyMode) => void;
  /** The acting step needs ProPR tools, so agents without them are limited to dry runs. */
  actingAvailable: boolean;
  disabled: boolean;
}

const AUTONOMY_TEXT: Record<AgentAutonomyMode, { label: string; description: string }> = {
  dry_run: {
    label: 'Dry run',
    description: 'The report is saved for you to read. Nothing else happens.',
  },
  preview: {
    label: 'Preview + approve',
    description: 'After the report, an acting step is prepared and waits for your approval before it uses ProPR tools.',
  },
  auto: {
    label: 'Auto',
    description: 'After the report, the acting step runs immediately and may create tasks, issues or goals through ProPR tools.',
  },
};

/** What happens once a run has produced its report. */
export const AgentAutonomySection: React.FC<AgentAutonomySectionProps> = ({ autonomy, onChange, actingAvailable, disabled }) => (
  <AgentFormRow
    label="Autonomy"
    hint={actingAvailable ? 'What happens after the report is written.' : 'This agent cannot use ProPR tools, so it can only run dry.'}
  >
    <div role="radiogroup" aria-label="Autonomy" className="space-y-2">
      {AGENT_AUTONOMY_MODES.map(mode => {
        const text = AUTONOMY_TEXT[mode];
        const locked = mode !== 'dry_run' && !actingAvailable;
        const id = `agent-autonomy-${mode}`;
        return (
          <label
            key={mode}
            htmlFor={id}
            className={`flex cursor-pointer items-start gap-3 rounded-md border px-3 py-2 ${autonomy === mode ? 'border-teal-600 bg-teal-50/40' : 'border-slate-200'} ${locked ? 'cursor-not-allowed opacity-60' : ''}`}
          >
            <input
              id={id}
              type="radio"
              name="agent-autonomy"
              value={mode}
              checked={autonomy === mode}
              disabled={disabled || locked}
              onChange={() => onChange(mode)}
              className="mt-0.5 h-4 w-4 border-slate-300 text-teal-600 focus:ring-teal-500"
            />
            <span className="min-w-0">
              <span className="block text-sm font-medium text-slate-900">{text.label}</span>
              <span className="block text-xs text-slate-500">{text.description}</span>
            </span>
          </label>
        );
      })}
    </div>
  </AgentFormRow>
);
