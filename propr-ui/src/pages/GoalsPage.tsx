import { PreviewThumbnails } from '../components/PreviewMedia';
/* eslint-disable max-lines -- goal list and split-pane console intentionally share this route-level surface */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  Activity, AlertTriangle, Check, CheckCircle2, CircleDot, CirclePause, CirclePlay, CircleSlash, CircleStop,
  Copy, ExternalLink, FileText, Filter, GitPullRequest, LoaderCircle, Plus, Search, Send,
  MoreHorizontal, Terminal, Trash2, X,
} from 'lucide-react';
import { getInstanceCatalog } from '../api/proprApi';
import type { InstanceCatalogRepository } from '../api/proprTypes';
import {
  cancelGoal, createGoal, deleteGoal, getGoal, getGoalCapabilities, getGoalVisualPreviews, listGoals, pauseGoal,
  requestGoalModel, resumeGoal, sendGoalInput,
  getGoalAttachmentUrl,
  type Goal, type GoalCapability, type GoalLaunchStrategy, type GoalVisualPreview,
} from '../api/goals';
import { useDebouncedCallback } from '../components/TaskList/hooks';
import { useTaskLiveData } from '../components/TaskDetails/useTaskLiveData';
import TodoList from '../components/TaskDetails/TodoList';
import ExecutionEventLog from '../components/TaskDetails/ExecutionEventLog';
import ThinkingLog from '../components/TaskDetails/ThinkingLog';
import { useThinkingLog } from '../components/TaskDetails/useThinkingLog';
import { trustedPreviewMedia } from '@propr/shared';
import VisualPreviewGallery from '../components/VisualPreviewGallery';
import { RepositorySelector, type RepoOption } from '../components/RepositorySelector';
import { ProviderLogo } from '../components/ui/ProviderLogo';
import { RepositoryChip } from '../components/ui/RepositoryChip';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { formatAgentLabel } from '../utils/agentStatus';
import { getModelDisplayName } from '../utils/modelDisplay';
import { GoalAttachmentInput } from '../components/Goals/GoalAttachmentInput';
import { clipboardImageFiles } from '../components/Goals/goalAttachmentUtils';
import { mergeGoalTimeline } from '../components/Goals/goalTimeline';
import { resizeImage } from '../components/TaskPlanner/imageUtils';
import { useDemoMode } from '../contexts/DemoModeContext';

const buttonClass = 'inline-flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50';
const checkpointIntervalOptions = [5, 10, 15, 30, 60, 120];
const goalFormSettingsStorageKey = 'propr.goalFormSettings';
const maxGoalAttachmentsPerPrompt = 10;

async function addGoalFiles(
  current: File[],
  incoming: File[],
  setFiles: React.Dispatch<React.SetStateAction<File[]>>,
  setError: React.Dispatch<React.SetStateAction<string | null>>,
) {
  if (current.length + incoming.length > maxGoalAttachmentsPerPrompt) {
    setError(`Attach up to ${maxGoalAttachmentsPerPrompt} files to each prompt.`);
    return;
  }
  setFiles([...current, ...await Promise.all(incoming.map(resizeImage))]);
}

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

const readGoalFormSettings = (): GoalFormSettings => {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(goalFormSettingsStorageKey) || 'null');
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
      checkpointIntervalMinutes: typeof stored.checkpointIntervalMinutes === 'number'
        && checkpointIntervalOptions.includes(stored.checkpointIntervalMinutes)
        ? stored.checkpointIntervalMinutes
        : 15,
    };
  } catch {
    return defaultGoalFormSettings;
  }
};

const saveGoalFormSettings = (settings: GoalFormSettings) => {
  try {
    window.localStorage.setItem(goalFormSettingsStorageKey, JSON.stringify(settings));
  } catch {
    // The form should remain usable when browser storage is unavailable.
  }
};

const duration = (milliseconds: number) => {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return hours ? `${hours}h ${minutes}m` : minutes ? `${minutes}m ${seconds}s` : `${seconds}s`;
};
const tokenTotal = (usage: { input_tokens?: number | null; output_tokens?: number | null; cache_creation_input_tokens?: number | null; cache_read_input_tokens?: number | null } | null) => usage
  ? (usage.input_tokens || 0) + (usage.output_tokens || 0)
    + (usage.cache_creation_input_tokens || 0) + (usage.cache_read_input_tokens || 0)
  : 0;

// Each threshold rounds up into the unit above it, so a count never reads as "1000K".
const compactUnits = [
  { threshold: 999_500_000, divisor: 1_000_000_000, suffix: 'B' },
  { threshold: 999_500, divisor: 1_000_000, suffix: 'M' },
  { threshold: 999.5, divisor: 1_000, suffix: 'K' },
];

/** Dashboard counts scan by magnitude: `101,280,735` reads as `101M`, with the exact value on hover. */
const compactCount = (value: number) => {
  const safe = Number.isFinite(value) && value > 0 ? value : 0;
  const unit = compactUnits.find(candidate => safe >= candidate.threshold);
  if (!unit) return Math.round(safe).toLocaleString('en-US');
  const scaled = safe / unit.divisor;
  return `${scaled >= 9.95 ? Math.round(scaled) : Number(scaled.toFixed(1))}${unit.suffix}`;
};

// The metric block has room the queue column does not, so it keeps one decimal: `34,562,641` reads as `34.5M`.
const preciseUnits = [
  { divisor: 1_000_000_000, suffix: 'B' },
  { divisor: 1_000_000, suffix: 'M' },
  { divisor: 1_000, suffix: 'K' },
];

