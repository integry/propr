import React, { useState, useEffect, useId, useRef } from 'react';
import { AlertTriangle, Loader2 } from 'lucide-react';
import type { PostFollowupResponse } from '../../api/proprApi';
import { inertOutside, WINDOW_CHROME_SELECTOR } from '../../utils/modalBackground';
import { useVisualViewportFrame } from '../../hooks/useVisualViewportFrame';
import type { FollowupTarget } from './types';
import { describeFollowupTarget } from './taskKind';

/** The server's receipt for a follow-up it did not confirm, kept verbatim for the dialog. */
export type FollowupReceipt = Pick<PostFollowupResponse, 'state' | 'posted' | 'commentId' | 'jobId' | 'message'>;

/** Thrown by `onSubmit` when the server answered with a receipt that is not a success. */
export class FollowupReceiptError extends Error {
  readonly receipt: FollowupReceipt;

  constructor(receipt: FollowupReceipt) {
    super(receipt.message || 'Follow-up was not confirmed.');
    this.name = 'FollowupReceiptError';
    this.receipt = receipt;
  }
}

interface FollowupModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (body: string) => Promise<void>;
  initialContent: string;
  /**
   * The thread the API resolved for the task ID `onSubmit` posts for. Without
   * one the dialog names no thread and does not post.
   */
  target: FollowupTarget | null;
}

interface Feedback {
  title: string;
  message: string;
  receipt?: FollowupReceipt;
  /**
   * The text that may already be on GitHub. Until it is edited, posting it
   * again could add a second identical comment, so Post Comment stays off.
   */
  postedBody?: string;
}

/**
 * Reads a failed submission. A receipt saying the comment was posted, or one
 * with no clear answer, means GitHub may already hold the comment; an error
 * without a receipt cannot say whether the comment was created either.
 */
function feedbackFor(error: unknown, body: string): Feedback {
  if (error instanceof FollowupReceiptError) {
    const { receipt } = error;
    const message = receipt.message || 'The follow-up was not confirmed.';
    if (receipt.posted === false) return { title: 'Follow-up was not posted', message, receipt };
    if (receipt.state === 'unknown' || receipt.posted === undefined) {
      return { title: 'Comment posted, but submission is unconfirmed', message, receipt, postedBody: body };
    }
    return { title: 'Comment posted, but the command was not submitted', message, receipt, postedBody: body };
  }
  const message = error instanceof Error && error.message ? error.message : 'Failed to post comment';
  return { title: 'Follow-up outcome unknown', message: `${message} The comment may still have been posted.`, postedBody: body };
}

const FOCUSABLE = 'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [href], [tabindex]:not([tabindex="-1"])';

/** The dialog's controls Tab can reach now, enabled and not hidden, in document order. */
const tabbableIn = (dialog: HTMLElement) => Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE))
  .filter(element => !element.closest('[hidden], [inert]') && (typeof element.checkVisibility !== 'function' || element.checkVisibility()))
  .sort((a, b) => a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1);

const sameBody = (a: string, b: string) => a.trim() === b.trim();

const ReceiptDetails: React.FC<{ receipt?: FollowupReceipt }> = ({ receipt }) => {
  if (!receipt || (!receipt.state && receipt.commentId === undefined && !receipt.jobId)) return null;
  return (
    <dl className="flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-red-800" aria-label="Submission receipt">
      {receipt.state && <div className="flex gap-1"><dt>State</dt><dd className="font-mono">{receipt.state}</dd></div>}
      {receipt.commentId !== undefined && <div className="flex gap-1"><dt>Comment</dt><dd className="font-mono">{receipt.commentId}</dd></div>}
      {receipt.jobId && <div className="flex min-w-0 gap-1"><dt>Job</dt><dd className="font-mono break-all">{receipt.jobId}</dd></div>}
    </dl>
  );
};

interface FollowupFeedbackProps {
  feedback: Feedback;
  titleId: string;
  retryHintId: string;
  duplicateBlocked: boolean;
}

/**
 * The result of a submission, between the comment and the actions so it is
 * never scrolled out of view with the comment. It holds focus when it appears.
 */
