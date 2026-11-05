import React, { useEffect } from 'react';
import { Loader2 } from 'lucide-react';

interface AgentDeleteDialogProps {
  name: string;
  deleting: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/** Destructive actions get a centered modal; Escape cancels. */
export const AgentDeleteDialog: React.FC<AgentDeleteDialogProps> = ({ name, deleting, onConfirm, onCancel }) => {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || deleting) return;
      event.preventDefault();
      onCancel();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [deleting, onCancel]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4">
      <div role="dialog" aria-modal="true" aria-labelledby="agent-delete-title" className="w-full max-w-md rounded-lg border border-slate-200 bg-white shadow-2xl">
        <div className="px-5 py-4">
          <h2 id="agent-delete-title" className="text-base font-semibold text-slate-900">Delete automation?</h2>
          <p className="mt-2 text-sm text-slate-600">
            <span className="font-medium text-slate-900">{name}</span>, its input files and its run history will be removed. This cannot be undone.
          </p>
        </div>
        <div className="flex justify-end gap-2 border-t border-slate-200 bg-slate-50 px-5 py-3">
          <button
            type="button"
            onClick={onCancel}
            disabled={deleting}
            className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-500"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={deleting}
            className="inline-flex items-center gap-1.5 rounded-md bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-500 disabled:opacity-60"
          >
            {deleting && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
            Delete agent
          </button>
        </div>
      </div>
    </div>
  );
};
