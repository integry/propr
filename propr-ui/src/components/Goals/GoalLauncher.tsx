import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronRight, Play, ScrollText } from 'lucide-react';
import { getInstanceCatalog } from '../../api/proprApi';
import type { InstanceCatalogRepository } from '../../api/proprTypes';
import {
  createGoal, getGoalCapabilities,
  type Goal, type GoalCapability, type GoalLaunchStrategy,
} from '../../api/goals';
import { BaseBranchSelector } from '../BaseBranchSelector';
import { RepositorySelector, type RepoOption } from '../RepositorySelector';
import { useDemoMode } from '../../contexts/DemoModeContext';
import { formatAgentLabel } from '../../utils/agentStatus';
import { getModelDisplayName } from '../../utils/modelDisplay';
import { GoalAttachmentInput } from './GoalAttachmentInput';
import { clipboardImageFiles } from './goalAttachmentUtils';
import { addGoalFiles, buttonClass } from './goalLauncherUtils';

const checkpointIntervalOptions = [5, 10, 15, 30, 60, 120];
const goalFormSettingsStorageKey = 'propr.goalFormSettings';
const taskFormSettingsStorageKey = 'propr.taskFormSettings';


const createGoalWithOptionalFiles = (body: Parameters<typeof createGoal>[0], files: File[]) => files.length > 0
  ? createGoal(body, files)
  : createGoal(body);

interface GoalFormSettings {
  repository: string;
  agentId: string;
  model: string;
  launchStrategy: GoalLaunchStrategy;
  maxParallelTasks: number | null;
  ultrafix: boolean;
  checkpointIntervalMinutes: number;
  /** Task launcher only; goals use the repository default branch. */
  baseBranch?: string;
}

const defaultGoalFormSettings: GoalFormSettings = {
  repository: '',
  agentId: '',
  model: '',
  launchStrategy: 'direct',
  maxParallelTasks: null,
  ultrafix: false,
  checkpointIntervalMinutes: 15,
};

const readGoalFormSettings = (storageKey = goalFormSettingsStorageKey): GoalFormSettings => {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(storageKey) || 'null');
    if (!parsed || typeof parsed !== 'object') return defaultGoalFormSettings;
    const stored = parsed as Record<string, unknown>;
    return {
      repository: typeof stored.repository === 'string' ? stored.repository : '',
      agentId: typeof stored.agentId === 'string' ? stored.agentId : '',
      model: typeof stored.model === 'string' ? stored.model : '',
      launchStrategy: stored.launchStrategy === 'orchestrate' ? 'orchestrate' : 'direct',
      maxParallelTasks: typeof stored.maxParallelTasks === 'number'
        && Number.isInteger(stored.maxParallelTasks)
        && stored.maxParallelTasks >= 1
        && stored.maxParallelTasks <= 32
        ? stored.maxParallelTasks
        : null,
      ultrafix: typeof stored.ultrafix === 'boolean' ? stored.ultrafix : false,
      ...(typeof stored.baseBranch === 'string' ? { baseBranch: stored.baseBranch } : {}),
      checkpointIntervalMinutes: typeof stored.checkpointIntervalMinutes === 'number'
        && checkpointIntervalOptions.includes(stored.checkpointIntervalMinutes)
        ? stored.checkpointIntervalMinutes
        : 15,
    };
  } catch {
    return defaultGoalFormSettings;
  }
};

const saveGoalFormSettings = (settings: GoalFormSettings, storageKey = goalFormSettingsStorageKey) => {
  try {
    window.localStorage.setItem(storageKey, JSON.stringify(settings));
  } catch {
    // The form should remain usable when browser storage is unavailable.
  }
};

/**
 * Tasks remember their own repository and execution options, but fall back to
 * the agent and model last used for a goal so the first task needs no setup.
 */
