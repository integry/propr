import React from 'react';
import { CheckCircle, XCircle, ChevronDown, ChevronUp } from 'lucide-react';
import { LlmLogEntry } from '../api/llmLogsApi';

// Format duration to human-readable (e.g., "1m 30s")
export const formatDuration = (ms: number | null): string => {
  if (ms === null) return '-';
  if (ms < 1000) return `${ms}ms`;

  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  if (minutes === 0) {
    return `${seconds}s`;
  }
  if (seconds === 0) {
    return `${minutes}m`;
  }
  return `${minutes}m ${seconds}s`;
};

// Format cost
export const formatCost = (cost: number | null): string => {
  if (cost === null) return '-';
  if (cost < 0.001) return '<$0.001';
  if (cost < 0.01) return `$${cost.toFixed(4)}`;
  return `$${cost.toFixed(3)}`;
};

// Format tokens
export const formatTokens = (input: number | null, output: number | null): string => {
  if (input === null && output === null) return '-';
  const inputStr = input !== null ? input.toLocaleString() : '0';
  const outputStr = output !== null ? output.toLocaleString() : '0';
  return `${inputStr} / ${outputStr}`;
};

// Format timestamp
export const formatTimestamp = (timestamp: string | null): string => {
  if (!timestamp) return '-';
  const date = new Date(timestamp);
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
};

// Format execution type for display
export const formatType = (type: string): string => {
  return type
    .split('_')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
};

// Get context display text (shows repository, draft ID, or session ID)
export const getContextDisplay = (log: LlmLogEntry): string => {
  if (log.repository) {
    return log.repository;
  }
  if (log.draftId) {
    return `Draft: ${log.draftId.substring(0, 8)}...`;
  }
  if (log.sessionId) {
    return `Session: ${log.sessionId.substring(0, 8)}...`;
  }
  return '-';
};

// Check if a log has detailed info to show
export const hasDetailedInfo = (log: LlmLogEntry): boolean => {
  return !!(log.metadata || log.draftId || log.sessionId || log.correlationId || log.errorMessage);
};

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

// Expanded row detail component
export const ExpandedRowDetails: React.FC<{ log: LlmLogEntry }> = ({ log }) => {
  return (
    <tr className="bg-gray-50">
      <td colSpan={9} className="px-4 py-4">
        <div className="grid grid-cols-2 gap-4 text-sm">
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
