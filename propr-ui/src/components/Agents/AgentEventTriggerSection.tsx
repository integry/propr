import React from 'react';
import { MAX_AUTOMATION_EVENT_RUNS_PER_ISSUE, PLAN_ISSUE_BLOCKED_REASON_KINDS, type PlanIssueBlockedReasonKind } from '@propr/shared';
import { BLOCKED_KIND_LABELS } from '../TaskPlanner/planQueueLabels';
import { AgentFieldError, AgentFormRow } from './AgentFormRow';
import { AGENT_FORM_FIELD_IDS, agentFieldErrorId } from './agentFormValidation';

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
  /** The error a refused save found, shown under the trigger. */
  error?: string | null;
}

const SEGMENT_CLASSES = 'px-3 py-1 text-xs font-medium focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-500 disabled:cursor-not-allowed';
const CHECKBOX_CLASSES = 'mt-0.5 h-4 w-4 rounded border-slate-300 text-teal-600 focus:ring-teal-500 disabled:opacity-50';

const CHECKBOX_ROW_CLASSES = 'grid grid-cols-[1rem_minmax(0,1fr)] items-start gap-x-3 text-sm text-slate-800';

function toggled<T extends string>(list: readonly T[], value: T, on: boolean, order: readonly T[]): T[] {
  const next = new Set(list);
  if (on) next.add(value);
  else next.delete(value);
  return order.filter(candidate => next.has(candidate));
}

/** Opt-in event trigger: run once whenever an epic queue issue in one of the automation's repositories becomes blocked. */
export const AgentEventTriggerSection: React.FC<AgentEventTriggerSectionProps> = ({
  enabled, repositories, reasonKinds, automationRepositories, onChange, disabled, error = null,
}) => {
  const noRepositories = automationRepositories.length === 0;
  const isAutomationRepository = (repository: string) =>
    automationRepositories.some(candidate => candidate.toLowerCase() === repository.toLowerCase());
  // Every repository the trigger was limited to was removed: an empty filter would mean all of them.
  const filterLost = !noRepositories && repositories.length > 0 && !repositories.some(isAutomationRepository);
  return (
    <AgentFormRow
      label="Event trigger"
      hint={`Runs when a plan issue becomes blocked. Up to ${MAX_AUTOMATION_EVENT_RUNS_PER_ISSUE} runs per issue.`}
    >
      <div
        id={AGENT_FORM_FIELD_IDS.eventTrigger}
        role="radiogroup"
        aria-label="Event trigger"
        aria-invalid={Boolean(error) || undefined}
        aria-describedby={error ? agentFieldErrorId('eventTrigger') : undefined}
        className={`inline-flex overflow-hidden rounded-md border ${error ? 'border-red-400' : 'border-slate-300'}`}
      >
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
      {error && !filterLost && <AgentFieldError id={agentFieldErrorId('eventTrigger')}>{error}</AgentFieldError>}

      {enabled && (
        <div className="mt-3 space-y-3" data-testid="agent-event-trigger-filters">
          {noRepositories ? (
            !error && <p className="text-xs text-slate-600" data-testid="agent-event-trigger-feedback">Choose at least one repository first.</p>
          ) : (
            <fieldset>
              <legend className="text-xs font-medium text-slate-700">Repositories <span className="font-normal text-slate-500">(all if none ticked)</span></legend>
              <ul className="mt-1.5 space-y-1.5">
                {automationRepositories.map(repository => (
                  <li key={repository}>
                    <label className={CHECKBOX_ROW_CLASSES}>
                      <input
                        type="checkbox"
                        className={CHECKBOX_CLASSES}
                        checked={repositories.some(candidate => candidate.toLowerCase() === repository.toLowerCase())}
                        disabled={disabled}
                        onChange={event => onChange({ blockedTriggerRepositories: toggled(repositories, repository, event.target.checked, automationRepositories) })}
                      />
                      <span className="min-w-0 break-all font-mono text-xs leading-5">{repository}</span>
                    </label>
                  </li>
                ))}
              </ul>
              {filterLost && (
                <div className="mt-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900" role="alert" data-testid="agent-event-trigger-filter-lost">
                  <p>
                    This trigger was limited to <span className="font-mono">{repositories.join(', ')}</span>, which {repositories.length === 1 ? 'is' : 'are'} no
                    longer in this automation. Check the repositories it should react to, or turn it off.
                  </p>
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={() => onChange({ blockedTriggerRepositories: [] })}
                    className="mt-1.5 font-medium text-amber-900 underline hover:text-amber-700 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    React to all of this automation&apos;s repositories
                  </button>
                </div>
              )}
            </fieldset>
          )}
          <fieldset>
            <legend className="text-xs font-medium text-slate-700">Reasons <span className="font-normal text-slate-500">(any if none ticked)</span></legend>
            <ul className="mt-1.5 space-y-1.5">
              {PLAN_ISSUE_BLOCKED_REASON_KINDS.map(kind => (
                <li key={kind}>
                  <label className={CHECKBOX_ROW_CLASSES}>
                    <input
                      type="checkbox"
                      className={CHECKBOX_CLASSES}
                      checked={reasonKinds.includes(kind)}
                      disabled={disabled}
                      onChange={event => onChange({ blockedTriggerReasonKinds: toggled(reasonKinds, kind, event.target.checked, PLAN_ISSUE_BLOCKED_REASON_KINDS) })}
                    />
                    <span>{BLOCKED_KIND_LABELS[kind]}</span>
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
