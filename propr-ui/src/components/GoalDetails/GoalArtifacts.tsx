import { ExternalLink } from 'lucide-react';
import type { GoalPassiveArtifacts } from '../../api/goalContracts';

const safeUrl = (value: string): string | null => {
  try { return new URL(value).protocol === 'https:' ? value : null; } catch { return null; }
};

export default function GoalArtifacts({ artifacts }: { artifacts: GoalPassiveArtifacts }) {
  const finalUrl = artifacts.finalPullRequest ? safeUrl(artifacts.finalPullRequest.url) : null;
  return (
    <section aria-labelledby="goal-artifacts-title" className="rounded-lg border border-slate-200 bg-white p-3">
      <h2 id="goal-artifacts-title" className="text-sm font-semibold text-slate-800">Associated GitHub artifacts</h2>
      <p className="mt-1 text-[11px] text-slate-500">Passively observed from the coding agent&apos;s work; these are not a ProPR work hierarchy.</p>
      <dl className="mt-2 grid grid-cols-2 gap-2 text-xs">
        <div className="rounded bg-slate-50 p-2"><dt className="text-[10px] uppercase text-slate-400">Issues</dt><dd>{artifacts.issues.total} total · {artifacts.issues.open} open · {artifacts.issues.closed} closed</dd></div>
        <div className="rounded bg-slate-50 p-2"><dt className="text-[10px] uppercase text-slate-400">Pull requests</dt><dd>{artifacts.pullRequests.total} total · {artifacts.pullRequests.open} open · {artifacts.pullRequests.draft} draft · {artifacts.pullRequests.merged} merged</dd></div>
      </dl>
      {artifacts.finalPullRequest && <p className="mt-2 text-xs text-slate-600">Final PR #{artifacts.finalPullRequest.number} · {artifacts.finalPullRequest.draft ? 'draft for human approval' : 'not draft'}{finalUrl && <a href={finalUrl} target="_blank" rel="noopener noreferrer" className="ml-2 inline-flex items-center gap-1 font-medium text-teal-700">Open<ExternalLink className="h-3 w-3" aria-hidden="true" /></a>}</p>}
    </section>
  );
}
