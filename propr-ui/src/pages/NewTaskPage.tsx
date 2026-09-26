import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { Play, ScrollText, Zap } from 'lucide-react';
import { getInstanceCatalog } from '../api/proprApi';
import type { InstanceCatalogResponse } from '../api/proprTypes';
import { createDraft, uploadAttachment } from '../api/plannerApi';
import { API_BASE_URL } from '../api/apiClient';
import { getTaskSubmission, retryTaskSubmission, submitTask, taskSnapshotStorage, listTaskSnapshots, type TaskSnapshot, type TaskSubmission } from '../api/taskSubmissions';
import { RepositorySelector } from '../components/RepositorySelector';
import { clipboardImageFiles } from '../components/Goals/goalAttachmentUtils';
import { resizeImage } from '../components/TaskPlanner/imageUtils';
import { GoalAttachmentInput } from '../components/Goals/GoalAttachmentInput';
import { useCurrentUser } from '../contexts/AuthContext';
import { useDemoMode } from '../contexts/DemoModeContext';
import { useDocumentTitle } from '../hooks/useDocumentTitle';

const button = 'scroll-mb-24 md:scroll-mb-0 inline-flex min-h-11 items-center justify-center gap-2 rounded-md border px-4 py-2 text-sm font-medium disabled:opacity-50';
interface Prefill { initialRepository?: string; initialPrompt?: string; todoIds?: string[] }
function savedRouting(scope: string): { agentAlias?: string; model?: string } {
  try { return JSON.parse(localStorage.getItem(`task-routing:${scope}`) || '{}'); } catch { return {}; }
}

export default function NewTaskPage() {
  const user = useCurrentUser();
  const scope = `${API_BASE_URL}:${user?.id}`;
  return <NewTaskLauncher key={scope} scope={scope} />;
}

