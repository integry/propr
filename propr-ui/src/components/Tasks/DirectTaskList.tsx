import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Activity, CheckCircle2, CircleAlert, CircleStop, GitPullRequest, LoaderCircle, Plus, Zap } from 'lucide-react';
import { listGoals, type Goal } from '../../api/goals';
import { goalPath } from '../Goals/goalPaths';
import { formatRelativeTime } from '../headerUtils';

const COLLAPSED_LIMIT = 3;

const directTaskState = (task: Goal) => task.resultState
  || (task.desiredState === 'cancelled' ? 'cancelling' : task.desiredState);

function DirectTaskState({ task }: { task: Goal }) {
  const state = directTaskState(task);
  const icon = state === 'completed'
    ? <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />
    : state === 'failed'
      ? <CircleAlert className="h-3.5 w-3.5" aria-hidden="true" />
      : state === 'cancelled' || state === 'cancelling'
        ? <CircleStop className="h-3.5 w-3.5" aria-hidden="true" />
        : state === 'running'
          ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
          : null;
  const color = state === 'completed'
    ? 'text-green-700'
    : state === 'failed' || state === 'cancelled'
      ? 'text-red-700'
      : state === 'running'
        ? 'text-blue-700'
        : 'text-amber-700';
  return <span className={`inline-flex items-center gap-1 text-xs font-semibold capitalize ${color}`}>{icon}{state}</span>;
}

function DirectTaskRow({ task }: { task: Goal }) {
  const activity = directTaskState(task) === 'running'
    ? task.liveSummary.currentTask
      || task.liveSummary.todos.find(todo => todo.status === 'in_progress')?.content
      || null
    : null;
  return <li className="border-b border-slate-100 last:border-b-0">
    <div className="flex min-w-0 items-center gap-3 px-4 py-2.5 hover:bg-slate-50 sm:px-6">
      <Link to={goalPath(task)} className="min-w-0 flex-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500">
        <span className="block truncate text-sm font-medium text-slate-900" title={task.title}>{task.title}</span>
        <span className="mt-0.5 flex min-w-0 items-center gap-2 text-xs text-slate-500">
          <DirectTaskState task={task} />
          <span aria-hidden="true" className="text-slate-300">•</span>
          <span className="truncate">{task.repository}</span>
          {activity && <>
            <span aria-hidden="true" className="hidden text-slate-300 sm:inline">•</span>
            <span className="hidden min-w-0 items-center gap-1 truncate sm:inline-flex"><Activity className="h-3 w-3 flex-none text-blue-500" aria-hidden="true" /><span className="truncate">{activity}</span></span>
          </>}
        </span>
      </Link>
      {task.finalPr && <a href={task.finalPr.url} target="_blank" rel="noreferrer" className="inline-flex flex-none items-center gap-1 text-xs font-medium text-primary-700 hover:underline">
        <GitPullRequest className="h-3.5 w-3.5" aria-hidden="true" />{task.finalPr.number ? `#${task.finalPr.number}` : 'PR'}
      </a>}
      <span className="hidden w-16 flex-none text-right text-xs text-slate-400 sm:block">{formatRelativeTime(task.updatedAt)}</span>
    </div>
  </li>;
}

/**
 * Direct tasks run on the goal execution path, but they belong with the rest
 * of the user's task activity rather than under Goals.
 */
export default function DirectTaskList() {
  const [tasks, setTasks] = useState<Goal[]>([]);
  const [expanded, setExpanded] = useState(false);
  const generationRef = useRef(0);

  const refresh = useCallback(async () => {
    const generation = ++generationRef.current;
    try {
      const data = await listGoals('task');
      if (generation === generationRef.current) setTasks(data.goals);
    } catch {
      // Direct tasks are supplementary to the task table; keep the last successful read.
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => { void refresh(); }, 10_000);
    return () => {
      generationRef.current += 1;
      window.clearInterval(timer);
    };
  }, [refresh]);

  if (tasks.length === 0) return null;
  const visible = expanded ? tasks : tasks.slice(0, COLLAPSED_LIMIT);
  return <section aria-labelledby="direct-tasks-heading" className="border-b border-slate-200 bg-white">
    <div className="flex items-center justify-between gap-3 px-4 pb-1 pt-3 sm:px-6">
      <h2 id="direct-tasks-heading" className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-widest text-slate-500">
        <Zap className="h-3.5 w-3.5 text-primary-600" aria-hidden="true" />Direct tasks
        <span className="font-semibold text-slate-400">({tasks.length})</span>
      </h2>
      <Link to="/tasks/new" className="inline-flex items-center gap-1 text-xs font-medium text-primary-700 hover:underline"><Plus className="h-3.5 w-3.5" aria-hidden="true" />New task</Link>
    </div>
    <ul aria-label="Direct tasks">{visible.map(task => <DirectTaskRow key={task.id} task={task} />)}</ul>
    {tasks.length > COLLAPSED_LIMIT && <button type="button" onClick={() => setExpanded(value => !value)} className="w-full px-4 py-2 text-left text-xs font-medium text-slate-500 hover:bg-slate-50 hover:text-slate-800 sm:px-6">
      {expanded ? 'Show fewer' : `Show all ${tasks.length} direct tasks`}
    </button>}
  </section>;
}
