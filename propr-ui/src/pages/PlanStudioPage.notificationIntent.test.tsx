import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { describe, expect, test, vi } from 'vitest';
import PlanStudioPage from './PlanStudioPage';
import type { DraftWithPlan } from '../api/plannerApi';

const draft: DraftWithPlan = {
  draft_id: 'draft-1',
  repository: 'integry/propr',
  initial_prompt: 'Notification intent plan',
  status: 'review',
  attachments: [],
  created_at: '2026-08-24T12:00:00.000Z',
  plan_json: [{
    id: 'task-1',
    title: 'Add confirmation',
    body: 'Context',
    implementation: 'Implementation',
  }],
};

vi.mock('../hooks/useDocumentTitle', () => ({ useDocumentTitle: vi.fn() }));
vi.mock('../hooks/useDraft', () => ({
  useDraft: () => ({
    draft,
    loading: false,
    error: null,
    refetch: vi.fn(),
    activateGenerationRun: vi.fn(),
  }),
}));
vi.mock('../components/TaskPlanner/PlanEditor', () => ({
  default: (props: { notificationIntent?: string | null }) => (
    <output data-testid="received-intent">{props.notificationIntent ?? 'none'}</output>
  ),
}));

const LocationSearch = () => <output data-testid="location-search">{useLocation().search}</output>;

function renderStudio(entry: string) {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/studio/:draftId" element={<><PlanStudioPage /><LocationSearch /></>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('PlanStudioPage notification intent routing', () => {
  test('consumes the intent with replacement while preserving unrelated query data', async () => {
    renderStudio('/studio/draft-1?flow=kept&intent=approve_execute');

    await waitFor(() => expect(screen.getByTestId('received-intent')).toHaveTextContent('approve_execute'));
    await waitFor(() => expect(screen.getByTestId('location-search')).toHaveTextContent('?flow=kept'));
  });

  test('a refresh of the cleaned URL has no repeat intent', () => {
    renderStudio('/studio/draft-1?flow=kept');
    expect(screen.getByTestId('received-intent')).toHaveTextContent('none');
  });
});
