import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronDown, ChevronRight, Loader2, Play, Trash2 } from 'lucide-react';
import { getScheduleDetail, type TaskSchedule, type TaskScheduleRun } from '../../../api/scheduleApi';
import { taskPath } from '../../../components/TaskList/rowModel';
import { SettingsStatus } from '../SettingsLayout';
import { RUN_STATUS_STYLES, errorMessage, formatScheduleTime, scheduleState } from './scheduleFormat';
import type { SchedulesState } from './useSchedules';

const ACTION_BUTTON = 'inline-flex items-center gap-1.5 rounded border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50';

function ScheduleStateBadge({ schedule }: { schedule: TaskSchedule }) {
  const state = scheduleState(schedule);
  if (state === 'enabled') return <SettingsStatus tone="ok">Active</SettingsStatus>;
  if (state === 'disabled') return <SettingsStatus tone="pending">Disabled</SettingsStatus>;
  return <SettingsStatus tone="warn">Paused</SettingsStatus>;
}

function ScheduleRuns({ scheduleId, version }: { scheduleId: string; version: number }) {
  const [runs, setRuns] = useState<TaskScheduleRun[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    getScheduleDetail(scheduleId)
      .then(detail => { if (active) { setRuns(detail.runs); setError(null); } })
      .catch(err => { if (active) setError(errorMessage(err)); });
    return () => { active = false; };
  }, [scheduleId, version]);

  if (error) return <p role="alert" className="text-[12px] text-red-700">Could not load runs: {error}</p>;
  if (!runs) return <p className="flex items-center gap-2 text-[12px] text-slate-500"><Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin" />Loading runs…</p>;
  if (runs.length === 0) return <p className="text-[12px] text-slate-500">No runs yet.</p>;

  return (
    <ul aria-label="Recent runs" className="divide-y divide-slate-100 rounded border border-slate-200">
      {runs.map(run => (
        <li key={run.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-[12px] text-slate-600">
          <span className={`rounded px-1.5 py-0.5 font-medium ${RUN_STATUS_STYLES[run.status] ?? 'bg-slate-100 text-slate-700'}`}>{run.status}</span>
          <span>{run.trigger === 'manual' ? 'Run now' : 'Scheduled'}</span>
          <span className="text-slate-500">{formatScheduleTime(run.createdAt)}</span>
          {run.taskId && <Link to={taskPath(run.taskId)} className="font-medium text-teal-700 hover:underline">View task</Link>}
          {run.reason && <span className="basis-full break-words text-slate-500">{run.reason}</span>}
        </li>
      ))}
    </ul>
  );
}

interface ScheduleRowProps {
  schedule: TaskSchedule;
  actions: Pick<SchedulesState, 'setEnabled' | 'remove' | 'runNow'>;
  onNotice(message: string | null, tone?: 'error' | 'success'): void;
}