const FollowupFeedback = React.forwardRef<HTMLDivElement, FollowupFeedbackProps>(({ feedback, titleId, retryHintId, duplicateBlocked }, ref) => (
  <div
    ref={ref}
    role="alert"
    tabIndex={-1}
    aria-labelledby={titleId}
    data-testid="followup-feedback"
    className="flex-none max-h-[40%] overflow-y-auto border-t border-red-200 bg-red-50 px-3 py-3 sm:px-4 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-red-500 [@media(max-height:26rem)]:max-h-none [@media(max-height:26rem)]:overflow-visible"
  >
    <div className="flex items-start gap-2">
      <AlertTriangle size={16} className="mt-0.5 flex-none text-red-600" aria-hidden="true" />
      <div className="min-w-0 space-y-1 text-sm text-red-700">
        <p id={titleId} className="font-semibold">{feedback.title}</p>
        <p className="break-words">{feedback.message}</p>
        <ReceiptDetails receipt={feedback.receipt} />
        {feedback.postedBody !== undefined && (
          <p id={retryHintId} className="text-red-800">
            {duplicateBlocked
              ? 'Posting the same text again could add a duplicate comment on GitHub. Check the task’s GitHub thread first, then edit the comment to post a new one.'
              : 'The comment was edited; Post Comment will add it as a new comment.'}
          </p>
        )}
      </div>
    </div>
  </div>
));
FollowupFeedback.displayName = 'FollowupFeedback';

