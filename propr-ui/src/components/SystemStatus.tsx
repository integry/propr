import React, { useState, useEffect } from 'react';
import { getSystemStatus } from '../api/proprApi';

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
}

const SystemStatus: React.FC = () => {
  const [status, setStatus] = useState<SystemStatusData | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchStatus = async () => {
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
    };

    fetchStatus();
    const interval = setInterval(fetchStatus, 5000); // Poll every 5 seconds
    return () => clearInterval(interval);
  }, []);

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
      case 'active':
        return '#10B981'; // emerald-500 for success states
      case 'stopped':
      case 'disconnected':
      case 'failed':
      case 'error':
        return '#ef4444'; // red-500 for failure states
      case 'idle':
        return '#F59E0B'; // amber-500 for warning states
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

  return (
    <div className="min-w-[300px]">
      <h3 className="section-header mb-6">System Status</h3>
      <div className="flex flex-col gap-3 dashboard-card">
        <div className="flex justify-between items-center py-2 border-b border-slate-200">
          <span className="font-medium text-slate-600">Daemon:</span>
          <span className="font-semibold" style={{ color: getStatusColor(status?.daemon) }}>
            {status?.daemon || 'Unknown'}
          </span>
        </div>
        <div className="flex justify-between items-center py-2 border-b border-slate-200">
          <span className="font-medium text-slate-600">Workers:</span>
          <span className="font-semibold text-slate-700">
            {getWorkerStatus()}
          </span>
        </div>
        <div className="flex justify-between items-center py-2 border-b border-slate-200">
          <span className="font-medium text-slate-600">Redis:</span>
          <span className="font-semibold" style={{ color: getStatusColor(status?.redis) }}>
            {status?.redis || 'Unknown'}
          </span>
        </div>
        <div className="flex justify-between items-center py-2 border-b border-slate-200">
          <span className="font-medium text-slate-600">GitHub Auth:</span>
          <span className="font-semibold" style={{ color: getStatusColor(status?.githubAuth) }}>
            {status?.githubAuth || 'Unknown'}
          </span>
        </div>
        <div className="flex justify-between items-center py-2">
          <span className="font-medium text-slate-600">Claude Auth:</span>
          <span className="font-semibold" style={{ color: getStatusColor(status?.claudeAuth) }}>
            {status?.claudeAuth || 'Unknown'}
          </span>
        </div>
      </div>
    </div>
  );
};

export default SystemStatus;