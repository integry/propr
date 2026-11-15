import { RefreshCw } from 'lucide-react';
import type { PluginDeliveryView, PluginHealthView } from '../../api/pluginsApi';
import { buttonClass, primaryButtonClass } from './pluginUi';
import type { usePluginActivity } from './usePluginActivity';

type Activity = ReturnType<typeof usePluginActivity>;

const STATUS: Record<PluginDeliveryView['status'], { label: string; className: string }> = {
  pending: { label: 'Pending', className: 'bg-slate-100 text-slate-700' },
  running: { label: 'Running', className: 'bg-sky-50 text-sky-800' },
  retrying: { label: 'Retrying', className: 'bg-amber-100 text-amber-900' },
  succeeded: { label: 'Succeeded', className: 'bg-teal-50 text-teal-800' },
  failed: { label: 'Failed', className: 'bg-red-50 text-red-800' },
  skipped: { label: 'Skipped', className: 'bg-slate-200 text-slate-700' },
};
const time = (ms: number) => new Date(ms).toLocaleString();
const duration = (ms: number) => (ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);

/** Degraded or Paused next to the plugin's state badge; nothing while deliveries are healthy. */
export function PluginHealthBadge({ health }: { health: PluginHealthView | undefined }) {
  if (!health || health.state === 'healthy') return null;
  const paused = health.state === 'paused';
  return (
    <span data-testid="plugin-health" data-state={health.state}
      className={`inline-flex items-center rounded px-1.5 py-0.5 text-[11px] leading-4 font-semibold uppercase tracking-wide ${paused ? 'bg-red-100 text-red-900' : 'bg-red-50 text-red-800'}`}>
      {paused ? 'Paused' : 'Degraded'}
    </span>
  );
}

/** Degraded: repeated failures, with the last error. Paused: deliveries stopped until Resume. */
function HealthNotice({ health, busy, onResume }: { health: PluginHealthView; busy: boolean; onResume: () => void }) {
  if (health.state === 'healthy') return null;
  const paused = health.state === 'paused';
  return (
    <div data-testid="plugin-health-notice" data-state={health.state} className={`space-y-2 rounded-md p-3 text-sm ${paused ? 'bg-red-50 text-red-900' : 'bg-amber-50 text-amber-900'}`}>
      <p className="font-medium">
        {paused
          ? `Deliveries are paused after ${health.consecutiveFailures} failures in a row. New events wait until you resume.`
          : `Degraded: ${health.consecutiveFailures} deliveries failed in a row. Deliveries pause after ${health.pauseAfterFailures}.`}
      </p>
      {health.lastError && <p className="[overflow-wrap:anywhere]">Last error{health.lastErrorAt ? ` (${time(health.lastErrorAt)})` : ''}: {health.lastError}</p>}
      {paused && <button type="button" className={primaryButtonClass} disabled={busy} onClick={onResume}>Resume deliveries</button>}
    </div>
  );
}

function DeliveryItem({ delivery, busy, onRetry }: { delivery: PluginDeliveryView; busy: boolean; onRetry: () => void }) {
  const status = STATUS[delivery.status];
  const gap = delivery.kind === 'gap';
  return (
    <li data-testid="plugin-delivery" data-status={delivery.status} className="space-y-1 border-t border-slate-100 py-3 first:border-t-0">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="font-medium text-slate-900 [overflow-wrap:anywhere]">{gap ? 'Events not delivered' : delivery.eventType}</span>
        {delivery.handler && <code className="rounded bg-slate-100 px-1 text-xs text-slate-700">{delivery.handler}</code>}
        <span className={`rounded px-1.5 py-0.5 text-[11px] leading-4 font-semibold uppercase tracking-wide ${status.className}`}>{status.label}</span>
        {delivery.status === 'failed' && !gap && (
          <button type="button" className={`${buttonClass} ml-auto`} disabled={busy} onClick={onRetry} aria-label={`Retry ${delivery.eventType} to ${delivery.handler}`}>Retry</button>
        )}
      </div>
      <p className="flex flex-wrap gap-x-3 text-xs text-slate-500">
        <span>{time(delivery.startedAt ?? delivery.createdAt)}</span>
        <span className="[overflow-wrap:anywhere]">{delivery.repository}</span>
        {!gap && <span>Event #{delivery.eventSeq}</span>}
        {!gap && <span>Attempt {delivery.attempt}</span>}
        {delivery.durationMs !== null && <span>{duration(delivery.durationMs)}{delivery.timedOut ? ' (timed out)' : ''}</span>}
        {delivery.nextAttemptAt !== null && delivery.status === 'retrying' && <span>Next attempt {time(delivery.nextAttemptAt)}</span>}
      </p>
      {delivery.error && <p className={`text-xs [overflow-wrap:anywhere] ${gap ? 'text-slate-600' : 'text-red-800'}`}>{delivery.error}</p>}
      {delivery.logs.length > 0 && (
        <details className="text-xs">
          <summary className="cursor-pointer text-slate-600">Log ({delivery.logs.length} {delivery.logs.length === 1 ? 'line' : 'lines'})</summary>
          <ol className="mt-1 space-y-0.5 rounded bg-slate-50 p-2 font-mono text-[11px] text-slate-700">
            {delivery.logs.map((line, index) => <li key={index} className="[overflow-wrap:anywhere]"><span className="uppercase text-slate-500">{line.level}</span> {line.message}</li>)}
          </ol>
        </details>
      )}
    </li>
  );
}

/**
 * Activity: each event delivered to the plugin's handlers and its result, newest first, with Retry for a failed
 * delivery, and the plugin's delivery health with Resume once deliveries are paused.
 */
export function PluginActivity({ activity: state }: { activity: Activity }) {
  const { activity, error, notice, busy } = state;
  return (
    <section aria-labelledby="plugin-activity" data-testid="plugin-activity" className="space-y-3 rounded-lg border border-slate-200 bg-white p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="plugin-activity" className="text-base font-semibold text-slate-900">Activity</h2>
        <button type="button" className={buttonClass} onClick={() => void state.refresh()}>
          <RefreshCw aria-hidden="true" className="mr-1 inline h-4 w-4" />Refresh
        </button>
      </div>
      {error && <p role="alert" className="rounded-md bg-red-50 p-3 text-sm text-red-800 [overflow-wrap:anywhere]">{error}</p>}
      {notice && <p role="status" className="text-sm text-teal-800">{notice}</p>}
      {activity && <HealthNotice health={activity.health} busy={busy !== null} onResume={() => void state.resume()} />}
      {!activity && !error && <p className="text-sm text-slate-500">Loading activity…</p>}
      {activity && !activity.deliveries.length && (
        <p className="text-sm text-slate-500">No activity yet. Each event delivered to the plugin and its result is listed here.</p>
      )}
      {activity && activity.deliveries.length > 0 && (
        <ul aria-label="Deliveries" className="text-sm text-slate-700">
          {activity.deliveries.map(delivery => (
            <DeliveryItem key={delivery.id} delivery={delivery} busy={busy !== null} onRetry={() => void state.retry(delivery.id)} />
          ))}
        </ul>
      )}
      <p className="text-xs text-slate-500">Records are kept for 14 days. They hold the event id and type, never its contents.</p>
    </section>
  );
}
