import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ConsumptionGroup } from './ContextStrip';
import { pickComputeUsage } from './computeUsage';
import type { ComputeUsage, HistoryItem } from './types';

const GIB = 1024 ** 3;

const measured: ComputeUsage = {
  runtime: 'docker', wallTimeMs: 252_000, cpuSeconds: 182.44, peakMemoryBytes: 1.2 * GIB, avgMemoryBytes: 640 * 1024 ** 2,
  costUsd: null, costSource: null,
};

describe('Compute usage in the run summary', () => {
  it('sits beside the token usage in Consumption with wall time, CPU and peak memory', () => {
    render(<ConsumptionGroup tokenUsage={{ input_tokens: 1000, output_tokens: 200 }} computeUsage={measured} />);
    const consumption = within(screen.getByRole('group', { name: 'Consumption' }));
    const chip = consumption.getByTestId('compute-usage-chip');
    expect(chip).toHaveTextContent('4m 12s · 182.4 CPU-s · 1.2 GiB peak');
    expect(chip).toHaveAccessibleName('Compute usage on docker: 4m 12s, 182.4 CPU-s, 1.2 GiB peak');
    expect(chip.getAttribute('title')).toContain('Average memory: 640 MiB');
    expect(chip.getAttribute('title')).toContain('Compute cost: not priced');
  });

  it('shows the compute cost and where it came from; leaves unmeasured figures out', () => {
    render(<ConsumptionGroup computeUsage={{ ...measured, runtime: 'fly', cpuSeconds: null, peakMemoryBytes: null, avgMemoryBytes: null, costUsd: 0.0042, costSource: 'rate_table' }} />);
    const chip = screen.getByTestId('compute-usage-chip');
    expect(chip).toHaveTextContent('4m 12s · $0.0042');
    expect(chip.getAttribute('title')).toContain('CPU: not measured');
    expect(chip.getAttribute('title')).toContain('Compute cost: $0.0042 (from the rate table)');
  });

  it('renders nothing for a run no runtime measured', () => {
    render(<ConsumptionGroup tokenUsage={{ input_tokens: 1 }} />);
    expect(screen.queryByTestId('compute-usage-chip')).not.toBeInTheDocument();
  });

  it('reads the newest history entry that recorded usage, ignoring malformed entries', () => {
    const entry = (metadata: HistoryItem['metadata']): HistoryItem => ({ state: 'claude_execution', timestamp: '2026-11-24T00:00:00Z', metadata } as HistoryItem);
    const older = { ...measured, wallTimeMs: 1000 };
    expect(pickComputeUsage([
      entry({ computeUsage: older }),
      entry({ computeUsage: measured }),
      entry({ computeUsage: { runtime: 'docker' } as unknown as ComputeUsage }),
      entry({}),
    ])).toBe(measured);
    expect(pickComputeUsage(null)).toBeUndefined();
  });
});