/** Truncated rather than rounded, so an abbreviated total never reads as more spend than was used. Exact value on hover. */
const metricCount = (value: number) => {
  const safe = Number.isFinite(value) && value > 0 ? value : 0;
  const unit = preciseUnits.find(candidate => safe >= candidate.divisor);
  if (!unit) return Math.round(safe).toLocaleString('en-US');
  return `${Math.floor((safe / unit.divisor) * 10) / 10}${unit.suffix}`;
};

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`;

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

// Every status badge carries the same geometry: one icon, then the label. Success is quiet,
// so only active work, pauses and failures spend colour.
const goalStateBadges: Record<string, { Icon: typeof CheckCircle2; color: string; spin?: boolean }> = {
  running: { Icon: LoaderCircle, color: 'bg-blue-100 text-blue-800', spin: true },
  cancelling: { Icon: LoaderCircle, color: 'bg-amber-100 text-amber-800', spin: true },
  paused: { Icon: CirclePause, color: 'bg-amber-100 text-amber-800' },
  completed: { Icon: CheckCircle2, color: 'bg-slate-100 text-slate-600' },
  failed: { Icon: AlertTriangle, color: 'bg-red-100 text-red-800' },
  cancelled: { Icon: CircleSlash, color: 'bg-red-100 text-red-800' },
};

/** The one state a goal reads as: a settled result first, then the state it is being driven to. */
const goalLifecycleState = (goal: Goal): string => goal.resultState
  || (goal.desiredState === 'cancelled' ? 'cancelling' : goal.desiredState);

// The status filter mirrors the Tasks and Plans dropdowns: one option per state a row can show,
// with the transient "cancelling" rows kept beside the cancelled work they are becoming.
const goalStatusFilters: Array<{ value: string; label: string }> = [
  { value: 'all', label: 'All Statuses' },
  { value: 'running', label: 'Running' },
  { value: 'paused', label: 'Paused' },
  { value: 'completed', label: 'Completed' },
  { value: 'failed', label: 'Failed' },
  { value: 'cancelled', label: 'Cancelled' },
];

const matchesGoalStatus = (goal: Goal, status: string): boolean => {
  if (status === 'all') return true;
  const state = goalLifecycleState(goal);
  if (status === 'cancelled') return state === 'cancelled' || state === 'cancelling';
  return state === status;
};

/** Every keyword has to land somewhere in the goal, so extra words narrow the queue instead of widening it. */
const matchesGoalSearch = (goal: Goal, terms: string[]): boolean => {
  if (terms.length === 0) return true;
  const haystack = `${goal.title} ${goal.objective} ${goal.repository}`.toLowerCase();
  return terms.every(term => haystack.includes(term));
};

const filterGoals = (goals: Goal[], repository: string, status: string, terms: string[]): Goal[] => goals.filter(goal =>
  (repository === 'all' || goal.repository === repository)
  && matchesGoalStatus(goal, status)
  && matchesGoalSearch(goal, terms));

/** One sentence for whichever filter emptied the queue, narrowest first. */
const emptyQueueReason = (search: string, status: string, repository: string): string => {
  if (search) return `No goals match “${search}”`;
  if (status !== 'all') {
    const label = goalStatusFilters.find(option => option.value === status)?.label || status;
    return `No ${label.toLowerCase()} goals`;
  }
  return `No goals in ${repository}`;
};

function GoalState({ goal, quietCompleted = false }: { goal: Goal; quietCompleted?: boolean }) {
  const state = goalLifecycleState(goal);
  if (quietCompleted && state === 'completed') {
    return <span className="inline-flex items-center gap-1.5 text-sm font-medium text-slate-500">
      <CheckCircle2 className="h-4 w-4" />
      Completed
    </span>;
  }
  const { Icon, color, spin } = goalStateBadges[state] ?? { Icon: CircleDot, color: 'bg-blue-100 text-blue-800' };
  return <span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-semibold capitalize ${color}`}>
    <Icon aria-hidden="true" className={`h-3 w-3 flex-none ${spin ? 'animate-spin' : ''}`.trim()} />
    {state}
  </span>;
}

function CheckpointDeclaration({ checkpoint, active }: { checkpoint: NonNullable<Goal['checkpoint']>; active: boolean }) {
  const latest = checkpoint.latest;
  if (!latest || latest.kind !== 'agent') return null;
  const badgeClass = latest.state === 'completed'
    ? 'bg-green-100 text-green-800'
    : latest.state === 'rejected' || latest.state === 'failed'
      ? 'bg-red-100 text-red-800'
      : 'bg-amber-100 text-amber-800';
  const paths = (label: string, values: string[] | null) => values && <div>
    <dt className="text-[10px] font-bold uppercase tracking-widest text-slate-500">{label}</dt>
    <dd className="mt-1 flex flex-wrap gap-1.5">{values.map(value => <code key={value} className="rounded border border-slate-200 bg-slate-100 px-1.5 py-0.5 font-mono text-[12px] text-slate-800">{value}</code>)}</dd>
  </div>;
  return <section aria-label="Latest checkpoint declaration" className={`mt-3 border-t pt-3 text-slate-800 ${active ? 'border-blue-200' : 'border-slate-200'}`}>
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h2 className="font-semibold">Latest checkpoint declaration</h2>
      <span className={`rounded-full px-2 py-0.5 text-xs font-semibold capitalize ${badgeClass}`}>{latest.state}</span>
    </div>
    <dl className="mt-3 grid gap-3 sm:grid-cols-2">
      <div><dt className="text-[10px] font-bold uppercase tracking-widest text-slate-500">Commit message</dt><dd className="mt-1 break-words font-medium">{latest.message || 'Not provided'}</dd></div>
      {latest.summary && <div><dt className="text-[10px] font-bold uppercase tracking-widest text-slate-500">Summary</dt><dd className="mt-1 break-words">{latest.summary}</dd></div>}
      {paths('Included paths', latest.include)}
      {paths('Excluded paths', latest.exclude)}
    </dl>
    {latest.commitSha && <p className="mt-3 text-xs text-slate-500">Published commit <code className="font-mono text-slate-700">{latest.commitSha}</code></p>}
    {latest.error && <p className="mt-3 rounded bg-red-50 p-2 text-sm text-red-700">{latest.error}</p>}
  </section>;
}

// The create surface coordinates persisted settings, runtime capabilities, attachments, and demo-mode access.
interface CreateGoalFormProps {
  onCancel: () => void;
  onCreated: (goal: Goal) => void;
  onDirtyChange: (dirty: boolean) => void;
  onSubmittingChange: (submitting: boolean) => void;
}

// eslint-disable-next-line complexity
function CreateGoalForm({ onCancel, onCreated, onDirtyChange, onSubmittingChange }: CreateGoalFormProps) {
  const { isDemoMode } = useDemoMode();
  const previousSettings = useMemo(readGoalFormSettings, []);
  const [repositories, setRepositories] = useState<InstanceCatalogRepository[]>([]);
  const [agents, setAgents] = useState<GoalCapability[]>([]);
  const [repository, setRepository] = useState(previousSettings.repository);
  const [agentId, setAgentId] = useState(previousSettings.agentId);
  const [model, setModel] = useState(previousSettings.model);
  const [objective, setObjective] = useState('');
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
        : catalog.repositories[0]?.name || '');
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
      const createBody = {
        repository, agentId, model, objective, launchStrategy,
        ...(parallelism ? { maxParallelTasks: Number(parallelism) } : {}),
        ...(launchStrategy === 'direct' ? { checkpointIntervalMinutes: checkpointInterval } : {}),
        ultrafix,
      };
      const result = await createGoalWithOptionalFiles(createBody, files);
      saveGoalFormSettings({
        repository,
        agentId,
        model,
        launchStrategy,
        maxParallelTasks: parallelism ? Number(parallelism) : null,
        ultrafix,
        checkpointIntervalMinutes: checkpointInterval,
      });
      onCreated(result.goal);
    } catch (err) { setError((err as Error).message); }
    finally { setSubmitting(false); onSubmittingChange(false); }
  };

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
        <textarea aria-label="Objective" aria-invalid={objectiveTooLong || undefined} aria-describedby={objectiveMaxCharacters === null ? undefined : 'goal-objective-limit'} value={objective} onChange={event => { markDirty(); setObjective(event.target.value); }} onPaste={event => {
          const pasted = clipboardImageFiles(event);
          if (!pasted.length) return;
          event.preventDefault();
          markDirty();
          void addGoalFiles(files, pasted, setFiles, setError);
        }} rows={5} className={`mt-1 w-full rounded-md border p-2 ${objectiveTooLong ? 'border-red-500' : 'border-slate-300'}`} required />
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
        <button type="button" onClick={onCancel} disabled={submitting} className={`${buttonClass} border border-slate-300 bg-white text-slate-700 hover:bg-slate-50`}>Cancel</button>
        <button type="submit" disabled={isDemoMode || submitting || objectiveTooLong || !repository || !agentId || !model || !objective.trim() || !selectedAgent?.goalCapable} title={isDemoMode ? 'Demo mode is read-only' : undefined} className={`${buttonClass} bg-primary-600 text-white hover:bg-primary-700`}>{submitting ? 'Starting…' : 'Start goal'}</button>
      </div>
    </form>
  );
}

