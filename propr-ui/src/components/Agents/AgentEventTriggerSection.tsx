import React from 'react';
import { MAX_AUTOMATION_EVENT_RUNS_PER_ISSUE, PLAN_ISSUE_BLOCKED_REASON_KINDS, type PlanIssueBlockedReasonKind } from '@propr/shared';
import { AgentFormRow } from './AgentFormRow';

interface AgentEventTriggerSectionProps {
  enabled: boolean;
  /** Empty: every repository of the automation. */
  repositories: string[];
  /** Empty: every reason kind. */
  reasonKinds: PlanIssueBlockedReasonKind[];
  /** The automation's repositories, which the trigger can be limited to. */
  automationRepositories: string[];
  onChange: (change: { blockedTrigger?: boolean; blockedTriggerRepositories?: string[]; blockedTriggerReasonKinds?: PlanIssueBlockedReasonKind[] }) => void;
  disabled: boolean;
}

const SEGMENT_CLASSES = 'px-3 py-1 text-xs font-medium focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-500 disabled:cursor-not-allowed';
const CHECKBOX_CLASSES = 'h-4 w-4 rounded border-slate-300 text-teal-600 focus:ring-teal-500 disabled:opacity-50';

const REASON_KIND_LABELS: Record<PlanIssueBlockedReasonKind, string> = {
  closed_unmerged: 'Closed without merging',
  missing_from_plan: 'Missing from the plan',
  dispatch_failed: 'Could not be started',
  agent_blocked: 'Agent reported a blocker',
  awaiting_human_merge: 'Waiting for a human merge',
  label_handoff: 'Processing labels not released',
  setup_not_ready: 'Model and branch setup not ready',
};

function toggled<T extends string>(list: readonly T[], value: T, on: boolean, order: readonly T[]): T[] {
  const next = new Set(list);
  if (on) next.add(value);
  else next.delete(value);
  return order.filter(candidate => next.has(candidate));
}

/** Opt-in event trigger: run once whenever an epic queue issue in one of the automation's repositories becomes blocked. */
export const AgentEventTriggerSection: React.FC<AgentEventTriggerSectionProps> = ({
  enabled, repositories, reasonKinds, automationRepositories, onChange, disabled,
}) => {
  const noRepositories = automationRepositories.length === 0;
  return (
    <AgentFormRow
      label="Event trigger"
      hint={`Run once for each epic queue issue that becomes blocked, with the event as input. The run is unattended, like a scheduled one. At most ${MAX_AUTOMATION_EVENT_RUNS_PER_ISSUE} runs per issue of a plan.`}
    >
      <div role="radiogroup" aria-label="Event trigger" className="inline-flex overflow-hidden rounded-md border border-slate-300">
        {([false, true] as const).map(value => (
          <button
            key={String(value)}
            type="button"
            role="radio"
            aria-checked={enabled === value}
            disabled={disabled}
            onClick={() => onChange({ blockedTrigger: value })}
            className={`${SEGMENT_CLASSES} ${value ? 'border-l border-slate-300' : ''} ${enabled === value ? 'bg-slate-900 text-white' : 'bg-white text-slate-600 hover:bg-slate-50'}`}
          >
            {value ? 'Plan issue blocked' : 'Off'}
          </button>
        ))}
      </div>

      {enabled && (
        <div className="mt-3 space-y-3" data-testid="agent-event-trigger-filters">
          {noRepositories ? (
            <p className="text-xs text-red-700" data-testid="agent-event-trigger-feedback">Choose the repositories this automation concerns; the trigger only reacts to plans in them.</p>
          ) : (
            <fieldset>
              <legend className="text-xs font-medium text-slate-700">Repositories <span className="font-normal text-slate-500">(none checked: all of this automation&apos;s)</span></legend>
              <ul className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
                {automationRepositories.map(repository => (
                  <li key={repository}>
                    <label className="inline-flex items-center gap-1.5 text-sm text-slate-800">
                      <input
                        type="checkbox"
                        className={CHECKBOX_CLASSES}
                        checked={repositories.some(candidate => candidate.toLowerCase() === repository.toLowerCase())}
                        disabled={disabled}
                        onChange={event => onChange({ blockedTriggerRepositories: toggled(repositories, repository, event.target.checked, automationRepositories) })}
                      />
                      <span className="font-mono text-xs">{repository}</span>
                    </label>
                  </li>
                ))}
              </ul>
            </fieldset>
          )}
          <fieldset>
            <legend className="text-xs font-medium text-slate-700">Blocker reasons <span className="font-normal text-slate-500">(none checked: any reason)</span></legend>
            <ul className="mt-1 grid gap-1 sm:grid-cols-2">
              {PLAN_ISSUE_BLOCKED_REASON_KINDS.map(kind => (
                <li key={kind}>
                  <label className="inline-flex items-center gap-1.5 text-sm text-slate-800">
                    <input
                      type="checkbox"
                      className={CHECKBOX_CLASSES}
                      checked={reasonKinds.includes(kind)}
                      disabled={disabled}
                      onChange={event => onChange({ blockedTriggerReasonKinds: toggled(reasonKinds, kind, event.target.checked, PLAN_ISSUE_BLOCKED_REASON_KINDS) })}
                    />
                    {REASON_KIND_LABELS[kind]}
                  </label>
                </li>
              ))}
            </ul>
          </fieldset>
        </div>
      )}
    </AgentFormRow>
  );
};
