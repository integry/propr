import React, { useRef } from 'react';
import {
  REVIEW_CONTEXT_BUDGET_PERCENT_MAX,
  REVIEW_CONTEXT_BUDGET_PERCENT_MIN,
  REVIEW_CONTEXT_BUDGET_PERCENT_STEP,
  type InstanceCatalogAgent,
} from '@propr/shared';
import { buildPrReviewOptions, type ModelSelectionAgent } from './modelSelectionHelpers';
import { SettingsCheckboxField, SettingsField } from './SettingsLayout';
import { SETTINGS_CONTROL, SETTINGS_HELPER } from './settingsStyles';
import {
  buildReviewerBudgetPreviews,
  describeCapacitySource,
  formatTokenCount,
  resolveConfiguredReviewerPreview,
  type ReviewBudgetPreviewAgent,
} from './reviewContextBudgetPreview';

interface ReviewContextSettingsProps {
  settings: {
    pr_review_model: string;
    default_agent_alias: string;
    pr_review_context_enabled: boolean;
    pr_review_context_model: string;
    pr_review_max_context_tokens: number;
    pr_review_context_budget_percent: number;
  };
  agents: ModelSelectionAgent[];
  /** Direct agent configurations; their runtime type determines each reviewer's capacity. */
  budgetAgents?: ReviewBudgetPreviewAgent[];
  catalogAgents?: InstanceCatalogAgent[];
  onSettingChange: (e: React.ChangeEvent<HTMLSelectElement>) => void;
  onEnabledChange: (enabled: boolean) => void;
  onBudgetPercentChange: (percent: number) => void;
  onBudgetPercentCommit: (percent: number) => void;
  onRemoveLegacyCap: () => void;
}