const readTaskFormSettings = (): GoalFormSettings => {
  const hasTaskSettings = (() => {
    try { return window.localStorage.getItem(taskFormSettingsStorageKey) !== null; } catch { return false; }
  })();
  if (hasTaskSettings) return { ...readGoalFormSettings(taskFormSettingsStorageKey), launchStrategy: 'direct', maxParallelTasks: null };
  const goalSettings = readGoalFormSettings();
  return { ...defaultGoalFormSettings, repository: goalSettings.repository, agentId: goalSettings.agentId, model: goalSettings.model };
};

// Codex counts the objective in Unicode code points; Claude Code's `/goal`
// counts its (trimmed) condition in UTF-16 units, so an emoji counts as two.
const objectiveLength = (objective: string, agentType: string | undefined) => agentType === 'claude'
  ? objective.trim().length
  : Array.from(objective).length;

const OBJECTIVE_LIMIT_PROVIDERS: Record<string, { name: string; unit: string }> = {
  codex: { name: 'Codex', unit: 'Unicode characters' },
  claude: { name: 'Claude', unit: 'characters (emoji and some symbols count as two)' },
};

const capabilityAgentLabel = (agent: GoalCapability, agents: GoalCapability[]) => formatAgentLabel(
  { type: agent.agentType, alias: agent.agentAlias },
  agents.map(candidate => ({ type: candidate.agentType, alias: candidate.agentAlias })),
);

/** Goals are open-ended; tasks are one-off direct goals that implement, validate, publish, and stop. */
export type GoalLauncherVariant = 'goal' | 'task';

export interface PlanFirstRequest {
  repository: string;
  prompt: string;
}

// The create surface coordinates persisted settings, runtime capabilities, attachments, and demo-mode access.
export interface GoalLauncherFormProps {
  variant?: GoalLauncherVariant;
  initialRepository?: string;
  initialObjective?: string;
  onCancel?: () => void;
  onCreated: (goal: Goal) => void;
  onDirtyChange?: (dirty: boolean) => void;
  onSubmittingChange?: (submitting: boolean) => void;
  /** Task launcher only: hand the instruction to the planner instead of running it now. */
  onPlanFirst?: (request: PlanFirstRequest) => void;
}

const noop = () => undefined;

/**
 * Shared launcher for direct goals. The goal variant exposes every launch
 * strategy; the task variant asks only for a repository and an instruction and
 * keeps execution settings under Options.
 */
