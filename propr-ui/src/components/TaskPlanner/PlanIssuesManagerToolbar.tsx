import React from 'react';
import { Check, CheckCircle, Info, Layers, ListChecks, Loader2, ArrowDownToLine } from 'lucide-react';
import { AgentModelPair } from '../../api/planIssuesApi';
import { PlanTask } from '../../api/plannerApi';
import type { InstanceCatalogAgent } from '@propr/shared';
import AgentModelSelector from './AgentModelSelector';
import { UltrafixSettingsControls } from './PlanIssueRowComponents';

/** Issue creation renders inside the same execution matrix the created issues will occupy. */
export const TasksBeingCreated: React.FC<{
  tasks: PlanTask[];
  issueCreationProgress: { createdCount: number; lastCreatedIssue?: { number: number } | null };
  spinnerRotationDegrees?: number;
}> = ({ tasks, issueCreationProgress, spinnerRotationDegrees }) => (
  <div className="divide-y divide-slate-100 rounded-md border border-slate-200 bg-white">
    {tasks.map((task, index) => {
      const isCreated = index < issueCreationProgress.createdCount;
      const isCreating = index === issueCreationProgress.createdCount;
      const lastCreated = issueCreationProgress.lastCreatedIssue;
      const issueNumber = isCreated && lastCreated && index === issueCreationProgress.createdCount - 1
        ? lastCreated.number
        : null;

      return (
        <div key={task.id || index} className="flex items-center gap-3 px-3 sm:px-4 py-2">
          <span className="w-16 flex-shrink-0 font-mono text-xs text-slate-500">
            {issueNumber ? `#${issueNumber}` : '—'}
          </span>
          <span className="w-24 flex-shrink-0">
            <span className={`inline-flex items-center gap-1.5 px-1.5 py-0.5 text-xs font-medium rounded border ${
              isCreated ? 'text-slate-500 bg-slate-50 border-slate-200'
                : isCreating ? 'text-teal-700 bg-teal-50 border-teal-200'
                : 'text-slate-600 bg-white border-slate-200'
            }`}>
              {isCreated ? (
                <Check size={10} strokeWidth={3} />
              ) : isCreating ? (
                <Loader2
                  size={10}
                  className={spinnerRotationDegrees === undefined ? 'animate-spin' : ''}
                  style={spinnerRotationDegrees === undefined ? undefined : { transform: `rotate(${spinnerRotationDegrees}deg)` }}
                />
              ) : null}
              {isCreated ? 'Created' : isCreating ? 'Creating' : 'Queued'}
            </span>
          </span>
          <span className={`flex-1 min-w-0 text-sm truncate ${isCreated ? 'text-slate-500' : 'text-slate-800'}`}>
            {task.title}
          </span>
        </div>
      );
    })}
  </div>
);

interface ExecutionOptionsToolbarProps {
  agents: InstanceCatalogAgent[];
  globalAgent: string | null; globalModel: string | null; globalIsMulti: boolean;
  globalSelectedModels: AgentModelPair[]; applyingGlobal: boolean;
  handleGlobalAgentChange: (agent: string | null) => void;
  handleGlobalModelChange: (model: string | null) => void;
  handleGlobalMultiToggle: (isMulti: boolean) => void;
  handleGlobalMultiModelChange: (models: AgentModelPair[]) => void;
  handleApplyToAll: () => void;
  autoMerge?: boolean; onAutoMergeChange?: (value: boolean) => void;
  useEpic?: boolean; onUseEpicChange?: (value: boolean) => void;
  runUltrafix?: boolean; onRunUltrafixChange?: (value: boolean) => void;
  ultrafixGoal?: number | null; onUltrafixGoalChange?: (value: number | null) => void;
  ultrafixMaxCycles?: number | null; onUltrafixMaxCyclesChange?: (value: number | null) => void;
  tasks: PlanTask[];
  disableImplementation?: boolean;
}

