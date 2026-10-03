import TextareaAutosize from 'react-textarea-autosize';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { AlertCircle, AlertTriangle, ExternalLink, Loader2, ScrollText, Zap } from 'lucide-react';
import { getInstanceCatalog } from '../api/proprApi';
import type { InstanceCatalogResponse } from '../api/proprTypes';
import { createDraft, uploadAttachment } from '../api/plannerApi';
import { API_BASE_URL } from '../api/apiClient';
import { getTaskSubmission, retryTaskSubmission, submitTask, taskSnapshotStorage, listTaskSnapshots, type TaskSnapshot, type TaskSubmission } from '../api/taskSubmissions';
import { CreationDialog } from '../components/CreationDialog';
import { RepositorySelector } from '../components/RepositorySelector';
import { clipboardImageFiles } from '../components/Goals/goalAttachmentUtils';
import { resizeImage } from '../components/TaskPlanner/imageUtils';
import { GoalAttachmentInput } from '../components/Goals/GoalAttachmentInput';
import { useCurrentUser } from '../contexts/AuthContext';
import { useDemoMode } from '../contexts/DemoModeContext';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useDecoratedRepoOptions } from '../hooks/useDecoratedRepoOptions';

const button = 'inline-flex min-h-11 items-center justify-center gap-2 rounded-md border px-4 py-2 text-sm font-medium disabled:opacity-50';
interface Prefill { initialRepository?: string; initialPrompt?: string; todoIds?: string[] }
// Last used repository and routing, preselected for the next task.
function savedRouting(scope: string): { repository?: string; agentAlias?: string; model?: string } {
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
  const [saved] = useState(() => savedRouting(scope));
  const [repository, setRepository] = useState(prefill.initialRepository || saved.repository || '');
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
    void getInstanceCatalog().then(value => {
      if (!active) return;
      setCatalog(value);
      // Drop a remembered repository that is no longer available on this instance.
      if (saved.repository) setRepository(current => current === saved.repository && !value.repositories.some(repo => repo.name === current && repo.enabled) ? '' : current);
    }).catch(error => { if (active) setError(error.message); });
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
  }, [scope, activeStorageKey, saved.repository]);

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
      if (next.state !== 'prepared' && next.state !== 'failed') {
        try { localStorage.setItem(`task-routing:${scope}`, JSON.stringify({ repository: current.payload.repository, agentAlias: current.payload.agentAlias || '', model: current.payload.model || '' })); } catch { /* Routing preferences are optional. */ }
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
  // The issue of a confirmed dispatch failure stays on GitHub; closing only
  // abandons the local retry state so the next launcher starts fresh.
  const dismiss = async () => {
    if (!snapshot || result?.state !== 'failed') return;
    try { await taskSnapshotStorage(scope, snapshot.key, null); } catch { /* Closing must not be blocked by local cleanup. */ }
    if (sessionStorage.getItem(activeStorageKey) === snapshot.key) sessionStorage.removeItem(activeStorageKey);
  };
  const locked = busy || Boolean(snapshot) || Boolean(planDraft);
  return {
    repository, setRepository, instruction, setInstruction, files, setFiles,
    agentAlias, setAgent, model, setModel, catalog, selection, invalidRouting,
    snapshot, result, busy, processingFiles, setProcessingFiles, planDraft,
    ready, error, setError, run, startOver, dismiss, planFirst, locked, isDemoMode, recoverable, reopen,
  };
}

type LauncherState = ReturnType<typeof useNewTaskLauncher>;