// eslint-disable-next-line complexity
export function GoalLauncherForm({
  variant = 'goal', initialRepository, initialObjective = '', onCancel, onCreated,
  onDirtyChange = noop, onSubmittingChange = noop, onPlanFirst,
}: GoalLauncherFormProps) {
  const { isDemoMode } = useDemoMode();
  const isTask = variant === 'task';
  const previousSettings = useMemo(() => isTask ? readTaskFormSettings() : readGoalFormSettings(), [isTask]);
  const [repositories, setRepositories] = useState<InstanceCatalogRepository[]>([]);
  const [agents, setAgents] = useState<GoalCapability[]>([]);
  const [repository, setRepository] = useState(initialRepository || previousSettings.repository);
  const [agentId, setAgentId] = useState(previousSettings.agentId);
  const [model, setModel] = useState(previousSettings.model);
  // A branch belongs to the repository it was chosen for; any other repository uses its default.
  const [branchSelection, setBranchSelection] = useState({ repository: previousSettings.repository, branch: previousSettings.baseBranch ?? '' });
  const baseBranch = branchSelection.repository === repository ? branchSelection.branch.trim() : '';
  const setBaseBranch = (branch: string) => setBranchSelection({ repository, branch });
  const [objective, setObjective] = useState(initialObjective);
  const [files, setFiles] = useState<File[]>([]);
  const [launchStrategy, setLaunchStrategy] = useState<GoalLaunchStrategy>(previousSettings.launchStrategy);
  const [parallelism, setParallelism] = useState(previousSettings.maxParallelTasks?.toString() || '');
  const [ultrafix, setUltrafix] = useState(previousSettings.ultrafix);
  const [checkpointInterval, setCheckpointInterval] = useState(previousSettings.checkpointIntervalMinutes);
  const [submitting, setSubmitting] = useState(false);
  const [rechecking, setRechecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selectedAgent = agents.find(agent => agent.agentId === agentId);
  const objectiveCharacters = objectiveLength(objective, selectedAgent?.agentType);
  const objectiveLimitProvider = OBJECTIVE_LIMIT_PROVIDERS[selectedAgent?.agentType ?? ''];
  const objectiveMaxCharacters = selectedAgent?.objectiveMaxCharacters ?? null;
  const objectiveTooLong = objectiveMaxCharacters !== null
    && objectiveCharacters > objectiveMaxCharacters;
  const unsupportedAgents = agents.filter(agent => !agent.goalCapable);
  const showRuntimeDiagnostics = agents.length > 0 && unsupportedAgents.length === agents.length;
  const repositoryOptions = useMemo<RepoOption[]>(() => repositories.map(repo => ({
    name: repo.name,
    enabled: repo.enabled,
    ...(repo.alias ? { displayName: repo.alias } : {}),
    ...(repo.baseBranch ? { baseBranch: repo.baseBranch } : {}),
  })), [repositories]);
  const markDirty = useCallback(() => onDirtyChange(true), [onDirtyChange]);

  const applyCapabilities = useCallback((capabilities: GoalCapability[]) => {
    setAgents(capabilities);
    setAgentId(current => capabilities.some(agent => agent.agentId === current && agent.goalCapable)
      ? current
      : capabilities.find(agent => agent.goalCapable)?.agentId || '');
  }, []);

  useEffect(() => {
    Promise.all([getInstanceCatalog(), getGoalCapabilities()]).then(([catalog, capabilityData]) => {
      setRepositories(catalog.repositories);
      applyCapabilities(capabilityData.agents);
      setRepository(current => catalog.repositories.some(repo => repo.name === current)
        ? current
        : catalog.repositories.find(repo => repo.enabled)?.name || catalog.repositories[0]?.name || '');
    }).catch(err => setError((err as Error).message));
  }, [applyCapabilities]);

  useEffect(() => {
    if (selectedAgent && !selectedAgent.models.includes(model)) setModel(selectedAgent.defaultModel || selectedAgent.models[0] || '');
  }, [model, selectedAgent]);

  const recheckCapabilities = async () => {
    setRechecking(true);
    setError(null);
    try {
      applyCapabilities((await getGoalCapabilities(true)).agents);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setRechecking(false);
    }
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (isDemoMode) return;
    if (objectiveTooLong) {
      setError(`Objective exceeds this coding agent's ${objectiveMaxCharacters?.toLocaleString('en-US')} character limit.`);
      return;
    }
    setSubmitting(true);
    onSubmittingChange(true);
    setError(null);
    try {
      const createBody = isTask
        ? {
          repository, agentId, model, objective, kind: 'task' as const, launchStrategy: 'direct' as const,
          checkpointIntervalMinutes: checkpointInterval, ultrafix,
          ...(baseBranch ? { baseBranch } : {}),
        }
        : {
          repository, agentId, model, objective, launchStrategy,
          ...(parallelism ? { maxParallelTasks: Number(parallelism) } : {}),
          ...(launchStrategy === 'direct' ? { checkpointIntervalMinutes: checkpointInterval } : {}),
          ultrafix,
        };
      const result = await createGoalWithOptionalFiles(createBody, files);
      if (isTask) {
        saveGoalFormSettings({
          ...defaultGoalFormSettings,
          repository, agentId, model, ultrafix, checkpointIntervalMinutes: checkpointInterval, baseBranch,
        }, taskFormSettingsStorageKey);
      } else {
        saveGoalFormSettings({
          repository,
          agentId,
          model,
          launchStrategy,
          maxParallelTasks: parallelism ? Number(parallelism) : null,
          ultrafix,
          checkpointIntervalMinutes: checkpointInterval,
        });
      }
      onCreated(result.goal);
    } catch (err) { setError((err as Error).message); }
    finally { setSubmitting(false); onSubmittingChange(false); }
  };

  const pasteIntoObjective = (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const pasted = clipboardImageFiles(event);
    if (!pasted.length) return;
    event.preventDefault();
    markDirty();
    void addGoalFiles(files, pasted, setFiles, setError);
  };
  const cannotStart = isDemoMode || submitting || objectiveTooLong || !repository || !agentId || !model
    || !objective.trim() || !selectedAgent?.goalCapable;

  if (isTask) return (
    <form onSubmit={submit} aria-label="New task" className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto">
      {isDemoMode && <p className="mb-4 border-l-2 border-amber-400 bg-amber-50 p-3 text-sm text-amber-800">Demo mode is read-only. You can inspect existing tasks, but cannot start a new one.</p>}
      {error && <p role="alert" className="mb-3 text-sm text-red-600">{error}</p>}
      {showRuntimeDiagnostics && <div className="mb-3 border-l-2 border-amber-400 bg-amber-50 p-3 text-sm text-amber-800">
        <p>No configured coding-agent runtime can run tasks directly.</p>
        <ul className="mt-2 list-disc space-y-1 pl-5">
          {unsupportedAgents.map(agent => <li key={agent.agentId}><span className="font-medium">{agent.agentAlias}:</span> {agent.reason || 'Required goal/session transport is unavailable'}</li>)}
        </ul>
        <button type="button" disabled={rechecking} onClick={recheckCapabilities} className="mt-2 font-medium underline disabled:opacity-50">{rechecking ? 'Rechecking…' : 'Recheck runtimes'}</button>
      </div>}
      <fieldset disabled={isDemoMode} aria-label="Task creation controls" className={`min-w-0 border-0 p-0 ${isDemoMode ? 'opacity-70' : ''}`}>
        <div className="max-w-md text-sm font-medium text-slate-700">Repository
          <RepositorySelector repos={repositoryOptions} selectedRepo={repository} onRepoChange={value => { markDirty(); setRepository(value); }} className="mt-1" />
        </div>
        <div className="mt-4 text-sm font-medium text-slate-700">
          <label htmlFor="task-instruction">Instruction</label>
          <textarea id="task-instruction" aria-invalid={objectiveTooLong || undefined} aria-describedby={objectiveMaxCharacters === null ? undefined : 'task-instruction-limit'} value={objective} onChange={event => { markDirty(); setObjective(event.target.value); }} onPaste={pasteIntoObjective} rows={6} placeholder="Describe the change you want, e.g. “Fix the date formatting on the invoice page”" className={`mt-1 w-full rounded-md border p-3 font-normal ${objectiveTooLong ? 'border-red-500' : 'border-slate-300'}`} required autoFocus />
          {objectiveMaxCharacters !== null && <div id="task-instruction-limit" className={`mt-1 flex flex-wrap items-center justify-between gap-x-3 text-xs font-normal ${objectiveTooLong ? 'text-red-600' : 'text-slate-500'}`}>
            <span>{objectiveLimitProvider?.name ?? selectedAgent?.agentAlias} accepts up to {objectiveMaxCharacters.toLocaleString('en-US')} {objectiveLimitProvider?.unit ?? 'characters'}.</span>
            <output aria-label="Instruction character count" aria-live="polite">{objectiveCharacters.toLocaleString('en-US')} / {objectiveMaxCharacters.toLocaleString('en-US')} characters</output>
          </div>}
          <GoalAttachmentInput files={files} onFilesSelected={markDirty} onChange={nextFiles => { markDirty(); setFiles(nextFiles); }} onError={setError} disabled={submitting} />
        </div>
        <details className="group mt-5 border-t border-slate-200 pt-3">
          <summary className="flex cursor-pointer list-none items-center gap-2 text-sm font-medium text-slate-700 [&::-webkit-details-marker]:hidden">
            <ChevronRight aria-hidden="true" className="h-4 w-4 text-slate-400 transition-transform group-open:rotate-90" />
            Options
            <span className="truncate text-xs font-normal text-slate-500">
              {selectedAgent ? capabilityAgentLabel(selectedAgent, agents) : 'Agent'} · {model ? getModelDisplayName(model) : 'Model'} · {baseBranch || 'default branch'}
            </span>
          </summary>
          <div className="mt-3 grid gap-4 md:grid-cols-2">
            <label className="text-sm font-medium text-slate-700">Coding agent
              <select aria-label="Coding agent" value={agentId} onChange={event => { markDirty(); setAgentId(event.target.value); }} className="mt-1 w-full rounded-md border border-slate-300 p-2" required>
                {agents.map(agent => <option key={agent.agentId} value={agent.agentId} disabled={!agent.goalCapable}>{capabilityAgentLabel(agent, agents)}{agent.goalCapable ? '' : ' — unsupported'}</option>)}
              </select>
            </label>
            <label className="text-sm font-medium text-slate-700">Model
              <select aria-label="Model" value={model} onChange={event => { markDirty(); setModel(event.target.value); }} className="mt-1 w-full rounded-md border border-slate-300 p-2" required>
                {(selectedAgent?.models || []).map(item => <option key={item} value={item}>{getModelDisplayName(item)}</option>)}
              </select>
            </label>
            <div className="text-sm font-medium text-slate-700">
              <span id="task-base-branch-label">Base branch</span>
              <div className="mt-1"><BaseBranchSelector repoName={repository} value={baseBranch} onChange={branch => { markDirty(); setBaseBranch(branch); }} placeholder="Repository default" controlId="task-base-branch" labelledBy="task-base-branch-label" disabled={!repository} /></div>
            </div>
            <label className="text-sm font-medium text-slate-700">Checkpoint target cadence
              <select aria-label="Checkpoint target cadence" value={checkpointInterval} onChange={event => { markDirty(); setCheckpointInterval(Number(event.target.value)); }} className="mt-1 w-full rounded-md border border-slate-300 p-2">
                {checkpointIntervalOptions.map(minutes => <option key={minutes} value={minutes}>About every {minutes} minutes</option>)}
              </select>
            </label>
          </div>
          <label className="mt-3 flex items-center gap-2 text-sm text-slate-700"><input type="checkbox" checked={ultrafix} onChange={event => { markDirty(); setUltrafix(event.target.checked); }} /> Ask the coding agent to use Ultrafix</label>
          <p className="mt-2 text-xs text-slate-500">ProPR opens a draft PR, the agent implements the instruction and runs relevant checks, and ProPR publishes the result. Larger scope is reported back as a proposed plan or goal instead.</p>
        </details>
      </fieldset>
      </div>
      <div className="mt-5 flex flex-none flex-wrap items-center justify-end gap-3 border-t border-slate-200 pt-4">
        {onCancel && <button type="button" onClick={onCancel} disabled={submitting} className={`${buttonClass} mr-auto text-slate-600 hover:bg-slate-100`}>Cancel</button>}
        {onPlanFirst && <button type="button" disabled={isDemoMode || submitting || !repository || !objective.trim()} onClick={() => onPlanFirst({ repository, prompt: objective })} className={`${buttonClass} border border-slate-300 bg-white text-slate-700 hover:bg-slate-50`}><ScrollText className="h-4 w-4" />Plan first</button>}
        <button type="submit" disabled={cannotStart} title={isDemoMode ? 'Demo mode is read-only' : undefined} className={`${buttonClass} bg-primary-600 text-white hover:bg-primary-700`}><Play className="h-4 w-4" />{submitting ? 'Starting…' : 'Run task'}</button>
      </div>
    </form>
  );

  return (
    <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5 sm:px-7">
      {isDemoMode && <p className="mb-4 border-l-2 border-amber-400 bg-amber-50 p-3 text-sm text-amber-800">Demo mode is read-only. You can inspect existing goals, but cannot start a new one.</p>}
      {error && <p role="alert" className="mb-3 text-sm text-red-600">{error}</p>}
      {showRuntimeDiagnostics && <div className="mb-3 border-l-2 border-amber-400 bg-amber-50 p-3 text-sm text-amber-800">
        <p>No configured coding-agent runtime currently supports goals.</p>
        <ul className="mt-2 list-disc space-y-1 pl-5">
          {unsupportedAgents.map(agent => <li key={agent.agentId}><span className="font-medium">{agent.agentAlias}:</span> {agent.reason || 'Required goal/session transport is unavailable'}</li>)}
        </ul>
        <button type="button" disabled={rechecking} onClick={recheckCapabilities} className="mt-2 font-medium underline disabled:opacity-50">{rechecking ? 'Rechecking…' : 'Recheck runtimes'}</button>
      </div>}
      <fieldset disabled={isDemoMode} aria-label="Goal creation controls" className={`min-w-0 border-0 p-0 ${isDemoMode ? 'opacity-70' : ''}`}>
        <div className="grid gap-4 md:grid-cols-2">
        <div className="text-sm font-medium text-slate-700">Repository
          <RepositorySelector repos={repositoryOptions} selectedRepo={repository} onRepoChange={value => { markDirty(); setRepository(value); }} className="mt-1" />
        </div>
        <label className="text-sm font-medium text-slate-700">Coding agent
          <select aria-label="Coding agent" value={agentId} onChange={event => { markDirty(); setAgentId(event.target.value); }} className="mt-1 w-full rounded-md border border-slate-300 p-2" required>
            {agents.map(agent => <option key={agent.agentId} value={agent.agentId} disabled={!agent.goalCapable}>{capabilityAgentLabel(agent, agents)}{agent.goalCapable ? '' : ' — unsupported'}</option>)}
          </select>
        </label>
        <label className="text-sm font-medium text-slate-700">Model
          <select aria-label="Model" value={model} onChange={event => { markDirty(); setModel(event.target.value); }} className="mt-1 w-full rounded-md border border-slate-300 p-2" required>
            {(selectedAgent?.models || []).map(item => <option key={item} value={item}>{getModelDisplayName(item)}</option>)}
          </select>
        </label>
        <label className="text-sm font-medium text-slate-700">Maximum parallel tasks (optional)
          <input aria-label="Maximum parallel tasks" type="number" min="1" max="32" value={parallelism} onChange={event => { markDirty(); setParallelism(event.target.value); }} className="mt-1 w-full rounded-md border border-slate-300 p-2" />
        </label>
        </div>
        <fieldset className="mt-4">
        <legend className="text-sm font-medium text-slate-700">Goal launch strategy</legend>
        <div className="mt-2 grid gap-3 md:grid-cols-2">
          <label className="flex cursor-pointer gap-3 border border-slate-200 p-3 text-sm text-slate-700"><input aria-label="Agent implements directly" type="radio" name="launch-strategy" value="direct" checked={launchStrategy === 'direct'} onChange={() => { markDirty(); setLaunchStrategy('direct'); }} /><span><strong className="block text-slate-900">Agent implements directly</strong>ProPR opens the draft PR before work begins and safely commits the agent's changes at checkpoints.</span></label>
          <label className="flex cursor-pointer gap-3 border border-slate-200 p-3 text-sm text-slate-700"><input aria-label="Agent orchestrates through ProPR" type="radio" name="launch-strategy" value="orchestrate" checked={launchStrategy === 'orchestrate'} onChange={() => { markDirty(); setLaunchStrategy('orchestrate'); }} /><span><strong className="block text-slate-900">Agent orchestrates through ProPR</strong>The agent owns decomposition, creates issues, and starts and monitors their implementation through ProPR.</span></label>
        </div>
        </fieldset>
        {launchStrategy === 'direct' && <div className="mt-4 max-w-xl">
        <div className="flex items-center justify-between gap-3">
          <label htmlFor="checkpoint-frequency" className="text-sm font-medium text-slate-700">Checkpoint target cadence</label>
          <output htmlFor="checkpoint-frequency" className="rounded-full bg-primary-500/10 px-2.5 py-1 text-xs font-semibold text-primary-700">{checkpointInterval} minutes</output>
        </div>
        <input
          id="checkpoint-frequency"
          aria-label="Checkpoint target cadence"
          aria-valuetext={`${checkpointInterval} minutes`}
          type="range"
          min="0"
          max={checkpointIntervalOptions.length - 1}
          step="1"
          value={checkpointIntervalOptions.indexOf(checkpointInterval)}
          onChange={event => { markDirty(); setCheckpointInterval(checkpointIntervalOptions[Number(event.target.value)]); }}
          className="mt-3 h-2 w-full cursor-pointer accent-primary-600"
        />
        <div aria-label="Checkpoint target cadence options" className="mt-1 flex justify-between text-xs text-slate-500">
          {checkpointIntervalOptions.map(minutes => <span key={minutes}>{minutes}</span>)}
        </div>
        <p className="mt-2 text-xs text-slate-500">Guidance for the agent, not a timer. ProPR commits only when the agent declares a coherent checkpoint ready.</p>
        </div>}
        <div className="mt-4 text-sm font-medium text-slate-700">Objective
        <textarea aria-label="Objective" aria-invalid={objectiveTooLong || undefined} aria-describedby={objectiveMaxCharacters === null ? undefined : 'goal-objective-limit'} value={objective} onChange={event => { markDirty(); setObjective(event.target.value); }} onPaste={pasteIntoObjective} rows={5} className={`mt-1 w-full rounded-md border p-2 ${objectiveTooLong ? 'border-red-500' : 'border-slate-300'}`} required />
        {objectiveMaxCharacters !== null && <div id="goal-objective-limit" className={`mt-1 flex flex-wrap items-center justify-between gap-x-3 text-xs ${objectiveTooLong ? 'text-red-600' : 'text-slate-500'}`}>
          <span>{objectiveLimitProvider?.name ?? selectedAgent?.agentAlias} accepts up to {objectiveMaxCharacters.toLocaleString('en-US')} {objectiveLimitProvider?.unit ?? 'characters'} for the objective.</span>
          <output aria-label="Objective character count" aria-live="polite">{objectiveCharacters.toLocaleString('en-US')} / {objectiveMaxCharacters.toLocaleString('en-US')} characters</output>
        </div>}
        <GoalAttachmentInput files={files} onFilesSelected={markDirty} onChange={nextFiles => { markDirty(); setFiles(nextFiles); }} onError={setError} disabled={submitting} />
        </div>
        <label className="mt-3 flex items-center gap-2 text-sm text-slate-700"><input type="checkbox" checked={ultrafix} onChange={event => { markDirty(); setUltrafix(event.target.checked); }} /> Ask the coding agent to use Ultrafix</label>
      </fieldset>
      </div>
      <div className="flex flex-none justify-end gap-3 border-t border-slate-200 bg-slate-50 px-5 py-4 sm:px-7">
        {onCancel && <button type="button" onClick={onCancel} disabled={submitting} className={`${buttonClass} border border-slate-300 bg-white text-slate-700 hover:bg-slate-50`}>Cancel</button>}
        <button type="submit" disabled={cannotStart} title={isDemoMode ? 'Demo mode is read-only' : undefined} className={`${buttonClass} bg-primary-600 text-white hover:bg-primary-700`}>{submitting ? 'Starting…' : 'Start goal'}</button>
      </div>
    </form>
  );
}
