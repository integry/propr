import React, { useState, useEffect } from 'react';
import { X, Activity } from 'lucide-react';
import { detectAgentTank, enableAgentTank } from '../api/revertApi';
import type { AgentTankMode } from '@propr/shared';

const DISMISSED_KEY = 'agent-tank-banner-dismissed';

const AgentTankDetectionBanner: React.FC = () => {
  const [detected, setDetected] = useState(false);
  // Which mode the backend suggests: 'external' when a daemon answered at the
  // default URL, 'bundled' when nothing is running but the agent image can do
  // the job with no install at all.
  const [offeredMode, setOfferedMode] = useState<AgentTankMode>('bundled');
  const [detectedUrl, setDetectedUrl] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [enabling, setEnabling] = useState(false);

  useEffect(() => {
    // Check if user previously dismissed
    const wasDismissed = sessionStorage.getItem(DISMISSED_KEY);
    if (wasDismissed) {
      setDismissed(true);
      return;
    }

    // Detect Agent Tank
    detectAgentTank()
      .then(result => {
        if (!result.detected) return;
        const mode = result.mode === 'external' && result.url ? 'external' : 'bundled';
        setOfferedMode(mode);
        setDetectedUrl(mode === 'external' ? result.url ?? null : null);
        setDetected(true);
      })
      .catch(() => {
        // Silently fail - detection is optional
      });
  }, []);

  const handleEnable = async () => {
    setEnabling(true);
    try {
      await enableAgentTank(offeredMode, detectedUrl ?? undefined);
      setDetected(false);
      // Reload the page to show the sidebar
      window.location.reload();
    } catch (err) {
      console.error('Failed to enable Agent Tank:', err);
      setEnabling(false);
    }
  };

  const handleDismiss = () => {
    sessionStorage.setItem(DISMISSED_KEY, 'true');
    setDismissed(true);
  };

  if (!detected || dismissed) return null;

  return (
    <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 flex items-center justify-between">
      <div className="flex items-center gap-3">
        <div className="p-2 bg-blue-100 rounded-lg">
          <Activity className="w-5 h-5 text-blue-600" />
        </div>
        <div>
          <p className="text-sm font-medium text-gray-900">
            {offeredMode === 'external' ? 'Agent Tank Detected' : 'Track Your LLM Usage Limits'}
          </p>
          <p className="text-xs text-gray-600">
            Monitor AI subscription limits and see how much rate-limit capacity each task consumes.
            {offeredMode === 'bundled' && ' Runs inside the ProPR agent image — nothing to install.'}
          </p>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <button
          onClick={handleEnable}
          disabled={enabling}
          className="px-3 py-1.5 text-xs font-medium text-white bg-primary-600 hover:bg-primary-700 rounded-md disabled:opacity-50"
        >
          {enabling ? 'Enabling...' : 'Enable'}
        </button>
        <button
          onClick={handleDismiss}
          className="p-1.5 text-gray-400 hover:text-gray-600 rounded"
          title="Dismiss"
        >
          <X className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
};

export default AgentTankDetectionBanner;