const GlobalAgentControls: React.FC<Pick<ExecutionOptionsToolbarProps,
  'agents' |
  'globalAgent' |
  'globalModel' |
  'globalIsMulti' |
  'globalSelectedModels' |
  'applyingGlobal' |
  'handleGlobalAgentChange' |
  'handleGlobalModelChange' |
  'handleGlobalMultiToggle' |
  'handleGlobalMultiModelChange' |
  'handleApplyToAll' |
  'disableImplementation'
>> = ({
  agents, globalAgent, globalModel, globalIsMulti, globalSelectedModels,
  applyingGlobal, handleGlobalAgentChange, handleGlobalModelChange,
  handleGlobalMultiToggle, handleGlobalMultiModelChange, handleApplyToAll,
  disableImplementation = false,
}) => (
  <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-3">
    <span className="text-[11px] font-bold uppercase tracking-widest text-slate-500 flex-shrink-0">Default Agent</span>
    <div className="flex flex-wrap items-center gap-2">
      <AgentModelSelector
        agents={agents} selectedAgent={globalAgent} selectedModel={globalModel}
        onAgentChange={handleGlobalAgentChange} onModelChange={handleGlobalModelChange}
        disabled={applyingGlobal || disableImplementation} compact isMulti={globalIsMulti}
        onMultiToggle={handleGlobalMultiToggle} selectedModels={globalSelectedModels}
        onMultiModelChange={handleGlobalMultiModelChange}
        onMultiConfirm={handleApplyToAll} autoOpenMultiDropdown
      />
      {!globalIsMulti && (
        <button
          onClick={handleApplyToAll}
          disabled={!globalAgent || applyingGlobal || disableImplementation}
          className="inline-flex items-center gap-1.5 px-2 sm:px-3 py-1.5 text-xs sm:text-sm font-medium rounded-md border border-slate-300 bg-white text-slate-700 shadow-sm hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors whitespace-nowrap"
        >
          {applyingGlobal ? (
            <><Loader2 size={14} className="animate-spin" /><span className="hidden sm:inline">Applying...</span></>
          ) : (
            <><CheckCircle size={14} /><span className="hidden sm:inline">Apply to All</span><span className="sm:hidden">Apply</span></>
          )}
        </button>
      )}
    </div>
  </div>
);

interface ExecutionModeToggleProps {
  useEpic: boolean;
  disabled: boolean;
  onChange?: (value: boolean) => void;
}

const ExecutionModeToggle: React.FC<ExecutionModeToggleProps> = ({ useEpic, disabled, onChange }) => {
  const options = [
    { value: true, label: 'Execute as Epic PR', icon: Layers, title: 'Runs every remaining issue in order and collects their PRs into one overarching Epic PR' },
    { value: false, label: 'Execute as Individual Tasks', icon: ListChecks, title: 'Each issue opens its own PR against the base branch' },
  ];
  return (
    <div role="radiogroup" aria-label="Execution mode" className="inline-flex rounded-md border border-slate-300 bg-white p-0.5">
      {options.map(({ value, label, icon: Icon, title }) => {
        const selected = useEpic === value;
        return (
          <button
            key={label}
            type="button"
            role="radio"
            aria-checked={selected}
            disabled={disabled}
            title={title}
            onClick={() => { if (!selected) onChange?.(value); }}
            className={`inline-flex items-center gap-1.5 rounded px-2.5 py-1 text-xs sm:text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
              selected ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
            }`}
          >
            <Icon size={14} />
            {label}
          </button>
        );
      })}
    </div>
  );
};

