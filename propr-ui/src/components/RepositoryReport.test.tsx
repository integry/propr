import { render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getStatsOverview } from '../api/taskStatsApi';
import RepositoryReport from './RepositoryReport';

vi.mock('../api/taskStatsApi', () => ({ getStatsOverview: vi.fn() }));

afterEach(() => vi.restoreAllMocks());

describe('RepositoryReport model identity', () => {
  it.each([
    ['gpt-5.5', 'openai/gpt-5.5', 'GPT-5.5'],
    ['claude-sonnet-9-1-20990101', 'claude-sonnet-9-1-20990201', 'Claude Sonnet 9.1'],
  ])('keeps distinct rows for %s and %s with the same display name', async (firstId, secondId, label) => {
    vi.mocked(getStatsOverview).mockResolvedValue({
      tasks: { completed: 0, planned: 0, pr_iterations_avg: 0, merged_prs: 0, total_followups: 0 },
      usage: { total_tokens: 0, total_cost_usd: 0, models: { [firstId]: 3, [secondId]: 1 } },
      system: { repos_indexed: 0 },
    });
    const consoleError = vi.spyOn(console, 'error');

    const { container } = render(<RepositoryReport />);

    const labels = await screen.findAllByText(label);
    expect(labels).toHaveLength(2);
    for (const element of labels) expect(element).toHaveAttribute('title', label);
    expect(within(labels[0].parentElement!).getByText('3')).toBeInTheDocument();
    expect(within(labels[0].parentElement!).getByText('75.0%')).toBeInTheDocument();
    expect(within(labels[1].parentElement!).getByText('1')).toBeInTheDocument();
    expect(within(labels[1].parentElement!).getByText('25.0%')).toBeInTheDocument();
    expect(container).not.toHaveTextContent(firstId);
    expect(container).not.toHaveTextContent(secondId);
    expect(consoleError).not.toHaveBeenCalled();
  });
});
