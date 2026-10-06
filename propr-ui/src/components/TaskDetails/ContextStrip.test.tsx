import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import ContextStrip from './ContextStrip';

const props = {
  taskInfo: { repoOwner: 'integry', repoName: 'propr', type: 'issue', number: 2658 },
  modelName: 'gpt-6-astra',
  duration: 632_000,
  prInfo: { number: 2661, url: 'https://github.com/integry/propr/pull/2661' },
  commitInfo: { shortHash: '5c7cd9e', url: 'https://github.com/integry/propr/commit/5c7cd9e' },
};

describe('Task details telemetry', () => {
  it('separates Git, runtime, and consumption and labels input/output including cached input', () => {
    render(<ContextStrip {...props}
      tokenUsage={{ input_tokens: 100_000, cache_read_input_tokens: 3_000_000, cache_creation_input_tokens: 800_000, output_tokens: 30_000 }}
      usageMetricRecords={[{ agent: 'codex', metricKey: 'weekly', metricValue: 1 }]} />);
    const git = within(screen.getByRole('group', { name: 'Git context' }));
    expect(git.getByRole('link', { name: 'integry/propr' })).toBeInTheDocument();
    expect(git.getByRole('link', { name: /PR #2661/ })).toBeInTheDocument();
    expect(git.getByRole('link', { name: '5c7cd9e' })).toBeInTheDocument();
    const runtime = screen.getByRole('group', { name: 'Execution runtime' });
    expect(runtime).toHaveTextContent('gpt-6-astra');
    expect(runtime).toHaveTextContent('10m 32s');
    const consumption = within(screen.getByRole('group', { name: 'Consumption' }));
    expect(screen.getByRole('group', { name: 'Consumption' })).toHaveTextContent('↑3.9M↓30k(1.0% quota)');
    expect(consumption.getByLabelText('3.9M input tokens')).toBeInTheDocument();
    expect(consumption.getByText('1.0% quota')).toHaveClass('text-slate-500');
    // Chips and clusters are set apart by space and a hairline rule, never dots.
    expect(document.body).not.toHaveTextContent(/[·•]/);
    expect(runtime).not.toHaveTextContent('5c7cd9e');
  });

  it('labels session and weekly quotas individually and warns on a task consuming more than 25%', () => {
    render(<ContextStrip {...props} usageMetricRecords={[
      { agent: 'claude', metricKey: 'Session', metricValue: 26 },
      { agent: 'claude', metricKey: 'Weekly', metricValue: 5.1 },
    ]} />);
    expect(screen.getByText('26.0% session')).toHaveClass('text-amber-600', 'font-medium');
    expect(screen.getByText('5.1% weekly')).toHaveClass('text-slate-500');
  });

  it('omits consumption when there are no tokens or quota deltas', () => {
    render(<ContextStrip {...props} tokenUsage={{ input_tokens: 0, output_tokens: null }}
      usageMetricRecords={[{ agent: 'codex', metricKey: 'Weekly', metricValue: 0 }]} />);
    expect(screen.queryByRole('group', { name: 'Consumption' })).not.toBeInTheDocument();
  });

  it('shows the run spend beside its cap and marks a run stopped at the cap', () => {
    const { rerender } = render(<ContextStrip {...props}
      budget={{ spentUsd: 1.2, capUsd: 5, percent: 24, source: 'workflow', exceeded: false }} />);
    const consumption = screen.getByRole('group', { name: 'Consumption' });
    expect(consumption).toHaveTextContent('$1.20 / $5.00 (24%)');
    expect(within(consumption).getByLabelText('Spend $1.20 of $5.00 cap, 24%')).toHaveAttribute('title', expect.stringContaining('.propr/workflow.yml'));

    rerender(<ContextStrip {...props} budget={{ spentUsd: 5.3, capUsd: 5, percent: 106, source: 'override', exceeded: true }} />);
    const capped = within(screen.getByRole('group', { name: 'Consumption' })).getByLabelText(/stopped at cap/);
    expect(capped).toHaveTextContent('$5.30 / $5.00 (106%)capped');
    expect(capped).toHaveClass('text-red-700');

    rerender(<ContextStrip {...props} budget={{ spentUsd: 0.75, capUsd: null, percent: null, source: null, exceeded: false }} />);
    expect(screen.getByRole('group', { name: 'Consumption' })).toHaveTextContent('$0.75');
  });
});