export const ExecutionOptionsToolbar: React.FC<ExecutionOptionsToolbarProps> = ({
  agents, globalAgent, globalModel, globalIsMulti, globalSelectedModels,
  applyingGlobal, handleGlobalAgentChange, handleGlobalModelChange,
  handleGlobalMultiToggle, handleGlobalMultiModelChange, handleApplyToAll,
  autoMerge, onAutoMergeChange, useEpic, onUseEpicChange,
  runUltrafix, onRunUltrafixChange, ultrafixGoal, onUltrafixGoalChange, ultrafixMaxCycles, onUltrafixMaxCyclesChange,
  tasks, disableImplementation = false,
}) => {
  const ultrafixEnabled = runUltrafix || false;
  const isBatchPlan = tasks.length >= 2;

  return (
    <div className="flex flex-col gap-2.5 sm:gap-3 py-3 border-b border-slate-200 bg-slate-50 px-3 sm:px-4 -mx-4 mb-3">
      <div className="flex flex-col gap-2.5 lg:flex-row lg:items-center lg:justify-between lg:gap-6">
        {isBatchPlan && (
          <ExecutionModeToggle useEpic={useEpic || false} disabled={disableImplementation} onChange={onUseEpicChange} />
        )}
        {isBatchPlan && (
          <GlobalAgentControls
            agents={agents}
            globalAgent={globalAgent}
            globalModel={globalModel}
            globalIsMulti={globalIsMulti}
            globalSelectedModels={globalSelectedModels}
            applyingGlobal={applyingGlobal}
            handleGlobalAgentChange={handleGlobalAgentChange}
            handleGlobalModelChange={handleGlobalModelChange}
            handleGlobalMultiToggle={handleGlobalMultiToggle}
            handleGlobalMultiModelChange={handleGlobalMultiModelChange}
            handleApplyToAll={handleApplyToAll}
            disableImplementation={disableImplementation}
          />
        )}
      </div>
      <div className="flex flex-col sm:flex-row sm:items-start gap-2 sm:gap-6">
        <span className="text-[11px] font-bold uppercase tracking-widest text-slate-500 flex-shrink-0 sm:pt-0.5">PR Options</span>
        {/* One option per line; ultrafix parameters nest under the checkbox they depend on */}
        <div className="flex flex-col gap-2">
          <label className="flex items-center gap-2 text-xs sm:text-sm text-slate-700 cursor-pointer select-none" title="Automatically merges the PR when all CI checks pass">
            <input type="checkbox" checked={autoMerge || false} onChange={(e) => onAutoMergeChange?.(e.target.checked)} disabled={disableImplementation} className="w-4 h-4 text-primary-600 border-slate-300 rounded focus:ring-primary-500 cursor-pointer disabled:cursor-not-allowed" />
            <ArrowDownToLine size={14} className="text-slate-500 hidden sm:block" />
            <span>Auto-merge <span className="hidden sm:inline">if checks pass</span></span>
            <Info size={14} className="text-slate-400 hover:text-slate-600 transition-colors" />
          </label>
          <div className="flex flex-col gap-1.5">
            <label className="flex items-center gap-2 text-xs sm:text-sm text-slate-700 cursor-pointer select-none" title="Automatically run ultrafix after the PR is opened">
              <input type="checkbox" checked={runUltrafix || false} onChange={(e) => onRunUltrafixChange?.(e.target.checked)} disabled={disableImplementation} className="w-4 h-4 text-primary-600 border-slate-300 rounded focus:ring-primary-500 cursor-pointer disabled:cursor-not-allowed" />
              <span>Run ultrafix after PR</span>
            </label>
            {ultrafixEnabled && (
              <div className="flex items-start gap-1.5 pl-6" data-testid="ultrafix-nested-settings">
                <span aria-hidden="true" className="pt-1 text-xs text-slate-400">↳</span>
                <UltrafixSettingsControls
                  enabled={!disableImplementation}
                  goal={ultrafixGoal}
                  maxCycles={ultrafixMaxCycles}
                  onGoalChange={(value) => onUltrafixGoalChange?.(value)}
                  onMaxCyclesChange={(value) => onUltrafixMaxCyclesChange?.(value)}
                  goalPlaceholder="Instance default"
                  maxPlaceholder="Default"
                  inputClassName="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs font-mono disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-400"
                  goalInputWidthClassName="w-44"
                  maxInputWidthClassName="w-16"
                  containerClassName="flex flex-col gap-1"
                  errorClassName="text-[11px] text-amber-700"
                />
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
