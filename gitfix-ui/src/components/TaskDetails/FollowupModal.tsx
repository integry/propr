import React, { useState, useEffect } from 'react';
import { Loader2 } from 'lucide-react';

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

const FollowupModal: React.FC<FollowupModalProps> = ({
  isOpen,
  onClose,
  onSubmit,
  initialContent,
  taskInfo
}) => {
  const [content, setContent] = useState(initialContent);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset content and state when modal opens - ensures fresh content each time
  useEffect(() => {
    if (isOpen) {
      setContent(initialContent);
      setError(null);
      setSubmitting(false);
    }
  }, [isOpen, initialContent]);

  if (!isOpen) return null;

  const handleSubmit = async () => {
    if (!content.trim()) {
      setError('Please enter a comment');
      return;
    }

    try {
      setSubmitting(true);
      setError(null);
      await onSubmit(content);
      onClose();
    } catch (err) {
      setError((err as Error).message || 'Failed to post comment');
    } finally {
      setSubmitting(false);
    }
  };

  const issueType = taskInfo?.type === 'pr-comment' ? 'PR' : 'Issue';
  const issueLink = taskInfo?.repoOwner && taskInfo?.repoName && taskInfo?.number
    ? `${taskInfo.repoOwner}/${taskInfo.repoName}#${taskInfo.number}`
    : 'the linked issue';

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-lg max-w-2xl w-full max-h-[80vh] flex flex-col border border-gray-300 shadow-lg">
        <div className="flex justify-between items-center p-4 border-b border-gray-200">
          <div>
            <h3 className="text-lg font-semibold text-gray-900">Follow Up on Task</h3>
            <p className="text-sm text-gray-500 mt-1">
              Post a comment to {issueType} {issueLink}
            </p>
          </div>
          <button
            className="text-gray-500 hover:text-gray-700 text-2xl leading-none"
            onClick={onClose}
            disabled={submitting}
          >
            &times;
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4">
          <div className="space-y-4">
            <div>
              <label htmlFor="followup-content" className="block text-sm font-medium text-gray-700 mb-2">
                Comment
              </label>
              <textarea
                id="followup-content"
                value={content}
                onChange={(e) => setContent(e.target.value)}
                rows={12}
                className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 font-mono text-sm resize-y"
                placeholder="Enter your follow-up request..."
                disabled={submitting}
              />
            </div>

            {error && (
              <div className="p-3 bg-red-50 border border-red-200 rounded-md">
                <p className="text-sm text-red-600">{error}</p>
              </div>
            )}

            <div className="bg-gray-50 rounded-md p-3 border border-gray-200">
              <p className="text-xs text-gray-500">
                This comment will be posted to the GitHub {issueType.toLowerCase()} and will trigger the standard GitFix processing workflow.
              </p>
            </div>
          </div>
        </div>

        <div className="flex justify-end gap-3 p-4 border-t border-gray-200 bg-gray-50">
          <button
            onClick={onClose}
            disabled={submitting}
            className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={submitting || !content.trim()}
            className="px-4 py-2 text-sm font-medium text-white bg-blue-600 border border-transparent rounded-md hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
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
