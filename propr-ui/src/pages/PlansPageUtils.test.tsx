import { describe, expect, it } from 'vitest';
import { getStatusBadge, toSingleLinePlainText } from './PlansPageUtils';

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
  it('keeps standard progression states neutral and reserves color for active work and drafts', () => {
    for (const status of ['review', 'pr_created', 'executed']) {
      expect(getStatusBadge(status)).toBe('bg-slate-100 text-slate-600');
    }
    expect(getStatusBadge('generating')).toContain('teal');
    expect(getStatusBadge('draft')).toContain('amber');
    expect(getStatusBadge('merged')).toBe('text-slate-500');
  });
});
