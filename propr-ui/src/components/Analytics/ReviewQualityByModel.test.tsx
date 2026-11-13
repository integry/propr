import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { ReviewScoreModelSummary, ReviewScoreSummaryResponse } from '../../api/taskStatsApi';
import ReviewQualityByModel from './ReviewQualityByModel';

const figures = (prs: number, first: number, final: number, merged: number): Omit<ReviewScoreModelSummary, 'implementer_model' | 'implementer_agent'> => ({
  prs_scored: prs,
  first_score: { mean: first, median: first, n: prs },
  final_score: { mean: final, n: prs },
  cycles_to_goal: { mean: null, n: 0, attempted: 0 },
  merge_rate: { value: merged / prs, merged, n: prs },
  cost_per_merged_pr: { usd: merged ? 2 : null, n: merged },
  score_delta: { mean: final - first, n: prs },
  runs_to_merge: { mean: merged ? 2 : null, n: merged },
});

const OPUS = { implementer_model: 'claude-opus-5-5', implementer_agent: 'claude' };
const GPT = { implementer_model: 'gpt-5.6', implementer_agent: 'codex' };
const UNTRACKED = { implementer_model: null, implementer_agent: null };

const summary: ReviewScoreSummaryResponse = {
  period: '30d', repository: 'all', prs_scored: 7, scores_recorded: 9,
  models: [{ ...OPUS, ...figures(4, 6, 8, 3) }, { ...GPT, ...figures(2, 5, 7, 2) }, { ...UNTRACKED, ...figures(1, 3, 3, 0) }],
  by_effort: [
    { ...OPUS, implementer_reasoning_level: 'high', ...figures(2, 6, 9, 2) },
    { ...OPUS, implementer_reasoning_level: 'xhigh', ...figures(1, 6, 8, 1) },
    { ...OPUS, implementer_reasoning_level: 'unknown', ...figures(1, 6, 6, 0) },
    { ...GPT, implementer_reasoning_level: 'medium', ...figures(2, 5, 7, 2) },
    { ...UNTRACKED, implementer_reasoning_level: 'unknown', ...figures(1, 3, 3, 0) },
  ],
};

describe('ReviewQualityByModel', () => {
  it('shows effort as a secondary grouping under each model\'s totals', () => {
    render(<ReviewQualityByModel summary={summary} loading={false} />);
    const table = screen.getByTestId('review-quality-table');
    // The model rows keep their meaning: one per model, over every effort.
    const models = within(table).getAllByTestId('review-quality-row');
    expect(models).toHaveLength(3);
    expect(models[0].textContent).toBe('Claude Opus 5.546.08.0+2.0 ▲2.075%');

    // A model with several levels has a row per level beneath it, unknown (historical) effort last.
    const efforts = within(table).getAllByTestId('review-quality-effort-row');
    expect(efforts.map(row => (row as HTMLTableRowElement).cells[0].textContent)).toEqual(['High effort', 'XHigh effort', 'Unknown effort']);
    expect(efforts[0].textContent).toBe('High effort26.09.0+3.0 ▲2.0100%');
    expect(models[0].nextElementSibling).toBe(efforts[0]);
    expect(efforts[2].nextElementSibling).toBe(models[1]);
    expect(within(efforts[2]).getByText('Unknown effort')).toHaveAttribute('title', expect.stringMatching(/recorded no reasoning level/));

    // One known level is a tag on its model; untracked work, all of unknown effort, has neither.
    expect(within(models[1]).getByTestId('review-quality-effort-tag')).toHaveTextContent('Medium effort');
    expect(within(models[0]).queryByTestId('review-quality-effort-tag')).not.toBeInTheDocument();
    expect(within(models[2]).queryByTestId('review-quality-effort-tag')).not.toBeInTheDocument();
    expect(models[2].nextElementSibling).toBeNull();
  });

  it('renders per-model rows alone from a server that predates the effort split', () => {
    const { by_effort: _efforts, ...legacy } = summary;
    render(<ReviewQualityByModel summary={legacy} loading={false} />);
    expect(screen.getAllByTestId('review-quality-row')).toHaveLength(3);
    expect(screen.queryByTestId('review-quality-effort-row')).not.toBeInTheDocument();
    expect(screen.queryByTestId('review-quality-effort-tag')).not.toBeInTheDocument();
  });
});