const FollowupModal: React.FC<FollowupModalProps> = ({
  isOpen,
  onClose,
  onSubmit,
  initialContent,
  target
}) => {
  const [content, setContent] = useState(initialContent);
  const [submitting, setSubmitting] = useState(false);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const submittingRef = useRef(false);
  const feedbackRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const layerRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  const feedbackTitleId = useId();
  const retryHintId = useId();
  const textareaId = useId();

  // Reset content and state when modal opens - ensures fresh content each time
  useEffect(() => {
    if (isOpen) {
      setContent(initialContent);
      setFeedback(null);
      setSubmitting(false);
      submittingRef.current = false;
    }
  }, [isOpen, initialContent]);

  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const submittingStateRef = useRef(submitting);
  submittingStateRef.current = submitting;

  // While open, the task workspace behind the dialog is inert (desktop window
  // controls stay usable) and Tab cycles through the dialog's controls. The
  // opener is read before the Comment field takes focus, and gets it back on
  // close unless focus has meanwhile moved somewhere else that still exists.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!isOpen || !dialog) return;
    const active = document.activeElement;
    const opener = active instanceof HTMLElement && active !== document.body && !dialog.contains(active) ? active : null;
    const restoreBackground = inertOutside(dialog);
    textareaRef.current?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (!submittingStateRef.current) closeRef.current();
        return;
      }
      if (event.key !== 'Tab' || event.defaultPrevented) return;
      const current = document.activeElement;
      if (current instanceof Element && current.closest(WINDOW_CHROME_SELECTOR)) return;
      // Moved by hand, so a focused result or a control just disabled by a
      // submission still steps to its neighbour inside the dialog.
      event.preventDefault();
      const tabbable = tabbableIn(dialog);
      if (!tabbable.length) { dialog.focus(); return; }
      const from = current && dialog.contains(current) ? current : null;
      const next = event.shiftKey
        ? (from && tabbable.filter(element => from.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_PRECEDING).pop()) || tabbable[tabbable.length - 1]
        : (from && tabbable.find(element => from.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING)) || tabbable[0];
      next.focus();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      restoreBackground();
      const focused = document.activeElement;
      const focusLeftWithDialog = !focused || focused === document.body || !focused.isConnected || dialog.contains(focused);
      if (opener?.isConnected && focusLeftWithDialog) opener.focus();
    };
  }, [isOpen]);

  // A new result takes focus, so it is both seen and announced wherever the user was.
  useEffect(() => {
    if (!feedback) return;
    feedbackRef.current?.focus({ preventScroll: true });
    feedbackRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [feedback]);

  // An on-screen keyboard pans the visible area below the layer's top; the layer follows it.
  useVisualViewportFrame(layerRef, isOpen);

  if (!isOpen) return null;

  const duplicateBlocked = feedback?.postedBody !== undefined && sameBody(content, feedback.postedBody);

  const handleSubmit = async () => {
    if (submittingRef.current || duplicateBlocked || !target) return;
    if (!content.trim()) {
      setFeedback({ title: 'Nothing to post', message: 'Please enter a comment.' });
      return;
    }

    const body = content;
    try {
      submittingRef.current = true;
      setSubmitting(true);
      setFeedback(null);
      await onSubmit(body);
      onClose();
    } catch (err) {
      setFeedback(feedbackFor(err, body));
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };


  // The dialog fills the viewport's height at most; the comment field gives up
  // space first, so the result and the actions below it stay on screen. On a
  // very short viewport (a zoomed window or a landscape phone) the whole
  // dialog scrolls instead, keeping each part reachable. Framed to a keyboard
  // band, the layer's padding shrinks so a band too short for the usual inset
  // (65px on a landscape phone) still holds a whole 44px control.
  return (
    <div ref={layerRef} className="app-modal-layer fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-2 sm:p-4 data-[visual-viewport=clipped]:p-1">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        tabIndex={-1}
        data-testid="followup-dialog"
        className="bg-white rounded-lg max-w-4xl w-full h-full max-h-[48rem] flex flex-col border border-gray-300 shadow-lg outline-none overflow-hidden [@media(max-height:26rem)]:overflow-y-auto"
      >
        <div className="flex flex-none justify-between items-start gap-2 p-3 sm:p-4 border-b border-gray-200">
          <div className="min-w-0">
            <h3 id={titleId} className="text-lg font-semibold text-gray-900">Follow Up on Task</h3>
            <p id={descriptionId} className="text-sm text-gray-500 mt-1 break-words">
              {target
                ? `Post a comment to ${describeFollowupTarget(target)}`
                : 'The GitHub thread for this follow-up is not available. Refresh the task before posting.'}
            </p>
          </div>
          <button
            type="button"
            className="inline-flex flex-none min-h-11 min-w-11 items-center justify-center text-gray-500 hover:text-gray-700 text-2xl leading-none"
            onClick={onClose}
            disabled={submitting}
            aria-label="Close follow-up dialog"
          >
            &times;
          </button>
        </div>

        <div
          data-testid="followup-body"
          className="flex flex-1 min-h-0 flex-col overflow-y-auto p-3 sm:p-4 [@media(max-height:26rem)]:flex-none [@media(max-height:26rem)]:overflow-visible"
        >
          <label htmlFor={textareaId} className="block flex-none text-sm font-medium text-gray-700 mb-2">
            Comment
          </label>
          <textarea
            ref={textareaRef}
            id={textareaId}
            value={content}
            onChange={(e) => setContent(e.target.value)}
            rows={18}
            className="w-full flex-1 min-h-[5rem] px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 font-mono text-sm resize-none [@media(max-height:26rem)]:flex-none [@media(max-height:26rem)]:h-32"
            placeholder="Enter your follow-up request..."
            disabled={submitting}
            aria-describedby={feedback ? feedbackTitleId : undefined}
          />
        </div>

        {feedback && (
          <FollowupFeedback
            ref={feedbackRef}
            feedback={feedback}
            titleId={feedbackTitleId}
            retryHintId={retryHintId}
            duplicateBlocked={duplicateBlocked}
          />
        )}

        <div className="flex flex-none flex-wrap justify-end gap-3 p-3 sm:p-4 border-t border-gray-200 bg-gray-50">
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="min-h-11 px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 disabled:opacity-50"
          >
            {feedback?.postedBody !== undefined ? 'Close' : 'Cancel'}
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={submitting || !content.trim() || duplicateBlocked || !target}
            aria-describedby={duplicateBlocked ? retryHintId : !target ? descriptionId : undefined}
            className="min-h-11 px-4 py-2 text-sm font-medium text-white bg-blue-600 border border-transparent rounded-md hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
          >
            {submitting ? (
              <>
                <Loader2 size={16} className="animate-spin" />
                Posting...
              </>
            ) : (
              'Post Comment'
            )}
          </button>
        </div>
      </div>
    </div>
  );
};

export default FollowupModal;