const ReviewContextSettings: React.FC<ReviewContextSettingsProps> = ({
  settings, agents, budgetAgents = [], catalogAgents = [], onSettingChange, onEnabledChange,
  onBudgetPercentChange, onBudgetPercentCommit, onRemoveLegacyCap,
}) => {
  const options = buildPrReviewOptions(agents.filter(agent => agent.enabled));
  const percent = settings.pr_review_context_budget_percent;
  const legacyCap = settings.pr_review_max_context_tokens;
  // Save once per completed interaction (pointer release, key release, blur),
  // not on every intermediate value while dragging.
  const pendingCommit = useRef<number | null>(null);
  const configured = resolveConfiguredReviewerPreview(settings, budgetAgents, catalogAgents);
  const reviewerPreviews = buildReviewerBudgetPreviews(settings, budgetAgents);

  const commit = () => {
    const value = pendingCommit.current;
    if (value === null) return;
    pendingCommit.current = null;
    onBudgetPercentCommit(value);
  };

  const allowanceText = configured.status === 'resolved'
    ? `≈ ${formatTokenCount(configured.reviewer.ceiling.ceiling)} input tokens for ${configured.reviewer.label}`
    : 'Automatic — allowance is resolved per reviewer when a review runs';

  return (
    <>
      <SettingsCheckboxField
        id="pr_review_context_enabled"
        label="Gather related unchanged code"
        helperText="Lets a read-only scout locate relevant unchanged callers, consumers, contracts, configuration, and tests before the review. Scout failure never blocks the review."
        checked={settings.pr_review_context_enabled}
        onChange={(event) => onEnabledChange(event.target.checked)}
      />

      <SettingsField
        label="Context Scout Model"
        htmlFor="pr_review_context_model"
        helperText="A fast coding-agent model used only to find relevant file ranges. If unset, ProPR uses the Fast Analysis Model, then the review model."
      >
        <select
          id="pr_review_context_model"
          name="pr_review_context_model"
          value={settings.pr_review_context_model}
          onChange={onSettingChange}
          disabled={!settings.pr_review_context_enabled || options.length === 0}
          className={SETTINGS_CONTROL}
        >
          <option value="">Use Fast Analysis Model</option>
          {options.map(option => (
            <option key={option.value} value={option.value}>
              {option.label}{option.isRecommended ? ' (Recommended)' : ''}
            </option>
          ))}
        </select>
      </SettingsField>

      <SettingsField
        label="Review context budget"
        htmlFor="pr_review_context_budget_percent"
        helperText={(
          <span id="pr_review_context_budget_help">
            Share of each reviewer&apos;s safe input allowance a review may use. 100% uses the full safe allowance; space for the
            review response and agent runtime is always reserved. A lower percentage reduces review context and can produce
            partial reviews. A <code>/review</code> command that names another model uses that model&apos;s own budget.
          </span>
        )}
      >
        <div className="flex items-center gap-3">
          <input
            id="pr_review_context_budget_percent"
            name="pr_review_context_budget_percent"
            type="range"
            min={REVIEW_CONTEXT_BUDGET_PERCENT_MIN}
            max={REVIEW_CONTEXT_BUDGET_PERCENT_MAX}
            step={REVIEW_CONTEXT_BUDGET_PERCENT_STEP}
            value={percent}
            aria-valuetext={`${percent}% of the safe input allowance`}
            aria-describedby="pr_review_context_budget_output pr_review_context_budget_help"
            onChange={(event) => {
              const value = Number(event.target.value);
              pendingCommit.current = value;
              onBudgetPercentChange(value);
            }}
            onPointerUp={commit}
            onKeyUp={commit}
            onBlur={commit}
            className="h-2 w-full cursor-pointer accent-primary-600"
          />
          <output
            id="pr_review_context_budget_output"
            htmlFor="pr_review_context_budget_percent"
            className="w-12 shrink-0 text-right text-sm font-semibold tabular-nums text-slate-900"
          >
            {percent}%
          </output>
        </div>
        <p className="mt-1.5 text-[12px] leading-5 text-slate-700" data-testid="review-context-budget-allowance">
          {allowanceText}
          {configured.status === 'resolved' && (
            <span className="text-slate-500">
              {' '}({configured.reviewer.ceiling.limitedBy === 'legacy-cap'
                ? 'limited by the legacy cap'
                : `${percent}% of ${formatTokenCount(configured.reviewer.capacity.safeInputTokens)} safe`};{' '}
              {describeCapacitySource(configured.reviewer.capacity)})
            </span>
          )}
        </p>
        {configured.status === 'unknown' && <p className={SETTINGS_HELPER}>{configured.reason}</p>}
        {legacyCap > 0 && (
          <div role="note" className="mt-2 rounded border border-amber-200 bg-amber-50 px-2.5 py-2 text-[12px] leading-5 text-amber-900">
            A legacy absolute cap of {legacyCap.toLocaleString('en-US')} tokens is still in effect. Each review uses the lower
            of this cap and the percentage above, so changing the model or percentage never raises it.{' '}
            <button
              type="button"
              onClick={onRemoveLegacyCap}
              className="font-medium underline hover:text-amber-950 focus:outline-none focus:ring-1 focus:ring-amber-500"
            >
              Remove legacy cap
            </button>
          </div>
        )}
        {reviewerPreviews.length > 1 && (
          <details className="mt-2 text-[12px] leading-5 text-slate-600">
            <summary className="cursor-pointer text-slate-700">Allowance by reviewer model</summary>
            <ul className="mt-1 space-y-0.5" aria-label="Estimated input allowance by reviewer model">
              {reviewerPreviews.map(preview => (
                <li key={preview.key} className="flex justify-between gap-3">
                  <span>{preview.label}</span>
                  <span className="tabular-nums">
                    ≈ {formatTokenCount(preview.ceiling.ceiling)}
                    {preview.ceiling.limitedBy === 'legacy-cap' ? ' (legacy cap)' : ''}
                  </span>
                </li>
              ))}
            </ul>
          </details>
        )}
      </SettingsField>
    </>
  );
};

export default ReviewContextSettings;