interface CreateGoalDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onCreated: (goal: Goal) => void;
}

function CreateGoalDialog({ isOpen, onClose, onCreated }: CreateGoalDialogProps) {
  const paneRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const dirtyRef = useRef(false);
  const submittingRef = useRef(submitting);
  submittingRef.current = submitting;
  const setDirty = useCallback((dirty: boolean) => { dirtyRef.current = dirty; }, []);

  const requestClose = useCallback(() => {
    if (submittingRef.current) return;
    if (dirtyRef.current && !window.confirm('Discard this unsaved goal? Your objective, attachments, and form changes will be lost.')) return;
    onClose();
  }, [onClose]);

  useEffect(() => {
    if (!isOpen) return;
    dirtyRef.current = false;
    setSubmitting(false);
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const frame = window.requestAnimationFrame(() => {
      if (paneRef.current && !paneRef.current.contains(document.activeElement)) paneRef.current.focus();
    });
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (event.defaultPrevented) return;
        event.preventDefault();
        requestClose();
        return;
      }
      if (event.key !== 'Tab' || !paneRef.current) return;
      const focusable = Array.from(paneRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
      ));
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const activeElement = document.activeElement;
      if (!paneRef.current.contains(activeElement)) { event.preventDefault(); first.focus(); }
      else if (event.shiftKey && (activeElement === first || activeElement === paneRef.current)) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      window.cancelAnimationFrame(frame);
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', handleKeyDown);
      if (previousFocusRef.current?.isConnected) previousFocusRef.current.focus();
    };
  }, [isOpen, requestClose]);

  if (!isOpen) return null;
  return <div
    className="fixed inset-0 z-50 flex justify-end bg-slate-950/40 sm:p-3 lg:p-5"
    onMouseDown={event => { if (event.target === event.currentTarget) requestClose(); }}
  >
    <div
      ref={paneRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="create-goal-title"
      aria-describedby="create-goal-description"
      tabIndex={-1}
      className="flex h-full w-full min-w-0 flex-col bg-white shadow-2xl outline-none sm:max-w-3xl sm:border sm:border-slate-200"
    >
      <header className="flex flex-none items-start justify-between gap-4 border-b border-slate-200 px-5 py-4 sm:px-7">
        <div>
          <h2 id="create-goal-title" className="flex items-center gap-2 text-lg font-semibold text-slate-900"><Plus className="h-5 w-5 text-primary-600" />Start a goal</h2>
          <p id="create-goal-description" className="mt-1 text-sm text-slate-500">Configure a dedicated coding-agent session. Your reusable settings are remembered after creation.</p>
        </div>
        <button type="button" onClick={requestClose} disabled={submitting} aria-label="Close goal creation" className="inline-flex h-10 w-10 flex-none items-center justify-center text-slate-500 hover:bg-slate-100 hover:text-slate-800 disabled:opacity-50"><X className="h-5 w-5" /></button>
      </header>
      <CreateGoalForm onCancel={requestClose} onCreated={onCreated} onDirtyChange={setDirty} onSubmittingChange={setSubmitting} />
    </div>
  </div>;
}

// The steering rail pads its own rows so the separating rules reach both edges of the pane.
const railInset = 'px-4 sm:px-6';
const railMetricLabel = 'text-[10px] font-bold uppercase tracking-widest text-slate-500';

/**
 * Identifiers are scanned by their ends, never read as prose. A 36-character UUID printed in full
 * wraps across the metric column and breaks the 2×2 grid, so the rail prints the ends and hands the
 * whole value over through the tooltip and the copy control beside it.
 */
const shortIdentifier = (value: string) => value.length > 20
  ? `${value.slice(0, 8)}...${value.slice(-4)}`
  : value;

/** Sits quiet until the metric is hovered or the control is focused; the truncated id stays readable either way. */
const CopyIdentifierButton: React.FC<{ value: string; label: string }> = ({ value, label }) => {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1_500);
    return () => window.clearTimeout(timer);
  }, [copied]);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
    } catch { /* No clipboard permission: the full value is still on the tooltip. */ }
  };
  return <button
    type="button"
    onClick={() => void copy()}
    aria-label={copied ? `${label} — copied` : label}
    title={label}
    className="flex-none rounded p-0.5 text-slate-400 opacity-0 transition hover:bg-slate-200 hover:text-slate-700 focus-visible:opacity-100 group-hover:opacity-100"
  >
    {copied ? <Check className="h-3 w-3 text-emerald-600" /> : <Copy className="h-3 w-3" />}
  </button>;
};

// Goal 35% · Repository 15% · Status 20% · Tokens 10% · Active time 10% · Output 10%.
// Status is the widest secondary column because it carries the running task beside its badge.
// A narrow desktop keeps the table and drops the two secondary measures instead of unfolding into
// cards: the columns that survive are the ones the queue is scanned by.
const queueGridColumns = 'lg:grid-cols-[minmax(0,2.45fr)_minmax(0,1.05fr)_minmax(0,1.4fr)_minmax(84px,0.7fr)] '
  + 'xl:grid-cols-[minmax(0,2.45fr)_minmax(0,1.05fr)_minmax(0,1.4fr)_minmax(64px,0.7fr)_minmax(72px,0.7fr)_minmax(84px,0.7fr)]';
// Tokens and active time are the first columns to go when the table narrows.
const queueSecondaryCell = 'min-w-0 lg:hidden xl:block xl:text-right';
const queueCellLabel = 'mb-1 block text-[10px] font-bold uppercase tracking-wider text-slate-400 lg:hidden';

