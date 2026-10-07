import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import type { DraftListItem } from '../api/plannerTypes';
import { PlansList } from './PlansPageComponents';

const draft: DraftListItem = {
  draft_id: 'd1', repository: 'integry/propr', name: 'Plan', initial_prompt: 'Plan',
  status: 'draft', created_at: '2026-10-06T12:00:00.000Z', updated_at: '2026-10-06T12:00:00.000Z',
};

const renderList = (repositories?: string[]) => render(
  <MemoryRouter>
    <PlansList drafts={[draft]} repositories={repositories} abortingId={null} onDelete={vi.fn()} onAbort={vi.fn()} />
  </MemoryRouter>,
);

describe('PlansList repository owner', () => {
  it('drops the shared owner when every repository with plans shares it', () => {
    renderList(['integry/propr', 'integry/digvin']);
    expect(screen.getAllByText('propr').length).toBeGreaterThan(0);
  });

  it('keeps the owner when another page lists a same-named repository from a different owner', () => {
    renderList(['integry/propr', 'fork-owner/propr']);
    expect(screen.getAllByText('integry/propr').length).toBeGreaterThan(0);
    expect(screen.queryByText('propr')).not.toBeInTheDocument();
  });
});
