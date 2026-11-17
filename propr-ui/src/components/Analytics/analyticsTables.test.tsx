import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import type { StatsOverviewResponse } from '../../api/taskStatsApi';
import RepositoryBreakdown from '../RepositoryBreakdown';
import TopModels from '../TopModels';

const inRouter = (node: React.ReactNode) => render(<MemoryRouter>{node}</MemoryRouter>);

describe('Repository performance', () => {
  it('counts only queued and running work as in progress, other states apart, with thousands separators', () => {
    inRouter(<RepositoryBreakdown loading={false} repositories={[
      { repository: 'example/workspace', total: 4_393, completed: 3_210, failed: 201, inProgress: 2, other: 980, successRate: 94.1 },
      { repository: 'example/idle', total: 3, completed: 0, failed: 0, inProgress: 1, other: 2, successRate: null },
    ]} />);

    const table = screen.getByTestId('repository-performance-table');
    expect(within(table).getByRole('columnheader', { name: 'Other' })).toHaveAttribute('title', expect.stringMatching(/cancelled/));
    const workspace = within(table).getByText('workspace').closest('tr')!;
    expect(workspace).toHaveTextContent('4,393');
    expect(within(workspace).getByTestId('repository-in-progress')).toHaveTextContent(/^2$/);
    expect(within(workspace).getByTestId('repository-other')).toHaveTextContent('980');
    expect(within(workspace).getByTestId('repository-success')).toHaveTextContent('94.1%');
    // Nothing finished: no success rate, rather than a red 0%.
    const idle = within(table).getByText('idle').closest('tr')!;
    expect(within(idle).getByTestId('repository-success')).toHaveTextContent('—');
    expect(within(idle).getByTestId('repository-success')).not.toHaveClass('text-red-600');
  });

  it('reads a missing other count from an older server as unknown', () => {
    inRouter(<RepositoryBreakdown loading={false} repositories={[
      { repository: 'example/docs', total: 4, completed: 4, failed: 0, inProgress: 0, successRate: 100 },
    ]} />);
    expect(screen.getByTestId('repository-other')).toHaveTextContent('—');
  });
});

describe('Models', () => {
  it('never clips a cost and names a placeholder model in words', () => {
    const overview = {
      usage: { total_tokens: 0, input_tokens: 0, output_tokens: 0, total_cost_usd: 0, models: {} },
      model_usage: [
        { model: 'claude-opus-5-5', runs: 12_034, tasks: 5, tokens: 3_100_000, cost_usd: 2_255.86 },
        { model: '<synthetic>', runs: 3, tasks: 1, tokens: 0, cost_usd: 0 },
      ],
    } as unknown as StatsOverviewResponse;
    inRouter(<TopModels overview={overview} loading={false} />);

    const models = screen.getByTestId('model-breakdown-table');
    // Figure columns size to their content in an auto-layout table, so a four-digit cost keeps its last digit.
    expect(models).not.toHaveClass('table-fixed');
    const costs = within(models).getAllByTestId('model-cost');
    expect(costs[0]).toHaveTextContent('$2,255.86');
    expect(costs[0]).toHaveClass('whitespace-nowrap', 'px-3', 'sm:px-4');
    expect(within(models).getAllByTestId('model-run-count')[0]).toHaveTextContent('12,034');
    // Names wrap instead of truncating, so two models never read the same.
    const names = within(models).getAllByTestId('model-name');
    expect(names.map(name => name.textContent)).toEqual(['Claude Opus 5.5', 'Synthetic']);
    for (const name of names) expect(name).not.toHaveClass('truncate');
  });
});