function GoalQueueRow({ goal, goalAgents }: { goal: Goal; goalAgents: Array<{ type: string; alias: string }> }) {
  // Live progress, never a second copy of the status: a settled goal has no current activity.
  const unsettled = !goal.resultState;
  const activity = unsettled
    ? goal.liveSummary.currentTask || goal.liveSummary.todos.find(todo => todo.status === 'in_progress')?.content || null
    : null;
  const openTodos = goal.liveSummary.todos.filter(todo => todo.status !== 'completed').length;
  const tokens = goal.liveSummary.nativeGoal?.tokensUsed ?? tokenTotal(goal.liveSummary.tokenUsage);
  const activeMs = goal.liveSummary.nativeGoal ? goal.liveSummary.nativeGoal.timeUsedSeconds * 1000 : goal.activeMs;
  const { issues, openIssues, pullRequests, openPullRequests } = goal.artifactStats;
  const agentLabel = formatAgentLabel(goal.agent, goalAgents);
  const modelName = getModelDisplayName(goal.requestedModel);
  return <li className="border-b border-slate-200 last:border-b-0">
    <Link to={`/goals/${goal.id}`} className={`grid min-w-0 grid-cols-2 gap-x-4 gap-y-3 px-4 py-3 transition-colors hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary-500 sm:px-6 ${queueGridColumns} lg:h-16 lg:items-center lg:gap-x-4 lg:gap-y-0 lg:py-0`}>
      <div className="col-span-2 min-w-0 lg:col-span-1">
        <div className="flex min-w-0 items-center gap-2">
          <h3 className="min-w-0 truncate text-sm font-semibold leading-5 text-slate-900" title={goal.title}>{goal.title}</h3>
          <PreviewThumbnails media={goal.previewMedia} size="micro" />
        </div>
        {/* Runtime and objective share one truncated line so every row keeps the same two-line height. */}
        <p className="flex min-w-0 items-center gap-1.5 text-xs leading-5 text-slate-500">
          <ProviderLogo provider={goal.agent.type} className="h-3.5 w-3.5 flex-none" />
          <span className="sr-only">{agentLabel}</span>
          <span className="flex-none" title={`${agentLabel} · ${modelName}`}>{modelName}</span>
          <span aria-hidden="true" className="flex-none text-slate-300">·</span>
          <span className="truncate" title={goal.objective}>{goal.objective}</span>
        </p>
      </div>
      <div className="min-w-0">
        <span className={queueCellLabel}>Repository</span>
        <RepositoryChip repository={goal.repository} />
      </div>
      <div className="min-w-0">
        <span className={queueCellLabel}>Status</span>
        <GoalState goal={goal} />
        {/* One neutral sub-status line: the running task and its step count never push the row taller. */}
        {(activity || (unsettled && goal.liveSummary.todos.length > 0)) && <span className="mt-1 flex min-w-0 items-center gap-1.5 text-xs leading-5 text-slate-500">
          <Activity aria-hidden="true" className="h-3 w-3 flex-none text-slate-400" />
          {activity && <span className="truncate" title={activity}>{activity}</span>}
          {activity && unsettled && goal.liveSummary.todos.length > 0 && <span aria-hidden="true" className="flex-none text-slate-300">·</span>}
          {unsettled && goal.liveSummary.todos.length > 0 && <span className="flex-none tabular-nums" title={`${openTodos} open of ${goal.liveSummary.todos.length} steps`}>{openTodos}/{goal.liveSummary.todos.length} steps</span>}
        </span>}
      </div>
      <div className={queueSecondaryCell}>
        <span className={queueCellLabel}>Tokens</span>
        <span className="block truncate font-mono text-xs tabular-nums text-slate-700" title={`${tokens.toLocaleString('en-US')} tokens`}>{compactCount(tokens)}</span>
      </div>
      <div className={queueSecondaryCell}>
        <span className={queueCellLabel}>Active time</span>
        <span className="block truncate font-mono text-xs tabular-nums text-slate-700">{duration(activeMs)}</span>
      </div>
      <div className="min-w-0 lg:text-right">
        <span className={queueCellLabel}>Output</span>
        {pullRequests === 0 && issues === 0
          ? <span className="block text-xs text-slate-400" title="No issues or pull requests yet">—</span>
          : <>
            <span className="block truncate text-xs tabular-nums text-slate-700" title={`${openPullRequests} of ${pullRequests} open`}>{plural(pullRequests, 'PR')}</span>
            <span className="block truncate text-xs tabular-nums text-slate-500" title={`${openIssues} of ${issues} open`}>{plural(issues, 'issue')}</span>
          </>}
      </div>
    </Link>
  </li>;
}

