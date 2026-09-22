import { PreviewThumbnails } from '../components/PreviewMedia';
/* eslint-disable max-lines -- goal list and split-pane console intentionally share this route-level surface */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, Navigate, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  Activity, CheckCircle2, CircleDot, CirclePause, CirclePlay, CircleStop, Clock3,
  Coins, ExternalLink, FileText, Filter, GitPullRequest, Github, ListTodo, LoaderCircle, Plus, Send,
  MoreHorizontal, Terminal, Trash2, X,
} from 'lucide-react';
import {
  cancelGoal, deleteGoal, getGoal, getGoalCapabilities, getGoalVisualPreviews, listGoals, pauseGoal,
  requestGoalModel, resumeGoal, sendGoalInput,
  getGoalAttachmentUrl,
  type Goal, type GoalVisualPreview,
} from '../api/goals';
import { goalPath } from '../components/Goals/goalPaths';
import { GoalLauncherForm } from '../components/Goals/GoalLauncher';
import { addGoalFiles, buttonClass } from '../components/Goals/goalLauncherUtils';
import { useTaskLiveData } from '../components/TaskDetails/useTaskLiveData';
import TodoList from '../components/TaskDetails/TodoList';
import ExecutionEventLog from '../components/TaskDetails/ExecutionEventLog';
import ThinkingLog from '../components/TaskDetails/ThinkingLog';
import { useThinkingLog } from '../components/TaskDetails/useThinkingLog';
import { RepositorySelector, type RepoOption } from '../components/RepositorySelector';
import { ProviderLogo } from '../components/ui/ProviderLogo';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { formatAgentLabel } from '../utils/agentStatus';
import { getModelDisplayName } from '../utils/modelDisplay';
import { GoalAttachmentInput } from '../components/Goals/GoalAttachmentInput';
import { clipboardImageFiles } from '../components/Goals/goalAttachmentUtils';
import { useDemoMode } from '../contexts/DemoModeContext';

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

