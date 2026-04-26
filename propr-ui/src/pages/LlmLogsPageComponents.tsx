import React from 'react';
import { CheckCircle, XCircle, ChevronDown, ChevronUp, ChevronLeft, ChevronRight } from 'lucide-react';
import { Link } from 'react-router-dom';
import { LlmLogEntry, LlmLogsPagination } from '../api/llmLogsApi';
import { getWorkTypeLabel } from './llmLogsUtils';

// Status icon component
export const StatusIcon: React.FC<{ success: boolean }> = ({ success }) => {
  if (success) {
    return <CheckCircle size={18} className="text-green-500" />;
  }
  return <XCircle size={18} className="text-red-500" />;
};

// Expand/Collapse button component
export const ExpandButton: React.FC<{
  isExpanded: boolean;
  onClick: (e: React.MouseEvent) => void;
}> = ({ isExpanded, onClick }) => (
  <button
    className="p-1 hover:bg-gray-200 rounded"
    onClick={onClick}
  >
    {isExpanded ? (
      <ChevronUp size={16} className="text-gray-500" />
    ) : (
      <ChevronDown size={16} className="text-gray-500" />
    )}
  </button>
);

// Work reference sub-component to reduce complexity
const WorkReferenceSection: React.FC<{ log: LlmLogEntry }> = ({ log }) => {
  if (!log.workType) return null;
  return (
    <div className="col-span-2 space-y-2">
      <h4 className="font-medium text-gray-700">Work Reference</h4>
      <div className="bg-white p-3 rounded border border-gray-200 flex flex-wrap gap-x-6 gap-y-1">
        <div>
          <span className="text-gray-500">Type:</span>{' '}
          <span className={`inline-block px-1.5 py-0.5 text-xs font-medium rounded ${
            log.workType === 'task' ? 'bg-blue-100 text-blue-800' :
            log.workType === 'plan' ? 'bg-purple-100 text-purple-800' :
            'bg-gray-100 text-gray-800'
          }`}>
            {getWorkTypeLabel(log.workType)}
          </span>
        </div>
        {(log.workRepository || log.repository) && (
          <div>
            <span className="text-gray-500">Repository:</span>{' '}
            <span className="font-mono text-gray-800">{log.workRepository || log.repository}</span>
          </div>
        )}
        {log.taskId && (
          <div>
            <span className="text-gray-500">Task ID:</span>{' '}
            <Link
              to={`/tasks/${log.taskId}`}
              className="font-mono text-teal-600 hover:text-teal-800 hover:underline"
              onClick={(e) => e.stopPropagation()}
            >
              {log.taskId}
            </Link>
          </div>
        )}
        {log.taskNumber != null && log.taskNumber !== 0 && (
          <div>
            <span className="text-gray-500">Issue:</span>{' '}
            <span className="font-mono text-gray-800">#{log.taskNumber}</span>
          </div>
        )}
        {log.prNumber != null && (
          <div>
            <span className="text-gray-500">PR:</span>{' '}
            <span className="font-mono text-gray-800">#{log.prNumber}</span>
          </div>
        )}
        {(log.planDraftId || (log.workType === 'plan' && log.draftId)) && (
          <div>
            <span className="text-gray-500">Draft:</span>{' '}
            <Link
              to={`/plans/${log.planDraftId || log.draftId}`}
              className="font-mono text-teal-600 hover:text-teal-800 hover:underline"
              onClick={(e) => e.stopPropagation()}
            >
              {(log.planDraftId || log.draftId || '').substring(0, 12)}...
            </Link>
          </div>
        )}
        {log.planIssueId != null && (
          <div>
            <span className="text-gray-500">Plan Issue:</span>{' '}
            <span className="font-mono text-gray-800">#{log.planIssueId}</span>
          </div>
        )}
      </div>
    </div>
  );
};