function GoalList() {
  const navigate = useNavigate();
  const newGoalButtonRef = useRef<HTMLButtonElement>(null);
  const [searchParams, setSearchParams] = useSearchParams();
  const [goals, setGoals] = useState<Goal[]>([]);
  const [initialLoading, setInitialLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [hasSuccessfulRead, setHasSuccessfulRead] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const requestGenerationRef = useRef(0);
  const repositoryFilter = searchParams.get('repository') || 'all';
  const statusFilter = searchParams.get('status') || 'all';
  const urlSearch = searchParams.get('search') || '';
  // The input stays instant while the URL and the filtered queue follow one debounce behind it.
  const [searchQuery, setSearchQuery] = useState(urlSearch);
  const [debouncedSearch, setDebouncedSearch] = useState(urlSearch);
  useEffect(() => {
    if (searchParams.get('new') !== '1') return;
    setIsCreating(true);
    setSearchParams(current => { const next = new URLSearchParams(current); next.delete('new'); return next; }, { replace: true });
  }, [searchParams, setSearchParams]);
  useDocumentTitle('Goals');
  const refresh = useCallback(async (initial = false) => {
    const generation = ++requestGenerationRef.current;
    if (initial) setInitialLoading(true);
    else setRefreshing(true);
    setError(null);
    try {
      const data = await listGoals();
      if (generation !== requestGenerationRef.current) return;
      setGoals(data.goals);
      setHasSuccessfulRead(true);
    } catch (err) {
      if (generation !== requestGenerationRef.current) return;
      setError((err as Error).message);
    } finally {
      if (generation === requestGenerationRef.current) {
        setInitialLoading(false);
        setRefreshing(false);
      }
    }
  }, []);
  useEffect(() => {
    void refresh(true);
    const timer = window.setInterval(() => { void refresh(); }, 10_000);
    return () => {
      requestGenerationRef.current += 1;
      window.clearInterval(timer);
    };
  }, [refresh]);
  const repositoryOptions = useMemo<RepoOption[]>(() => {
    const counts = new Map<string, number>();
    goals.forEach(goal => counts.set(goal.repository, (counts.get(goal.repository) || 0) + 1));
    return [
      { name: 'all', enabled: true, displayName: 'All Repos', count: goals.length },
      ...Array.from(counts, ([name, count]) => ({ name, enabled: true, count }))
        .sort((left, right) => left.name.localeCompare(right.name)),
    ];
  }, [goals]);
  const searchTerms = useMemo(
    () => debouncedSearch.toLowerCase().split(/\s+/).filter(Boolean),
    [debouncedSearch],
  );
  const visibleGoals = useMemo(
    () => filterGoals(goals, repositoryFilter, statusFilter, searchTerms),
    [goals, repositoryFilter, searchTerms, statusFilter],
  );
  const updateFilterParams = useCallback((updates: Record<string, string | null>) => {
    setSearchParams(current => {
      const next = new URLSearchParams(current);
      Object.entries(updates).forEach(([key, value]) => {
        if (!value || value === 'all') next.delete(key);
        else next.set(key, value);
      });
      return next;
    }, { replace: true });
  }, [setSearchParams]);
  const setRepositoryFilter = useCallback(
    (repository: string) => updateFilterParams({ repository }),
    [updateFilterParams],
  );
  const setStatusFilter = useCallback(
    (status: string) => updateFilterParams({ status }),
    [updateFilterParams],
  );
  const commitSearch = useCallback((value: string) => {
    setDebouncedSearch(value);
    updateFilterParams({ search: value.trim() || null });
  }, [updateFilterParams]);
  useDebouncedCallback(searchQuery, commitSearch, 400);
  const clearSearch = useCallback(() => {
    setSearchQuery('');
    commitSearch('');
  }, [commitSearch]);
  const clearFilters = useCallback(() => {
    setSearchQuery('');
    setDebouncedSearch('');
    updateFilterParams({ repository: null, status: null, search: null });
  }, [updateFilterParams]);
  const queueEmptyReason = emptyQueueReason(debouncedSearch, statusFilter, repositoryFilter);
  const goalAgents = goals.map(goal => ({ type: goal.agent.type, alias: goal.agent.alias }));
  const closeCreator = useCallback(() => {
    setIsCreating(false);
    newGoalButtonRef.current?.focus();
  }, []);
  const openCreator = useCallback(() => setIsCreating(true), []);
  return <div className="min-h-full w-full min-w-0 bg-white pb-6">
    <div className="flex flex-wrap items-start justify-between gap-3 px-4 pb-3 pt-4 sm:px-6">
      <div className="min-w-0"><h1 className="text-xl font-bold text-slate-900">Goals</h1><p className="mt-0.5 text-sm text-slate-600">Long-running work kept in one exact coding-agent session.</p></div>
      <button ref={newGoalButtonRef} type="button" onClick={openCreator} className={`${buttonClass} min-h-10 flex-none justify-center bg-primary-600 text-white hover:bg-primary-700`}><Plus className="h-4 w-4" />New goal</button>
    </div>
    {error && <p role="alert" className="mx-4 mb-3 border-l-2 border-red-500 bg-red-50 p-3 text-sm text-red-700 sm:mx-6">{error}</p>}
    <section aria-labelledby="goal-work-queue-title">
      {/* One toolbar rail: the queue count sits with the filter that changes it. The list border below closes the bar. */}
      <div className="flex flex-col gap-2 border-t border-slate-200 bg-slate-50 px-4 py-2 sm:flex-row sm:items-center sm:justify-between sm:px-6">
        <div className="flex items-baseline gap-2"><h2 id="goal-work-queue-title" className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Work queue</h2>{hasSuccessfulRead && <span className="text-xs tabular-nums text-slate-500">{visibleGoals.length} of {goals.length}</span>}{refreshing && hasSuccessfulRead && <span role="status" className="text-xs text-slate-500">Refreshing…</span>}</div>
        {goals.length > 0 && <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center sm:gap-3">
          <div className="relative min-w-0 sm:w-64">
            <Search aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input
              type="text"
              value={searchQuery}
              onChange={event => setSearchQuery(event.target.value)}
              aria-label="Search goals"
              placeholder="Search goals..."
              className="w-full rounded-md border border-slate-300 bg-white py-1.5 pl-9 pr-8 text-sm text-slate-700 focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-500"
            />
            {searchQuery && <button
              type="button"
              onClick={clearSearch}
              title="Clear search"
              aria-label="Clear search"
              className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
            ><X className="h-4 w-4" /></button>}
          </div>
          <div className="flex min-w-0 items-center gap-2">
            <Filter className="h-4 w-4 flex-none text-slate-400" aria-hidden="true" />
            <select
              value={statusFilter}
              onChange={event => setStatusFilter(event.target.value)}
              aria-label="Filter goals by status"
              className="flex-none rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm text-slate-700 focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-500"
            >
              {goalStatusFilters.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
            <div role="group" aria-label="Filter goals by repository" className="min-w-0 flex-1 sm:w-[240px] sm:flex-none">
              <RepositorySelector
                repos={repositoryOptions}
                selectedRepo={repositoryFilter}
                onRepoChange={setRepositoryFilter}
                labelLayout="stacked"
                className="w-full min-w-0"
              />
            </div>
          </div>
        </div>}
      </div>
      {!hasSuccessfulRead && (initialLoading || refreshing)
        ? <div role="status" className="flex items-center justify-center gap-2 border-y border-slate-200 py-10 text-sm text-slate-500"><LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />Loading goals…</div>
        : error && goals.length === 0
          ? null
          : goals.length === 0
        ? <div className="border-y border-dashed border-slate-300 py-10 text-center"><p className="text-sm font-medium text-slate-700">No goals yet</p><p className="mt-1 text-sm text-slate-500">Start a goal to add dedicated agent work to this queue.</p></div>
        : visibleGoals.length === 0
          ? <div className="border-y border-dashed border-slate-300 py-10 text-center"><p className="text-sm font-medium text-slate-700">{queueEmptyReason}</p><button type="button" onClick={clearFilters} className="mt-2 text-sm font-medium text-primary-700 hover:underline">Show all goals</button></div>
          : <div className="border-y border-slate-200 bg-white">
            <div aria-hidden="true" data-testid="goal-queue-columns" className={`hidden gap-x-4 border-b border-slate-200 bg-slate-50 px-6 py-2 text-[10px] font-bold uppercase tracking-wider text-slate-500 ${queueGridColumns} lg:grid`}>
              <span>Goal</span><span>Repository</span><span>Status</span>
              <span data-testid="goal-queue-column-tokens" className="hidden text-right xl:block">Tokens</span>
              <span data-testid="goal-queue-column-active-time" className="hidden text-right xl:block">Active time</span>
              <span className="text-right">Output</span>
            </div>
            <ul aria-label="Goal work queue">{visibleGoals.map(goal => <GoalQueueRow key={goal.id} goal={goal} goalAgents={goalAgents} />)}</ul>
          </div>}
    </section>
    <CreateGoalDialog isOpen={isCreating} onClose={closeCreator} onCreated={goal => navigate(`/goals/${goal.id}`)} />
  </div>;
}

// The detail surface intentionally composes all goal controls and existing task projections.
// eslint-disable-next-line complexity
function GoalDetails({ goalId }: { goalId: string }) {
  const navigate = useNavigate();
  const { isDemoMode } = useDemoMode();
  const [goal, setGoal] = useState<Goal | null>(null);
  const [message, setMessage] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [models, setModels] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outputMode, setOutputMode] = useState<'readable' | 'terminal'>('readable');
  const [visualPreviews, setVisualPreviews] = useState<GoalVisualPreview[]>([]);
  const { liveDetails: live } = useTaskLiveData(goal?.taskId);
  const goalHistory = useMemo(() => goal?.startedAt
    ? [{ state: 'CLAUDE_EXECUTION', timestamp: goal.startedAt }]
    : [], [goal?.startedAt]);
  const thinkingLog = useThinkingLog(live, goalHistory);
  // Operator corrections live outside the provider stdout stream, so both views merge them in.
  const readableTimeline = useMemo(
    () => mergeGoalTimeline(thinkingLog.thinkingLogWithTimestamps, goal?.inputs, { executionStartTime: goal?.startedAt }),
    [goal?.inputs, goal?.startedAt, thinkingLog.thinkingLogWithTimestamps],
  );
  const terminalTimeline = useMemo(
    () => mergeGoalTimeline(live.events, goal?.inputs),
    [goal?.inputs, live.events],
  );
  useDocumentTitle(goal?.title || 'Goal');

  const refresh = useCallback(async () => {
    try {
      const data = await getGoal(goalId); setGoal(data.goal);
      if (models.length === 0) {
        const capabilityData = await getGoalCapabilities();
        setModels(capabilityData.agents.find(agent => agent.agentId === data.goal.agent.id)?.models || [data.goal.requestedModel]);
      }
    } catch (err) { setError((err as Error).message); }
  }, [goalId, models.length]);
  useEffect(() => { refresh(); const timer = window.setInterval(refresh, 5_000); return () => window.clearInterval(timer); }, [refresh]);
  useEffect(() => {
    if (!goal?.finalPr?.number) {
      setVisualPreviews([]);
      return;
    }
    let active = true;
    const refreshPreviews = () => getGoalVisualPreviews(goalId)
      // Filtered at the client boundary so only trusted GitHub attachments reach the gallery and lightbox.
      .then(data => { if (active && !data.unavailable) setVisualPreviews(trustedPreviewMedia(data.previews, 8)); })
      .catch(() => { /* Keep the last successfully fetched GitHub previews. */ });
    void refreshPreviews();
    const timer = window.setInterval(refreshPreviews, 30_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [goal?.finalPr?.number, goalId]);
  const act = async (operation: () => Promise<{ goal: Goal }>) => { if (isDemoMode) return; setBusy(true); setError(null); try { setGoal((await operation()).goal); } catch (err) { setError((err as Error).message); } finally { setBusy(false); } };
  const continueWith = async (body: { message?: string; canned?: 'done' | 'left' }, attachments: File[] = []) => {
    if (!goal || isDemoMode) return;
    setBusy(true); setError(null);
    try {
      const result = attachments.length > 0 ? await sendGoalInput(goal.id, body, attachments) : await sendGoalInput(goal.id, body);
      setGoal(result.goal); setMessage(''); setFiles([]);
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };
  const remove = async () => {
    if (!goal || isDemoMode || !window.confirm('Delete this goal? If it is running, it will be stopped first. This action cannot be undone.')) return;
    setBusy(true); setError(null);
    try {
      await deleteGoal(goal.id);
      navigate('/goals', { replace: true });
    } catch (err) { setError((err as Error).message); setBusy(false); }
  };
  const totalTokens = useMemo(
    () => tokenTotal(live.tokenUsage || null) || goal?.liveSummary.nativeGoal?.tokensUsed || 0,
    [goal?.liveSummary.nativeGoal?.tokensUsed, live.tokenUsage],
  );
  if (!goal) return <div className="p-6 text-slate-600">{error || 'Loading goal…'}</div>;
  const terminal = Boolean(goal.resultState);
  const cancelling = !terminal && goal.desiredState === 'cancelled';
  const mutable = !terminal && !cancelling;
  const canMutate = mutable && !isDemoMode;
  const strategyLabel = goal.launchStrategy === 'direct' ? 'Direct' : 'ProPR orchestrated';
  const currentModel = getModelDisplayName(goal.effectiveModel || goal.requestedModel);
  // The locked-console state is a header note, not a sticky footer bar: it needs no screen real estate of its own.
  const correctionsNote = canMutate
    ? null
    : isDemoMode && mutable
      ? 'Demo mode is read-only. Corrections disabled.'
      : goal.resultState === 'completed'
        ? 'Goal completed. Corrections disabled.'
        : 'Goal closed. Corrections disabled.';
  const artifactLinks = goal.artifacts
    .map(artifact => artifact as { type?: string; number?: number; url?: string })
    .filter(artifact => Boolean(artifact.url));
  return <div className="min-h-full bg-white text-slate-900">
    <header className="w-full border-b border-slate-200 px-4 py-3 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-7xl">
        <div className="flex items-center gap-4">
          <Link to="/goals" className="text-sm font-medium text-slate-600 transition hover:text-primary-700">← All goals</Link>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-bold tracking-tight text-slate-950 sm:text-3xl">{goal.title}</h1>
          <GoalState goal={goal} quietCompleted />
          {correctionsNote && <span className="text-xs text-slate-500">{correctionsNote}</span>}
        </div>
        <div className="mt-2 flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
          {/* Self-evident values carry no uppercase key, so the row reads as one sentence instead of stuttering label/value pairs.
              The row aligns on baselines, not on box centres: the chip's border and padding make it taller
              than the text beside it, and centring boxes of 14px prose against 12px mono still leaves their
              baselines a pixel apart. Every item exports the baseline of its own text (the logo and the
              repository mark centre themselves instead), so the whole row reads along one straight line.
              Each raw value still carries the chip's 1.375rem line box, so the row's rhythm stays even. */}
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-2 text-sm leading-[1.375rem] text-slate-700">
            <span className="font-medium" title={`${strategyLabel} launch strategy`}>{strategyLabel}</span>
            <span aria-hidden="true" className="text-slate-300">·</span>
            <span className="inline-flex items-baseline gap-1.5 font-medium" title={`Model: ${currentModel}`}>
              <ProviderLogo provider={goal.agent.type} className="h-3.5 w-3.5 flex-none self-center" />
              {currentModel}
            </span>
            <span aria-hidden="true" className="text-slate-300">·</span>
            <span className="font-mono text-xs font-semibold leading-[1.375rem] text-slate-700" title="Elapsed time">{duration(goal.elapsedMs)}</span>
            <span aria-hidden="true" className="hidden text-slate-300 sm:inline">·</span>
            <RepositoryChip repository={goal.repository} />
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2">
            {goal.desiredState === 'running' && canMutate && <button disabled={busy} onClick={() => act(() => pauseGoal(goal.id))} className={`${buttonClass} border border-amber-300 text-amber-800 hover:bg-amber-50`}><CirclePause className="h-4 w-4" />Pause</button>}
            {goal.desiredState === 'paused' && canMutate && <button disabled={busy} onClick={() => act(() => resumeGoal(goal.id))} className={`${buttonClass} border border-green-300 text-green-800 hover:bg-green-50`}><CirclePlay className="h-4 w-4" />{goal.pausePending ? 'Resume after safe boundary' : 'Resume'}</button>}
            {canMutate && <button disabled={busy} onClick={() => act(() => cancelGoal(goal.id))} className={`${buttonClass} border border-red-300 text-red-700 hover:bg-red-50`}><CircleStop className="h-4 w-4" />Cancel</button>}
            {goal.finalPr && <a href={goal.finalPr.url} target="_blank" rel="noreferrer" className={`${buttonClass} bg-primary-600 text-white shadow-sm hover:bg-primary-700`}><GitPullRequest className="h-4 w-4" />{goal.launchStrategy === 'direct' ? 'Open draft PR' : 'Review final PR'} <ExternalLink className="h-3.5 w-3.5" /></a>}
            <details className="group relative">
              <summary aria-label="More goal actions" className="flex h-9 w-9 cursor-pointer list-none items-center justify-center rounded-md border border-slate-300 text-slate-600 transition hover:bg-slate-50 [&::-webkit-details-marker]:hidden"><MoreHorizontal className="h-4 w-4" /></summary>
              <div className="absolute right-0 z-20 mt-2 w-48 overflow-hidden rounded-md border border-slate-200 bg-white py-1 shadow-lg">
                <Link to={`/tasks/${encodeURIComponent(goal.taskId)}`} className="block px-3 py-2 text-sm text-slate-700 hover:bg-slate-50">Open task history</Link>
                {!isDemoMode && <button disabled={busy} onClick={remove} className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-red-700 hover:bg-red-50 disabled:opacity-50"><Trash2 className="h-4 w-4" />Delete goal</button>}
              </div>
            </details>
          </div>
        </div>
      </div>
    </header>

    {(error || goal.failureReason || cancelling) && <div className="mx-auto max-w-7xl space-y-2 px-4 pt-4 sm:px-6 lg:px-8">
      {error && <p role="alert" className="bg-red-50 p-3 text-sm text-red-700">{error}</p>}
      {goal.failureReason && <p role="alert" className="bg-red-50 p-3 text-sm text-red-700">{goal.failureReason}</p>}
      {cancelling && <p className="bg-amber-50 p-3 text-sm text-amber-800">Cancelling at the provider boundary and cleaning up the active session…</p>}
    </div>}

    <div className="mx-auto grid min-h-[calc(100vh-17rem)] max-w-7xl lg:grid-cols-[minmax(0,3fr)_minmax(22rem,2fr)]">
      <main aria-label="Goal monitor" className="min-w-0 bg-white px-4 py-6 sm:px-6 lg:px-8">
        <section aria-labelledby="goal-context-heading">
          <h2 id="goal-context-heading" className="text-[10px] font-bold uppercase tracking-widest text-slate-500">Context</h2>
          <details className="group border-b border-slate-200 py-4 text-sm" open>
            <summary className="cursor-pointer font-semibold text-slate-800">Goal description</summary>
            <p className="mt-3 whitespace-pre-wrap break-words leading-6 text-slate-600">{goal.objective}</p>
          </details>
          {(goal.attachments || []).length > 0 && <div className="border-b border-slate-200 py-4 text-sm">
            <h3 className="font-semibold text-slate-800">Files shared with this goal</h3>
            <div className="mt-3 flex flex-wrap gap-2">{(goal.attachments || []).map(attachment => <a key={attachment.id} href={getGoalAttachmentUrl(goal.id, attachment.id)} target="_blank" rel="noreferrer" className="inline-flex max-w-full items-center gap-2 rounded-md border border-slate-200 bg-slate-50 px-2.5 py-2 text-xs text-slate-700 hover:border-primary-300 hover:text-primary-700">
              {attachment.type === 'image'
                ? <img src={getGoalAttachmentUrl(goal.id, attachment.id)} alt="" className="h-9 w-9 rounded object-cover" />
                : <FileText className="h-4 w-4 text-slate-400" />}
              <span className="max-w-52 truncate" title={attachment.originalName}>{attachment.originalName}</span>
            </a>)}</div>
          </div>}
          <details className="group border-b border-slate-200 py-4 text-sm">
            <summary className="cursor-pointer font-semibold text-slate-800">Initial provider prompt</summary>
            <pre className="mt-3 whitespace-pre-wrap break-words font-mono text-xs leading-5 text-slate-600">{goal.initialPrompt}</pre>
          </details>
        </section>

        {/* Colour is reserved for active work: once the goal settles, the checkpoint panel reads as history. */}
        {goal.checkpoint && <section className={`mb-6 mt-3 border p-4 text-sm ${mutable ? 'border-blue-200 bg-blue-50 text-blue-950' : 'border-slate-200 bg-slate-50 text-slate-700'}`}>
          <div className="flex items-start gap-3">
            <CircleDot className={`mt-0.5 h-4 w-4 flex-none ${mutable ? 'text-blue-600' : 'text-slate-400'}`} />
            <div className="min-w-0">
              <p className={`font-medium ${mutable ? '' : 'text-slate-800'}`}>{goal.checkpoint.count} checkpoint commit{goal.checkpoint.count === 1 ? '' : 's'}{goal.checkpoint.lastAt ? ` · last ${new Date(goal.checkpoint.lastAt).toLocaleString()}` : ''}</p>
              <p className={`mt-1 ${mutable ? 'text-blue-800' : 'text-slate-500'}`}>Target cadence: about every {goal.checkpoint.intervalMinutes || 15} minutes. <span className="text-xs">The agent declares when coherent work is ready.</span></p>
              {goal.checkpoint.error && !goal.checkpoint.latest?.error && <p className="mt-2 text-red-700">Checkpoint error: {goal.checkpoint.error}</p>}
              <CheckpointDeclaration checkpoint={goal.checkpoint} active={mutable} />
            </div>
          </div>
        </section>}

        {visualPreviews.length > 0 && <section aria-labelledby="goal-visual-previews-heading" className="my-6 border-y border-slate-200 py-5">
          <div className="flex items-end justify-between gap-3">
            <div>
              <h2 id="goal-visual-previews-heading" className="font-semibold text-slate-900">Visual previews</h2>
              <p className="mt-0.5 text-xs text-slate-500">Current evidence published on the goal PR.</p>
            </div>
            <span className="text-xs text-slate-400">From GitHub</span>
          </div>
          {/* Same evidence surface as the task detail screen: full-width media with lightbox support. */}
          <VisualPreviewGallery previews={visualPreviews} className="mt-4" />
        </section>}

        {/* A settled goal is not waiting for anything: with no queue on record the section goes away
            rather than telling a finished goal it has "no provider todos yet". */}
        {(live.todos.length > 0 || mutable) && <section aria-labelledby="live-progress-heading" className="mt-6">
          <div className="flex items-center gap-2">
            <h2 id="live-progress-heading" className="text-[11px] font-bold uppercase tracking-widest text-slate-500">Execution queue</h2>
            {mutable && goal.desiredState === 'running' && <span className="relative flex h-2 w-2"><span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-blue-400 opacity-75" /><span className="relative inline-flex h-2 w-2 rounded-full bg-blue-500" /></span>}
          </div>
          {live.todos.length ? <div className="[&>div]:border-t-0 [&>div]:pt-3 [&>div>h4]:hidden"><TodoList liveDetails={live} history={[{ state: goal.taskState }]} /></div> : <p className="mt-3 text-sm text-slate-500">No provider todos yet.</p>}
        </section>}

        <section className="mt-8 border-t border-slate-200 pt-5">
          {/* One header row owns both the label and the control that switches what sits under it. */}
          <header className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <h2 className="text-[10px] font-bold uppercase tracking-widest text-slate-500">Implementation log</h2>
              {readableTimeline.length > 0 && <span className="rounded border border-slate-200 bg-slate-50 px-2 py-0.5 font-mono text-[10px] font-bold text-slate-500">{readableTimeline.length}</span>}
            </div>
            <div role="group" aria-label="Goal output view" className="inline-flex rounded-md border border-slate-200 bg-slate-50 p-1">
              <button type="button" aria-pressed={outputMode === 'readable'} onClick={() => setOutputMode('readable')} className={`inline-flex items-center gap-1.5 rounded px-2.5 py-1.5 text-xs font-medium transition ${outputMode === 'readable' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}><FileText className="h-3.5 w-3.5" />Human readable</button>
              <button type="button" aria-pressed={outputMode === 'terminal'} onClick={() => setOutputMode('terminal')} className={`inline-flex items-center gap-1.5 rounded px-2.5 py-1.5 text-xs font-medium transition ${outputMode === 'terminal' ? 'bg-slate-800 text-white shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}><Terminal className="h-3.5 w-3.5" />Raw terminal</button>
            </div>
          </header>
          {outputMode === 'readable'
            ? <div className="min-h-32 py-4">{readableTimeline.length > 0
              ? <ThinkingLog events={readableTimeline} todos={live.todos} showHeader={false} />
              : <p className="text-sm text-slate-500">No human-readable output yet.</p>}</div>
            : <div className="mt-4 min-h-32 bg-slate-950 p-4 text-slate-100">{terminalTimeline.length > 0
              ? <ExecutionEventLog events={terminalTimeline} collapsed={false} onToggleCollapse={() => undefined} lastThought={thinkingLog.lastThought} isTaskActive={mutable && goal.desiredState === 'running'} taskInfo={null} />
              : <p className="text-sm text-slate-400">No terminal output yet.</p>}</div>}
        </section>
      </main>

      <aside aria-label="Steering console" className="flex min-w-0 flex-col border-t border-slate-200 bg-slate-50 py-6 lg:border-l lg:border-t-0">
        {/* The rail is one slate-50 canvas. Nothing here is boxed in white: rows are separated by rules that span the pane. */}
        <section aria-labelledby="goal-metrics-heading">
          <h2 id="goal-metrics-heading" className={`${railInset} text-[10px] font-bold uppercase tracking-widest text-slate-500`}>Metrics</h2>
          <dl className="mt-3 border-t border-slate-200">
            <div className={`${railInset} grid grid-cols-2 gap-x-6 border-b border-slate-200 py-4`}>
              <div className="min-w-0">
                <dt className={railMetricLabel}>Usage</dt>
                <dd className="mt-1 text-2xl font-bold tracking-tight text-slate-950" title={`${totalTokens.toLocaleString()} tokens`}>{metricCount(totalTokens)}</dd>
                <dd className="text-xs text-slate-500">tokens</dd>
                {goal.liveSummary.nativeGoal && <dd className="mt-1 text-xs text-slate-500">{goal.liveSummary.nativeGoal.status} · {duration(goal.liveSummary.nativeGoal.timeUsedSeconds * 1000)}</dd>}
              </div>
              <div className="min-w-0">
                <dt className={railMetricLabel}>Active</dt>
                <dd className="mt-1 font-mono text-sm font-semibold text-slate-800">{duration(goal.activeMs)}</dd>
                <dd className="mt-1 text-xs text-slate-500">{duration(goal.pausedMs)} paused</dd>
              </div>
            </div>
            <div className={`${railInset} grid grid-cols-2 gap-x-6 border-b border-slate-200 py-4`}>
              <div className="min-w-0">
                <dt className={railMetricLabel}>Artifacts</dt>
                <dd className="mt-1 text-sm font-semibold text-slate-800">{goal.artifactStats.openPullRequests}/{goal.artifactStats.pullRequests} PRs</dd>
                <dd className="mt-1 text-xs text-slate-500">{goal.artifactStats.openIssues}/{goal.artifactStats.issues} open issues</dd>
              </div>
              {/* The id clips inside its half of the grid instead of wrapping and stretching the row. */}
              <div className="group min-w-0">
                <dt className={railMetricLabel}>Session</dt>
                {goal.sessionId
                  ? <dd className="mt-1 flex items-center gap-1">
                    <span className="truncate font-mono text-xs text-slate-700" title={goal.sessionId}>{shortIdentifier(goal.sessionId)}</span>
                    <CopyIdentifierButton value={goal.sessionId} label="Copy session id" />
                  </dd>
                  : <dd className="mt-1 truncate text-xs text-slate-500">Waiting for provider identity</dd>}
              </div>
            </div>
          </dl>
        </section>

        {/* Orphaned PR and issue chips belong to a labelled section here, not adrift in the reading column. */}
        {artifactLinks.length > 0 && <section aria-labelledby="goal-artifacts-heading" className={`${railInset} mt-7`}>
          <h2 id="goal-artifacts-heading" className="text-[10px] font-bold uppercase tracking-widest text-slate-500">Related artifacts</h2>
          <ul className="mt-3 flex flex-wrap gap-2">{artifactLinks.map(artifact => <li key={artifact.url}>
            <a href={artifact.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 rounded border border-slate-200 px-2 py-1 text-xs text-slate-700 transition hover:border-slate-300 hover:text-primary-700">
              {artifact.type === 'pull_request'
                ? <GitPullRequest className="h-3.5 w-3.5 flex-none text-slate-400" />
                : <CircleDot className="h-3.5 w-3.5 flex-none text-slate-400" />}
              {artifact.type === 'pull_request' ? 'PR' : 'Issue'} #{artifact.number}
            </a>
          </li>)}</ul>
        </section>}

        {canMutate && <section aria-labelledby="quick-actions-heading" className={`${railInset} mt-7`}>
          <h2 id="quick-actions-heading" className="text-[10px] font-bold uppercase tracking-widest text-slate-500">Quick actions</h2>
          <div className="mt-3 flex flex-wrap gap-2"><button disabled={busy} onClick={() => continueWith({ canned: 'done' })} className={`${buttonClass} border border-slate-300 text-slate-700 hover:bg-slate-100`}>What's done?</button><button disabled={busy} onClick={() => continueWith({ canned: 'left' })} className={`${buttonClass} border border-slate-300 text-slate-700 hover:bg-slate-100`}>What's left?</button></div>
        </section>}

        {/* A closed goal gets no footer bar: the locked state is already stated beside the status badge. */}
        {canMutate && <section aria-labelledby="correction-heading" className={`${railInset} sticky bottom-0 mt-auto bg-slate-50 pb-1 pt-10`}>
          <div className="mb-2 flex flex-col items-end gap-1">
            <label htmlFor="goal-continuation-model" className="text-xs text-slate-500">Model for next continuation</label>
            <select id="goal-continuation-model" value={goal.requestedModel} onChange={event => act(() => requestGoalModel(goal.id, event.target.value))} className="max-w-48 rounded-md border border-slate-200 bg-white px-2 py-1.5 text-xs font-medium text-slate-700 shadow-sm">{models.map(item => <option key={item} value={item}>{getModelDisplayName(item)}</option>)}</select>
          </div>
          <div className="bg-white p-2 shadow-md ring-1 ring-slate-200/70">
            <h2 id="correction-heading" className="sr-only">Send a correction</h2>
            <textarea aria-label="Correction or follow-up" value={message} onChange={event => setMessage(event.target.value)} onPaste={event => {
              const pasted = clipboardImageFiles(event);
              if (!pasted.length) return;
              event.preventDefault();
              void addGoalFiles(files, pasted, setFiles, setError);
            }} rows={3} className="w-full resize-none border-0 p-2 text-sm text-slate-800 outline-none placeholder:text-slate-400 focus:ring-0" placeholder="Send a correction to the same coding-agent session…" />
            <GoalAttachmentInput files={files} onChange={setFiles} onError={setError} disabled={busy} compact />
            <div className="mt-2 flex justify-end"><button disabled={busy || !message.trim()} onClick={() => continueWith({ message }, files)} className={`${buttonClass} bg-primary-600 text-white hover:bg-primary-700`}><Send className="h-4 w-4" />Send</button></div>
          </div>
        </section>}
      </aside>
    </div>
  </div>;
}

export default function GoalsPage() { const { goalId } = useParams(); return goalId ? <GoalDetails goalId={goalId} /> : <GoalList />; }
