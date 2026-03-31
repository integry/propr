import React, { useEffect, useState, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { getLlmLogs, LlmLogEntry, LlmLogsPagination } from '../api/llmLogsApi';
import { ChevronLeft, ChevronRight, Filter, Clock, Cpu, Zap, Info } from 'lucide-react';
import {
  formatDuration,
  formatTimestamp,
  formatType,
  getContextDisplay,
  hasDetailedInfo,
} from './llmLogsUtils';
import {
  StatusIcon,
  ExpandButton,
  ExpandedRowDetails,
} from './LlmLogsPageComponents';
import { UsageBadge } from '../components/ui/UsageBadge';
import type { UsageMetrics } from '@propr/shared';

const DEFAULT_PAGE_SIZE = 20;

const LlmLogsPage: React.FC = () => {
  useDocumentTitle('LLM Log');
  const [searchParams, setSearchParams] = useSearchParams();

  // Derive state from URL parameters
  const typeFilter = searchParams.get('type') || 'all';
  const modelFilter = searchParams.get('model') || 'all';
  const statusFilter = searchParams.get('status') || 'all';
  const currentPage = Math.max(1, parseInt(searchParams.get('page') || '1', 10));

  const [logs, setLogs] = useState<LlmLogEntry[]>([]);
  const [pagination, setPagination] = useState<LlmLogsPagination | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedRows, setExpandedRows] = useState<Set<number>>(new Set());

  // Extract unique values for filters
  const [availableTypes, setAvailableTypes] = useState<string[]>([]);
  const [availableModels, setAvailableModels] = useState<string[]>([]);

  // Helper to update URL params
  const updateSearchParams = useCallback((updates: Record<string, string | null>) => {
    setSearchParams(prev => {
      const newParams = new URLSearchParams(prev);
      Object.entries(updates).forEach(([key, value]) => {
        if (value === null || value === 'all' || value === '') {
          newParams.delete(key);
        } else {
          newParams.set(key, value);
        }
      });
      return newParams;
    }, { replace: true });
  }, [setSearchParams]);

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

  // Filter change handlers using URL params
  const handleTypeFilterChange = (value: string) => {
    updateSearchParams({ type: value, page: '1' });
  };

  const handleModelFilterChange = (value: string) => {
    updateSearchParams({ model: value, page: '1' });
  };

  const handleStatusFilterChange = (value: string) => {
    updateSearchParams({ status: value, page: '1' });
  };

  const handlePageChange = (newPage: number) => {
    updateSearchParams({ page: newPage.toString() });
  };

  // Toggle row expansion
  const toggleRowExpansion = (logId: number) => {
    setExpandedRows(prev => {
      const newSet = new Set(prev);
      if (newSet.has(logId)) {
        newSet.delete(logId);
      } else {
        newSet.add(logId);
      }
      return newSet;
    });
  };

  if (loading && logs.length === 0) {
    return (
      <div className="flex flex-col h-full">
        <div className="flex-shrink-0 bg-slate-50 border-b border-gray-200 px-6 py-4">
          <h1 className="text-2xl font-bold text-gray-800">LLM Log</h1>
        </div>
        <div className="flex-1 overflow-auto px-6 py-6">
          <div className="text-gray-500">Loading logs...</div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col h-full">
        <div className="flex-shrink-0 bg-slate-50 border-b border-gray-200 px-6 py-4">
          <h1 className="text-2xl font-bold text-gray-800">LLM Log</h1>
        </div>
        <div className="flex-1 overflow-auto px-6 py-6">
          <div className="p-4 bg-red-50 border border-red-200 rounded-lg text-red-700">{error}</div>
        </div>
      </div>
    );
  }

  const totalPages = pagination?.totalPages || 1;

  return (
    <div className="flex flex-col h-full">
      {/* Anchored Header - compact on mobile */}
      <div className="flex-shrink-0 bg-slate-50 border-b border-gray-200 px-4 sm:px-6 py-2 sm:py-4">
        <div className="flex items-center justify-between gap-2 sm:gap-4">
          <h1 className="text-lg sm:text-2xl font-bold text-gray-800 flex-shrink-0">LLM Log</h1>
          <div className="flex items-center gap-2 sm:gap-4">
            <Filter size={16} className="text-gray-500 hidden sm:block" />

            {/* Status Filter */}
            <select
              value={statusFilter}
              onChange={(e) => handleStatusFilterChange(e.target.value)}
              className="px-2 sm:px-3 py-1.5 sm:py-2 border border-gray-300 rounded-md text-sm bg-white text-gray-700 focus:outline-none focus:ring-2 focus:ring-teal-500 focus:border-teal-500"
            >
              <option value="all">All Status</option>
              <option value="success">Success</option>
              <option value="failed">Failed</option>
            </select>

            {/* Type Filter - hidden on mobile */}
            {availableTypes.length > 0 && (
              <select
                value={typeFilter}
                onChange={(e) => handleTypeFilterChange(e.target.value)}
                className="hidden sm:block px-2 sm:px-3 py-1.5 sm:py-2 border border-gray-300 rounded-md text-sm bg-white text-gray-700 focus:outline-none focus:ring-2 focus:ring-teal-500 focus:border-teal-500"
              >
                <option value="all">All Types</option>
                {availableTypes.map(type => (
                  <option key={type} value={type}>{formatType(type)}</option>
                ))}
              </select>
            )}

            {/* Model Filter - hidden on mobile */}
            {availableModels.length > 0 && (
              <select
                value={modelFilter}
                onChange={(e) => handleModelFilterChange(e.target.value)}
                className="hidden sm:block px-2 sm:px-3 py-1.5 sm:py-2 border border-gray-300 rounded-md text-sm bg-white text-gray-700 focus:outline-none focus:ring-2 focus:ring-teal-500 focus:border-teal-500"
              >
                <option value="all">All Models</option>
                {availableModels.map(model => (
                  <option key={model} value={model}>{model}</option>
                ))}
              </select>
            )}
          </div>
        </div>
      </div>

      {/* Scrollable Content Area */}
      <div className="flex-1 overflow-auto">
        {logs.length === 0 ? (
          <div className="text-center py-20 mx-6 my-6 bg-gray-50 rounded-lg border border-dashed border-gray-300">
            <div className="mb-4">
              <Cpu className="w-16 h-16 mx-auto text-gray-400" />
            </div>
            <p className="text-gray-500">No LLM executions found.</p>
          </div>
        ) : (
          <div className="flex flex-col h-full bg-white">
            <div className="flex-1 overflow-auto">
              <table className="min-w-full divide-y divide-gray-200">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-2 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider w-10">
                      {/* Expand/Collapse column */}
                    </th>
                    <th className="px-2 sm:px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Status
                    </th>
                    <th className="px-2 sm:px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Type
                    </th>
                    <th className="hidden sm:table-cell px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      <div className="flex items-center gap-1">
                        <Info size={14} />
                        Context
                      </div>
                    </th>
                    <th className="hidden md:table-cell px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Model
                    </th>
                    <th className="px-2 sm:px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      <div className="flex items-center gap-1">
                        <Zap size={14} />
                        Usage
                      </div>
                    </th>
                    <th className="hidden md:table-cell px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      <div className="flex items-center gap-1">
                        <Clock size={14} />
                        Duration
                      </div>
                    </th>
                    <th className="hidden lg:table-cell px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Timestamp
                    </th>
                  </tr>
                </thead>
                <tbody className="bg-white divide-y divide-gray-200">
                  {logs.map((log) => (
                    <React.Fragment key={log.logId}>
                      <tr
                        className={`hover:bg-gray-50 ${hasDetailedInfo(log) ? 'cursor-pointer' : ''}`}
                        onClick={() => hasDetailedInfo(log) && toggleRowExpansion(log.logId)}
                      >
                        <td className="px-2 py-3 sm:py-4 whitespace-nowrap">
                          {hasDetailedInfo(log) && (
                            <ExpandButton
                              isExpanded={expandedRows.has(log.logId)}
                              onClick={(e) => {
                                e.stopPropagation();
                                toggleRowExpansion(log.logId);
                              }}
                            />
                          )}
                        </td>
                        <td className="px-2 sm:px-4 py-3 sm:py-4 whitespace-nowrap">
                          <div className="flex items-center" title={log.success ? 'Success' : log.errorMessage || 'Failed'}>
                            <StatusIcon success={log.success} />
                          </div>
                        </td>
                        <td className="px-2 sm:px-4 py-3 sm:py-4 whitespace-nowrap">
                          <span className="px-1.5 sm:px-2 py-0.5 sm:py-1 text-xs font-medium rounded-full bg-indigo-100 text-indigo-800">
                            {formatType(log.executionType)}
                          </span>
                        </td>
                        <td className="hidden sm:table-cell px-4 py-4 whitespace-nowrap text-sm text-gray-700">
                          <span title={log.repository || log.draftId || log.sessionId || undefined}>
                            {getContextDisplay(log)}
                          </span>
                        </td>
                        <td className="hidden md:table-cell px-4 py-4 whitespace-nowrap text-sm text-gray-700 font-mono">
                          {log.modelName || '-'}
                        </td>
                        <td className="px-2 sm:px-4 py-3 sm:py-4 whitespace-nowrap">
                          <UsageBadge
                            tokens={(log.inputTokens || 0) + (log.outputTokens || 0)}
                            cost={log.costUsd ?? undefined}
                            usageMetrics={log.usageMetrics as UsageMetrics | undefined}
                          />
                        </td>
                        <td className="hidden md:table-cell px-4 py-4 whitespace-nowrap text-sm text-gray-700">
                          {formatDuration(log.durationMs)}
                        </td>
                        <td className="hidden lg:table-cell px-4 py-4 whitespace-nowrap text-sm text-gray-500">
                          {formatTimestamp(log.startTime)}
                        </td>
                      </tr>
                      {expandedRows.has(log.logId) && <ExpandedRowDetails log={log} />}
                    </React.Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      {/* Anchored Footer - compact on mobile */}
      {logs.length > 0 && totalPages > 1 && pagination && (
        <div className="flex-shrink-0 bg-slate-50 border-t border-gray-200">
          <div className="flex items-center justify-between px-4 sm:px-6 py-2 sm:py-4 gap-2">
            <span className="text-xs sm:text-sm text-gray-600">
              <span className="hidden sm:inline">Showing </span>{(currentPage - 1) * DEFAULT_PAGE_SIZE + 1}-{Math.min(currentPage * DEFAULT_PAGE_SIZE, pagination.total)}<span className="hidden sm:inline"> of {pagination.total} entries</span>
            </span>
            <div className="flex items-center gap-1 sm:gap-2">
              <button
                onClick={() => handlePageChange(Math.max(1, currentPage - 1))}
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
                onClick={() => handlePageChange(Math.min(totalPages, currentPage + 1))}
                disabled={!pagination.hasNextPage || loading}
                className="inline-flex items-center gap-1 px-2 sm:px-3 py-1 sm:py-1.5 text-xs sm:text-sm font-medium rounded-md border border-gray-300 bg-white text-gray-700 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                <span className="hidden sm:inline">Next</span>
                <ChevronRight size={14} className="sm:w-4 sm:h-4" />
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default LlmLogsPage;
