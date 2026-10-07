import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { History, Loader2, RotateCcw, X } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { getPlanRevision, listPlanRevisions, type PlanRevision, type PlanRevisionSummary } from '../../api/proprApi';
import { describeRevision, describeRevisionCause } from './planRevisionLabels';
import { getOutlineTitle } from './planDisplayName';

interface PlanHistoryDialogProps {
  isOpen: boolean;
  draftId: string;
  onClose: () => void;
  onRestore: (revisionId: number) => Promise<void>;
  isReadOnly?: boolean;
}

// SQLite CURRENT_TIMESTAMP is UTC without a timezone suffix.
const parseTimestamp = (value: string) => new Date(/Z|[+-]\d{2}:?\d{2}$/.test(value) ? value : `${value.replace(' ', 'T')}Z`);

export const PlanHistoryDialog: React.FC<PlanHistoryDialogProps> = ({ isOpen, draftId, onClose, onRestore, isReadOnly = false }) => {
  const dialogRef = useRef<HTMLDivElement>(null);
  const previewRequest = useRef(0);
  const [revisions, setRevisions] = useState<PlanRevisionSummary[] | null>(null);
  const [selected, setSelected] = useState<PlanRevision | null>(null);
  const [loadingId, setLoadingId] = useState<number | null>(null);
  const [isRestoring, setIsRestoring] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Invalidate the previous dialog session before the new draft can be used.
  useLayoutEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    setRevisions(null);
    setSelected(null);
    setLoadingId(null);
    setIsRestoring(false);
    setError(null);
    listPlanRevisions(draftId)
      .then(result => { if (!cancelled) setRevisions(result); })
      .catch(err => { if (!cancelled) setError((err as Error).message || 'Failed to load plan history'); });
    return () => {
      cancelled = true;
      previewRequest.current += 1;
    };
  }, [draftId, isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => { if (e.key === 'Escape' && !isRestoring) onClose(); };
    document.body.style.overflow = 'hidden';
    document.addEventListener('keydown', handleKeyDown);
    dialogRef.current?.focus();
    return () => {
      document.body.style.overflow = '';
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen, isRestoring, onClose]);

  const select = useCallback(async (revisionId: number) => {
    const request = ++previewRequest.current;
    setSelected(null);
    setLoadingId(revisionId);
    setError(null);
    try {
      const revision = await getPlanRevision(draftId, revisionId);
      if (request === previewRequest.current) setSelected(revision);
    } catch (err) {
      if (request === previewRequest.current) setError((err as Error).message || 'Failed to load plan version');
    } finally {
      if (request === previewRequest.current) setLoadingId(null);
    }
  }, [draftId]);

  const restore = async () => {
    if (!selected || loadingId !== null || isRestoring || isReadOnly) return;
    const request = previewRequest.current;
    setIsRestoring(true);
    setError(null);
    try {
      await onRestore(selected.revision_id);
    } catch (err) {
      if (request === previewRequest.current) setError((err as Error).message || 'Failed to restore plan version');
    } finally {
      if (request === previewRequest.current) setIsRestoring(false);
    }
  };

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4"
          onClick={(e) => { if (e.target === e.currentTarget && !isRestoring) onClose(); }}
        >
          <motion.div
            ref={dialogRef}
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.95 }}
            transition={{ duration: 0.15 }}
            className="bg-white rounded-lg max-w-3xl w-full max-h-[85vh] flex flex-col border border-gray-300 shadow-lg"
            tabIndex={-1}
            role="dialog"
            aria-modal="true"
            aria-labelledby="plan-history-dialog-title"
          >
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200">
              <h3 id="plan-history-dialog-title" className="flex items-center gap-2 text-lg font-semibold text-gray-900">
                <History size={18} className="text-gray-600" />
                Plan history
              </h3>
              <button type="button" onClick={onClose} disabled={isRestoring} className="p-1.5 rounded hover:bg-gray-100 disabled:opacity-50" title="Close">
                <X size={18} className="text-gray-600" />
              </button>
            </div>

            <div className="flex flex-col md:flex-row min-h-0 flex-1 overflow-hidden">
              <ul className="md:w-72 md:border-r border-b md:border-b-0 border-gray-200 overflow-y-auto max-h-48 md:max-h-none flex-shrink-0" aria-label="Earlier plan versions">
                {revisions === null && !error && (
                  <li className="flex items-center gap-2 px-4 py-3 text-sm text-gray-500"><Loader2 size={14} className="animate-spin" />Loading…</li>
                )}
                {revisions?.length === 0 && (
                  <li className="px-4 py-3 text-sm text-gray-500">No earlier versions yet. Each generation, refinement or edit keeps the plan it replaces.</li>
                )}
                {revisions?.map(revision => (
                  <li key={revision.revision_id}>
                    <button
                      type="button"
                      onClick={() => void select(revision.revision_id)}
                      disabled={isRestoring}
                      aria-current={selected?.revision_id === revision.revision_id}
                      className={`w-full text-left px-4 py-3 border-b border-gray-100 hover:bg-gray-50 ${selected?.revision_id === revision.revision_id ? 'bg-teal-50' : ''}`}
                    >
                      <div className="flex items-center justify-between gap-2 text-sm font-medium text-gray-900">
                        <span>{describeRevision(revision)}</span>
                        {loadingId === revision.revision_id && <Loader2 size={12} className="animate-spin text-gray-500" />}
                      </div>
                      <div className="mt-1 text-xs font-medium text-teal-700">{describeRevisionCause(revision.cause)}</div>
                      <div className="text-xs text-gray-500">
                        {parseTimestamp(revision.replaced_at).toLocaleString()} · {revision.issue_count} {revision.issue_count === 1 ? 'task' : 'tasks'}
                      </div>
                    </button>
                  </li>
                ))}
              </ul>

              <div className="flex-1 overflow-y-auto p-4 min-h-0">
                {selected ? (
                  <ol className="space-y-3">
                    {selected.plan.map((task, index) => (
                      <li key={task.id ?? index} className="border border-gray-200 rounded-md p-3">
                        <div className="text-sm font-semibold text-gray-900">{index + 1}. {getOutlineTitle(task.title)}</div>
                        <p className="mt-1 text-xs text-gray-600 whitespace-pre-wrap line-clamp-6">{task.body}</p>
                      </li>
                    ))}
                  </ol>
                ) : (
                  <p className="text-sm text-gray-500">Select a version to see its tasks.</p>
                )}
              </div>
            </div>

            {error && <div className="px-5 py-2 text-sm text-red-700 bg-red-50 border-t border-red-200" role="alert">{error}</div>}

            <div className="flex items-center justify-between gap-3 px-5 py-3 border-t border-gray-200 bg-gray-50 rounded-b-lg">
              <p className="text-xs text-gray-500">Restoring keeps the current plan in this history.</p>
              <button
                type="button"
                onClick={() => void restore()}
                disabled={!selected || loadingId !== null || isRestoring || isReadOnly}
                title={isReadOnly ? 'Demo mode is read-only' : undefined}
                className="px-4 py-2 text-sm font-medium text-white bg-teal-700 rounded-md hover:bg-teal-800 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
              >
                {isRestoring ? <Loader2 size={14} className="animate-spin" /> : <RotateCcw size={14} />}
                Restore this version
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
};

export default PlanHistoryDialog;
