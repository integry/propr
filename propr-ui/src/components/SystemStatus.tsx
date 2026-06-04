import React, { useState, useEffect, useCallback } from 'react';
import { getSystemStatus } from '../api/proprApi';
import type { SystemAgentStatus } from '../api/proprTypes';
import { useSocket } from '../contexts/useSocket';

interface Worker {
  id: number;
  status: string;
}

interface SystemStatusData {
  daemon: string;
  workers: Worker[];
  redis: string;
  githubAuth: string;
  claudeAuth: string;
  indexing: string;
  agents: SystemAgentStatus[];
}

const SystemStatus: React.FC = () => {
  const { isConnected } = useSocket();
  const [status, setStatus] = useState<SystemStatusData | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  const fetchStatus = useCallback(async () => {
    try {
      setLoading(true);
      const data = await getSystemStatus();
      setStatus(data);
      setError(null);
    } catch (err) {
      setError('Failed to fetch system status');
      console.error('Error fetching system status:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  // Fetch system status on mount and when WebSocket connection state changes
  // This ensures we get fresh status when connectivity is restored
  useEffect(() => {
    fetchStatus();
  }, [fetchStatus, isConnected]);

  if (loading && !status) {
    return <div className="text-gray-500">Loading System Status...</div>;
  }

  if (error) {
    return <div className="text-red-600">Error: {error}</div>;
  }

  const getStatusColor = (status?: string): string => {
    switch (status?.toLowerCase()) {
      case 'running':
      case 'connected':
      case 'authenticated':
      case 'ready':
      case 'active':
      case 'idle':
        return '#10B981'; // emerald-500 for success states
      case 'queued':
        return '#F59E0B'; // amber-500 for pending work
      case 'stopped':
      case 'disconnected':
      case 'failed':
      case 'error':
      case 'unavailable':
        return '#ef4444'; // red-500 for failure states
      default:
        return '#64748B'; // slate-500
    }
  };

  const getWorkerStatus = () => {
    if (!status?.workers || status.workers.length === 0) return 'No workers';
    const activeCount = status.workers.filter((w: Worker) => w.status === 'active').length;
    const totalCount = status.workers.length;
    return `${activeCount}/${totalCount} active`;
  };

  const formatAgentLabel = (agent: SystemAgentStatus): string => {
    const alias = agent.alias === 'default' ? '' : ` (${agent.alias})`;
    return `${agent.type.charAt(0).toUpperCase()}${agent.type.slice(1)}${alias}`;
  };

  const renderStatusRow = (label: string, value?: string, isLast = false) => (
    <div className={`flex justify-between items-center py-2 ${isLast ? '' : 'border-b border-slate-200'}`}>
      <span className="font-medium text-slate-600">{label}:</span>
      <span className="font-semibold" style={{ color: getStatusColor(value) }}>
        {value || 'Unknown'}
      </span>
    </div>
  );

  return (
    <div className="min-w-[300px]">
      <h3 className="section-header mb-6">System Status</h3>
      <div className="flex flex-col gap-3 dashboard-card">
        {renderStatusRow('Daemon', status?.daemon)}
        <div className="flex justify-between items-center py-2 border-b border-slate-200">
          <span className="font-medium text-slate-600">Workers:</span>
          <span className="font-semibold text-slate-700">
            {getWorkerStatus()}
          </span>
        </div>
        {renderStatusRow('Redis', status?.redis)}
        {renderStatusRow('GitHub Auth', status?.githubAuth)}
        {renderStatusRow('Indexing', status?.indexing, (status?.agents.length || 0) === 0)}
        {status?.agents.map((agent, index) => renderStatusRow(
          formatAgentLabel(agent),
          agent.status,
          index === status.agents.length - 1
        ))}
      </div>
    </div>
  );
};

export default SystemStatus;
