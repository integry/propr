import React, { useState, useEffect, useId, useRef } from 'react';
import { AlertTriangle, Loader2 } from 'lucide-react';
import type { PostFollowupResponse } from '../../api/proprApi';

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
  taskInfo?: {
    repoOwner?: string;
    repoName?: string;
    number?: number;
    type?: string;
  } | null;
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
  taskInfo
}) => {
  const [content, setContent] = useState(initialContent);
  const [submitting, setSubmitting] = useState(false);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const submittingRef = useRef(false);
  const feedbackRef = useRef<HTMLDivElement>(null);
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

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !submitting) onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose, submitting]);

  // A new result takes focus, so it is both seen and announced wherever the user was.
  useEffect(() => {
    if (!feedback) return;
    feedbackRef.current?.focus({ preventScroll: true });
    feedbackRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [feedback]);

  if (!isOpen) return null;

  const duplicateBlocked = feedback?.postedBody !== undefined && sameBody(content, feedback.postedBody);

  const handleSubmit = async () => {
    if (submittingRef.current || duplicateBlocked) return;
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

  const issueType = taskInfo?.type === 'pr-comment' ? 'PR' : 'Issue';
  const issueLink = taskInfo?.repoOwner && taskInfo?.repoName && taskInfo?.number
    ? `${taskInfo.repoOwner}/${taskInfo.repoName}#${taskInfo.number}`
    : 'the linked issue';

  // The dialog fills the viewport's height at most; the comment field gives up
  // space first, so the result and the actions below it stay on screen. On a
  // very short viewport (a zoomed window or a landscape phone) the whole
  // dialog scrolls instead, keeping each part reachable.
  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-2 sm:p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        data-testid="followup-dialog"
        className="bg-white rounded-lg max-w-4xl w-full h-full max-h-[48rem] flex flex-col border border-gray-300 shadow-lg overflow-hidden [@media(max-height:26rem)]:overflow-y-auto"
      >
        <div className="flex flex-none justify-between items-start gap-2 p-3 sm:p-4 border-b border-gray-200">
          <div className="min-w-0">
            <h3 id={titleId} className="text-lg font-semibold text-gray-900">Follow Up on Task</h3>
            <p id={descriptionId} className="text-sm text-gray-500 mt-1 break-words">
              Post a comment to {issueType} {issueLink}
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
            id={textareaId}
            value={content}
            onChange={(e) => setContent(e.target.value)}
            rows={18}
            className="w-full flex-1 min-h-[5rem] px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 font-mono text-sm resize-none [@media(max-height:26rem)]:flex-none [@media(max-height:26rem)]:h-32"
            placeholder="Enter your follow-up request..."
            disabled={submitting}
            aria-describedby={feedback ? feedbackTitleId : undefined}
            autoFocus
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
            disabled={submitting || !content.trim() || duplicateBlocked}
            aria-describedby={duplicateBlocked ? retryHintId : undefined}
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
