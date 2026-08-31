import type { GoalDetailStatsV1 } from '../../api/goalContracts';
import { formatDuration, formatTokens } from '../../pages/goalsPageUtils';

export default function GoalStats({ stats }: { stats: GoalDetailStatsV1 }) {
  const items = [
    ['Issues', `${stats.issues.processed} processed · ${stats.issues.active} active · ${stats.issues.failed} failed · ${stats.issues.blocked} blocked`],
    ['PR readiness', `${stats.pullRequests.open} open · ${stats.pullRequests.reviewPending} review · ${stats.pullRequests.ultrafixPending} Ultrafix · ${stats.pullRequests.mergeReady} ready · ${stats.pullRequests.merged} merged`],
    ['Tokens', formatTokens(stats.tokens.total)],
    ['Time', `${formatDuration(stats.time.elapsedSeconds)} elapsed · ${formatDuration(stats.time.activeSeconds)} active · ${formatDuration(stats.time.pausedSeconds)} paused · ${formatDuration(stats.time.recoverySeconds)} recovery`],
  ];
  return (
    <section aria-labelledby="goal-stats-title" className="rounded-lg border border-slate-200 bg-white p-3">
      <h2 id="goal-stats-title" className="text-sm font-semibold text-slate-800">Statistics</h2>
      <dl className="mt-2 grid gap-2 sm:grid-cols-2">
        {items.map(([label, value]) => <div key={label} className="rounded bg-slate-50 p-2"><dt className="text-[10px] font-semibold uppercase text-slate-400">{label}</dt><dd className="mt-0.5 text-xs text-slate-700">{value}</dd></div>)}
      </dl>
      {stats.tokens.byModel.length > 0 && (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-left text-[11px] text-slate-600">
            <caption className="sr-only">Token usage by provider and model</caption>
            <thead><tr className="border-b"><th className="py-1 pr-2">Provider / model</th><th className="px-2 py-1">Input</th><th className="px-2 py-1">Output</th><th className="px-2 py-1">Cache</th><th className="px-2 py-1">Reasoning</th><th className="py-1 pl-2">Total</th></tr></thead>
            <tbody>{stats.tokens.byModel.map(row => <tr key={`${row.provider}:${row.model}`} className="border-b border-slate-100"><td className="py-1 pr-2 font-medium">{row.provider} / {row.model}</td><td className="px-2">{formatTokens(row.input)}</td><td className="px-2">{formatTokens(row.output)}</td><td className="px-2">{formatTokens(row.cacheRead + row.cacheWrite)}</td><td className="px-2">{formatTokens(row.reasoning)}</td><td className="pl-2">{formatTokens(row.total)}</td></tr>)}</tbody>
          </table>
        </div>
      )}
    </section>
  );
}