function ScheduleRow({ schedule, actions, onNotice }: ScheduleRowProps) {
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState<'toggle' | 'run' | 'delete' | null>(null);
  const [runsVersion, setRunsVersion] = useState(0);
  const state = scheduleState(schedule);

  const perform = useCallback(async (kind: 'toggle' | 'run' | 'delete', action: () => Promise<string>) => {
    setBusy(kind);
    onNotice(null);
    try {
      onNotice(await action(), 'success');
    } catch (err) {
      onNotice(`${schedule.name}: ${errorMessage(err)}`, 'error');
    } finally {
      setBusy(null);
    }
  }, [onNotice, schedule.name]);

  const toggle = () => perform('toggle', async () => {
    await actions.setEnabled(schedule.id, !schedule.enabled);
    return `${schedule.name} ${schedule.enabled ? 'disabled' : 'enabled'}.`;
  });
  const runNow = () => perform('run', async () => {
    const run = await actions.runNow(schedule.id);
    setRunsVersion(version => version + 1);
    return run.status === 'skipped' ? `${schedule.name} skipped: ${run.reason || 'not admitted'}` : `${schedule.name} run started.`;
  });
  const remove = () => {
    if (!window.confirm(`Delete the schedule "${schedule.name}"? Tasks it already started are kept.`)) return;
    void perform('delete', async () => {
      await actions.remove(schedule.id);
      return `${schedule.name} deleted.`;
    });
  };

  const runsId = `schedule-runs-${schedule.id}`;
  return (
    <li className="py-4" data-testid="schedule-row">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <h5 className="text-sm font-medium text-slate-900">{schedule.name}</h5>
            <ScheduleStateBadge schedule={schedule} />
          </div>
          <p className="mt-1 text-[12px] text-slate-600">
            <span className="font-medium">{schedule.repository}</span>
            <span className="mx-1.5 text-slate-300">·</span>
            <code className="rounded bg-slate-100 px-1 py-0.5 text-[11px]">{schedule.cron}</code>
            <span className="ml-1">({schedule.timezone})</span>
            <span className="mx-1.5 text-slate-300">·</span>
            <span>by @{schedule.owner.username}</span>
          </p>
          <p className="mt-1 text-[12px] text-slate-500">
            Next run: {state === 'enabled' ? formatScheduleTime(schedule.nextRunAt) : '—'}
            <span className="mx-1.5 text-slate-300">·</span>
            Last run: {formatScheduleTime(schedule.lastRunAt)}
          </p>
          {state === 'paused' && <p className="mt-1 text-[12px] text-amber-800">{schedule.pausedReason}</p>}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="inline-flex cursor-pointer items-center gap-1.5 text-xs font-medium text-slate-700">
            <input type="checkbox" checked={schedule.enabled} disabled={busy !== null} onChange={() => void toggle()}
              aria-label={`Enable ${schedule.name}`} className="h-4 w-4 rounded border-slate-300 text-primary-600 focus:ring-primary-500" />
            Enabled
          </label>
          <button type="button" className={ACTION_BUTTON} disabled={busy !== null} onClick={() => void runNow()} aria-label={`Run ${schedule.name} now`}>
            {busy === 'run' ? <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin" /> : <Play aria-hidden="true" className="h-3.5 w-3.5" />}Run now
          </button>
          <button type="button" className={`${ACTION_BUTTON} hover:border-red-300 hover:text-red-700`} disabled={busy !== null} onClick={remove} aria-label={`Delete ${schedule.name}`}>
            <Trash2 aria-hidden="true" className="h-3.5 w-3.5" />Delete
          </button>
        </div>
      </div>
      <button type="button" aria-expanded={expanded} aria-controls={runsId} onClick={() => setExpanded(open => !open)}
        className="mt-2 inline-flex items-center gap-1 text-[12px] font-medium text-slate-600 hover:text-slate-900">
        {expanded ? <ChevronDown aria-hidden="true" className="h-3.5 w-3.5" /> : <ChevronRight aria-hidden="true" className="h-3.5 w-3.5" />}
        Recent runs
      </button>
      {expanded && <div id={runsId} className="mt-2"><ScheduleRuns scheduleId={schedule.id} version={runsVersion} /></div>}
    </li>
  );
}

export function ScheduleList({ schedules, actions, onNotice }: {
  schedules: TaskSchedule[];
  actions: ScheduleRowProps['actions'];
  onNotice: ScheduleRowProps['onNotice'];
}) {
  if (schedules.length === 0) {
    return <p className="max-w-2xl text-[12px] text-slate-500">No scheduled tasks yet.</p>;
  }
  return (
    <ul aria-label="Scheduled tasks" className="max-w-3xl divide-y divide-slate-200 border-y border-slate-200">
      {schedules.map(schedule => <ScheduleRow key={schedule.id} schedule={schedule} actions={actions} onNotice={onNotice} />)}
    </ul>
  );
}
