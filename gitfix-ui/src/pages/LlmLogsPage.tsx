import React, { useEffect, useState, useCallback } from 'react';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { getLlmLogs, LlmLogEntry, LlmLogsPagination } from '../api/llmLogsApi';
import { ChevronLeft, ChevronRight, Filter, CheckCircle, XCircle, Clock, Coins, Cpu, Zap } from 'lucide-react';

const DEFAULT_PAGE_SIZE = 20;

const LlmLogsPage: React.FC = () => {
  useDocumentTitle('LLM Log');
  const [logs, setLogs] = useState<LlmLogEntry[]>([]);
  const [pagination, setPagination] = useState<LlmLogsPagination | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Filter states
  const [typeFilter, setTypeFilter] = useState<string>('all');
  const [modelFilter, setModelFilter] = useState<string>('all');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [currentPage, setCurrentPage] = useState(1);

  // Extract unique values for filters
  const [availableTypes, setAvailableTypes] = useState<string[]>([]);
  const [availableModels, setAvailableModels] = useState<string[]>([]);

  const loadLogs = useCallback(async (page: number, showLoading = true) => {
    if (showLoading) {
      setLoading(true);
    }
    try {
      const params: Record<string, unknown> = {
        page,
        limit: DEFAULT_PAGE_SIZE,
      };
      if (typeFilter !== 'all') {
        params.execution_type = typeFilter;
      }
      if (modelFilter !== 'all') {
        params.model = modelFilter;
      }
      if (statusFilter !== 'all') {
        params.success = statusFilter === 'success';
      }

      const data = await getLlmLogs(params as Parameters<typeof getLlmLogs>[0]);
      setLogs(data.logs);
      setPagination(data.pagination);

      // Extract unique types and models from current page for filter options
      // For a more complete solution, you'd fetch all unique values from a dedicated endpoint
      const types = [...new Set(data.logs.map(l => l.executionType).filter(Boolean))];
      const models = [...new Set(data.logs.map(l => l.modelName).filter(Boolean))] as string[];

      setAvailableTypes(prev => [...new Set([...prev, ...types])].sort());
      setAvailableModels(prev => [...new Set([...prev, ...models])].sort());

      setError(null);
    } catch (err) {
      if (showLoading) {
        setError((err as Error).message || 'Failed to load LLM logs');
      } else {
        console.error('Silent refresh failed:', err);
      }
    } finally {
      if (showLoading) {
        setLoading(false);
      }
    }
  }, [typeFilter, modelFilter, statusFilter]);

  // Initial load and when filters change
  useEffect(() => {
    loadLogs(currentPage);
  }, [currentPage, loadLogs]);

  // Reset to first page when filters change
  const handleTypeFilterChange = (value: string) => {
    setTypeFilter(value);
    setCurrentPage(1);
  };

  const handleModelFilterChange = (value: string) => {
    setModelFilter(value);
    setCurrentPage(1);
  };

  const handleStatusFilterChange = (value: string) => {
    setStatusFilter(value);
    setCurrentPage(1);
  };

  // Format duration to human-readable (e.g., "1m 30s")
  const formatDuration = (ms: number | null): string => {
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
  const formatCost = (cost: number | null): string => {
    if (cost === null) return '-';
    if (cost < 0.001) return '<$0.001';
    if (cost < 0.01) return `$${cost.toFixed(4)}`;
    return `$${cost.toFixed(3)}`;
  };

  // Format tokens
  const formatTokens = (input: number | null, output: number | null): string => {
    if (input === null && output === null) return '-';
    const inputStr = input !== null ? input.toLocaleString() : '0';
    const outputStr = output !== null ? output.toLocaleString() : '0';
    return `${inputStr} / ${outputStr}`;
  };

  // Format timestamp
  const formatTimestamp = (timestamp: string | null): string => {
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
  const formatType = (type: string): string => {
    return type
      .split('_')
      .map(word => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
  };

  // Get status icon
  const StatusIcon: React.FC<{ success: boolean }> = ({ success }) => {
    if (success) {
      return <CheckCircle size={18} className="text-green-500" />;
    }
    return <XCircle size={18} className="text-red-500" />;
  };

  if (loading && logs.length === 0) {
    return (
      <div className="p-6">
        <h1 className="text-2xl font-bold text-gray-800 mb-6">LLM Log</h1>
        <div className="text-gray-500">Loading logs...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-6">
        <h1 className="text-2xl font-bold text-gray-800 mb-6">LLM Log</h1>
        <div className="p-4 bg-red-50 border border-red-200 rounded-lg text-red-700">{error}</div>
      </div>
    );
  }

  const totalPages = pagination?.totalPages || 1;

  return (
    <div className="p-6">
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-2xl font-bold text-gray-800">LLM Log</h1>
        <div className="flex items-center gap-4">
          <Filter size={16} className="text-gray-500" />

          {/* Status Filter */}
          <select
            value={statusFilter}
            onChange={(e) => handleStatusFilterChange(e.target.value)}
            className="px-3 py-2 border border-gray-300 rounded-md text-sm bg-white text-gray-700 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
          >
            <option value="all">All Status</option>
            <option value="success">Success</option>
            <option value="failed">Failed</option>
          </select>

          {/* Type Filter */}
          {availableTypes.length > 0 && (
            <select
              value={typeFilter}
              onChange={(e) => handleTypeFilterChange(e.target.value)}
              className="px-3 py-2 border border-gray-300 rounded-md text-sm bg-white text-gray-700 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
            >
              <option value="all">All Types</option>
              {availableTypes.map(type => (
                <option key={type} value={type}>{formatType(type)}</option>
              ))}
            </select>
          )}

          {/* Model Filter */}
          {availableModels.length > 0 && (
            <select
              value={modelFilter}
              onChange={(e) => handleModelFilterChange(e.target.value)}
              className="px-3 py-2 border border-gray-300 rounded-md text-sm bg-white text-gray-700 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
            >
              <option value="all">All Models</option>
              {availableModels.map(model => (
                <option key={model} value={model}>{model}</option>
              ))}
            </select>
          )}
        </div>
      </div>

      {logs.length === 0 ? (
        <div className="text-center py-20 bg-gray-50 rounded-lg border border-dashed border-gray-300">
          <div className="mb-4">
            <Cpu className="w-16 h-16 mx-auto text-gray-400" />
          </div>
          <p className="text-gray-500">No LLM executions found.</p>
        </div>
      ) : (
        <div className="bg-white shadow rounded-lg overflow-hidden">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Status
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Type
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Model
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  <div className="flex items-center gap-1">
                    <Zap size={14} />
                    Tokens (In/Out)
                  </div>
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  <div className="flex items-center gap-1">
                    <Coins size={14} />
                    Cost
                  </div>
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  <div className="flex items-center gap-1">
                    <Clock size={14} />
                    Duration
                  </div>
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Timestamp
                </th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {logs.map((log) => (
                <tr key={log.logId} className="hover:bg-gray-50">
                  <td className="px-4 py-4 whitespace-nowrap">
                    <div className="flex items-center" title={log.success ? 'Success' : log.errorMessage || 'Failed'}>
                      <StatusIcon success={log.success} />
                    </div>
                  </td>
                  <td className="px-4 py-4 whitespace-nowrap">
                    <span className="px-2 py-1 text-xs font-medium rounded-full bg-indigo-100 text-indigo-800">
                      {formatType(log.executionType)}
                    </span>
                  </td>
                  <td className="px-4 py-4 whitespace-nowrap text-sm text-gray-700 font-mono">
                    {log.modelName || '-'}
                  </td>
                  <td className="px-4 py-4 whitespace-nowrap text-sm text-gray-700 font-mono">
                    {formatTokens(log.inputTokens, log.outputTokens)}
                  </td>
                  <td className="px-4 py-4 whitespace-nowrap text-sm text-gray-700 font-mono">
                    {formatCost(log.costUsd)}
                  </td>
                  <td className="px-4 py-4 whitespace-nowrap text-sm text-gray-700">
                    {formatDuration(log.durationMs)}
                  </td>
                  <td className="px-4 py-4 whitespace-nowrap text-sm text-gray-500">
                    {formatTimestamp(log.startTime)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {/* Pagination controls */}
          {totalPages > 1 && pagination && (
            <div className="flex items-center justify-between px-6 py-4 border-t border-gray-200 bg-gray-50">
              <span className="text-sm text-gray-600">
                Showing {(currentPage - 1) * DEFAULT_PAGE_SIZE + 1}-{Math.min(currentPage * DEFAULT_PAGE_SIZE, pagination.total)} of {pagination.total} entries
              </span>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                  disabled={!pagination.hasPreviousPage || loading}
                  className="inline-flex items-center gap-1 px-3 py-1.5 text-sm font-medium rounded-md border border-gray-300 bg-white text-gray-700 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  <ChevronLeft size={16} />
                  Previous
                </button>
                <span className="text-sm text-gray-600 px-2">
                  Page {currentPage} of {totalPages}
                </span>
                <button
                  onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
                  disabled={!pagination.hasNextPage || loading}
                  className="inline-flex items-center gap-1 px-3 py-1.5 text-sm font-medium rounded-md border border-gray-300 bg-white text-gray-700 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  Next
                  <ChevronRight size={16} />
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default LlmLogsPage;
