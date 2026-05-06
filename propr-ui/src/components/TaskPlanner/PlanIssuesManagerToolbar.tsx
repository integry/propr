import React, { useEffect, useState } from 'react';
import { Check, CheckCircle, Info, Layers, Loader2, ArrowDownToLine } from 'lucide-react';
import { AgentModelPair } from '../../api/planIssuesApi';
import { PlanTask } from '../../api/plannerApi';
import { AgentConfig } from '../../api/proprApi';
import AgentModelSelector from './AgentModelSelector';

export const TasksBeingCreated: React.FC<{
  tasks: PlanTask[];
  issueCreationProgress: { createdCount: number; lastCreatedIssue?: { number: number } | null };
}> = ({ tasks, issueCreationProgress }) => (
  <div className="relative pl-1">
    <div className="absolute left-[13px] top-2 bottom-2 w-0.5 bg-slate-200" style={{ zIndex: 0 }} />
    <div className="relative" style={{ zIndex: 1 }}>
      {tasks.map((task, index) => {
        const isCreated = index < issueCreationProgress.createdCount;
        const isCreating = index === issueCreationProgress.createdCount;
        const lastCreated = issueCreationProgress.lastCreatedIssue;
        const issueNumber = isCreated && lastCreated && index === issueCreationProgress.createdCount - 1
          ? lastCreated.number
          : null;

        return (
          <div key={task.id || index} className="flex items-center gap-2.5 py-1 group">
            <div className="flex-shrink-0 w-5 h-5 flex items-center justify-center bg-white rounded-full">
              {isCreated ? (
                <div className="w-4 h-4 rounded-full bg-gray-100 flex items-center justify-center">
                  <Check size={10} className="text-gray-400" strokeWidth={3} />
                </div>
              ) : isCreating ? (
                <Loader2 size={14} className="text-blue-600 animate-spin" />
              ) : (
                <div className="w-3 h-3 rounded-full border-2 border-gray-300 bg-white" />
              )}
            </div>
            <span className={`flex-1 text-sm truncate ${
              isCreated ? 'text-gray-400' :
              isCreating ? 'text-blue-700 font-medium' :
              'text-gray-500'
            }`}>
              {task.title}
            </span>
            {issueNumber && (
              <span className="flex-shrink-0 px-1.5 py-0.5 bg-gray-100 rounded text-[10px] font-mono text-gray-500">
                #{issueNumber}
              </span>
            )}
          </div>
        );
      })}
    </div>
  </div>
);

interface ExecutionOptionsToolbarProps {
  agents: AgentConfig[];
  globalAgent: string; globalModel: string; globalIsMulti: boolean;
  globalSelectedModels: AgentModelPair[]; applyingGlobal: boolean;
  handleGlobalAgentChange: (agent: string) => void;
  handleGlobalModelChange: (model: string) => void;
  handleGlobalMultiToggle: (isMulti: boolean) => void;
  handleGlobalMultiModelChange: (models: AgentModelPair[]) => void;
  handleApplyToAll: () => void;
  autoMerge?: boolean; onAutoMergeChange?: (value: boolean) => void;
  useEpic?: boolean; onUseEpicChange?: (value: boolean) => void;
  runUltrafix?: boolean; onRunUltrafixChange?: (value: boolean) => void;
  ultrafixGoal?: number | null; onUltrafixGoalChange?: (value: number | null) => void;
  ultrafixMaxCycles?: number | null; onUltrafixMaxCyclesChange?: (value: number | null) => void;
  tasks: PlanTask[]; pendingCount: number;
  implementingAll: boolean; handleImplementAll: () => void;
}

