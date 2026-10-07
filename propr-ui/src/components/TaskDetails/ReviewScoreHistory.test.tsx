import { render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ReviewScoreHistory from './ReviewScoreHistory';
import { sparklinePoints } from './reviewScoreSparkline';
import { getPullRequestScores } from '../../api/taskStatsApi';

vi.mock('../../api/taskStatsApi', () => ({ getPullRequestScores: vi.fn() }));

const score = (overrides: Record<string, unknown>) => ({
  cycle_number: null, source: 'review', score: 7, goal: null, blocker_count: 0, suggestion_count: 0,
  reviewer_agent: 'codex', reviewer_model: 'gpt-5.6', implementer_model: 'claude-opus-5-5',
  head_sha: '0123456789abcdef', task_id: 'review-task', created_at: '2026-10-06T10:00:00.000Z', ...overrides,
});

describe('ReviewScoreHistory', () => {
  beforeEach(() => vi.clearAllMocks());

  it('lists each score with its cycle, reviewer and head, plus the PR outcome', async () => {
    vi.mocked(getPullRequestScores).mockResolvedValue({
      repository: 'acme/repo', pr_number: 42, outcome: 'merged', merged_at: '2026-10-06T12:00:00.000Z', closed_at: null,
      scores: [
        score({ source: 'ultrafix', cycle_number: 1, score: 5, created_at: '2026-10-06T10:00:00.000Z' }),
        score({ source: 'ultrafix', cycle_number: 2, score: 9, head_sha: 'fedcba9876543210', created_at: '2026-10-06T11:00:00.000Z' }),
      ],
    } as Awaited<ReturnType<typeof getPullRequestScores>>);

    render(<ReviewScoreHistory repository="acme/repo" prNumber={42} />);

    const history = await screen.findByTestId('review-score-history');
    expect(getPullRequestScores).toHaveBeenCalledWith('acme/repo', 42);
    const items = within(history).getAllByRole('listitem');
    expect(items[0]).toHaveTextContent('Cycle 1');
    expect(items[0]).toHaveTextContent('5/10');
    expect(items[0]).toHaveTextContent('0123456');
    expect(items[1]).toHaveTextContent('9/10');
    expect(items[1]).toHaveTextContent('fedcba9');
    expect(within(history).getByRole('img', { name: 'Review scores: 5, 9 out of 10' })).toBeInTheDocument();
    expect(history).toHaveTextContent('Merged');
  });

  it('renders nothing for an unscored PR or a failed read', async () => {
    vi.mocked(getPullRequestScores).mockResolvedValue({
      repository: 'acme/repo', pr_number: 7, outcome: null, merged_at: null, closed_at: null, scores: [],
    });
    const { container, rerender } = render(<ReviewScoreHistory repository="acme/repo" prNumber={7} />);
    await vi.waitFor(() => expect(getPullRequestScores).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();

    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(getPullRequestScores).mockRejectedValue(new Error('offline'));
    rerender(<ReviewScoreHistory repository="acme/repo" prNumber={8} />);
    await vi.waitFor(() => expect(getPullRequestScores).toHaveBeenCalledWith('acme/repo', 8));
    expect(container).toBeEmptyDOMElement();
  });

  it('never shows a previous PR\'s history under a new PR, while loading or after a failed read', async () => {
    vi.mocked(getPullRequestScores).mockResolvedValueOnce({
      repository: 'acme/repo', pr_number: 42, outcome: 'merged', merged_at: '2026-10-06T12:00:00.000Z', closed_at: null,
      scores: [score({ score: 9 })],
    } as Awaited<ReturnType<typeof getPullRequestScores>>);
    const { container, rerender } = render(<ReviewScoreHistory repository="acme/repo" prNumber={42} />);
    expect(await screen.findByTestId('review-score-history')).toHaveTextContent('PR #42');

    vi.spyOn(console, 'warn').mockImplementation(() => {});
    let rejectRead: (error: Error) => void = () => {};
    vi.mocked(getPullRequestScores).mockReturnValueOnce(new Promise((_, reject) => { rejectRead = reject; }));
    rerender(<ReviewScoreHistory repository="acme/repo" prNumber={43} />);
    expect(getPullRequestScores).toHaveBeenLastCalledWith('acme/repo', 43);
    // While PR 43 loads, PR 42's scores are not shown under its heading.
    expect(container).toBeEmptyDOMElement();

    rejectRead(new Error('offline'));
    await vi.waitFor(() => expect(console.warn).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it('plots scores on a fixed 1–10 axis', () => {
    expect(sparklinePoints([1, 10])).toBe('0.0,28.0 120.0,0.0');
    expect(sparklinePoints([10])).toBe('60.0,0.0');
  });
});
