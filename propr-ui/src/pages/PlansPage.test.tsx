import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import PlansPage from './PlansPage';
import type { PaginatedDraftsResponse, RepositoriesResponse } from '../api/proprApi';
import { getDrafts, getDraftRepositories } from '../api/proprApi';
import type { DraftUpdatePayload } from '@propr/shared';

const draftUpdateListeners = new Set<(payload: DraftUpdatePayload) => void | Promise<void>>();
const socketState = {
  isConnected: false,
  onDraftUpdate: vi.fn((callback: (payload: DraftUpdatePayload) => void | Promise<void>) => {
    draftUpdateListeners.add(callback);
    return () => {
      draftUpdateListeners.delete(callback);
    };
  }),
};

vi.mock('../hooks/useDocumentTitle', () => ({
  useDocumentTitle: vi.fn(),
}));

vi.mock('../api/proprApi', () => ({
  getDrafts: vi.fn(),
  getDraftRepositories: vi.fn(),
  deleteDraft: vi.fn(),
  abortGeneration: vi.fn(),
}));

vi.mock('../contexts/useSocket', () => ({
  useSocket: () => socketState,
}));

vi.mock('./PlansPageComponents', () => ({
  EmptyState: () => <div>empty state</div>,
  PlansTable: () => <div>plans table</div>,
  PaginationControls: () => null,
}));

const mockGetDrafts = vi.mocked(getDrafts);
const mockGetDraftRepositories = vi.mocked(getDraftRepositories);

describe('PlansPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    draftUpdateListeners.clear();
    socketState.isConnected = false;
  });

  it('renders repository filter counts and respects the repository query param', async () => {
    const repositoriesResponse: RepositoriesResponse = {
      repositories: [
        { repo: 'integry/propr', count: 3 },
        { repo: 'integry/agent', count: 1 },
      ],
      total: 4,
    };
    const draftsResponse: PaginatedDraftsResponse = {
      drafts: [{
        draft_id: 'draft-1',
        repository: 'integry/propr',
        initial_prompt: 'Test draft',
        status: 'draft',
        updated_at: '2026-04-27T00:00:00Z',
        created_at: '2026-04-27T00:00:00Z',
      }],
      total: 1,
      page: 1,
      limit: 20,
      hasMore: false,
    };
    mockGetDraftRepositories.mockResolvedValue(repositoriesResponse);
    mockGetDrafts.mockResolvedValue(draftsResponse);

    render(
      <MemoryRouter initialEntries={['/plans?repository=integry/propr']}>
        <Routes>
          <Route path="/plans" element={<PlansPage />} />
        </Routes>
      </MemoryRouter>
    );

    await waitFor(() => expect(mockGetDrafts).toHaveBeenCalledWith(expect.objectContaining({
      repository: 'integry/propr',
    })));

    const trigger = screen.getByRole('button', { name: /propr/i });
    expect(trigger.textContent).toContain('integry');
    expect(trigger.textContent).toContain('propr');
    expect(trigger.textContent).toContain('3');

    fireEvent.click(trigger);

    expect(screen.getByText('All Repos')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /All Repos/ }).textContent).toContain('4');
    expect(screen.getByRole('button', { name: /agent/ }).textContent).toContain('1');
  });

  it('refreshes repository metadata for relevant socket status changes on the current page', async () => {
    socketState.isConnected = true;
    mockGetDraftRepositories
      .mockResolvedValueOnce({ repositories: [{ repo: 'integry/propr', count: 1 }], total: 1 })
      .mockResolvedValueOnce({ repositories: [{ repo: 'integry/propr', count: 1 }], total: 1 });
    mockGetDrafts
      .mockResolvedValueOnce({
        drafts: [{
          draft_id: 'draft-1',
          repository: 'integry/propr',
          initial_prompt: 'Test draft',
          status: 'draft',
          updated_at: '2026-04-27T00:00:00Z',
          created_at: '2026-04-27T00:00:00Z',
        }],
        total: 1,
        page: 1,
        limit: 20,
        hasMore: false,
      })
      .mockResolvedValueOnce({
        drafts: [{
          draft_id: 'draft-1',
          repository: 'integry/propr',
          initial_prompt: 'Test draft',
          status: 'review',
          updated_at: '2026-04-27T00:00:01Z',
          created_at: '2026-04-27T00:00:00Z',
        }],
        total: 1,
        page: 1,
        limit: 20,
        hasMore: false,
      });

    render(
      <MemoryRouter initialEntries={['/plans?repository=integry/propr']}>
        <Routes>
          <Route path="/plans" element={<PlansPage />} />
        </Routes>
      </MemoryRouter>
    );

    await waitFor(() => expect(draftUpdateListeners.size).toBeGreaterThan(0));

    await waitFor(() => expect(mockGetDraftRepositories).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(mockGetDrafts).toHaveBeenCalledTimes(1));

    await act(async () => {
      await Promise.all(
        [...draftUpdateListeners].map(listener => listener({
          eventType: 'draft:update',
          draftId: 'draft-1',
          step: 'complete',
          status: 'completed',
          timestamp: '2026-05-05T00:00:10Z',
          draftStatus: 'review',
        }))
      );
    });

    await waitFor(() => expect(mockGetDraftRepositories).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(mockGetDrafts).toHaveBeenCalledTimes(2));
  });

  it('reloads the filtered list for off-page status updates that could enter the current view', async () => {
    socketState.isConnected = true;
    mockGetDraftRepositories
      .mockResolvedValueOnce({ repositories: [{ repo: 'integry/propr', count: 1 }], total: 1 })
      .mockResolvedValueOnce({ repositories: [{ repo: 'integry/propr', count: 2 }], total: 2 });
    mockGetDrafts
      .mockResolvedValueOnce({
        drafts: [{
          draft_id: 'draft-1',
          repository: 'integry/propr',
          initial_prompt: 'Test draft',
          status: 'draft',
          updated_at: '2026-04-27T00:00:00Z',
          created_at: '2026-04-27T00:00:00Z',
        }],
        total: 1,
        page: 1,
        limit: 20,
        hasMore: false,
      })
      .mockResolvedValueOnce({
        drafts: [{
          draft_id: 'draft-1',
          repository: 'integry/propr',
          initial_prompt: 'Test draft',
          status: 'draft',
          updated_at: '2026-04-27T00:00:00Z',
          created_at: '2026-04-27T00:00:00Z',
        }, {
          draft_id: 'draft-2',
          repository: 'integry/propr',
          initial_prompt: 'Other draft',
          status: 'review',
          updated_at: '2026-05-05T00:00:10Z',
          created_at: '2026-05-05T00:00:00Z',
        }],
        total: 2,
        page: 1,
        limit: 20,
        hasMore: false,
      });

    render(
      <MemoryRouter initialEntries={['/plans?repository=integry/propr&status=review']}>
        <Routes>
          <Route path="/plans" element={<PlansPage />} />
        </Routes>
      </MemoryRouter>
    );

    await waitFor(() => expect(draftUpdateListeners.size).toBeGreaterThan(0));
    await waitFor(() => expect(mockGetDrafts).toHaveBeenCalledTimes(1));

    await act(async () => {
      await Promise.all(
        [...draftUpdateListeners].map(listener => listener({
          eventType: 'draft:update',
          draftId: 'draft-2',
          step: 'complete',
          status: 'completed',
          timestamp: '2026-05-05T00:00:10Z',
          draftStatus: 'review',
        }))
      );
    });

    await waitFor(() => expect(mockGetDrafts).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(mockGetDraftRepositories).toHaveBeenCalledTimes(2));
  });
});
