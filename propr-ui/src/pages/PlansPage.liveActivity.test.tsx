import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import PlansPage from './PlansPage';
import type { DraftListItem, PaginatedDraftsResponse } from '../api/proprApi';
import { getDrafts, getDraftRepositories } from '../api/proprApi';
import type { ActivityUpdatePayload, DraftUpdatePayload } from '@propr/shared';

/**
 * A plan issue leaving refinement changes the listed plan's counts while the
 * plan itself stays `pr_created`, so no draft status change announces it. The
 * list follows it through the instance activity room it already shares with
 * the rest of the shell.
 */

const draftListeners = new Set<(payload: DraftUpdatePayload) => void>();
const activityListeners = new Set<(payload: ActivityUpdatePayload) => void>();
const socketState = {
  isConnected: true,
  onDraftUpdate: vi.fn((callback: (payload: DraftUpdatePayload) => void) => {
    draftListeners.add(callback);
    return () => { draftListeners.delete(callback); };
  }),
  onActivityUpdate: vi.fn((callback: (payload: ActivityUpdatePayload) => void) => {
    activityListeners.add(callback);
    return () => { activityListeners.delete(callback); };
  }),
  subscribeToActivity: vi.fn(),
  unsubscribeFromActivity: vi.fn(),
};

vi.mock('../hooks/useDocumentTitle', () => ({ useDocumentTitle: vi.fn() }));
vi.mock('../api/proprApi', () => ({
  getDrafts: vi.fn(),
  getDraftRepositories: vi.fn(),
  deleteDraft: vi.fn(),
  abortGeneration: vi.fn(),
}));
vi.mock('../contexts/useSocket', () => ({ useSocket: () => socketState }));

const mockGetDrafts = vi.mocked(getDrafts);
const mockGetDraftRepositories = vi.mocked(getDraftRepositories);

const REPOSITORY = 'propr-ultrafix/propr-desktop-acceptance';

function listing(summary: NonNullable<DraftListItem['issue_summary']>): PaginatedDraftsResponse {
  return {
    drafts: [{
      draft_id: 'abe415d2', repository: REPOSITORY, name: 'Acceptance plan', initial_prompt: 'Acceptance plan',
      status: 'pr_created', updated_at: '2026-10-14T08:27:54Z', created_at: '2026-10-14T01:00:00Z',
      issue_summary: summary,
    }],
    total: 1, page: 1, limit: 50, hasMore: false,
  };
}

const refining = listing({ total: 1, pending: 0, processing: 1, in_review: 0, merged: 0, closed: 0 });
const inReview = listing({ total: 1, pending: 0, processing: 0, in_review: 1, merged: 0, closed: 0 });

function planActivity(repository: string | null, change: ActivityUpdatePayload['change'] = 'blocked'): ActivityUpdatePayload {
  return {
    eventType: 'activity:update', domain: 'plan', change, entityId: '1', repository,
    terminal: change === 'completed' || change === 'cancelled', occurredAt: '2026-10-15T11:30:00Z',
  } as ActivityUpdatePayload;
}

const emit = <T,>(listeners: Set<(payload: T) => void>, payload: T) => act(async () => {
  listeners.forEach(listener => listener(payload));
});

function renderPlans(url = '/plans') {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <Routes><Route path="/plans" element={<PlansPage />} /></Routes>
    </MemoryRouter>
  );
}

describe('PlansPage plan activity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    draftListeners.clear();
    activityListeners.clear();
    socketState.isConnected = true;
    mockGetDraftRepositories.mockResolvedValue({ repositories: [{ repo: REPOSITORY, count: 1 }], total: 1 });
  });

  it('moves a visible plan from running to in review while its status stays pr_created, without a reload', async () => {
    mockGetDrafts.mockResolvedValueOnce(refining).mockResolvedValueOnce(inReview);
    const view = renderPlans();

    expect((await screen.findAllByText(/1 running/)).length).toBeGreaterThan(0);
    expect(socketState.subscribeToActivity).toHaveBeenCalledTimes(1);

    // The draft status did not change, so a draft update would not refresh the list.
    await emit(draftListeners, {
      eventType: 'draft:update', draftId: 'abe415d2', step: 'complete', status: 'completed',
      timestamp: '2026-10-15T11:30:00Z', draftStatus: 'pr_created',
    } as DraftUpdatePayload);
    // Plan activity elsewhere does not touch the visible plans.
    await emit(activityListeners, planActivity('integry/other'));
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(mockGetDrafts).toHaveBeenCalledTimes(1);

    // The refinement settles: plan activity in the plan's repository.
    await emit(activityListeners, planActivity(REPOSITORY));
    await waitFor(() => expect(mockGetDrafts).toHaveBeenCalledTimes(2));
    expect((await screen.findAllByText(/1 in review/)).length).toBeGreaterThan(0);
    expect(screen.queryByText(/1 running/)).not.toBeInTheDocument();
    expect(mockGetDrafts).toHaveBeenLastCalledWith(expect.objectContaining({ page: 1, limit: 50 }));

    view.unmount();
    expect(socketState.unsubscribeFromActivity).toHaveBeenCalledTimes(1);
  });

  it('coalesces a burst of plan activity into one read and keeps the repository filter', async () => {
    mockGetDrafts.mockResolvedValueOnce(refining).mockResolvedValue(inReview);
    renderPlans(`/plans?repository=${encodeURIComponent(REPOSITORY)}`);
    expect((await screen.findAllByText(/1 running/)).length).toBeGreaterThan(0);

    await emit(activityListeners, planActivity(REPOSITORY, 'blocked'));
    await emit(activityListeners, planActivity(REPOSITORY, 'created'));
    await emit(activityListeners, planActivity(REPOSITORY, 'blocked'));
    await waitFor(() => expect(mockGetDrafts).toHaveBeenCalledTimes(2));
    expect(mockGetDrafts).toHaveBeenLastCalledWith(expect.objectContaining({ repository: REPOSITORY }));
    expect((await screen.findAllByText(/1 in review/)).length).toBeGreaterThan(0);
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(mockGetDrafts).toHaveBeenCalledTimes(2);
  });

  it('does not join the activity room while disconnected', async () => {
    socketState.isConnected = false;
    mockGetDrafts.mockResolvedValue(refining);
    renderPlans();
    expect((await screen.findAllByText(/1 running/)).length).toBeGreaterThan(0);
    expect(socketState.subscribeToActivity).not.toHaveBeenCalled();
  });
});
