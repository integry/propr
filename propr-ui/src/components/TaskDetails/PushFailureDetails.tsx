import React from 'react';
import type { HistoryItemMetadata, PushRejectionClass } from './types';

const CLASSIFICATION_LABELS: Record<PushRejectionClass, string> = {
  push_protection: 'Secret scanning push protection',
  ruleset_or_branch_protection: 'Ruleset or branch protection',
  non_fast_forward: 'Non-fast-forward',
  auth: 'Authentication / permission',
  network: 'Network error',
  unknown: 'Unknown reason',
};

const formatPushRejectionClass = (classification: string): string =>
  CLASSIFICATION_LABELS[classification as PushRejectionClass] ?? classification;

/** Renders `code` spans from the backtick-quoted recovery instruction. */
const InlineCode: React.FC<{ text: string }> = ({ text }) => (
  <>
    {text.split('`').map((part, index) => index % 2 === 1
      ? <code key={index} className="break-all rounded bg-slate-100 px-1 font-mono text-[11px] text-slate-800">{part}</code>
      : <React.Fragment key={index}>{part}</React.Fragment>)}
  </>
);

/** Why a final push was rejected and where the salvage ladder kept the commits.
 * Spans only, so it can sit inside the branch variant's inline step rows. */
const PushFailureDetails: React.FC<{ metadata?: HistoryItemMetadata }> = ({ metadata }) => {
  const failure = metadata?.pushFailure;
  if (failure) {
    const { diagnosis } = failure;
    return (
      <span className="mt-1.5 block rounded border border-red-200 bg-red-50 px-2.5 py-2 text-xs leading-5" data-testid="push-failure">
        <span className="block font-medium text-red-800">
          Push rejected: {formatPushRejectionClass(diagnosis.classification)}
          <span className="ml-1 font-mono text-[10px] font-normal text-red-600">{diagnosis.classification}</span>
        </span>
        <span className="mt-0.5 block break-words text-slate-700">{diagnosis.summary}</span>
        {diagnosis.unblockUrls.length > 0 && (
          <span className="mt-1 block" data-testid="push-failure-unblock">
            <span className="font-medium text-slate-800">Unblock URL:</span>
            {diagnosis.unblockUrls.map(url => (
              <a key={url} href={url} target="_blank" rel="noopener noreferrer" className="block break-all text-blue-700 hover:underline">{url}</a>
            ))}
          </span>
        )}
        <span className="mt-1 block break-words text-slate-700" data-testid="push-failure-recovery">
          <span className="font-medium text-slate-800">Recovery: </span>
          <InlineCode text={failure.recoveryInstruction} />
        </span>
      </span>
    );
  }
  const salvage = metadata?.pushSalvage;
  // A salvage timeline entry already uses the summary as its label.
  if (!salvage || metadata?.description === salvage.summary) return null;
  return (
    <span className="mt-1 block break-words text-xs text-slate-500" data-testid="push-salvage">
      {salvage.summary}
    </span>
  );
};

export default PushFailureDetails;
