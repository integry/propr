import React, { useState, useEffect, useMemo } from 'react';

const MAX_PROGRESS_PERCENT = 98;
const LONG_ESTIMATE_THRESHOLD_MS = 60000;
const MESSAGE_ROTATION_INTERVAL_MS = 10000;

const HUMOROUS_MESSAGES = [
  "It may be slow, but it's worth the wait...",
  "Reticulating splines...",
  "Consulting the oracle...",
  "Teaching AI to be patient...",
  "Brewing some digital coffee...",
  "Counting to infinity (almost there)...",
  "Asking the hamsters to run faster...",
  "Polishing the response...",
  "Good things come to those who wait...",
  "The AI is deep in thought...",
];

const formatDuration = (ms: number): string => {
  if (ms < 1000) return `${Math.round(ms / 100) / 10}s`;
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds}s`;
  if (seconds === 0) return `${minutes}m`;
  return `${minutes}m ${seconds}s`;
};

interface RefinementProgressBarProps {
  startedAt: string;
  estimatedDuration: number;
}

export const RefinementProgressBar: React.FC<RefinementProgressBarProps> = ({ startedAt, estimatedDuration }) => {
  const [progress, setProgress] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [messageIndex, setMessageIndex] = useState(0);

  const startTime = useMemo(() => new Date(startedAt).getTime(), [startedAt]);

  const isLongEstimate = estimatedDuration > LONG_ESTIMATE_THRESHOLD_MS;

  useEffect(() => {
    const updateProgress = () => {
      const now = Date.now();
      const elapsedMs = now - startTime;
      setElapsed(elapsedMs);

      const rawProgress = (elapsedMs / estimatedDuration) * 100;
      setProgress(Math.min(rawProgress, MAX_PROGRESS_PERCENT));
    };

    updateProgress();

    const interval = setInterval(updateProgress, 500);

    return () => clearInterval(interval);
  }, [startTime, estimatedDuration]);

  useEffect(() => {
    if (!isLongEstimate) return;

    const rotateMessage = () => {
      setMessageIndex(prev => (prev + 1) % HUMOROUS_MESSAGES.length);
    };

    const interval = setInterval(rotateMessage, MESSAGE_ROTATION_INTERVAL_MS);

    return () => clearInterval(interval);
  }, [isLongEstimate]);

  const remaining = Math.max(0, estimatedDuration - elapsed);
  const isOverEstimate = elapsed > estimatedDuration;

  const getOverEstimateMessage = () => {
    if (isLongEstimate) {
      return HUMOROUS_MESSAGES[messageIndex];
    }
    return "Taking longer than expected...";
  };

  return (
    <div className="mt-2 mb-1">
      <div className="w-full h-1.5 bg-gray-200 rounded-full overflow-hidden">
        <div
          className="h-full transition-all duration-500 ease-out rounded-full"
          style={{
            width: `${progress}%`,
            backgroundColor: isOverEstimate ? 'rgb(234, 179, 8)' : 'rgb(29, 138, 138)'
          }}
        />
      </div>
      <div className="flex justify-between mt-1 text-xs text-gray-400">
        <span>
          {isOverEstimate ? (
            <span className="text-yellow-600">{getOverEstimateMessage()}</span>
          ) : (
            `~${formatDuration(remaining)} remaining`
          )}
        </span>
        <span>{Math.round(progress)}%</span>
      </div>
    </div>
  );
};
