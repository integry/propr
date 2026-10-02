import React from 'react';
import { GitCommitHorizontal } from 'lucide-react';
import type { ParsedGoalCheckpointOutput } from '@propr/shared';
import { renderMarkdown } from './renderMarkdown';
import type { CheckpointOutcome, PreparedThinkingLogEvent } from './checkpointLog';

const gutterLabelRow = 'flex min-h-[1.4219rem] items-center gap-1.5';

const checkpointStateLabel = (outcome: CheckpointOutcome | undefined): string => {
  // The goal API exposes only its latest durable checkpoint. An unmatched declaration may be an
  // older published checkpoint rather than a still-pending request, so keep this fallback neutral.
  if (!outcome) return 'Checkpoint request';
  if (outcome.state === 'processing') return 'Publishing checkpoint';
  if (outcome.state === 'completed') return outcome.commitSha ? 'Checkpoint published' : 'Checkpoint completed';
  if (outcome.state === 'failed') return 'Checkpoint failed';
  if (outcome.state === 'rejected') return 'Checkpoint rejected';
  if (outcome.state === 'skipped') return 'Checkpoint skipped';
  return 'Checkpoint queued';
};

export const CheckpointLogEntry: React.FC<{
  event: PreparedThinkingLogEvent;
  checkpoint: ParsedGoalCheckpointOutput;
}> = ({ event, checkpoint }) => {
  const declaration = checkpoint.declaration;
  if ('rejected' in declaration) {
    return (
      <div data-testid="goal-checkpoint-rejected-event" className="border-b border-slate-200 bg-slate-50/70 py-3 last:border-b-0">
        <div className="flex items-start gap-3">
          <div className="flex w-[100px] flex-shrink-0 flex-col items-start">
            <div className={gutterLabelRow}>
              <GitCommitHorizontal className="h-3 w-3 text-slate-500" />
              <span className="font-mono text-[11px] font-bold uppercase tracking-tighter text-slate-600">CHECKPOINT</span>
            </div>
            {event.relativeTime && <span className="ml-[18px] mt-0.5 font-mono text-[10px] text-slate-500">{event.relativeTime}</span>}
          </div>
          <div className="min-w-0 flex-1 overflow-hidden border-l-2 border-slate-400 bg-white/70 px-3 py-2">
            {checkpoint.remainder && (
              <div className="mb-2 break-words text-sm leading-relaxed text-slate-700">{renderMarkdown(checkpoint.remainder)}</div>
            )}
            <p className="m-0 text-[10px] font-bold uppercase tracking-widest text-slate-600">Checkpoint rejected</p>
            {declaration.message && <p className="mt-1 break-words font-mono text-[13px] font-semibold leading-relaxed text-slate-700">{declaration.message}</p>}
            <p role="status" className="mt-1 break-words text-sm leading-relaxed text-slate-600">{declaration.error}</p>
          </div>
        </div>
      </div>
    );
  }

  const scope = [
    declaration.include ? `${declaration.include.length} included` : 'All changed files',
    declaration.exclude?.length ? `${declaration.exclude.length} excluded` : null,
  ].filter(Boolean).join(' · ');
  const outcome = event.checkpointOutcome;

  return (
    <div data-testid="goal-checkpoint-event" className="border-b border-emerald-100 bg-emerald-50/40 py-3 last:border-b-0">
      <div className="flex items-start gap-3">
        <div className="flex w-[100px] flex-shrink-0 flex-col items-start">
          <div className={gutterLabelRow}>
            <GitCommitHorizontal className="h-3 w-3 text-emerald-600" />
            <span className="font-mono text-[11px] font-bold uppercase tracking-tighter text-emerald-700">CHECKPOINT</span>
          </div>
          {event.relativeTime && <span className="ml-[18px] mt-0.5 font-mono text-[10px] text-slate-500">{event.relativeTime}</span>}
        </div>
        <div className="min-w-0 flex-1 overflow-hidden border-l-2 border-emerald-500 bg-white/70 px-3 py-2">
          {checkpoint.remainder && (
            <div className="mb-2 break-words text-sm leading-relaxed text-slate-700">{renderMarkdown(checkpoint.remainder)}</div>
          )}
          <p className="m-0 text-[10px] font-bold uppercase tracking-widest text-emerald-700">{checkpointStateLabel(outcome)}</p>
          <p className="mt-1 break-words font-mono text-[13px] font-semibold leading-relaxed text-slate-800">{declaration.message}</p>
          {declaration.summary && <p className="mt-1 whitespace-pre-wrap break-words text-sm leading-relaxed text-slate-600">{declaration.summary}</p>}
          <p className="mt-2 text-[11px] font-medium text-emerald-700">{scope}</p>
          {outcome?.commitSha && (
            <p className="mt-1 text-[11px] text-slate-500">Published commit <code className="font-mono text-slate-700">{outcome.commitSha}</code></p>
          )}
          {outcome?.error && <p role="status" className="mt-2 rounded bg-red-50 p-2 text-sm text-red-700">{outcome.error}</p>}
        </div>
      </div>
    </div>
  );
};
