import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { ScrollText, Target, Zap } from 'lucide-react';
import { GoalLauncherForm, type PlanFirstRequest } from '../components/Goals/GoalLauncher';
import { goalPath } from '../components/Goals/goalPaths';
import { useDocumentTitle } from '../hooks/useDocumentTitle';

interface NewTaskLocationState {
  initialPrompt?: string;
  initialRepository?: string;
  todoIds?: string[];
}

/**
 * The simplest path from intent to implementation: describe the change, run
 * it, and follow the running task. Execution uses a direct goal underneath.
 */
export default function NewTaskPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const state = (location.state ?? {}) as NewTaskLocationState;
  const initialRepository = state.initialRepository || searchParams.get('repository') || undefined;
  useDocumentTitle('New Task');

  const planFirst = ({ repository, prompt }: PlanFirstRequest) => navigate('/studio/new?mode=task', {
    state: { initialPrompt: prompt, initialRepository: repository, ...(state.todoIds ? { todoIds: state.todoIds } : {}) },
  });

  return <div className="min-h-full w-full min-w-0 bg-white">
    <div className="mx-auto flex max-w-3xl flex-col px-4 py-6 sm:px-6">
      <header className="mb-5">
        <h1 className="flex items-center gap-2 text-2xl font-bold text-slate-900"><Zap className="h-6 w-6 text-primary-600" aria-hidden="true" />New task</h1>
        <p className="mt-1 text-sm text-slate-600">Describe what you want done. A coding agent implements it on a draft PR, runs the relevant checks, and stops.</p>
      </header>
      <GoalLauncherForm
        variant="task"
        initialRepository={initialRepository}
        initialObjective={state.initialPrompt}
        onCreated={task => navigate(goalPath(task))}
        onPlanFirst={planFirst}
      />
      <nav aria-label="Other ways to start work" className="mt-8 grid gap-3 border-t border-slate-200 pt-5 text-sm sm:grid-cols-2">
        <Link to="/studio/new" className="flex items-start gap-3 rounded-md border border-slate-200 p-3 text-slate-700 hover:border-slate-300 hover:bg-slate-50">
          <ScrollText className="mt-0.5 h-4 w-4 flex-none text-teal-600" aria-hidden="true" />
          <span><strong className="block text-slate-900">New plan</strong>Work out and review what to do before anything runs.</span>
        </Link>
        <Link to="/goals?new=1" className="flex items-start gap-3 rounded-md border border-slate-200 p-3 text-slate-700 hover:border-slate-300 hover:bg-slate-50">
          <Target className="mt-0.5 h-4 w-4 flex-none text-indigo-600" aria-hidden="true" />
          <span><strong className="block text-slate-900">New goal</strong>Keep an agent working toward an outcome across tasks.</span>
        </Link>
      </nav>
    </div>
  </div>;
}