function TaskRoutingOptions({ agentAlias, setAgent, model, setModel, catalog, selection, invalidRouting, locked, isDemoMode }: LauncherState) {
  const [optionsOpen, setOptionsOpen] = useState(invalidRouting);
  return <details className="border-y border-slate-200 py-4" open={invalidRouting || undefined} onToggle={event => setOptionsOpen(event.currentTarget.open)}>
    <summary className="cursor-pointer text-sm font-medium text-slate-700">Advanced Options {!optionsOpen && <span className="ml-2 font-normal text-slate-500">{agentAlias || 'Default agent'} · {model || 'Default model'}</span>}</summary>
    <fieldset disabled={locked || isDemoMode} className="mt-4 grid gap-4 disabled:opacity-60 sm:grid-cols-2">
      <label className="text-sm text-slate-700">Agent<select aria-label="Agent" value={agentAlias} onChange={event => { setAgent(event.target.value); setModel(''); }} className="mt-1 w-full rounded border border-slate-300 p-2"><option value="">Instance default</option>{invalidRouting && !selection && <option value={agentAlias}>{agentAlias} (unavailable)</option>}{catalog?.agents.map(agent => <option key={agent.alias} value={agent.alias}>{agent.alias}</option>)}</select></label>
      <label className="text-sm text-slate-700">Model<select aria-label="Model" value={model} disabled={!agentAlias} onChange={event => setModel(event.target.value)} className="mt-1 w-full rounded border border-slate-300 p-2"><option value="">Agent default</option>{model && !selection?.supportedModels.includes(model) && <option value={model}>{model} (unavailable)</option>}{selection?.supportedModels.map(model => <option key={model}>{model}</option>)}</select></label>
    </fieldset>
    <p className="mt-3 text-xs text-slate-500">Base branch and automatic review settings follow the repository’s issue workflow.</p>
  </details>;
}

const isPartialFailure = (result?: TaskSubmission) => result?.state === 'failed' && Boolean(result.issueUrl);

interface SubmissionNotice { tone: 'info' | 'warning' | 'error'; title?: string; body?: string; detail?: string | null }

// One notice per state. An in-flight submission is shown on the submit button only.
function submissionNotice(busy: boolean, error: string | null, result?: TaskSubmission, snapshot?: TaskSnapshot): SubmissionNotice | null {
  const detail = error || result?.error;
  if (isPartialFailure(result)) return { tone: 'warning', title: `Issue #${result!.issueNumber} created, but agent failed to queue`, body: 'GitHub issue was opened successfully, but the local worker failed to start implementation.', detail };
  if (result?.state === 'failed') return { tone: 'error', title: 'Could not start task', detail };
  if (result?.state === 'prepared') return { tone: 'error', title: 'Could not create issue', detail };
  if (busy) return null;
  if (detail) return snapshot && !result?.issueUrl
    ? { tone: 'error', title: 'Could not confirm submission', body: 'Retry checks this submission before creating anything else.', detail }
    : { tone: 'error', detail };
  if (result?.state === 'queued') return { tone: 'info', title: 'Queued — waiting for task details' };
  if (result?.issueUrl) return { tone: 'info', title: 'Issue created — starting task' };
  if (snapshot) return { tone: 'info', title: 'Confirming submission with GitHub', body: result ? undefined : 'Retry checks this submission before creating anything else.' };
  return null;
}

const noticeStyles = {
  info: { box: 'border-teal-200 bg-teal-50 text-slate-700', icon: null },
  warning: { box: 'border-amber-200 bg-amber-50 text-amber-900', icon: AlertTriangle },
  error: { box: 'border-red-200 bg-red-50 text-red-800', icon: AlertCircle },
};

