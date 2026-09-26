import React from 'react';
import { RefreshCw, WifiOff } from 'lucide-react';
import type { HeaderStatsResourceStatus } from '../hooks/useHeaderStats';

interface HeaderResourceStatusProps {
  label: string;
  status: Exclude<HeaderStatsResourceStatus, 'available'>;
}

const HeaderResourceStatus: React.FC<HeaderResourceStatusProps> = ({ label, status }) => {
  const checking = status === 'checking';
  return (
    <div
      className="flex h-full items-center px-3"
      role="status"
      aria-label={checking ? `Checking ${label.toLowerCase()}` : `${label} unavailable`}
    >
      <div className="flex items-center gap-1.5 border border-amber-200 bg-amber-50 px-2.5 py-1 text-amber-700">
        {checking
          ? <RefreshCw className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
          : <WifiOff className="h-3.5 w-3.5" aria-hidden="true" />}
        <span className="text-xs font-medium">
          {checking ? `Checking ${label.toLowerCase()}` : `${label} unavailable`}
        </span>
      </div>
    </div>
  );
};

export default HeaderResourceStatus;