// Expanded row detail component
export const ExpandedRowDetails: React.FC<{ log: LlmLogEntry }> = ({ log }) => {
  return (
    <tr className="bg-gray-50">
      <td colSpan={8} className="px-4 py-4">
        <div className="grid grid-cols-2 gap-4 text-sm">
          <WorkReferenceSection log={log} />

          {/* IDs Section */}
          <div className="space-y-2">
            <h4 className="font-medium text-gray-700">Identifiers</h4>
            <div className="bg-white p-3 rounded border border-gray-200 space-y-1">
              {log.repository && (
                <div>
                  <span className="text-gray-500">Repository:</span>{' '}
                  <span className="font-mono text-gray-800">{log.repository}</span>
                </div>
              )}
              {log.draftId && (
                <div>
                  <span className="text-gray-500">Draft ID:</span>{' '}
                  <span className="font-mono text-gray-800">{log.draftId}</span>
                </div>
              )}
              {log.sessionId && (
                <div>
                  <span className="text-gray-500">Session ID:</span>{' '}
                  <span className="font-mono text-gray-800">{log.sessionId}</span>
                </div>
              )}
              {log.correlationId && (
                <div>
                  <span className="text-gray-500">Correlation ID:</span>{' '}
                  <span className="font-mono text-gray-800">{log.correlationId}</span>
                </div>
              )}
              {log.agentAlias && (
                <div>
                  <span className="text-gray-500">Agent:</span>{' '}
                  <span className="font-mono text-gray-800">{log.agentAlias}</span>
                </div>
              )}
            </div>
          </div>

          {/* Metadata Section */}
          <div className="space-y-2">
            <h4 className="font-medium text-gray-700">Metadata</h4>
            <div className="bg-white p-3 rounded border border-gray-200">
              {log.metadata ? (
                <pre className="text-xs font-mono text-gray-800 whitespace-pre-wrap overflow-x-auto">
                  {JSON.stringify(log.metadata, null, 2)}
                </pre>
              ) : (
                <span className="text-gray-400 italic">No metadata available</span>
              )}
            </div>
          </div>

          {/* Error Message Section (if failed) */}
          {log.errorMessage && (
            <div className="col-span-2 space-y-2">
              <h4 className="font-medium text-red-700">Error Message</h4>
              <div className="bg-red-50 p-3 rounded border border-red-200">
                <pre className="text-xs font-mono text-red-800 whitespace-pre-wrap">
                  {log.errorMessage}
                </pre>
              </div>
            </div>
          )}

          {/* Cache Info Section (if available) */}
          {(log.cacheCreationInputTokens || log.cacheReadInputTokens) && (
            <div className="col-span-2 space-y-2">
              <h4 className="font-medium text-gray-700">Cache Statistics</h4>
              <div className="bg-white p-3 rounded border border-gray-200 flex gap-6">
                {log.cacheCreationInputTokens !== null && (
                  <div>
                    <span className="text-gray-500">Cache Creation Tokens:</span>{' '}
                    <span className="font-mono text-gray-800">{log.cacheCreationInputTokens.toLocaleString()}</span>
                  </div>
                )}
                {log.cacheReadInputTokens !== null && (
                  <div>
                    <span className="text-gray-500">Cache Read Tokens:</span>{' '}
                    <span className="font-mono text-gray-800">{log.cacheReadInputTokens.toLocaleString()}</span>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </td>
    </tr>
  );
};

// Pagination footer component
export const PaginationFooter: React.FC<{
  currentPage: number;
  totalPages: number;
  pageSize: number;
  pagination: LlmLogsPagination;
  loading: boolean;
  onPageChange: (page: number) => void;
}> = ({ currentPage, totalPages, pageSize, pagination, loading, onPageChange }) => (
  <div className="flex-shrink-0 bg-slate-50 border-t border-gray-200">
    <div className="flex items-center justify-between px-4 sm:px-6 py-2 sm:py-4 gap-2">
      <span className="text-xs sm:text-sm text-gray-600">
        <span className="hidden sm:inline">Showing </span>{(currentPage - 1) * pageSize + 1}-{Math.min(currentPage * pageSize, pagination.total)}<span className="hidden sm:inline"> of {pagination.total} entries</span>
      </span>
      <div className="flex items-center gap-1 sm:gap-2">
        <button
          onClick={() => onPageChange(Math.max(1, currentPage - 1))}
          disabled={!pagination.hasPreviousPage || loading}
          className="inline-flex items-center gap-1 px-2 sm:px-3 py-1 sm:py-1.5 text-xs sm:text-sm font-medium rounded-md border border-gray-300 bg-white text-gray-700 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          <ChevronLeft size={14} className="sm:w-4 sm:h-4" />
          <span className="hidden sm:inline">Previous</span>
        </button>
        <span className="text-xs sm:text-sm text-gray-600 px-1">
          {currentPage}/{totalPages}
        </span>
        <button
          onClick={() => onPageChange(Math.min(totalPages, currentPage + 1))}
          disabled={!pagination.hasNextPage || loading}
          className="inline-flex items-center gap-1 px-2 sm:px-3 py-1 sm:py-1.5 text-xs sm:text-sm font-medium rounded-md border border-gray-300 bg-white text-gray-700 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          <span className="hidden sm:inline">Next</span>
          <ChevronRight size={14} className="sm:w-4 sm:h-4" />
        </button>
      </div>
    </div>
  </div>
);
