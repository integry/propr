import { describe, expect, it } from 'vitest';
import { getIssueSummaryTokens, getRepositoryShortName, getStatusBadge, getStatusLabel, toSingleLinePlainText } from './PlansPageUtils';

describe('toSingleLinePlainText', () => {
  it('strips markdown headings and line breaks from prompt-derived titles', () => {
    const prompt = 'Expose the repository retrieval as MCP tools.\n\n## Background / what already exists\nThe planner uses **retrieval** in `planner.ts`.';
    expect(toSingleLinePlainText(prompt)).toBe(
      'Expose the repository retrieval as MCP tools. Background / what already exists The planner uses retrieval in planner.ts.'
    );
  });

  it('removes inline heading markers that survived sentence truncation', () => {
    expect(toSingleLinePlainText('Add tools locally. ## Background The planner')).toBe('Add tools locally. Background The planner');
  });
});

describe('getStatusBadge', () => {
  it('uses the Task list pill palette: neutral review states, teal for active work, purple merges, red failures', () => {
    for (const status of ['review', 'pr_created', 'executed', 'approved']) {
      expect(getStatusBadge(status)).toBe('bg-slate-100 text-slate-700 border border-slate-200');
    }
    expect(getStatusBadge('draft')).toBe('bg-slate-100 text-slate-600 border border-slate-200');
    expect(getStatusBadge('generating')).toBe('bg-teal-50 text-teal-700 border border-teal-200');
    expect(getStatusBadge('merged')).toBe('bg-purple-50 text-purple-700 border border-purple-200');
    expect(getStatusBadge('failed')).toBe('bg-red-50 text-red-700 border border-red-200');
  });

  it('labels the review stage plainly', () => {
    expect(getStatusLabel('review')).toBe('In Review');
    expect(getStatusLabel('merged')).toBe('Merged');
    expect(getStatusLabel('failed')).toBe('Failed');
  });
});

describe('getIssueSummaryTokens', () => {
  it('spells out each count instead of using glyphs', () => {
    expect(getIssueSummaryTokens({ total: 3, pending: 2, processing: 1, merged: 0, closed: 0 })).toEqual(['3 issues', '1 running', '2 pending']);
    expect(getIssueSummaryTokens({ total: 1, pending: 0, processing: 0, merged: 1, closed: 0 })).toEqual(['1 issue', '1 merged']);
    expect(getIssueSummaryTokens(null)).toEqual([]);
  });
});

describe('getRepositoryShortName', () => {
  it('drops the organization prefix', () => {
    expect(getRepositoryShortName('integry/propr')).toBe('propr');
    expect(getRepositoryShortName('digvin')).toBe('digvin');
  });
});
