import { describe, expect, it } from 'vitest';
import type { DraftListItem } from '../api/plannerApi';
import { getItemDescription, getSearchStatus, splitFailureReason } from './globalSearchModel';

const plan = (name: string, initial_prompt: string) =>
  ({ kind: 'plan' as const, key: 'plan:1', plan: { draft_id: '1', repository: 'a/b', name, initial_prompt } as DraftListItem });

describe('globalSearchModel', () => {
  it('drops a description that only restates the title', () => {
    expect(getItemDescription(plan('Expose retrieval over MCP', 'Plan Expose retrieval over MCP'))).toBeNull();
    expect(getItemDescription(plan('Expose retrieval over MCP', 'Expose retrieval over MCP.'))).toBeNull();
    expect(getItemDescription(plan('', 'Configure endpoint routes'))).toBeNull();
    expect(getItemDescription(plan('Expose retrieval over MCP', 'Configure endpoint routes and handlers.')))
      .toBe('Configure endpoint routes and handlers.');
  });

  it('splits file paths out of a failure reason', () => {
    expect(splitFailureReason('Lint failed on src/mcp/activity.ts')).toEqual([
      { text: 'Lint failed on ', path: false },
      { text: 'src/mcp/activity.ts', path: true },
    ]);
    expect(splitFailureReason('Timed out')).toEqual([{ text: 'Timed out', path: false }]);
  });

  it('labels statuses with capitalised text and a tone', () => {
    expect(getSearchStatus('failed')).toEqual({ label: 'Failed', tone: 'failed' });
    expect(getSearchStatus('review')).toEqual({ label: 'Review', tone: 'review' });
    expect(getSearchStatus('pr_created')).toEqual({ label: 'PR created', tone: 'review' });
    expect(getSearchStatus('post_processing')).toEqual({ label: 'Post processing', tone: 'active' });
  });
});