function TaskSubmissionFeedback({ busy, result, snapshot, error, invalidRouting }:
  Pick<LauncherState, 'busy' | 'result' | 'snapshot' | 'error' | 'invalidRouting'>) {
  const notice = submissionNotice(busy, error, result, snapshot);
  const style = notice && noticeStyles[notice.tone];
  const Icon = style?.icon;

  return <>
    {invalidRouting && <p role="alert" className="text-sm text-red-700">The saved agent or model is unavailable. Choose a supported selection in Advanced Options.</p>}
    {notice && style && <div role={notice.tone === 'info' ? 'status' : 'alert'} className={`flex gap-3 break-words rounded-md border p-4 text-sm ${style.box}`}>
      {Icon && <Icon aria-hidden="true" size={18} className="mt-0.5 flex-none" />}
      <div className="min-w-0">
        {notice.title && <p className="font-semibold">{notice.title}</p>}
        {notice.body && <p className={notice.title ? 'mt-1' : undefined}>{notice.body}</p>}
        {notice.detail && <p className={`${notice.title ? 'mt-1' : ''} ${notice.tone === 'warning' ? 'text-xs text-amber-800' : ''}`}>{notice.detail}</p>}
        {result?.issueUrl && notice.tone !== 'error' && <a href={result.issueUrl} target="_blank" rel="noreferrer" className={`mt-3 inline-flex items-center gap-1.5 rounded-md border bg-white px-3 py-1.5 font-medium ${notice.tone === 'warning' ? 'border-amber-300 text-amber-900 hover:bg-amber-100' : 'border-teal-200 text-teal-700 hover:bg-teal-100'}`}>View issue #{result.issueNumber}<ExternalLink aria-hidden="true" size={14} /></a>}
      </div>
    </div>}
  </>;
}

function submitLabel(result?: TaskSubmission, snapshot?: TaskSnapshot) {
  if (isPartialFailure(result)) return 'Retry agent';
  return snapshot ? 'Retry submission' : 'Run task';
}

// Start over is hidden while the first request is in flight and for partial
// failures, whose issue already exists and only needs the agent retried.
const canStartOver = (busy: boolean, result?: TaskSubmission, snapshot?: TaskSnapshot) =>
  Boolean(snapshot) && !isPartialFailure(result) && (Boolean(result) || !busy);

function TaskLauncherActions({ onCancel, snapshot, result, startOver, ready, busy, processingFiles, isDemoMode, repository, instruction, planDraft, planFirst, invalidRouting }:
  Pick<LauncherState, 'snapshot' | 'result' | 'startOver' | 'ready' | 'busy' | 'processingFiles' | 'isDemoMode' | 'repository' | 'instruction' | 'planDraft' | 'planFirst' | 'invalidRouting'> & { onCancel: () => void }) {
  const launchDisabled = !ready || busy || processingFiles || isDemoMode || !repository || !instruction.trim();
  const partialFailure = isPartialFailure(result);

  return <div className="flex flex-none flex-wrap justify-end gap-3 border-t border-slate-200 bg-slate-50 px-5 py-4 sm:px-7">
    <button type="button" onClick={onCancel} disabled={busy || processingFiles} className={`${button} mr-auto border-transparent text-slate-700 hover:bg-slate-100`}>{partialFailure ? 'Close' : 'Cancel'}</button>
    {canStartOver(busy, result, snapshot) && <button type="button" onClick={() => void startOver()} disabled={busy || isDemoMode} className={`${button} border-slate-300 bg-white text-slate-700`}>{result?.state === 'prepared' ? 'Edit request' : 'Start over'}</button>}
    {!snapshot && <button type="button" onClick={() => void planFirst()} disabled={launchDisabled} className={`${button} border-slate-300 bg-white text-slate-700 hover:bg-slate-100`}><ScrollText aria-hidden="true" size={16} />Plan first</button>}
    {result?.state !== 'queued' && <button type="submit" disabled={launchDisabled || Boolean(planDraft) || invalidRouting} className={`${button} border-teal-600 bg-teal-600 text-white hover:bg-teal-700 ${busy ? 'pointer-events-none disabled:opacity-80' : ''}`}>{busy ? <><Loader2 aria-hidden="true" size={16} className="animate-spin" />Submitting…</> : submitLabel(result, snapshot)}</button>}
  </div>;
}

function NewTaskLauncher({ scope }: { scope: string }) {
  const launcher = useNewTaskLauncher(scope);
  const { catalog, repository, setRepository, instruction, setInstruction, files, setFiles,
    setError, processingFiles, setProcessingFiles, locked, isDemoMode, run, snapshot } = launcher;

  const navigate = useNavigate();
  const [dirty, setDirty] = useState(false);
  const repoOptions = useDecoratedRepoOptions(useMemo(() => catalog?.repositories.map(({ name, enabled }) => ({ name, enabled })), [catalog]));
  const requestClose = async () => {
    if (launcher.busy || processingFiles) return;
    if (!snapshot && dirty && !window.confirm('Discard this unsaved task? Your prompt, attachments, and form changes will be lost.')) return;
    await launcher.dismiss();
    navigate('/tasks', { replace: true });
  };

  return <CreationDialog title="New task" icon={Zap} description="Describe the change you want. Run task creates an issue and starts implementation."
    closeLabel="Close task creation" onClose={() => void requestClose()} busy={launcher.busy || processingFiles}>
    <form className="flex min-h-0 flex-col" onChange={() => setDirty(true)} onSubmit={event => { event.preventDefault(); void run(); }}>
      <div className="min-h-0 overflow-y-auto px-5 py-5 sm:px-7 space-y-5">
    {!snapshot && !launcher.planDraft && launcher.recoverable.length > 0 && <section aria-label="Unresolved submissions" className="mt-6 rounded-md border border-amber-200 bg-amber-50 p-4 text-sm text-slate-700">
      <h2 className="font-semibold">Unresolved submissions</h2>
      <p className="mt-1">Reopen a previous request to check its status and finish starting the task.</p>
      <ul className="mt-3 space-y-3">{launcher.recoverable.map(value => <li key={value.key} className="flex items-center justify-between gap-3">
        <div className="min-w-0"><p className="font-medium">{value.payload.repository}</p><p className="truncate">{value.payload.instruction}</p></div>
        <button type="button" disabled={!launcher.ready || launcher.busy || processingFiles || isDemoMode} onClick={() => void launcher.reopen(value.key)} className={`${button} shrink-0 border-slate-300 bg-white`}>Reopen submission</button>
      </li>)}</ul>
    </section>}
      <fieldset disabled={locked || isDemoMode} className="space-y-5 disabled:opacity-60">
        <div><label className="mb-2 block text-sm font-medium text-slate-700">Repository</label><RepositorySelector repos={repoOptions} selectedRepo={repository} onRepoChange={value => { setDirty(true); setRepository(value); }} disabled={locked || isDemoMode} placeholder="Select a repository" /></div>
        <div><label htmlFor="task-instruction" className="mb-2 block text-sm font-medium text-slate-700">Prompt</label>
          <div className="rounded-md border border-slate-200 focus-within:border-teal-500 focus-within:ring-1 focus-within:ring-teal-500">
          <TextareaAutosize id="task-instruction" required maxLength={50000} value={instruction} onChange={event => setInstruction(event.target.value)} onPaste={event => {
            const incoming = clipboardImageFiles(event);
            if (!incoming.length || locked || processingFiles) return;
            event.preventDefault();
            setDirty(true);
            if (incoming.length + files.length > 10) { setError('Attach up to 10 files.'); return; }
            setProcessingFiles(true);
            void Promise.all(incoming.map(resizeImage)).then(processed => setFiles(current => [...current, ...processed]))
              .catch(() => setError('Could not process pasted images.')).finally(() => setProcessingFiles(false));
          }} minRows={6} maxRows={16} placeholder="Fix the invoice date format…" className="block w-full resize-none rounded-t-md border-none p-3 text-sm leading-6 focus:outline-none focus:ring-0" />
          <GoalAttachmentInput docked files={files} onFilesSelected={() => setDirty(true)} onChange={next => { setDirty(true); setFiles(next); }} onError={setError} onProcessingChange={setProcessingFiles} disabled={locked || processingFiles || isDemoMode} />
          </div>
        </div>
      </fieldset>
      <TaskRoutingOptions {...launcher} />
      <TaskSubmissionFeedback {...launcher} />
      </div>
      <TaskLauncherActions {...launcher} onCancel={() => void requestClose()} />
    </form>
  </CreationDialog>;
}