function useNewTaskLauncher(scope: string) {
  useDocumentTitle('New Task');
  const navigate = useNavigate();
  const location = useLocation();
  const { isDemoMode } = useDemoMode();
  const prefill = (location.state || {}) as Prefill;
  const saved = savedRouting(scope);
  const [repository, setRepository] = useState(prefill.initialRepository || '');
  const [instruction, setInstruction] = useState(prefill.initialPrompt || '');
  const [files, setFiles] = useState<File[]>([]);
  const [todoIds, setTodoIds] = useState(prefill.todoIds);
  const [agentAlias, setAgent] = useState(saved.agentAlias || '');
  const [model, setModel] = useState(saved.model || '');
  const [catalog, setCatalog] = useState<InstanceCatalogResponse>();
  const [snapshot, setSnapshot] = useState<TaskSnapshot>();
  const [recoverable, setRecoverable] = useState<TaskSnapshot[]>([]);
  const activeStorageKey = `task-active-submission:${scope}`;
  const [result, setResult] = useState<TaskSubmission>();
  const [busy, setBusy] = useState(false);
  const [processingFiles, setProcessingFiles] = useState(false);
  const [planDraft, setPlanDraft] = useState<string>();
  const transferredFiles = useRef(0);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submitting = useRef(false);
  const selection = catalog?.agents.find(agent => agent.alias === agentAlias);
  const invalidRouting = Boolean(agentAlias && catalog && (!selection || (model && !selection.supportedModels.includes(model))));

  useEffect(() => {
    let active = true;
    void getInstanceCatalog().then(value => { if (active) setCatalog(value); }).catch(error => { if (active) setError(error.message); });
    void listTaskSnapshots(scope).then(values => { if (active) setRecoverable(values); }).catch(error => { if (active) setError(error.message); });
    const key = sessionStorage.getItem(activeStorageKey);
    void taskSnapshotStorage(scope, key || undefined).then(value => {
      if (!active || !value) return;
      sessionStorage.setItem(activeStorageKey, value.key);
      setTodoIds(value.payload.todoIds);
      setSnapshot(value); setRepository(value.payload.repository); setInstruction(value.payload.instruction);
      setAgent(value.payload.agentAlias || ''); setModel(value.payload.model || ''); setFiles(value.files);
      void getTaskSubmission(value.key).then(row => { if (active && sessionStorage.getItem(activeStorageKey) === value.key) setResult(row); }).catch(() => undefined);
    }).catch(() => undefined).finally(() => { if (active) setReady(true); });
    return () => { active = false; };
  }, [scope, activeStorageKey]);

  useEffect(() => {
    if (!snapshot || !result) return;
    if (result.taskId) {
      let active = true;
      void taskSnapshotStorage(scope, snapshot.key, null).then(() => {
        if (sessionStorage.getItem(activeStorageKey) === snapshot.key) sessionStorage.removeItem(activeStorageKey);
      }).catch(() => undefined).then(() => { if (active) navigate(`/tasks/${encodeURIComponent(result.taskId!)}`, { replace: true }); });
      return () => { active = false; };
    }
    if (result.state !== 'queued' && result.state !== 'issue_created' && result.state !== 'creating') return;
    let active = true;
    const timer = setInterval(() => {
      void getTaskSubmission(snapshot.key).then(value => { if (active) setResult(value); }).catch(error => { if (active) setError(error.message); });
    }, 2000);
    return () => { active = false; clearInterval(timer); };
  }, [snapshot, result, navigate, scope, activeStorageKey]);

  const run = async () => {
    if (submitting.current || processingFiles || isDemoMode) return;
    submitting.current = true; setBusy(true); setError(null);
    const current = snapshot || { key: crypto.randomUUID(), payload: { repository, instruction, ...(agentAlias ? { agentAlias } : {}), ...(model ? { model } : {}), todoIds }, files };
    try {
      // Persist before the network mutation. A reload can safely repeat this exact request.
      await taskSnapshotStorage(scope, current.key, current);
      sessionStorage.setItem(activeStorageKey, current.key);
      setSnapshot(current);
      const next = result ? await retryTaskSubmission(current.key) : await submitTask(current.key, current.payload, current.files);
      setResult(next);
      if (next.state === 'queued') {
        try { localStorage.setItem(`task-routing:${scope}`, JSON.stringify({ agentAlias, model })); } catch { /* Routing preferences are optional. */ }
      }
    } catch (error) {
      setError((error as Error).message);
      const status = (error as { status?: number }).status;
      if (!snapshot && status && [400, 401, 403, 404].includes(status)) {
        await taskSnapshotStorage(scope, current.key, null); sessionStorage.removeItem(activeStorageKey); setSnapshot(undefined);
        return;
      }
      // A lost response is resolved via the same key, never a new submission.
      try { setResult(await getTaskSubmission(current.key)); } catch { /* Retain the exact request for retry. */ }
    } finally { submitting.current = false; setBusy(false); }
  };
  const startOver = async () => {
    if (submitting.current || !snapshot) return;
    submitting.current = true; setBusy(true);
    try {
      // Confirmed failures can be discarded. Keep uncertain submissions stored
      // with their original identity when starting unrelated work.
      if (result?.state === 'prepared' || result?.state === 'failed') {
        await taskSnapshotStorage(scope, snapshot.key, null);
        setRecoverable(current => current.filter(value => value.key !== snapshot.key));
      } else {
        setRecoverable(current => [...current.filter(value => value.key !== snapshot.key), snapshot]);
      }
      sessionStorage.removeItem(activeStorageKey);
      if (result?.state !== 'prepared') { setInstruction(''); setFiles([]); setTodoIds(undefined); }
      setSnapshot(undefined); setResult(undefined); setError(null);
    } catch (error) { setError((error as Error).message); }
    finally { submitting.current = false; setBusy(false); }
  };
  const reopen = async (key: string) => {
    if (submitting.current || snapshot || planDraft || isDemoMode) return;
    submitting.current = true; setBusy(true); setError(null);
    try {
      const value = await taskSnapshotStorage(scope, key);
      if (!value) { setRecoverable(current => current.filter(item => item.key !== key)); return; }
      sessionStorage.setItem(activeStorageKey, value.key);
      setSnapshot(value); setResult(undefined);
      setRepository(value.payload.repository); setInstruction(value.payload.instruction);
      setTodoIds(value.payload.todoIds); setFiles(value.files);
      setAgent(value.payload.agentAlias || ''); setModel(value.payload.model || '');
      try { setResult(await getTaskSubmission(value.key)); } catch { /* Retry the saved request with its original key. */ }
    } catch (error) { setError((error as Error).message); }
    finally { submitting.current = false; setBusy(false); }
  };
  const planFirst = async () => {
    if (submitting.current || processingFiles || isDemoMode) return;
    if (!files.length) { navigate('/studio/new', { state: { initialRepository: repository, initialPrompt: instruction, todoIds } }); return; }
    submitting.current = true; setBusy(true); setError(null);
    try {
      const id = planDraft || (await createDraft(repository, instruction, { todoIds })).draft_id;
      setPlanDraft(id);
      while (transferredFiles.current < files.length) {
        await uploadAttachment(id, files[transferredFiles.current]);
        transferredFiles.current++;
      }
      navigate(`/studio/${id}`);
    } catch (error) { setError(`Plan handoff did not finish. Your files are kept here; retry Plan first. ${(error as Error).message}`); }
    finally { submitting.current = false; setBusy(false); }
  };
  const locked = busy || Boolean(snapshot) || Boolean(planDraft);
  return {
    repository, setRepository, instruction, setInstruction, files, setFiles,
    agentAlias, setAgent, model, setModel, catalog, selection, invalidRouting,
    snapshot, result, busy, processingFiles, setProcessingFiles, planDraft,
    ready, error, setError, run, startOver, planFirst, locked, isDemoMode, recoverable, reopen,
  };
}

