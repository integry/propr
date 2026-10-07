import React from 'react';
import { Github, Loader2 } from 'lucide-react';

const FinalizeButtonContent: React.FC<{ isReadOnly: boolean; isFinalizing: boolean; planLength: number }> = ({
  isReadOnly,
  isFinalizing,
  planLength
}) => {
  if (isReadOnly) {
    return (
      <>
        <Github size={14} />
        Read-only Demo
      </>
    );
  }

  if (isFinalizing) {
    return (
      <>
        <Loader2 size={14} className="animate-spin" />
        Creating Issues...
      </>
    );
  }

  return (
    <>
      <Github size={14} />
      Create {planLength} GitHub {planLength === 1 ? 'Issue' : 'Issues'}
    </>
  );
};

/** The document-level primary action, kept in the header's action cluster like a PR's merge button. */
export const FinalizeButton: React.FC<{ planLength: number; isFinalizing: boolean; isReadOnly: boolean; onFinalize: () => void }> = ({
  planLength,
  isFinalizing,
  isReadOnly,
  onFinalize
}) => (
  <button
    type="button"
    onClick={onFinalize}
    disabled={isFinalizing || planLength === 0 || isReadOnly}
    title={isReadOnly ? 'Demo mode is read-only' : undefined}
    className="flex items-center gap-1.5 whitespace-nowrap rounded-md bg-[rgb(29,138,138)] px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-[rgb(24,118,118)] disabled:cursor-not-allowed disabled:bg-slate-300"
  >
    <FinalizeButtonContent isReadOnly={isReadOnly} isFinalizing={isFinalizing} planLength={planLength} />
  </button>
);