export const ExecutionOptionsToolbar: React.FC<ExecutionOptionsToolbarProps> = ({
  agents, globalAgent, globalModel, globalIsMulti, globalSelectedModels,
  applyingGlobal, handleGlobalAgentChange, handleGlobalModelChange,
  handleGlobalMultiToggle, handleGlobalMultiModelChange, handleApplyToAll,
  autoMerge, onAutoMergeChange, useEpic, onUseEpicChange,
  runUltrafix, onRunUltrafixChange, ultrafixGoal, onUltrafixGoalChange, ultrafixMaxCycles, onUltrafixMaxCyclesChange,
  tasks, pendingCount, implementingAll, handleImplementAll,
}) => {
  const [goalInput, setGoalInput] = useState(ultrafixGoal?.toString() ?? '');
  const [maxCyclesInput, setMaxCyclesInput] = useState(ultrafixMaxCycles?.toString() ?? '');

  useEffect(() => {
    setGoalInput(ultrafixGoal?.toString() ?? '');
  }, [ultrafixGoal]);

  useEffect(() => {
    setMaxCyclesInput(ultrafixMaxCycles?.toString() ?? '');
  }, [ultrafixMaxCycles]);

  const commitGoal = () => {
    const nextValue = goalInput.trim() === '' ? null : Number(goalInput);
    if (nextValue !== null && (!Number.isInteger(nextValue) || nextValue < 1 || nextValue > 10)) {
      setGoalInput(ultrafixGoal?.toString() ?? '');
      return;
    }
    if (nextValue !== ultrafixGoal) onUltrafixGoalChange?.(nextValue);
  };

  const commitMaxCycles = () => {
    const nextValue = maxCyclesInput.trim() === '' ? null : Number(maxCyclesInput);
    if (nextValue !== null && (!Number.isInteger(nextValue) || nextValue < 1)) {
      setMaxCyclesInput(ultrafixMaxCycles?.toString() ?? '');
      return;
    }
    if (nextValue !== ultrafixMaxCycles) onUltrafixMaxCyclesChange?.(nextValue);
  };

  return (
    <div className="flex flex-col gap-2.5 sm:gap-3 py-2.5 border-b border-slate-200 bg-slate-50 px-3 sm:px-4 -mx-4 mb-3">
      <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-3">
        <span className="text-[11px] font-bold uppercase tracking-widest text-slate-500 flex-shrink-0">Agent</span>
        <div className="flex flex-wrap items-center gap-2">
          <AgentModelSelector
            agents={agents} selectedAgent={globalAgent} selectedModel={globalModel}
            onAgentChange={handleGlobalAgentChange} onModelChange={handleGlobalModelChange}
            disabled={applyingGlobal} compact isMulti={globalIsMulti}
            onMultiToggle={handleGlobalMultiToggle} selectedModels={globalSelectedModels}
            onMultiModelChange={handleGlobalMultiModelChange}
            onMultiConfirm={handleApplyToAll} autoOpenMultiDropdown
          />
          {!globalIsMulti && (
            <button
              onClick={handleApplyToAll}
              disabled={!globalAgent || applyingGlobal}
              className="inline-flex items-center gap-1.5 px-2 sm:px-3 py-1.5 text-xs sm:text-sm font-medium rounded-md bg-blue-600 text-white shadow-sm hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors whitespace-nowrap"
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
      <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-6">
        <span className="text-[11px] font-bold uppercase tracking-widest text-slate-500 flex-shrink-0">PR Options</span>
        <div className="flex flex-wrap items-center gap-3 sm:gap-6">
          <label className="flex items-center gap-2 text-xs sm:text-sm text-gray-700 cursor-pointer select-none" title="Automatically merges the PR when all CI checks pass">
            <input type="checkbox" checked={autoMerge || false} onChange={(e) => onAutoMergeChange?.(e.target.checked)} className="w-4 h-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500 cursor-pointer" />
            <ArrowDownToLine size={14} className="text-slate-500 hidden sm:block" />
            <span>Auto-merge <span className="hidden sm:inline">if checks pass</span></span>
            <Info size={14} className="text-slate-400 hover:text-slate-600 transition-colors" />
          </label>
          {tasks.length >= 2 && (
            <label className="flex items-center gap-2 text-xs sm:text-sm text-gray-700 cursor-pointer select-none" title="Creates an overarching PR that aggregates all individual task PRs">
              <input type="checkbox" checked={useEpic || false} onChange={(e) => onUseEpicChange?.(e.target.checked)} className="w-4 h-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500 cursor-pointer" />
              <Layers size={14} className="text-slate-500 hidden sm:block" />
              <span>Epic PR</span>
              <Info size={14} className="text-slate-400 hover:text-slate-600 transition-colors" />
            </label>
          )}
          <label className="flex items-center gap-2 text-xs sm:text-sm text-gray-700 cursor-pointer select-none" title="Automatically run ultrafix after the PR is opened">
            <input type="checkbox" checked={runUltrafix || false} onChange={(e) => onRunUltrafixChange?.(e.target.checked)} className="w-4 h-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500 cursor-pointer" />
            <span>Run ultrafix after PR</span>
          </label>
          <input
            type="number"
            min={1}
            max={10}
            value={goalInput}
            onChange={(e) => setGoalInput(e.target.value)}
            onBlur={commitGoal}
            onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
            placeholder="UF goal"
            className="w-24 rounded-md border border-slate-300 px-2 py-1 text-xs sm:text-sm"
          />
          <input
            type="number"
            min={1}
            value={maxCyclesInput}
            onChange={(e) => setMaxCyclesInput(e.target.value)}
            onBlur={commitMaxCycles}
            onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
            placeholder="UF max"
            className="w-24 rounded-md border border-slate-300 px-2 py-1 text-xs sm:text-sm"
          />
        </div>
      </div>
      {pendingCount >= 2 && autoMerge && useEpic && (
        <div className="flex items-center justify-end pt-1 border-t border-slate-200/50">
          <button
            onClick={handleImplementAll}
            disabled={implementingAll || !globalAgent}
            className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-md bg-green-600 text-white shadow-sm hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            title={!globalAgent ? 'Select an agent first' : 'Start sequential implementation: each issue will be processed and merged before the next one starts'}
          >
            {implementingAll ? (
              <><Loader2 size={16} className="animate-spin" /><span>Starting sequence...</span></>
            ) : (
              <><CheckCircle size={16} /><span>Run All Sequentially ({pendingCount})</span></>
            )}
          </button>
        </div>
      )}
    </div>
  );
};