type LauncherState = ReturnType<typeof useNewTaskLauncher>;

function TaskRoutingOptions({ agentAlias, setAgent, model, setModel, catalog, selection, invalidRouting }:
  Pick<LauncherState, 'agentAlias' | 'setAgent' | 'model' | 'setModel' | 'catalog' | 'selection' | 'invalidRouting'>) {
  return <details className="border-y border-slate-200 py-4" open={invalidRouting || undefined}>
    <summary className="cursor-pointer text-sm font-medium text-slate-700">Options <span className="ml-2 font-normal text-slate-500">{agentAlias || 'Default agent'} · {model || 'Default model'}</span></summary>
    <div className="mt-4 grid gap-4 sm:grid-cols-2">
      <label className="text-sm text-slate-700">Agent<select aria-label="Agent" value={agentAlias} onChange={event => { setAgent(event.target.value); setModel(''); }} className="mt-1 w-full rounded border border-slate-300 p-2"><option value="">Instance default</option>{invalidRouting && !selection && <option value={agentAlias}>{agentAlias} (unavailable)</option>}{catalog?.agents.map(agent => <option key={agent.alias} value={agent.alias}>{agent.alias}</option>)}</select></label>
      <label className="text-sm text-slate-700">Model<select aria-label="Model" value={model} disabled={!agentAlias} onChange={event => setModel(event.target.value)} className="mt-1 w-full rounded border border-slate-300 p-2"><option value="">Agent default</option>{model && !selection?.supportedModels.includes(model) && <option value={model}>{model} (unavailable)</option>}{selection?.supportedModels.map(model => <option key={model}>{model}</option>)}</select></label>
    </div>
    <p className="mt-3 text-xs text-slate-500">Base branch and automatic review settings follow the repository’s issue workflow.</p>
  </details>;
}

function submissionStatus(busy: boolean, result?: TaskSubmission, snapshot?: TaskSnapshot) {
  if (busy) return 'Submitting…';
  if (result?.state === 'queued') return 'Queued — waiting for task details';
  if (result?.state === 'prepared') return 'Could not create issue';
  if (result?.state === 'failed') return 'Could not start task';
  if (result?.issueUrl) return 'Issue created — starting task';
  return snapshot ? 'Confirming submission with GitHub' : null;
}

