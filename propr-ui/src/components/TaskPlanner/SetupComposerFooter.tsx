import React from 'react';
import { Download, Loader2 } from 'lucide-react';
import type { Granularity } from '../../api/proprApi';
import { GranularityPills } from './ComposerControls';

interface SetupComposerFooterProps {
  /** Phone layout: one settings group with a row per control, ending with a full-width Generate button. */
  stacked: boolean;
  /** Extra stacked-group rows (scope, context repos, cost) that the desktop shows in the context pane instead. */
  extraSettingsRows?: React.ReactNode[];
  granularity: Granularity;
  onGranularityChange: (granularity: Granularity) => void;
  modelSelector: React.ReactNode;
  onExport: () => void;
  isExporting: boolean;
  exportDisabled: boolean;
  onGenerate?: () => void;
  generateDisabled: boolean;
  generateLabel: React.ReactNode;
  generateTitle?: string;
}

/** A labelled row puts its control on the right; an unlabelled row lays out its own label and control. */
const SettingsRow: React.FC<{ label?: string; children: React.ReactNode }> = ({ label, children }) => (
  label ? (
    <div className="flex min-w-0 items-center justify-between gap-3 px-3 py-2.5">
      <span className="flex-shrink-0 text-xs text-slate-500">{label}</span>
      <div className="flex min-w-0 justify-end">{children}</div>
    </div>
  ) : (
    <div className="min-w-0 px-3 py-2.5">{children}</div>
  )
);

/**
 * Plan shape, model and Generate. Desktop docks them in one row on the prompt box; on a phone they
 * join the scope slider and context repos in one divided settings group under the prompt, followed
 * by the Generate button that ends the input flow.
 */
export const SetupComposerFooter: React.FC<SetupComposerFooterProps> = ({
  stacked, extraSettingsRows = [], granularity, onGranularityChange, modelSelector, onExport, isExporting, exportDisabled, onGenerate, generateDisabled, generateLabel, generateTitle,
}) => {
  const breakPlan = (
    <div className="flex min-w-0 max-w-full items-center gap-2 overflow-x-auto md:flex-shrink-0">
      <span className="text-xs text-gray-500 whitespace-nowrap">Break plan:</span>
      <GranularityPills value={granularity} onChange={onGranularityChange} hideEstimate compact />
    </div>
  );
  const generateButton = (
    <button
      onClick={onGenerate}
      disabled={generateDisabled}
      title={generateTitle}
      className={`flex max-w-full items-center justify-center gap-1.5 whitespace-nowrap text-white font-medium rounded-md bg-[rgb(29,138,138)] hover:bg-[rgb(24,118,118)] disabled:bg-gray-300 disabled:cursor-not-allowed transition-colors flex-shrink-0 ${stacked ? 'w-full px-4 py-2.5 text-sm' : 'px-3 py-1.5 text-xs'}`}
    >
      {generateLabel}
    </button>
  );

  if (stacked) {
    return (
      <div className="flex min-w-0 flex-col gap-3">
        <div data-testid="setup-settings-group" className="divide-y divide-slate-100 rounded-lg border border-slate-200 bg-white">
          <SettingsRow label="Break into">
            <GranularityPills value={granularity} onChange={onGranularityChange} hideEstimate compact />
          </SettingsRow>
          <SettingsRow label="Model">
            <div className="flex w-56 min-w-0 max-w-full">{modelSelector}</div>
          </SettingsRow>
          {extraSettingsRows.filter(Boolean).map((row, index) => (
            <SettingsRow key={index}>{row}</SettingsRow>
          ))}
        </div>
        {generateButton}
      </div>
    );
  }

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2 sm:gap-3 md:flex-nowrap">
      {breakPlan}
      {modelSelector}
      <div className="ml-auto flex flex-shrink-0 items-center gap-1 sm:gap-2">
        <button
          onClick={onExport}
          disabled={exportDisabled}
          className="hidden md:flex items-center p-1.5 text-gray-500 hover:text-gray-700 hover:bg-white rounded-md disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          title="Export context as XML"
          aria-label="Export Context"
        >
          {isExporting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
        </button>
        {generateButton}
      </div>
    </div>
  );
};

export default SetupComposerFooter;
