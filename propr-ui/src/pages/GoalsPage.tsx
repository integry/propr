import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { CirclePause, CirclePlay, CircleStop, ExternalLink, GitCommit, Plus, Send } from 'lucide-react';
import { getInstanceCatalog } from '../api/proprApi';
import type { InstanceCatalogRepository } from '../api/proprTypes';
import {
  cancelGoal, checkpointGoal, createGoal, getGoal, getGoalCapabilities, listGoals, pauseGoal,
  requestGoalCheckpointInterval, requestGoalModel, resumeGoal, sendGoalInput,
  type Goal, type GoalCapability, type GoalLaunchStrategy,
} from '../api/goals';
import { useTaskLiveData } from '../components/TaskDetails/useTaskLiveData';
import TodoList from '../components/TaskDetails/TodoList';
import RealTimeStats from '../components/TaskDetails/RealTimeStats';
import ExecutionEventLog from '../components/TaskDetails/ExecutionEventLog';
import { useDocumentTitle } from '../hooks/useDocumentTitle';

const buttonClass = 'inline-flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50';
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

function GoalState({ goal }: { goal: Goal }) {
  const state = goal.resultState || (goal.desiredState === 'cancelled' ? 'cancelling' : goal.desiredState);
  const color = state === 'completed' ? 'bg-green-100 text-green-800' : state === 'failed' || state === 'cancelled' ? 'bg-red-100 text-red-800' : state === 'paused' || state === 'cancelling' ? 'bg-amber-100 text-amber-800' : 'bg-blue-100 text-blue-800';
  return <span className={`rounded-full px-2.5 py-1 text-xs font-semibold capitalize ${color}`}>{state}</span>;
}