function TaskSubmissionFeedback({ busy, result, snapshot, error, invalidRouting }:
  Pick<LauncherState, 'busy' | 'result' | 'snapshot' | 'error' | 'invalidRouting'>) {
  const status = submissionStatus(busy, result, snapshot);

  return <>
    {invalidRouting && <p role="alert" className="text-sm text-red-700">The saved agent or model is unavailable. Choose a supported selection in Options.</p>}
    {(error || result?.error) && <p role="alert" className="break-words rounded-md bg-red-50 p-3 text-sm text-red-800">{error || result?.error}</p>}
    {status && <div role="status" className="rounded-md border border-teal-200 bg-teal-50 p-4 text-sm text-slate-700"><p className="font-semibold">{status}</p>{result?.issueUrl && <a href={result.issueUrl} target="_blank" rel="noreferrer" className="mt-2 inline-block text-teal-700 underline">Open issue #{result.issueNumber}</a>}{snapshot && !result?.issueUrl && <p className="mt-2">Retry checks this submission before creating anything else.</p>}{snapshot && result?.state !== 'prepared' && <p className="mt-2">Start over opens a new request. It does not cancel this submission.</p>}</div>}
  </>;
}

function TaskLauncherActions({ snapshot, result, startOver, planFirst, ready, busy, processingFiles, isDemoMode, repository, instruction, planDraft, invalidRouting }:
  Pick<LauncherState, 'snapshot' | 'result' | 'startOver' | 'planFirst' | 'ready' | 'busy' | 'processingFiles' | 'isDemoMode' | 'repository' | 'instruction' | 'planDraft' | 'invalidRouting'>) {
  const launchDisabled = !ready || busy || processingFiles || isDemoMode || !repository || !instruction.trim();

  return <div className="flex flex-wrap justify-end gap-3">
    {snapshot && <button type="button" onClick={() => void startOver()} disabled={busy || isDemoMode} className={`${button} border-slate-300 bg-white text-slate-700`}>{result?.state === 'prepared' ? 'Edit request' : 'Start over'}</button>}
    {!snapshot && <button type="button" onClick={() => void planFirst()} disabled={launchDisabled} className={`${button} border-slate-300 bg-white text-slate-700`}><ScrollText size={16} />Plan first</button>}
    {result?.state !== 'queued' && <button type="submit" disabled={launchDisabled || Boolean(planDraft) || invalidRouting} className={`${button} border-teal-600 bg-teal-600 text-white hover:bg-teal-700`}><Play size={16} />{busy ? 'Submitting…' : snapshot ? 'Retry submission' : 'Run task'}</button>}
  </div>;
}

function NewTaskLauncher({ scope }: { scope: string }) {
  const launcher = useNewTaskLauncher(scope);
  const { catalog, repository, setRepository, instruction, setInstruction, files, setFiles,
    setError, processingFiles, setProcessingFiles, locked, isDemoMode, run, snapshot } = launcher;

  return <main className="mx-auto w-full max-w-3xl px-4 pt-6 pb-28 sm:px-8 md:py-10">
    <h1 className="flex items-center gap-2 text-2xl font-semibold text-slate-900"><Zap className="h-6 w-6 text-teal-600" />New task</h1>
    <p className="mt-2 text-sm leading-6 text-slate-600">Describe the change you want. Run task creates a GitHub issue and starts implementation using the repository’s settings.</p>
    {!snapshot && !launcher.planDraft && launcher.recoverable.length > 0 && <section aria-label="Unresolved submissions" className="mt-6 rounded-md border border-amber-200 bg-amber-50 p-4 text-sm text-slate-700">
      <h2 className="font-semibold">Unresolved submissions</h2>
      <p className="mt-1">Reopen a previous request to check its status and finish starting the task.</p>
      <ul className="mt-3 space-y-3">{launcher.recoverable.map(value => <li key={value.key} className="flex items-center justify-between gap-3">
        <div className="min-w-0"><p className="font-medium">{value.payload.repository}</p><p className="truncate">{value.payload.instruction}</p></div>
        <button type="button" disabled={!launcher.ready || launcher.busy || processingFiles || isDemoMode} onClick={() => void launcher.reopen(value.key)} className={`${button} shrink-0 border-slate-300 bg-white`}>Reopen submission</button>
      </li>)}</ul>
    </section>}
    <form className="mt-6 space-y-5" onSubmit={event => { event.preventDefault(); void run(); }}>
      <fieldset disabled={locked || isDemoMode} className="space-y-5">
        <div><label className="mb-2 block text-sm font-medium text-slate-700">Repository</label><RepositorySelector repos={catalog?.repositories} selectedRepo={repository} onRepoChange={setRepository} disabled={locked || isDemoMode} placeholder="Select a repository" /></div>
        <div><label htmlFor="task-instruction" className="mb-2 block text-sm font-medium text-slate-700">Instruction</label>
          <textarea id="task-instruction" required maxLength={50000} value={instruction} onChange={event => setInstruction(event.target.value)} onPaste={event => {
            const incoming = clipboardImageFiles(event);
            if (!incoming.length || locked || processingFiles) return;
            event.preventDefault();
            if (incoming.length + files.length > 10) { setError('Attach up to 10 files.'); return; }
            setProcessingFiles(true);
            void Promise.all(incoming.map(resizeImage)).then(processed => setFiles(current => [...current, ...processed]))
              .catch(() => setError('Could not process pasted images.')).finally(() => setProcessingFiles(false));
          }} rows={7} placeholder="Fix the invoice date format…" className="w-full rounded-md border border-slate-300 p-3 text-sm leading-6 focus:border-teal-500 focus:outline-none focus:ring-1 focus:ring-teal-500" />
          <GoalAttachmentInput files={files} onChange={setFiles} onError={setError} onProcessingChange={setProcessingFiles} disabled={locked || processingFiles || isDemoMode} />
        </div>
        <TaskRoutingOptions {...launcher} />
      </fieldset>
      <TaskSubmissionFeedback {...launcher} />
      <TaskLauncherActions {...launcher} />
    </form>
    {!snapshot && <div className="mt-8 grid gap-3 border-t border-slate-200 pt-6 sm:grid-cols-2"><Link to="/studio/new" className="rounded-lg border border-slate-200 p-4 text-sm"><strong>New Plan</strong><p className="mt-1 text-slate-500">Plan and review work before implementation.</p></Link><Link to="/goals?new=1" className="rounded-lg border border-slate-200 p-4 text-sm"><strong>New Goal</strong><p className="mt-1 text-slate-500">Start an ongoing agent session.</p></Link></div>}
  </main>;
}