function GoalState({ goal, quietCompleted = false }: { goal: Goal; quietCompleted?: boolean }) {
  const state = goal.resultState || (goal.desiredState === 'cancelled' ? 'cancelling' : goal.desiredState);
  if (quietCompleted && state === 'completed') {
    return <span className="inline-flex items-center gap-1.5 text-sm font-medium text-slate-500">
      <CheckCircle2 className="h-4 w-4" />
      Completed
    </span>;
  }
  const color = state === 'completed' ? 'bg-green-100 text-green-800' : state === 'failed' || state === 'cancelled' ? 'bg-red-100 text-red-800' : state === 'paused' || state === 'cancelling' ? 'bg-amber-100 text-amber-800' : 'bg-blue-100 text-blue-800';
  return <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold capitalize ${color}`}>
    {state === 'running' && <LoaderCircle className="h-3.5 w-3.5 animate-spin" />}
    {state}
  </span>;
}

function CheckpointDeclaration({ checkpoint }: { checkpoint: NonNullable<Goal['checkpoint']> }) {
  const latest = checkpoint.latest;
  if (!latest || latest.kind !== 'agent') return null;
  const badgeClass = latest.state === 'completed'
    ? 'bg-green-100 text-green-800'
    : latest.state === 'rejected' || latest.state === 'failed'
      ? 'bg-red-100 text-red-800'
      : 'bg-amber-100 text-amber-800';
  const paths = (label: string, values: string[] | null) => values && <div>
    <dt className="text-[10px] font-bold uppercase tracking-widest text-slate-500">{label}</dt>
    <dd className="mt-1 flex flex-wrap gap-1.5">{values.map(value => <code key={value} className="rounded border border-slate-200 bg-white px-1.5 py-0.5 font-mono text-[12px] text-slate-700">{value}</code>)}</dd>
  </div>;
  return <section aria-label="Latest checkpoint declaration" className="mt-3 border-t border-blue-200 pt-3 text-slate-800">
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
      <GoalLauncherForm onCancel={requestClose} onCreated={onCreated} onDirtyChange={setDirty} onSubmittingChange={setSubmitting} />
    </div>
  </div>;
}

function GoalQueueRow({ goal, goalAgents }: { goal: Goal; goalAgents: Array<{ type: string; alias: string }> }) {
  const activity = goal.liveSummary.currentTask
    || goal.liveSummary.todos.find(todo => todo.status === 'in_progress')?.content
    || goal.taskState;
  const openTodos = goal.liveSummary.todos.filter(todo => todo.status !== 'completed').length;
  const tokens = goal.liveSummary.nativeGoal?.tokensUsed ?? tokenTotal(goal.liveSummary.tokenUsage);
  const activeMs = goal.liveSummary.nativeGoal ? goal.liveSummary.nativeGoal.timeUsedSeconds * 1000 : goal.activeMs;
  return <li className="border-b border-slate-200 last:border-b-0">
    <Link to={`/goals/${goal.id}`} className="grid min-w-0 grid-cols-2 gap-x-4 gap-y-4 px-4 py-4 transition-colors hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary-500 sm:px-5 xl:grid-cols-[minmax(240px,2fr)_120px_minmax(140px,1fr)_minmax(180px,1.4fr)_160px] xl:items-center xl:gap-x-5 xl:gap-y-0 xl:py-3.5">
      <div className="col-span-2 min-w-0 xl:col-span-1">
        <h3 className="line-clamp-2 font-semibold leading-5 text-slate-900" title={goal.title}>{goal.title}</h3>
        <p className="mt-1 line-clamp-2 text-sm leading-5 text-slate-500" title={goal.objective}>{goal.objective}</p>
        <PreviewThumbnails media={goal.previewMedia} />
      </div>
      <div className="min-w-0">
        <span className="mb-1.5 block text-[10px] font-bold uppercase tracking-wider text-slate-400 xl:hidden">Status</span>
        <GoalState goal={goal} />
        <span className="mt-2 flex min-w-0 items-center gap-1.5 text-xs text-slate-500">
          <ProviderLogo provider={goal.agent.type} className="h-3.5 w-3.5 flex-none" />
          <span className="truncate">{formatAgentLabel(goal.agent, goalAgents)}</span>
        </span>
        <span className="mt-0.5 block truncate text-xs text-slate-500" title={getModelDisplayName(goal.requestedModel)}>{getModelDisplayName(goal.requestedModel)}</span>
      </div>
      <div className="min-w-0">
        <span className="mb-1.5 block text-[10px] font-bold uppercase tracking-wider text-slate-400 xl:hidden">Repository</span>
        <span className="flex min-w-0 items-center gap-1.5 text-sm text-slate-700"><Github className="h-3.5 w-3.5 flex-none text-slate-400" /><span className="truncate" title={goal.repository}>{goal.repository}</span></span>
      </div>
      <div className="col-span-2 min-w-0 xl:col-span-1">
        <span className="mb-1.5 block text-[10px] font-bold uppercase tracking-wider text-slate-400 xl:hidden">Current activity</span>
        <span className="flex min-w-0 items-start gap-1.5 text-sm text-slate-700"><Activity className="mt-0.5 h-3.5 w-3.5 flex-none text-blue-500" /><span className="line-clamp-2" title={activity}>{activity}</span></span>
        {goal.liveSummary.todos.length > 0 && <span className="mt-1 flex items-center gap-1.5 text-xs text-slate-500"><ListTodo className="h-3.5 w-3.5" />{openTodos} open of {goal.liveSummary.todos.length} steps</span>}
      </div>
      <div className="col-span-2 min-w-0 xl:col-span-1">
        <span className="mb-1.5 block text-[10px] font-bold uppercase tracking-wider text-slate-400 xl:hidden">Usage</span>
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-600">
          <span className="inline-flex items-center gap-1"><Coins className="h-3.5 w-3.5 text-amber-500" />{tokens.toLocaleString()} tokens</span>
          <span className="inline-flex items-center gap-1"><Clock3 className="h-3.5 w-3.5 text-indigo-500" />{duration(activeMs)} active</span>
        </span>
        <span className="mt-1.5 flex flex-wrap gap-x-2 gap-y-1 text-xs text-slate-500">
          <span className="inline-flex items-center gap-1"><CircleDot className="h-3.5 w-3.5" />{goal.artifactStats.openIssues}/{goal.artifactStats.issues} open issues</span>
          <span className="inline-flex items-center gap-1"><GitPullRequest className="h-3.5 w-3.5" />{goal.artifactStats.openPullRequests}/{goal.artifactStats.pullRequests} open PRs</span>
        </span>
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
  // Global "New goal" entry points open the creator directly via ?new=1.
  const [isCreating, setIsCreating] = useState(() => searchParams.get('new') === '1');
  const requestGenerationRef = useRef(0);
  const repositoryFilter = searchParams.get('repository') || 'all';
  useDocumentTitle('Goals');
  const refresh = useCallback(async (initial = false) => {
    const generation = ++requestGenerationRef.current;
    if (initial) setInitialLoading(true);
    else setRefreshing(true);
    setError(null);
    try {
      const data = await listGoals('goal');
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
  const visibleGoals = repositoryFilter === 'all'
    ? goals
    : goals.filter(goal => goal.repository === repositoryFilter);
  const setRepositoryFilter = useCallback((repository: string) => {
    setSearchParams(current => {
      const next = new URLSearchParams(current);
      if (repository === 'all') next.delete('repository');
      else next.set('repository', repository);
      return next;
    }, { replace: true });
  }, [setSearchParams]);
  const goalAgents = goals.map(goal => ({ type: goal.agent.type, alias: goal.agent.alias }));
  const closeCreator = useCallback(() => {
    setIsCreating(false);
    setSearchParams(current => {
      if (!current.has('new')) return current;
      const next = new URLSearchParams(current);
      next.delete('new');
      return next;
    }, { replace: true });
    newGoalButtonRef.current?.focus();
  }, [setSearchParams]);
  const openCreator = useCallback(() => setIsCreating(true), []);
  const requestedCreator = searchParams.get('new') === '1';
  useEffect(() => { if (requestedCreator) setIsCreating(true); }, [requestedCreator]);
  return <div className="min-h-full w-full min-w-0 bg-white p-4 sm:p-6">
    <div className="border-b border-slate-200 pb-5">
      <div><h1 className="text-2xl font-bold text-slate-900">Goals</h1><p className="mt-1 text-sm text-slate-600">Long-running work kept in one exact coding-agent session.</p></div>
    </div>
    {error && <p role="alert" className="mt-4 border-l-2 border-red-500 bg-red-50 p-3 text-sm text-red-700">{error}</p>}
    <section aria-labelledby="goal-work-queue-title" className="mt-5">
      <div className="flex flex-col gap-3 pb-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-baseline gap-2"><h2 id="goal-work-queue-title" className="text-base font-semibold text-slate-900">Work queue</h2>{hasSuccessfulRead && <span className="text-xs text-slate-500">{visibleGoals.length} of {goals.length}</span>}{refreshing && hasSuccessfulRead && <span role="status" className="text-xs text-slate-500">Refreshing…</span>}</div>
        <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center">
          {goals.length > 0 && <div role="group" aria-label="Filter goals by repository" className="flex min-w-0 items-center gap-2">
            <Filter className="h-4 w-4 flex-none text-slate-400" aria-hidden="true" />
            <RepositorySelector
              repos={repositoryOptions}
              selectedRepo={repositoryFilter}
              onRepoChange={setRepositoryFilter}
              labelLayout="stacked"
              className="min-w-0 flex-1 sm:w-[240px] sm:flex-none"
            />
          </div>}
          <button ref={newGoalButtonRef} type="button" onClick={openCreator} className={`${buttonClass} min-h-10 justify-center bg-primary-600 text-white hover:bg-primary-700`}><Plus className="h-4 w-4" />New goal</button>
        </div>
      </div>
      {!hasSuccessfulRead && (initialLoading || refreshing)
        ? <div role="status" className="flex items-center justify-center gap-2 border-y border-slate-200 py-10 text-sm text-slate-500"><LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />Loading goals…</div>
        : error && goals.length === 0
          ? null
          : goals.length === 0
        ? <div className="border-y border-dashed border-slate-300 py-10 text-center"><p className="text-sm font-medium text-slate-700">No goals yet</p><p className="mt-1 text-sm text-slate-500">Start a goal to add dedicated agent work to this queue.</p></div>
        : visibleGoals.length === 0
          ? <div className="border-y border-dashed border-slate-300 py-10 text-center"><p className="text-sm font-medium text-slate-700">No goals in {repositoryFilter}</p><button type="button" onClick={() => setRepositoryFilter('all')} className="mt-2 text-sm font-medium text-primary-700 hover:underline">Show all goals</button></div>
          : <div className="border-y border-slate-200 bg-white">
            <div aria-hidden="true" className="hidden grid-cols-[minmax(240px,2fr)_120px_minmax(140px,1fr)_minmax(180px,1.4fr)_160px] gap-x-5 border-b border-slate-200 bg-slate-50 px-5 py-2 text-[10px] font-bold uppercase tracking-wider text-slate-500 xl:grid">
              <span>Goal</span><span>Status / runtime</span><span>Repository</span><span>Current activity</span><span>Usage</span>
            </div>
            <ul aria-label="Goal work queue">{visibleGoals.map(goal => <GoalQueueRow key={goal.id} goal={goal} goalAgents={goalAgents} />)}</ul>
          </div>}
    </section>
    <CreateGoalDialog isOpen={isCreating} onClose={closeCreator} onCreated={goal => navigate(goalPath(goal))} />
  </div>;
}

// The detail surface intentionally composes all goal controls and existing task projections.
/** One-off tasks reuse the goal console, presented with task wording and task navigation. */
export type GoalPresentation = 'goal' | 'task';

// eslint-disable-next-line complexity
function GoalDetails({ goalId, presentation = 'goal' }: { goalId: string; presentation?: GoalPresentation }) {
  const isTask = presentation === 'task';
  const noun = isTask ? 'task' : 'goal';
  const Noun = isTask ? 'Task' : 'Goal';
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
  useDocumentTitle(goal?.title || Noun);

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
      .then(data => { if (active && !data.unavailable) setVisualPreviews(data.previews); })
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
    if (!goal || isDemoMode || !window.confirm(`Delete this ${noun}? If it is running, it will be stopped first. This action cannot be undone.`)) return;
    setBusy(true); setError(null);
    try {
      await deleteGoal(goal.id);
      navigate(isTask ? '/tasks' : '/goals', { replace: true });
    } catch (err) { setError((err as Error).message); setBusy(false); }
  };
  const totalTokens = useMemo(
    () => tokenTotal(live.tokenUsage || null) || goal?.liveSummary.nativeGoal?.tokensUsed || 0,
    [goal?.liveSummary.nativeGoal?.tokensUsed, live.tokenUsage],
  );
  if (!goal) return <div className="p-6 text-slate-600">{error || `Loading ${noun}…`}</div>;
  // Keep each item under the concept it was started as, whichever URL was followed.
  if ((goal.kind === 'task') !== isTask) return <Navigate to={goalPath(goal)} replace />;
  const terminal = Boolean(goal.resultState);
  const cancelling = !terminal && goal.desiredState === 'cancelled';
  const mutable = !terminal && !cancelling;
  const canMutate = mutable && !isDemoMode;
  const strategyLabel = goal.launchStrategy === 'direct' ? 'Direct' : 'ProPR orchestrated';
  const currentModel = getModelDisplayName(goal.effectiveModel || goal.requestedModel);
  return <div className="min-h-full bg-white text-slate-900">
    <header className="w-full border-b border-slate-200 px-4 py-3 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-7xl">
        <div className="flex items-center gap-4">
          <Link to={isTask ? '/tasks' : '/goals'} className="text-sm font-medium text-slate-600 transition hover:text-primary-700">{isTask ? '← All tasks' : '← All goals'}</Link>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-bold tracking-tight text-slate-950 sm:text-3xl">{goal.title}</h1>
          <GoalState goal={goal} quietCompleted />
        </div>
        <div className="mt-2 flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-2 text-sm text-slate-700">
            <span className="text-[10px] font-bold uppercase tracking-widest text-slate-500">{isTask ? 'Type' : 'Strategy'}</span>
            <span className="font-medium">{isTask ? 'Direct task' : strategyLabel}</span>
            <span aria-hidden="true" className="text-slate-300">•</span>
            <span className="text-[10px] font-bold uppercase tracking-widest text-slate-500">Model</span>
            <code className="rounded bg-slate-100 px-2 py-1 font-mono text-xs font-semibold text-slate-700">{currentModel}</code>
            <span aria-hidden="true" className="text-slate-300">•</span>
            <span className="text-[10px] font-bold uppercase tracking-widest text-slate-500">Elapsed</span>
            <span className="font-mono text-xs font-semibold text-slate-700">{duration(goal.elapsedMs)}</span>
            <span aria-hidden="true" className="hidden text-slate-300 sm:inline">•</span>
            <span className="text-xs text-slate-500">{goal.repository} · {goal.agent.alias}</span>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2">
            {goal.desiredState === 'running' && canMutate && <button disabled={busy} onClick={() => act(() => pauseGoal(goal.id))} className={`${buttonClass} border border-amber-300 text-amber-800 hover:bg-amber-50`}><CirclePause className="h-4 w-4" />Pause</button>}
            {goal.desiredState === 'paused' && canMutate && <button disabled={busy} onClick={() => act(() => resumeGoal(goal.id))} className={`${buttonClass} border border-green-300 text-green-800 hover:bg-green-50`}><CirclePlay className="h-4 w-4" />{goal.pausePending ? 'Resume after safe boundary' : 'Resume'}</button>}
            {canMutate && <button disabled={busy} onClick={() => act(() => cancelGoal(goal.id))} className={`${buttonClass} border border-red-300 text-red-700 hover:bg-red-50`}><CircleStop className="h-4 w-4" />Cancel</button>}
            {goal.finalPr && <a href={goal.finalPr.url} target="_blank" rel="noreferrer" className={`${buttonClass} bg-primary-600 text-white shadow-sm hover:bg-primary-700`}><GitPullRequest className="h-4 w-4" />{goal.launchStrategy === 'direct' ? 'Open draft PR' : 'Review final PR'} <ExternalLink className="h-3.5 w-3.5" /></a>}
            <details className="group relative">
              <summary aria-label={`More ${noun} actions`} className="flex h-9 w-9 cursor-pointer list-none items-center justify-center rounded-md border border-slate-300 text-slate-600 transition hover:bg-slate-50 [&::-webkit-details-marker]:hidden"><MoreHorizontal className="h-4 w-4" /></summary>
              <div className="absolute right-0 z-20 mt-2 w-48 overflow-hidden rounded-md border border-slate-200 bg-white py-1 shadow-lg">
                <Link to={`/tasks/${encodeURIComponent(goal.taskId)}`} className="block px-3 py-2 text-sm text-slate-700 hover:bg-slate-50">Open task history</Link>
                {!isDemoMode && <button disabled={busy} onClick={remove} className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-red-700 hover:bg-red-50 disabled:opacity-50"><Trash2 className="h-4 w-4" />Delete {noun}</button>}
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
      <main aria-label={`${Noun} monitor`} className="min-w-0 bg-white px-4 py-6 sm:px-6 lg:px-8">
        <section aria-labelledby="goal-context-heading">
          <h2 id="goal-context-heading" className="text-[10px] font-bold uppercase tracking-widest text-slate-500">Context</h2>
          <details className="group border-b border-slate-200 py-4 text-sm" open>
            <summary className="cursor-pointer font-semibold text-slate-800">{isTask ? 'Task instruction' : 'Goal description'}</summary>
            <p className="mt-3 whitespace-pre-wrap break-words leading-6 text-slate-600">{goal.objective}</p>
          </details>
          {(goal.attachments || []).length > 0 && <div className="border-b border-slate-200 py-4 text-sm">
            <h3 className="font-semibold text-slate-800">Files shared with this {noun}</h3>
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

        {goal.checkpoint && <section className="mb-6 mt-3 bg-blue-50 p-4 text-sm text-blue-950">
          <div className="flex items-start gap-3">
            <CircleDot className="mt-0.5 h-4 w-4 flex-none text-blue-600" />
            <div className="min-w-0">
              <p className="font-medium">{goal.checkpoint.count} checkpoint commit{goal.checkpoint.count === 1 ? '' : 's'}{goal.checkpoint.lastAt ? ` · last ${new Date(goal.checkpoint.lastAt).toLocaleString()}` : ''}</p>
              <p className="mt-1 text-blue-800">Target cadence: about every {goal.checkpoint.intervalMinutes || 15} minutes. <span className="text-xs">The agent declares when coherent work is ready.</span></p>
              {goal.checkpoint.error && !goal.checkpoint.latest?.error && <p className="mt-2 text-red-700">Checkpoint error: {goal.checkpoint.error}</p>}
              <CheckpointDeclaration checkpoint={goal.checkpoint} />
            </div>
          </div>
        </section>}

        {visualPreviews.length > 0 && <section aria-labelledby="goal-visual-previews-heading" className="my-6 border-y border-slate-200 py-5">
          <div className="flex items-end justify-between gap-3">
            <div>
              <h2 id="goal-visual-previews-heading" className="font-semibold text-slate-900">Visual previews</h2>
              <p className="mt-0.5 text-xs text-slate-500">Current evidence published on the {noun} PR.</p>
            </div>
            <span className="text-xs text-slate-400">From GitHub</span>
          </div>
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            {visualPreviews.map((preview, index) => <figure key={`${preview.url}-${index}`} className="overflow-hidden rounded-lg border border-slate-200 bg-slate-50">
              {preview.type === 'image'
                ? <img src={preview.url} alt={preview.title} loading="lazy" className="aspect-video w-full bg-white object-contain" />
                : <video src={preview.url} aria-label={preview.title} controls preload="metadata" className="aspect-video w-full bg-slate-950 object-contain" />}
              <figcaption className="border-t border-slate-200 px-3 py-2.5">
                <p className="text-sm font-medium text-slate-800">{preview.title}</p>
                {preview.description && <p className="mt-1 text-xs leading-5 text-slate-500">{preview.description}</p>}
              </figcaption>
            </figure>)}
          </div>
        </section>}

        {goal.artifacts.length > 0 && <div className="my-5 flex flex-wrap gap-2 text-xs text-slate-600">{goal.artifacts.map((artifact, index) => { const item = artifact as { type?: string; number?: number; url?: string }; return item.url ? <a key={item.url} href={item.url} target="_blank" rel="noreferrer" className="rounded bg-slate-100 px-2 py-1 hover:underline">{item.type === 'pull_request' ? 'PR' : 'Issue'} #{item.number}</a> : <span key={index} />; })}</div>}

        <section aria-labelledby="live-progress-heading" className="mt-6">
          <div className="flex items-center gap-2">
            <h2 id="live-progress-heading" className="text-[11px] font-bold uppercase tracking-widest text-slate-500">Execution queue</h2>
            {mutable && goal.desiredState === 'running' && <span className="relative flex h-2 w-2"><span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-blue-400 opacity-75" /><span className="relative inline-flex h-2 w-2 rounded-full bg-blue-500" /></span>}
          </div>
          {live.todos.length ? <div className="[&>div]:border-t-0 [&>div]:pt-3 [&>div>h4]:hidden"><TodoList liveDetails={live} history={[{ state: goal.taskState }]} /></div> : <p className="mt-3 text-sm text-slate-500">No provider todos yet.</p>}
        </section>

        <section className="mt-8 border-t border-slate-200 pt-5">
          <header className="flex items-center justify-between gap-3">
            <h2 className="text-[10px] font-bold uppercase tracking-widest text-slate-500">{Noun} output</h2>
            <div role="group" aria-label={`${Noun} output view`} className="inline-flex rounded-md border border-slate-200 bg-slate-50 p-1">
              <button type="button" aria-pressed={outputMode === 'readable'} onClick={() => setOutputMode('readable')} className={`inline-flex items-center gap-1.5 rounded px-2.5 py-1.5 text-xs font-medium transition ${outputMode === 'readable' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}><FileText className="h-3.5 w-3.5" />Human readable</button>
              <button type="button" aria-pressed={outputMode === 'terminal'} onClick={() => setOutputMode('terminal')} className={`inline-flex items-center gap-1.5 rounded px-2.5 py-1.5 text-xs font-medium transition ${outputMode === 'terminal' ? 'bg-slate-800 text-white shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}><Terminal className="h-3.5 w-3.5" />Raw terminal</button>
            </div>
          </header>
          {outputMode === 'readable'
            ? <div className="min-h-32 py-4">{thinkingLog.thinkingLogWithTimestamps.length > 0
              ? <ThinkingLog events={thinkingLog.thinkingLogWithTimestamps} todos={live.todos} />
              : <p className="text-sm text-slate-500">No human-readable output yet.</p>}</div>
            : <div className="mt-4 min-h-32 bg-slate-950 p-4 text-slate-100">{live.events.length > 0
              ? <ExecutionEventLog events={live.events} collapsed={false} onToggleCollapse={() => undefined} lastThought={thinkingLog.lastThought} isTaskActive={mutable && goal.desiredState === 'running'} taskInfo={null} />
              : <p className="text-sm text-slate-400">No terminal output yet.</p>}</div>}
        </section>
      </main>

      <aside aria-label="Steering console" className="flex min-w-0 flex-col border-t border-slate-200 bg-slate-50 px-4 py-6 sm:px-6 lg:border-l lg:border-t-0">
        <section aria-labelledby="goal-metrics-heading">
          <h2 id="goal-metrics-heading" className="text-[10px] font-bold uppercase tracking-widest text-slate-500">Metrics</h2>
          <dl className="mt-3 grid grid-cols-2 border-y border-slate-200">
            <div className="border-b border-r border-slate-200 py-4 pr-4"><dt className="text-[10px] font-bold uppercase tracking-widest text-slate-500">Usage</dt><dd className="mt-1 text-2xl font-bold tracking-tight text-slate-950">{totalTokens.toLocaleString()}</dd><dd className="text-xs text-slate-500">tokens</dd>{goal.liveSummary.nativeGoal && <dd className="mt-1 text-xs text-slate-500">{goal.liveSummary.nativeGoal.status} · {duration(goal.liveSummary.nativeGoal.timeUsedSeconds * 1000)}</dd>}</div>
            <div className="border-b border-slate-200 py-4 pl-4"><dt className="text-[10px] font-bold uppercase tracking-widest text-slate-500">Session</dt><dd className="mt-2 break-all"><code className="rounded bg-white px-2 py-1 font-mono text-xs text-slate-700 shadow-sm">{goal.sessionId || 'Waiting for provider identity'}</code></dd></div>
            <div className="border-r border-slate-200 py-4 pr-4"><dt className="text-[10px] font-bold uppercase tracking-widest text-slate-500">Active</dt><dd className="mt-1 font-mono text-sm font-semibold text-slate-800">{duration(goal.activeMs)}</dd><dd className="mt-1 text-xs text-slate-500">{duration(goal.pausedMs)} paused</dd></div>
            <div className="py-4 pl-4"><dt className="text-[10px] font-bold uppercase tracking-widest text-slate-500">Artifacts</dt><dd className="mt-1 text-sm font-semibold text-slate-800">{goal.artifactStats.openPullRequests}/{goal.artifactStats.pullRequests} PRs</dd><dd className="mt-1 text-xs text-slate-500">{goal.artifactStats.openIssues}/{goal.artifactStats.issues} open issues</dd></div>
          </dl>
        </section>

        {canMutate && <section aria-labelledby="quick-actions-heading" className="mt-7">
          <h2 id="quick-actions-heading" className="text-[10px] font-bold uppercase tracking-widest text-slate-500">Quick actions</h2>
          <div className="mt-3 flex flex-wrap gap-2"><button disabled={busy} onClick={() => continueWith({ canned: 'done' })} className={`${buttonClass} border border-slate-200 bg-white text-slate-700 shadow-sm hover:border-slate-300 hover:bg-slate-50`}>What's done?</button><button disabled={busy} onClick={() => continueWith({ canned: 'left' })} className={`${buttonClass} border border-slate-200 bg-white text-slate-700 shadow-sm hover:border-slate-300 hover:bg-slate-50`}>What's left?</button></div>
        </section>}

        {canMutate ? <section aria-labelledby="correction-heading" className="sticky bottom-0 mt-auto pt-10">
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
        </section> : <section aria-label="Correction command bar" className="sticky bottom-0 mt-auto pt-10">
          <input
            aria-label="Correction or follow-up"
            type="text"
            disabled
            className="w-full cursor-not-allowed rounded-md border border-slate-200 bg-slate-100 px-3 py-3 text-sm text-slate-500 shadow-sm placeholder:text-slate-500 disabled:opacity-100"
            placeholder={isDemoMode && mutable ? 'Demo mode is read-only. Corrections disabled.' : goal.resultState === 'completed' ? `${Noun} completed. Corrections disabled.` : `${Noun} closed. Corrections disabled.`}
          />
        </section>}
      </aside>
    </div>
  </div>;
}

export default function GoalsPage({ presentation = 'goal' }: { presentation?: GoalPresentation }) {
  const { goalId } = useParams();
  if (goalId) return <GoalDetails key={goalId} goalId={goalId} presentation={presentation} />;
  return presentation === 'task' ? <Navigate to="/tasks" replace /> : <GoalList />;
}