function CreateGoalForm({ onCreated }: { onCreated: (goal: Goal) => void }) {
  const [repositories, setRepositories] = useState<InstanceCatalogRepository[]>([]);
  const [agents, setAgents] = useState<GoalCapability[]>([]);
  const [repository, setRepository] = useState('');
  const [agentId, setAgentId] = useState('');
  const [model, setModel] = useState('');
  const [objective, setObjective] = useState('');
  const [launchStrategy, setLaunchStrategy] = useState<GoalLaunchStrategy>('direct');
  const [parallelism, setParallelism] = useState('');
  const [ultrafix, setUltrafix] = useState(false);
  const [checkpointInterval, setCheckpointInterval] = useState('15');
  const [submitting, setSubmitting] = useState(false);
  const [rechecking, setRechecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selectedAgent = agents.find(agent => agent.agentId === agentId);
  const unsupportedAgents = agents.filter(agent => !agent.goalCapable);
  const showRuntimeDiagnostics = agents.length > 0 && unsupportedAgents.length === agents.length;

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
      setRepository(catalog.repositories[0]?.name || '');
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
    setSubmitting(true);
    setError(null);
    try {
      const result = await createGoal({
        repository, agentId, model, objective, launchStrategy,
        ...(parallelism ? { maxParallelTasks: Number(parallelism) } : {}),
        ...(launchStrategy === 'direct' ? { checkpointIntervalMinutes: Number(checkpointInterval) } : {}),
        ultrafix,
      });
      onCreated(result.goal);
    } catch (err) { setError((err as Error).message); }
    finally { setSubmitting(false); }
  };

  return (
    <form onSubmit={submit} className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
      <h2 className="mb-4 flex items-center gap-2 text-lg font-semibold"><Plus className="h-5 w-5" /> Start a goal</h2>
      {error && <p role="alert" className="mb-3 text-sm text-red-600">{error}</p>}
      {showRuntimeDiagnostics && <div className="mb-3 rounded bg-amber-50 p-3 text-sm text-amber-800">
        <p>No configured coding-agent runtime currently supports goals.</p>
        <ul className="mt-2 list-disc space-y-1 pl-5">
          {unsupportedAgents.map(agent => <li key={agent.agentId}><span className="font-medium">{agent.agentAlias}:</span> {agent.reason || 'Required goal/session transport is unavailable'}</li>)}
        </ul>
        <button type="button" disabled={rechecking} onClick={recheckCapabilities} className="mt-2 font-medium underline disabled:opacity-50">{rechecking ? 'Rechecking…' : 'Recheck runtimes'}</button>
      </div>}
      <div className="grid gap-4 md:grid-cols-2">
        <label className="text-sm font-medium text-slate-700">Repository
          <select aria-label="Repository" value={repository} onChange={event => setRepository(event.target.value)} className="mt-1 w-full rounded-md border border-slate-300 p-2" required>
            {repositories.map(repo => <option key={repo.name} value={repo.name}>{repo.alias || repo.name}</option>)}
          </select>
        </label>
        <label className="text-sm font-medium text-slate-700">Coding agent
          <select aria-label="Coding agent" value={agentId} onChange={event => setAgentId(event.target.value)} className="mt-1 w-full rounded-md border border-slate-300 p-2" required>
            {agents.map(agent => <option key={agent.agentId} value={agent.agentId} disabled={!agent.goalCapable}>{agent.agentAlias}{agent.goalCapable ? '' : ' — unsupported'}</option>)}
          </select>
        </label>
        <label className="text-sm font-medium text-slate-700">Model
          <select aria-label="Model" value={model} onChange={event => setModel(event.target.value)} className="mt-1 w-full rounded-md border border-slate-300 p-2" required>
            {(selectedAgent?.models || []).map(item => <option key={item} value={item}>{item}</option>)}
          </select>
        </label>
        <label className="text-sm font-medium text-slate-700">Maximum parallel tasks (optional)
          <input aria-label="Maximum parallel tasks" type="number" min="1" max="32" value={parallelism} onChange={event => setParallelism(event.target.value)} className="mt-1 w-full rounded-md border border-slate-300 p-2" />
        </label>
      </div>
      <fieldset className="mt-4">
        <legend className="text-sm font-medium text-slate-700">Goal launch strategy</legend>
        <div className="mt-2 grid gap-3 md:grid-cols-2">
          <label className="flex cursor-pointer gap-3 rounded-md border border-slate-200 p-3 text-sm text-slate-700"><input aria-label="Agent implements directly" type="radio" name="launch-strategy" value="direct" checked={launchStrategy === 'direct'} onChange={() => setLaunchStrategy('direct')} /><span><strong className="block text-slate-900">Agent implements directly</strong>ProPR opens the draft PR before work begins and safely commits the agent's changes at checkpoints.</span></label>
          <label className="flex cursor-pointer gap-3 rounded-md border border-slate-200 p-3 text-sm text-slate-700"><input aria-label="Agent orchestrates through ProPR" type="radio" name="launch-strategy" value="orchestrate" checked={launchStrategy === 'orchestrate'} onChange={() => setLaunchStrategy('orchestrate')} /><span><strong className="block text-slate-900">Agent orchestrates through ProPR</strong>The agent owns decomposition, creates issues, and starts and monitors their implementation through ProPR.</span></label>
        </div>
      </fieldset>
      {launchStrategy === 'direct' && <label className="mt-4 block text-sm font-medium text-slate-700">Checkpoint frequency (minutes)
        <input aria-label="Checkpoint frequency" type="number" min="5" max="120" step="1" value={checkpointInterval} onChange={event => setCheckpointInterval(event.target.value)} className="mt-1 w-full rounded-md border border-slate-300 p-2 md:w-48" required />
        <span className="mt-1 block text-xs font-normal text-slate-500">Automatic commits run at safe provider-turn boundaries, from 5 to 120 minutes.</span>
      </label>}
      <label className="mt-4 block text-sm font-medium text-slate-700">Objective
        <textarea aria-label="Objective" value={objective} onChange={event => setObjective(event.target.value)} rows={5} className="mt-1 w-full rounded-md border border-slate-300 p-2" required />
      </label>
      <label className="mt-3 flex items-center gap-2 text-sm text-slate-700"><input type="checkbox" checked={ultrafix} onChange={event => setUltrafix(event.target.checked)} /> Ask the coding agent to use Ultrafix</label>
      <button type="submit" disabled={submitting || !repository || !agentId || !model || !objective.trim() || !selectedAgent?.goalCapable} className={`${buttonClass} mt-4 bg-primary-600 text-white hover:bg-primary-700`}>{submitting ? 'Starting…' : 'Start goal'}</button>
    </form>
  );
}

