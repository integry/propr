import React from 'react';
import type { AgentConfig } from '../../api/proprApi';
import { buildPrReviewOptions } from './modelSelectionHelpers';

interface ReviewContextSettingsProps {
  settings: {
    pr_review_context_enabled: boolean;
    pr_review_context_model: string;
    pr_review_max_context_tokens: number;
  };
  agents: AgentConfig[];
  onSettingChange: (e: React.ChangeEvent<HTMLSelectElement>) => void;
  onEnabledChange: (enabled: boolean) => void;
  onMaxContextTokensChange: (value: number) => void;
  onMaxContextTokensBlur: () => void;
}

const Row = ({ label, htmlFor, helperText, children }: {
  label: string;
  htmlFor: string;
  helperText: string;
  children: React.ReactNode;
}) => (
  <div className="grid grid-cols-1 md:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] gap-2 md:gap-4 items-start">
    <label className="block text-xs font-medium text-gray-600 md:pt-1.5" htmlFor={htmlFor}>{label}</label>
    <div>{children}<p className="mt-1 text-[11px] text-slate-500">{helperText}</p></div>
  </div>
);

const ReviewContextSettings: React.FC<ReviewContextSettingsProps> = ({
  settings, agents, onSettingChange, onEnabledChange, onMaxContextTokensChange, onMaxContextTokensBlur
}) => {
  const options = buildPrReviewOptions(agents.filter(agent => agent.enabled));
  return (
    <>
      <Row
        label="Related Code Context"
        htmlFor="pr_review_context_enabled"
        helperText="Lets a read-only scout locate relevant unchanged callers, consumers, contracts, configuration, and tests before the review. Scout failure never blocks the review."
      >
        <label className="inline-flex items-center gap-2 text-sm text-gray-700">
          <input
            id="pr_review_context_enabled"
            type="checkbox"
            checked={settings.pr_review_context_enabled}
            onChange={(event) => onEnabledChange(event.target.checked)}
            className="h-4 w-4 rounded border-gray-300 text-primary-600 focus:ring-primary-500"
          />
          Gather related unchanged code
        </label>
      </Row>

      <Row
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
          className="w-full rounded border-gray-300 focus:border-primary-500 focus:ring-primary-500 text-sm px-2.5 py-1.5 border disabled:bg-gray-100 disabled:text-gray-500"
        >
          <option value="">Use Fast Analysis Model</option>
          {options.map(option => (
            <option key={option.value} value={option.value}>
              {option.label}{option.isRecommended ? ' (Recommended)' : ''}
            </option>
          ))}
        </select>
      </Row>

      <Row
        label="Maximum Review Context"
        htmlFor="pr_review_max_context_tokens"
        helperText="Maximum input context per review request, in tokens. Use 0 for the selected review model's automatic safe limit; explicit values are still capped at the model's hard limit."
      >
        <input
          id="pr_review_max_context_tokens"
          name="pr_review_max_context_tokens"
          type="number"
          min={0}
          max={2000000}
          step={10000}
          value={settings.pr_review_max_context_tokens}
          onChange={(event) => onMaxContextTokensChange(Number(event.target.value))}
          onBlur={onMaxContextTokensBlur}
          className="w-full rounded border-gray-300 focus:border-primary-500 focus:ring-primary-500 text-sm px-2.5 py-1.5 border"
        />
      </Row>
    </>
  );
};

export default ReviewContextSettings;
