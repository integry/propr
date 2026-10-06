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
});

describe('Task details attempt lineage', () => {
  it('shows the attempt and links every other attempt of an automatic-replacement lineage', () => {
    render(<ContextStrip {...props} taskInfo={{
      ...props.taskInfo, attemptNumber: 2, replacesTaskId: 'attempt-1', replacedByTaskId: 'attempt-3',
      attemptLineage: [
        { taskId: 'attempt-1', attemptNumber: 1, replacementCause: null, state: 'failed' },
        { taskId: 'attempt-2', attemptNumber: 2, replacementCause: 'infra_lost', state: 'failed' },
        { taskId: 'attempt-3', attemptNumber: 3, replacementCause: 'provider_transient', state: 'processing' },
      ],
    }} />);
    const lineage = within(screen.getByRole('group', { name: 'Attempt lineage' }));
    expect(lineage.getByText('Attempt 2 of 3')).toBeInTheDocument();
    expect(lineage.getByRole('link', { name: '#1' })).toHaveAttribute('href', '/tasks/attempt-1');
    expect(lineage.getByRole('link', { name: '#3' })).toHaveAttribute('href', '/tasks/attempt-3');
    expect(lineage.queryByRole('link', { name: '#2' })).toBeNull();
  });

  it('links the neighbouring attempts when the full lineage is unavailable', () => {
    render(<ContextStrip {...props} taskInfo={{ ...props.taskInfo, attemptNumber: 2, replacesTaskId: 'attempt-1', replacedByTaskId: null }} />);
    const lineage = within(screen.getByRole('group', { name: 'Attempt lineage' }));
    expect(lineage.getByRole('link', { name: 'replaces previous' })).toHaveAttribute('href', '/tasks/attempt-1');
  });

  it('shows nothing for a task outside a lineage', () => {
    render(<ContextStrip {...props} taskInfo={{ ...props.taskInfo, attemptNumber: 1, replacesTaskId: null, replacedByTaskId: null }} />);
    expect(screen.queryByRole('group', { name: 'Attempt lineage' })).toBeNull();
  });
});