function GoalList() {
  const navigate = useNavigate();
  const [goals, setGoals] = useState<Goal[]>([]);
  const [error, setError] = useState<string | null>(null);
  useDocumentTitle('Goals');
  const refresh = useCallback(() => listGoals().then(data => setGoals(data.goals)).catch(err => setError((err as Error).message)), []);
  useEffect(() => { refresh(); const timer = window.setInterval(refresh, 10_000); return () => window.clearInterval(timer); }, [refresh]);
  return <div className="mx-auto max-w-5xl space-y-6 p-4 sm:p-6">
    <div><h1 className="text-2xl font-bold text-slate-900">Goals</h1><p className="mt-1 text-sm text-slate-600">Long-running work kept in one exact coding-agent session.</p></div>
    <CreateGoalForm onCreated={goal => navigate(`/goals/${goal.id}`)} />
    {error && <p role="alert" className="text-red-600">{error}</p>}
    <section className="space-y-3"><h2 className="text-lg font-semibold">Your goals</h2>
      {goals.length === 0 ? <p className="rounded-lg border border-dashed p-8 text-center text-sm text-slate-500">No goals yet.</p> : goals.map(goal => <Link key={goal.id} to={`/goals/${goal.id}`} className="block rounded-lg border border-slate-200 bg-white p-4 hover:border-primary-300">
        <div className="flex items-start justify-between gap-4"><div><div className="font-semibold text-slate-900">{goal.objective}</div><div className="mt-1 text-sm text-slate-500">{goal.repository} · {goal.agent.alias} · {goal.requestedModel}</div></div><GoalState goal={goal} /></div>
        <div className="mt-3 grid gap-2 text-xs text-slate-600 sm:grid-cols-3"><span>Current: {goal.liveSummary.currentTask || goal.taskState}</span><span>{(goal.liveSummary.nativeGoal?.tokensUsed ?? tokenTotal(goal.liveSummary.tokenUsage)).toLocaleString()} tokens · {duration(goal.liveSummary.nativeGoal ? goal.liveSummary.nativeGoal.timeUsedSeconds * 1000 : goal.activeMs)} active</span><span>{goal.artifactStats.openIssues}/{goal.artifactStats.issues} open issues · {goal.artifactStats.openPullRequests}/{goal.artifactStats.pullRequests} open PRs</span></div>
        {goal.liveSummary.todos.length > 0 && <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-600">{goal.liveSummary.todos.map(todo => <li key={todo.id}>{todo.status === 'completed' ? '✓' : todo.status === 'in_progress' ? '◉' : '○'} {todo.content}</li>)}</ul>}
      </Link>)}</section>
  </div>;
}

// The detail surface intentionally composes all goal controls and existing task projections.
// eslint-disable-next-line complexity
function GoalDetails({ goalId }: { goalId: string }) {
  const [goal, setGoal] = useState<Goal | null>(null);
  const [message, setMessage] = useState('');
  const [models, setModels] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { liveDetails: live } = useTaskLiveData(goal?.taskId);
  useDocumentTitle(goal?.objective || 'Goal');

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
  const act = async (operation: () => Promise<{ goal: Goal }>) => { setBusy(true); setError(null); try { setGoal((await operation()).goal); } catch (err) { setError((err as Error).message); } finally { setBusy(false); } };
  const continueWith = async (body: { message?: string; canned?: 'done' | 'left' }) => {
    if (!goal) return;
    setBusy(true); setError(null);
    try {
      setGoal((await sendGoalInput(goal.id, body)).goal); setMessage('');
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };
  const totalTokens = useMemo(
    () => tokenTotal(live.tokenUsage || null) || goal?.liveSummary.nativeGoal?.tokensUsed || 0,
    [goal?.liveSummary.nativeGoal?.tokensUsed, live.tokenUsage],
  );
  if (!goal) return <div className="p-6 text-slate-600">{error || 'Loading goal…'}</div>;
  const terminal = Boolean(goal.resultState);
  const cancelling = !terminal && goal.desiredState === 'cancelled';
  const mutable = !terminal && !cancelling;
  return <div className="mx-auto max-w-6xl space-y-5 p-4 sm:p-6">
    <Link to="/goals" className="text-sm text-primary-600 hover:underline">← All goals</Link>
    <header className="rounded-lg border bg-white p-5"><div className="flex flex-wrap items-start justify-between gap-4"><div><h1 className="text-xl font-bold text-slate-900">{goal.objective}</h1><p className="mt-2 text-sm text-slate-500">{goal.repository} · {goal.agent.alias}</p></div><GoalState goal={goal} /></div>
      <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-3 lg:grid-cols-7"><div><dt className="text-slate-500">Launch strategy</dt><dd className="font-medium">{goal.launchStrategy === 'direct' ? 'Agent implements directly' : 'Agent orchestrates through ProPR'}</dd></div><div><dt className="text-slate-500">Requested model</dt><dd className="font-medium">{goal.requestedModel}</dd></div><div><dt className="text-slate-500">Effective model</dt><dd className="font-medium">{goal.effectiveModel || 'Pending provider report'}</dd></div><div><dt className="text-slate-500">Current task</dt><dd className="font-medium">{live.currentTask || goal.taskState}</dd></div><div><dt className="text-slate-500">Elapsed</dt><dd className="font-medium">{duration(goal.elapsedMs)}</dd></div><div><dt className="text-slate-500">Active</dt><dd className="font-medium">{duration(goal.activeMs)}</dd></div><div><dt className="text-slate-500">Paused</dt><dd className="font-medium">{duration(goal.pausedMs)}</dd></div></dl>
      <div className="mt-4 flex flex-wrap gap-2">{goal.desiredState === 'running' && mutable && <button disabled={busy} onClick={() => act(() => pauseGoal(goal.id))} className={`${buttonClass} bg-amber-100 text-amber-800`}><CirclePause className="h-4 w-4" />Pause</button>}{goal.desiredState === 'paused' && mutable && <button disabled={busy} onClick={() => act(() => resumeGoal(goal.id))} className={`${buttonClass} bg-green-100 text-green-800`}><CirclePlay className="h-4 w-4" />{goal.pausePending ? 'Resume after safe boundary' : 'Resume'}</button>}{goal.launchStrategy === 'direct' && goal.desiredState === 'running' && mutable && <button disabled={busy || goal.checkpoint?.pending} onClick={() => act(() => checkpointGoal(goal.id))} className={`${buttonClass} bg-indigo-100 text-indigo-800`}><GitCommit className="h-4 w-4" />{goal.checkpoint?.pending ? 'Checkpoint pending' : 'Checkpoint now'}</button>}{mutable && <button disabled={busy} onClick={() => act(() => cancelGoal(goal.id))} className={`${buttonClass} bg-red-100 text-red-800`}><CircleStop className="h-4 w-4" />Cancel</button>}<Link to={`/tasks/${goal.taskId}`} className={`${buttonClass} bg-slate-100 text-slate-700`}>Open task history</Link>{goal.finalPr && <a href={goal.finalPr.url} target="_blank" rel="noreferrer" className={`${buttonClass} bg-primary-50 text-primary-700`}>{goal.launchStrategy === 'direct' ? 'Open draft PR' : 'Review final PR'} <ExternalLink className="h-4 w-4" /></a>}</div>
      {cancelling && <p className="mt-3 rounded bg-amber-50 p-3 text-sm text-amber-800">Cancelling at the provider boundary and cleaning up the active session…</p>}
      <p className="mt-3 text-xs text-slate-500">{goal.artifactStats.openIssues}/{goal.artifactStats.issues} open issues · {goal.artifactStats.openPullRequests}/{goal.artifactStats.pullRequests} open PRs</p>
      {goal.checkpoint && <div className="mt-3 flex flex-wrap items-center gap-3 rounded-md bg-indigo-50 p-3 text-sm text-indigo-900">
        <span>{goal.checkpoint.count} checkpoint commit{goal.checkpoint.count === 1 ? '' : 's'}{goal.checkpoint.lastAt ? ` · last ${new Date(goal.checkpoint.lastAt).toLocaleString()}` : ''}</span>
        {mutable && <label>Every <select aria-label="Checkpoint frequency" disabled={busy} value={goal.checkpoint.intervalMinutes || 15} onChange={event => act(() => requestGoalCheckpointInterval(goal.id, Number(event.target.value)))} className="mx-1 rounded border border-indigo-200 bg-white p-1"><option value="5">5 minutes</option><option value="10">10 minutes</option><option value="15">15 minutes</option><option value="30">30 minutes</option><option value="60">60 minutes</option><option value="120">120 minutes</option></select></label>}
        {goal.checkpoint.error && <span className="text-red-700">Checkpoint error: {goal.checkpoint.error}</span>}
      </div>}
      {goal.artifacts.length > 0 && <div className="mt-3 flex flex-wrap gap-2 text-xs text-slate-600">{goal.artifacts.map((artifact, index) => { const item = artifact as { type?: string; number?: number; url?: string }; return item.url ? <a key={item.url} href={item.url} target="_blank" rel="noreferrer" className="rounded bg-slate-100 px-2 py-1 hover:underline">{item.type === 'pull_request' ? 'PR' : 'Issue'} #{item.number}</a> : <span key={index} />; })}</div>}
      <details className="mt-4 rounded-md bg-slate-50 p-3 text-sm"><summary className="cursor-pointer font-medium text-slate-700">Initial provider prompt</summary><pre className="mt-3 whitespace-pre-wrap break-words font-mono text-xs text-slate-600">{goal.initialPrompt}</pre></details>
    </header>
    {error && <p role="alert" className="rounded bg-red-50 p-3 text-sm text-red-700">{error}</p>}
    {goal.failureReason && <p role="alert" className="rounded bg-red-50 p-3 text-sm text-red-700">{goal.failureReason}</p>}
    {mutable && <section className="rounded-lg border bg-white p-4"><div className="flex flex-wrap gap-2"><button disabled={busy} onClick={() => continueWith({ canned: 'done' })} className={`${buttonClass} bg-slate-100`}>What's done?</button><button disabled={busy} onClick={() => continueWith({ canned: 'left' })} className={`${buttonClass} bg-slate-100`}>What's left?</button></div><div className="mt-3 flex gap-2"><textarea aria-label="Correction or follow-up" value={message} onChange={event => setMessage(event.target.value)} rows={2} className="min-w-0 flex-1 rounded-md border border-slate-300 p-2" placeholder="Send a correction to the same coding-agent session…" /><button disabled={busy || !message.trim()} onClick={() => continueWith({ message })} className={`${buttonClass} bg-primary-600 text-white`}><Send className="h-4 w-4" />Send</button></div>
      <label className="mt-3 block text-sm text-slate-600">Model for next continuation <select value={goal.requestedModel} onChange={event => act(() => requestGoalModel(goal.id, event.target.value))} className="ml-2 rounded border p-1">{models.map(item => <option key={item} value={item}>{item}</option>)}</select></label>
    </section>}
    <section className="grid gap-5 lg:grid-cols-3"><div className="rounded-lg border bg-white p-4"><h2 className="font-semibold">Native todos</h2>{live.todos.length ? <TodoList liveDetails={live} history={[{ state: goal.taskState }]} /> : <p className="mt-3 text-sm text-slate-500">No provider todos yet.</p>}</div><div className="rounded-lg border bg-white p-4"><h2 className="font-semibold">Usage</h2><p className="mt-3 text-2xl font-bold">{totalTokens.toLocaleString()}</p>{goal.liveSummary.nativeGoal && <p className="mt-1 text-xs text-slate-500">Native goal: {goal.liveSummary.nativeGoal.status} · {duration(goal.liveSummary.nativeGoal.timeUsedSeconds * 1000)}</p>}<RealTimeStats tokenUsage={live.tokenUsage || undefined} /></div><div className="rounded-lg border bg-white p-4"><h2 className="font-semibold">Session</h2><p className="mt-3 break-all text-sm text-slate-600">{goal.sessionId || 'Waiting for provider identity'}</p></div></section>
    <section className="rounded-lg border bg-slate-950 p-4 text-slate-100"><ExecutionEventLog events={live.events} collapsed={false} onToggleCollapse={() => undefined} lastThought={null} isTaskActive={mutable && goal.desiredState === 'running'} taskInfo={null} /></section>
  </div>;
}

export default function GoalsPage() { const { goalId } = useParams(); return goalId ? <GoalDetails goalId={goalId} /> : <GoalList />; }
