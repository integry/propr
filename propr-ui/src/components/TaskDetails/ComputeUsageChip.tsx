import React from 'react';
import { Cpu } from 'lucide-react';
import type { ComputeUsage } from './types';
import { formatComputeCost, formatMemory, formatWallTime, isFiniteNumber } from './computeUsage';

/**
 * The sandbox's own consumption beside the token cost:
 * `⚙ 4m 12s · 182.4 CPU-s · 1.2 GiB peak · $0.03`. Unmeasured figures are left out.
 */
export const ComputeUsageChip: React.FC<{ computeUsage?: ComputeUsage }> = ({ computeUsage }) => {
  if (!computeUsage) return null;
  const { runtime, wallTimeMs, cpuSeconds, peakMemoryBytes, avgMemoryBytes, costUsd, costSource } = computeUsage;
  const parts = [formatWallTime(wallTimeMs)];
  if (isFiniteNumber(cpuSeconds)) parts.push(`${cpuSeconds.toFixed(1)} CPU-s`);
  if (isFiniteNumber(peakMemoryBytes)) parts.push(`${formatMemory(peakMemoryBytes)} peak`);
  if (isFiniteNumber(costUsd)) parts.push(formatComputeCost(costUsd));
  const details = [
    `Runtime: ${runtime}`,
    `Wall time: ${formatWallTime(wallTimeMs)}`,
    isFiniteNumber(cpuSeconds) ? `CPU: ${cpuSeconds.toFixed(1)} s` : 'CPU: not measured',
    isFiniteNumber(peakMemoryBytes) ? `Peak memory: ${formatMemory(peakMemoryBytes)}` : 'Memory: not measured',
    ...(isFiniteNumber(avgMemoryBytes) ? [`Average memory: ${formatMemory(avgMemoryBytes)}`] : []),
    isFiniteNumber(costUsd)
      ? `Compute cost: ${formatComputeCost(costUsd)} (${costSource === 'runtime' ? 'reported by the runtime' : 'from the rate table'})`
      : 'Compute cost: not priced',
  ];
  return (
    <span
      className="inline-flex items-center gap-1 font-mono text-xs text-slate-500"
      title={`Compute usage. ${details.join(' | ')}`}
      aria-label={`Compute usage on ${runtime}: ${parts.join(', ')}`}
      data-testid="compute-usage-chip"
    >
      <Cpu size={12} aria-hidden="true" />
      {parts.join(' · ')}
    </span>
  );
};
